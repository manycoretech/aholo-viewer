#include <algorithm>
#include <chrono>
#include <compact.h>
#include <expand.h>
#include <gpu/compute.h>
#include <gpu/context.h>
#include <iostream>
#include <type_traits>
#include <utility>

using namespace splat_transform;
namespace {
template<class T>
constexpr bool unique_owner = !std::is_copy_constructible_v<T> && !std::is_copy_assignable_v<T> && std::is_nothrow_move_constructible_v<T> && std::is_nothrow_move_assignable_v<T>;
static_assert(unique_owner<gpu::Buffer> && unique_owner<gpu::ComputePipeline> && unique_owner<gpu::DescriptorTable>);
static_assert(unique_owner<gpu::CommandList> && unique_owner<gpu::Fence>);
static_assert(std::is_trivially_copyable_v<gpu::ComputeDevice>);
static_assert(!std::is_copy_constructible_v<gpu::Queue> && !std::is_move_constructible_v<gpu::Queue>);

void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
template<class F>
void rejects(F&& action) {
    bool rejected = false;
    try {
        action();
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    require(rejected, "HAL accepted an invalid resource range or command state");
}
gpu::ComputeShader shader(gpu::ShaderCode code) {
    return { "same-name", code, { gpu::BufferAccess::Read, gpu::BufferAccess::ReadWrite }, 20 };
}
void transfers_and_lifetimes(const gpu::ComputeDevice& device) {
    auto& queue = device.default_queue();
    auto fence = device.create_fence();
    uint64_t completion = 0;
    require(fence.completed_value() == 0, "New fence should start at zero");
    queue.wait_cpu(fence, 0);
    rejects([&] { queue.wait_cpu(fence, 1); });
    const auto initial = device.allocation_bytes();
    {
        auto readback = device.create_buffer(16, gpu::BufferMemory::Readback);
        const auto readback_bytes = device.allocation_bytes();
        auto storage = device.create_buffer(16);
        auto commands = device.create_commands();
        rejects([&] { commands.end(); });
        rejects([&] { queue.submit(commands, fence); });
        commands.begin();
        rejects([&] { commands.copy(storage, readback, 20); });
        rejects([&] { commands.copy(storage, readback, 3); });
        rejects([&] { commands.copy(storage, storage, 8, 0, 4); });
        rejects([&] { commands.fill(storage, 0, 4, 16); });
        rejects([&] { commands.fill(readback); });
        rejects([&] { storage.mapped_data(); });
        commands.fill(storage, 0x12345678);
        commands.copy(storage, readback, 16);
        commands.end();
        completion = queue.submit(commands, fence);
        require(completion == 1, "Rejected submission consumed a fence value");
        rejects([&] { commands.reset(); });
        rejects([&] { commands.begin(); });
        rejects([&] { queue.submit(commands, fence); });
        device.default_queue().wait_cpu(fence, completion);
        require(fence.completed_value() == 1, "Wait did not advance the caller-owned fence");
        completion = queue.submit(commands, fence);
        require(completion == 2, "Pending submission rejection consumed a fence value");
        queue.wait_cpu();
        require(fence.completed_value() == 2, "Queue CPU wait did not complete submitted values");
        std::array<uint32_t, 4> result {};
        readback.read_into(std::as_writable_bytes(std::span(result)));
        require(std::ranges::all_of(result, [](auto value) { return value == 0x12345678; }), "GPU fill/copy/readback changed data");
        rejects([&] { commands.begin(); });
        // Completion permits release. The unused recording must not retain it.
        storage = {};
        require(device.allocation_bytes() == readback_bytes, "Command recording retained a released buffer");
        commands.reset();
        commands.begin();
        auto upload = device.create_buffer(16, gpu::BufferMemory::Upload);
        rejects([&] { commands.copy(readback, upload, 16); });
        rejects([&] { upload.read_into(std::as_writable_bytes(std::span(result))); });
        rejects([&] { readback.upload(std::as_bytes(std::span(result))); });
        rejects([&] { readback.read_into(std::as_writable_bytes(std::span(result)), 4); });
    }
    require(device.allocation_bytes() == initial, "Destroyed commands retained allocations");
    {
        auto readback = device.create_buffer(4, gpu::BufferMemory::Readback);
        auto storage = device.create_buffer(4);
        auto commands = device.create_commands();
        try {
            commands.begin();
            commands.fill(storage, 91);
            commands.copy(storage, readback, 4);
            commands.end();
            completion = queue.submit(commands, fence);
            throw std::runtime_error("simulated task failure after submission");
        } catch (const std::runtime_error&) {
            // Owners remain in scope until exception cleanup observes completion.
            queue.wait_cpu();
        }
        uint32_t result = 0;
        readback.read_into(std::as_writable_bytes(std::span(&result, 1)));
        require(result == 91, "Caller-owned exception cleanup did not complete the transfer");
    }
    require(device.allocation_bytes() == initial, "Exceptional destruction leaked task resources");
}
void explicit_command_reset(const gpu::ComputeDevice& device) {
    auto& queue = device.default_queue();
    auto fence = device.create_fence();
    auto commands = device.create_commands();
    auto storage = device.create_buffer(8);
    auto readback = device.create_buffer(8, gpu::BufferMemory::Readback);
    commands.begin();
    commands.fill(storage, 13);
    commands.end();
    auto completion = queue.submit(commands, fence);
    queue.wait_cpu(fence, completion);

    // Waiting preserves an executable recording; begin must not discard it.
    rejects([&] { commands.begin(); });
    commands.reset();
    commands.begin();
    commands.fill(storage, 99, 4);
    rejects([&] { commands.begin(); });
    // Discard an unfinished recording without ever executing its writes.
    commands.reset();
    rejects([&] { commands.end(); });
    commands.begin();
    commands.fill(storage, 29, 4, 4);
    commands.copy(storage, readback, 8);
    commands.end();
    completion = queue.submit(commands, fence);
    rejects([&] { commands.reset(); });
    queue.wait_cpu(fence, completion);
    std::array<uint32_t, 2> result {};
    readback.read_into(std::as_writable_bytes(std::span(result)));
    require(result == std::array<uint32_t, 2> { 13, 29 }, "Explicit reset did not discard the previous recording");
}
void pipeline_bindings(const gpu::ComputeDevice& device) {
    auto& queue = device.default_queue();
    auto fence = device.create_fence();
    using enum gpu::BufferMemory;
    const auto expand = device.create_pipeline(shader(shaders::expand));
    const auto compact = device.create_pipeline(shader(shaders::compact));
    const std::array<uint32_t, 3> packed { 0, 0x80000001, 0x40000002 };
    const std::array<uint32_t, 5> parameters { 4, 4, 4, 1, 1 };
    auto upload = device.create_buffer(sizeof(packed), Upload);
    auto blocks = device.create_buffer(sizeof(packed));
    auto dense = device.create_buffer(8);
    auto masks = device.create_buffer(8);
    auto readback = device.create_buffer(8, Readback);
    upload.upload(std::as_bytes(std::span(packed)));
    auto commands = device.create_commands();
    commands.begin();
    commands.copy(upload, blocks, sizeof(packed));
    commands.fill(dense);
    const std::array<gpu::BufferRange, 2> expansion { gpu::BufferRange { &blocks }, { &dense } };
    const std::array<gpu::BufferRange, 2> compaction { gpu::BufferRange { &dense }, { &masks } };
    const auto expansion_table = device.create_descriptor_table(expand, expansion);
    // Layout compatibility is independent of shader code and pipeline identity.
    const auto compaction_table = device.create_descriptor_table(expand, compaction);
    rejects([&] { commands.dispatch({ 1, 1, 1 }); });
    rejects([&] { commands.bind_descriptor_table(expansion_table); });
    commands.bind_pipeline(expand);
    const gpu::DescriptorTable empty_table;
    rejects([&] { commands.bind_descriptor_table(empty_table); });
    rejects([&] { device.create_descriptor_table({}, expansion); });
    rejects([&] { device.create_descriptor_table(expand, std::span(expansion).first(1)); });
    const std::array<gpu::BufferRange, 2> invalid { gpu::BufferRange { &blocks, 0, blocks.size() + 4 }, { &dense } };
    rejects([&] { device.create_descriptor_table(expand, invalid); });
    auto invalid_ranges = expansion;
    invalid_ranges[0] = { &blocks, blocks.size() };
    rejects([&] { device.create_descriptor_table(expand, invalid_ranges); });
    invalid_ranges[0] = {};
    rejects([&] { device.create_descriptor_table(expand, invalid_ranges); });
    for (const auto* buffer : { &upload, &readback }) {
        invalid_ranges[0] = { buffer };
        rejects([&] { device.create_descriptor_table(expand, invalid_ranges); });
    }
    if (device.limits().buffer_offset_alignment > 1) {
        invalid_ranges[0] = { &blocks, 1, 4 };
        rejects([&] { device.create_descriptor_table(expand, invalid_ranges); });
    }
    auto incompatible = shader(shaders::expand);
    incompatible.bindings[0] = gpu::BufferAccess::ReadWrite;
    const auto incompatible_pipeline = device.create_pipeline(incompatible);
    rejects([&] {
        commands.bind_pipeline(incompatible_pipeline);
        commands.bind_descriptor_table(expansion_table);
    });
    commands.bind_pipeline(expand);
    commands.bind_descriptor_table(expansion_table);
    rejects([&] { commands.dispatch({ 1, 1, 1 }); });
    rejects([&] { commands.push_constants(std::as_bytes(std::span(parameters).first(4))); });
    commands.push_constants(std::as_bytes(std::span(parameters)));
    rejects([&] { commands.dispatch({ device.limits().workgroup_count[0] + 1, 1, 1 }); });
    commands.dispatch({ 1, 1, 1 });
    commands.bind_pipeline(compact);
    // No stale descriptors or constants may survive a pipeline switch.
    rejects([&] { commands.dispatch({ 1, 1, 1 }); });
    commands.bind_descriptor_table(compaction_table);
    commands.push_constants(std::as_bytes(std::span(parameters)));
    commands.dispatch({ 1, 1, 1 });
    commands.copy(masks, readback, 8);
    commands.end();
    auto completion = queue.submit(commands, fence);
    queue.wait_cpu(fence, completion);
    std::array<uint32_t, 2> result {};
    readback.read_into(std::as_writable_bytes(std::span(result)));
    require(result == std::array<uint32_t, 2> { packed[1], packed[2] }, "Independent same-name pipelines changed their shader behavior");
    auto invalid_shader = shader(shaders::expand);
    invalid_shader.constants = { { 0, 0 }, { 0, 1 } };
    rejects([&] { device.create_pipeline(invalid_shader); });
    invalid_shader = shader({});
    rejects([&] { device.create_pipeline(invalid_shader); });
    invalid_shader = shader(shaders::expand);
    invalid_shader.push_constant_bytes = 3;
    rejects([&] { device.create_pipeline(invalid_shader); });
    commands.reset();
    commands.begin();
    commands.fill(masks);
    rejects([&] { commands.dispatch({ 1, 1, 1 }); });
    commands.bind_pipeline(compact);
    rejects([&] { commands.dispatch({ 1, 1, 1 }); });
    commands.bind_descriptor_table(compaction_table);
    rejects([&] { commands.dispatch({ 1, 1, 1 }); });
    commands.push_constants(std::as_bytes(std::span(parameters)));
    commands.dispatch({ 1, 1, 1 });
    commands.copy(masks, readback, 8);
    commands.end();
    completion = queue.submit(commands, fence);
    queue.wait_cpu(fence, completion);
    readback.read_into(std::as_writable_bytes(std::span(result)));
    require(result == std::array<uint32_t, 2> { packed[1], packed[2] }, "Command reset invalidated a reusable descriptor table");
    require(device.linear_groups(0, 64) == std::array<uint32_t, 3> { 0, 1, 1 }, "Empty linear dispatch is not empty");
    require(device.linear_groups(65, 64) == std::array<uint32_t, 3> { 2, 1, 1 }, "Linear dispatch hardcodes a shader workgroup size");
    rejects([&] { device.linear_groups(1, 0); });
    rejects([&] { device.linear_groups(device.linear_item_limit(128) + 1, 128); });
}
void descriptor_table_lifetimes(const gpu::ComputeDevice& device) {
    auto& queue = device.default_queue();
    auto fence = device.create_fence();
    const auto pipeline = device.create_pipeline(shader(shaders::expand));
    const std::array<uint32_t, 3> packed { 0, 0x80000001, 0x40000002 };
    const std::array<uint32_t, 5> parameters { 4, 4, 4, 1, 1 };
    const auto initial = device.allocation_bytes();
    {
        auto readback = device.create_buffer(8, gpu::BufferMemory::Readback);
        const auto readback_bytes = device.allocation_bytes();
        auto blocks = device.create_buffer(sizeof(packed));
        auto dense = device.create_buffer(8);
        const std::array<gpu::BufferRange, 2> ranges { gpu::BufferRange { &blocks }, { &dense } };
        auto table = device.create_descriptor_table(pipeline, ranges);
        {
            auto upload = device.create_buffer(sizeof(packed), gpu::BufferMemory::Upload);
            upload.upload(std::as_bytes(std::span(packed)));
            auto initialize = device.create_commands();
            initialize.begin();
            initialize.copy(upload, blocks, sizeof(packed));
            initialize.end();
            const auto value = queue.submit(initialize, fence);
            queue.wait_cpu(fence, value);
        }
        auto commands = device.create_commands();
        commands.begin();
        commands.fill(dense);
        commands.bind_pipeline(pipeline);
        commands.bind_descriptor_table(table);
        commands.push_constants(std::as_bytes(std::span(parameters)));
        commands.dispatch({ 1, 1, 1 });
        commands.copy(dense, readback, 8);
        commands.end();
        const auto value = queue.submit(commands, fence);
        queue.wait_cpu(fence, value);
        std::array<uint32_t, 2> result {};
        readback.read_into(std::as_writable_bytes(std::span(result)));
        require(result == std::array<uint32_t, 2> { packed[1], packed[2] }, "Caller-owned descriptor bindings changed dispatch results");
        // Keep the now-unused table and recording alive while releasing buffers.
        blocks = {};
        dense = {};
        require(device.allocation_bytes() == readback_bytes, "Descriptor table or recording retained a released buffer");
        commands.reset();
    }
    require(device.allocation_bytes() == initial, "Descriptor table lifetime leaked buffer allocations");
}
void timeline_progress(const gpu::ComputeDevice& device) {
    auto& queue = device.default_queue();
    const uint64_t initial = uint64_t(1) << 40;
    auto fence = device.create_fence(initial);
    require(fence.completed_value() == initial, "Fence truncated its 64-bit initial value");
    queue.wait_cpu(fence, initial);
    rejects([&] { queue.wait_cpu(fence, initial + 1); });
    gpu::Fence empty;
    rejects([&] { empty.completed_value(); });
    rejects([&] { queue.wait_cpu(empty, 0); });

    auto storage = device.create_buffer(4);
    auto readback = device.create_buffer(8, gpu::BufferMemory::Readback);
    auto a = device.create_commands();
    a.begin();
    a.fill(storage, 17);
    a.copy(storage, readback, 4);
    a.end();
    auto b = device.create_commands();
    b.begin();
    b.fill(storage, 31);
    b.copy(storage, readback, 4, 0, 4);
    b.end();
    auto unused = device.create_commands();
    unused.begin();
    unused.end();
    const auto first = queue.submit(a, fence);
    auto moved_fence = std::move(fence);
    auto moved_commands = std::move(a);
    require(!fence, "Moving a fence did not transfer unique ownership");
    fence = std::move(moved_fence);
    a = std::move(moved_commands);
    const auto second = queue.submit(b, fence);
    require(first == initial + 1 && second == first + 1, "Moving owners changed pending completion values");
    rejects([&] { queue.submit(b, fence); });
    rejects([&] { queue.wait_cpu(fence, second + 1); });
    queue.wait_cpu(fence, first);
    a.reset();
    queue.wait_cpu(fence, second);
    b.reset();
    require(fence.completed_value() == second, "Shared timeline lost an in-flight submission");
    queue.wait_cpu(fence, first);
    std::array<uint32_t, 2> result {};
    readback.read_into(std::as_writable_bytes(std::span(result)));
    require(result == std::array<uint32_t, 2> { 17, 31 }, "Timeline completion did not preserve submission order");

    a.begin();
    a.fill(storage, 43);
    a.copy(storage, readback, 4);
    a.end();
    const auto third = queue.submit(a, fence);
    require(third == second + 1, "Rejected submission consumed a completion value");
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (fence.completed_value() < third) {
        require(std::chrono::steady_clock::now() < deadline, "Fence polling did not observe GPU completion");
    }
    // Polling is also a completion observation and permits explicit command reset.
    a.reset();
    readback.read_into(std::as_writable_bytes(std::span(result)));
    require(result[0] == 43, "Polled completion did not make the transfer available");

    auto terminal = device.create_fence(UINT64_MAX - 1);
    const auto last = queue.submit(unused, terminal);
    require(last == UINT64_MAX, "Fence increment truncated the final 64-bit value");
    queue.wait_cpu(terminal, last);
    require(terminal.completed_value() == UINT64_MAX, "Fence truncated its final 64-bit value");
    rejects([&] { queue.submit(unused, terminal); });
    require(terminal.completed_value() == UINT64_MAX, "Exhausted fence wrapped its completion value");

    // Exhausting one fence must not poison the recording or another fence.
    auto fresh = device.create_fence();
    const auto next = queue.submit(unused, fresh);
    require(next == 1, "A new fence inherited another fence's counter");
    queue.wait_cpu(fresh, next);
}
void caller_submission_lifetimes() {
    // The caller owns the context outside all commands, fences and resources.
    gpu::DeviceGuard owner;
    const gpu::ComputeDevice device;
    auto readback = device.create_buffer(8, gpu::BufferMemory::Readback);
    {
        auto& queue = device.default_queue();
        auto first = device.create_fence(5);
        auto second = device.create_fence();
        uint64_t first_value = 0, second_value = 0;
        require(first.completed_value() == 5, "Initial fence value was ignored");
        queue.wait_cpu(first, 5);
        {
            auto storage = device.create_buffer(4);
            auto a = device.create_commands();
            a.begin();
            a.fill(storage, 13);
            a.copy(storage, readback, 4);
            a.end();
            auto b = device.create_commands();
            b.begin();
            b.fill(storage, 29);
            b.copy(storage, readback, 4, 0, 4);
            b.end();
            first_value = queue.submit(a, first);
            second_value = queue.submit(b, second);
            queue.wait_cpu(second, second_value);
        }
        require(first_value == 6 && second_value == 1, "Independent fences did not allocate their own completion values");
        require(first.completed_value() == first_value && second.completed_value() == second_value, "Waiting a later fence did not retire earlier submissions");
        std::array<uint32_t, 2> result {};
        readback.read_into(std::as_writable_bytes(std::span(result)));
        require(result == std::array<uint32_t, 2> { 13, 29 }, "Queue submission order changed transfer results");
        {
            auto storage = device.create_buffer(8);
            auto commands = device.create_commands();
            commands.begin();
            commands.fill(storage, 47);
            commands.copy(storage, readback, 8);
            commands.end();
            const auto value = queue.submit(commands, first);
            queue.wait_cpu(first, value);
        }
    }
    std::array<uint32_t, 2> result {};
    readback.read_into(std::as_writable_bytes(std::span(result)));
    require(result == std::array<uint32_t, 2> { 47, 47 }, "Explicit completion did not preserve caller-owned transfer results");
}
void borrowed_device_views(const gpu::ComputeDevice& device) {
    const auto initial = device.allocation_bytes();
    {
        gpu::Buffer storage;
        {
            const auto view = device;
            require(view == device, "Copying a borrowed view changed its context");
            storage = view.create_buffer(4);
        }
        // Destroying a view does not destroy its guard-owned context or buffers.
        auto readback = device.create_buffer(4, gpu::BufferMemory::Readback);
        auto commands = device.create_commands();
        auto fence = device.create_fence();
        commands.begin();
        commands.fill(storage, 71);
        commands.copy(storage, readback, 4);
        commands.end();
        auto& queue = device.default_queue();
        const auto value = queue.submit(commands, fence);
        queue.wait_cpu(fence, value);
        uint32_t result = 0;
        readback.read_into(std::as_writable_bytes(std::span(&result, 1)));
        require(result == 71, "Destroyed device view invalidated a borrowed resource");
    }
    require(device.allocation_bytes() == initial, "Borrowed device view retained task resources");
}
} // namespace
int main() {
    try {
        {
            gpu::DeviceGuard owner;
            const gpu::ComputeDevice device;
            transfers_and_lifetimes(device);
            explicit_command_reset(device);
            pipeline_bindings(device);
            descriptor_table_lifetimes(device);
            timeline_progress(device);
            borrowed_device_views(device);
        }
        // A later top-level scope can recreate the context after full teardown.
        caller_submission_lifetimes();
        std::cout << "Compute HAL queue, fence, resource, binding and caller-owned lifetime contracts passed\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
