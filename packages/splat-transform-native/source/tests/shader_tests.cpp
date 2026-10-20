#include "candidate_count.h"
#include "candidate_scatter.h"
#include "cluster.h"
#include "compact.h"
#include "dilate.h"
#include "expand.h"
#include "voxelize.h"
#include <algorithm>
#include <cstring>
#include <gpu/compute.h>
#include <iostream>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace {
using Words = std::span<const uint32_t>;
enum Opcode : uint16_t {
    Extension = 10,
    EntryPoint = 15,
    ExecutionMode = 16,
    Capability = 17,
    TypeInt = 21,
    TypeFloat = 22,
    TypeVector = 23,
    TypeArray = 28,
    TypeRuntimeArray = 29,
    TypeStruct = 30,
    TypePointer = 32,
    Constant = 43,
    Variable = 59,
    Decorate = 71,
    MemberDecorate = 72,
};
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
struct Module {
    std::vector<uint32_t> words;
    std::vector<Words> instructions;
    std::unordered_map<uint32_t, Words> types;
    std::unordered_map<uint32_t, uint32_t> constants;

    explicit Module(std::span<const uint8_t> bytes) : words(bytes.size() / 4) {
        require(bytes.size() % 4 == 0 && words.size() >= 5, "Invalid SPIR-V size");
        std::memcpy(words.data(), bytes.data(), bytes.size());
        require(words[0] == 0x07230203 && words[1] == 0x00010300, "Expected Vulkan 1.1 / SPIR-V 1.3");
        for (size_t offset = 5; offset < words.size();) {
            const size_t count = words[offset] >> 16;
            require(count != 0 && count <= words.size() - offset, "Invalid SPIR-V instruction");
            const auto instruction = Words(words).subspan(offset, count);
            const auto opcode = uint16_t(instruction[0]);
            instructions.push_back(instruction);
            if (opcode >= TypeInt && opcode <= TypePointer) {
                types.emplace(instruction[1], instruction);
            }
            if (opcode == Constant && count == 4) {
                constants.emplace(instruction[2], instruction[3]);
            }
            offset += count;
        }
    }
    uint32_t decoration(uint32_t id, uint32_t kind) const {
        for (const auto instruction : instructions) {
            if (uint16_t(instruction[0]) == Decorate && instruction[1] == id && instruction[2] == kind) {
                return instruction[3];
            }
        }
        throw std::runtime_error("Missing SPIR-V decoration");
    }
    uint32_t size(uint32_t id) const {
        const auto type = types.at(id);
        switch (uint16_t(type[0])) {
        case TypeInt:
        case TypeFloat:
            require(type[2] == 32, "Shader ABI requires 32-bit scalars");
            return 4;
        case TypeVector:
            return size(type[2]) * type[3];
        case TypeArray:
            return size(type[2]) * constants.at(type[3]);
        case TypeStruct: {
            uint32_t bytes = 0;
            for (auto member : type.subspan(2)) {
                bytes += size(member);
            }
            return bytes;
        }
        default:
            throw std::runtime_error("Unexpected shader ABI type");
        }
    }
    void scalar_offsets(uint32_t id) const {
        const auto type = types.at(id);
        require(uint16_t(type[0]) == TypeStruct, "Expected an ABI struct");
        size_t offsets = 0;
        for (const auto instruction : instructions) {
            if (uint16_t(instruction[0]) != MemberDecorate || instruction[1] != id || instruction[3] != 35) {
                continue;
            }
            const auto member = instruction[2];
            require(member < type.size() - 2 && instruction[4] == member * 4, "CPU/shader member offset mismatch");
            require(size(type[member + 2]) == 4, "CPU/shader member width mismatch");
            ++offsets;
        }
        require(offsets == type.size() - 2, "Missing ABI member offsets");
    }
};

void check(std::span<const uint8_t> bytes, Words strides, uint32_t push_size, uint32_t local_size, uint32_t shared_size) {
    const Module module(bytes);
    std::vector<bool> bindings(strides.size());
    uint32_t shared = 0, pushes = 0, entries = 0, local_sizes = 0;
    for (const auto instruction : module.instructions) {
        const auto opcode = uint16_t(instruction[0]);
        require(opcode != Extension, "Shader unexpectedly requires a SPIR-V extension");
        if (opcode == Capability) {
            require(instruction[1] == 1, "Shader unexpectedly requires an optional Vulkan capability");
        }
        if (opcode == EntryPoint) {
            require(instruction[1] == 5, "Expected a compute entry point");
            ++entries;
        }
        if (opcode == ExecutionMode && instruction[2] == 17) {
            require(instruction[3] == local_size && instruction[4] == 1 && instruction[5] == 1, "Workgroup size mismatch");
            ++local_sizes;
        }
        if (opcode != Variable) {
            continue;
        }
        const auto pointer = module.types.at(instruction[1]);
        require(uint16_t(pointer[0]) == TypePointer, "Expected a variable pointer");
        const auto type_id = pointer[3];
        if (instruction[3] == 4) { // Workgroup
            shared += module.size(type_id);
        } else if (instruction[3] == 9) { // PushConstant
            module.scalar_offsets(type_id);
            require(module.size(type_id) == push_size, "Push constant size mismatch");
            ++pushes;
        } else if (instruction[3] == 2 || instruction[3] == 12) { // Uniform / StorageBuffer
            const auto binding = module.decoration(instruction[2], 33);
            require(module.decoration(instruction[2], 34) == 0, "Descriptor set mismatch");
            require(binding < strides.size() && !bindings[binding], "Descriptor binding mismatch");
            const auto block = module.types.at(type_id);
            require(uint16_t(block[0]) == TypeStruct && block.size() == 3, "Expected a storage buffer block");
            const auto array = module.types.at(block[2]);
            require(uint16_t(array[0]) == TypeRuntimeArray, "Expected a runtime storage array");
            require(module.decoration(array[1], 6) == strides[binding], "Storage buffer stride mismatch");
            require(module.size(array[2]) == strides[binding], "Storage buffer element size mismatch");
            if (uint16_t(module.types.at(array[2])[0]) == TypeStruct) {
                module.scalar_offsets(array[2]);
            }
            bindings[binding] = true;
        }
    }
    require(entries == 1 && local_sizes == 1 && pushes == 1, "Missing shader entry, workgroup size, or push constants");
    require(std::ranges::all_of(bindings, [](bool present) { return present; }), "Missing storage buffer binding");
    require(shared == shared_size, "Shared memory no longer matches the device tile budget");
}
} // namespace

int main() {
    using namespace splat_transform::gpu::vulkan::shaders;
    static_assert(sizeof(splat_transform::gpu::Gaussian) == 64);
    static_assert(sizeof(splat_transform::gpu::VoxelBatch) == 32);
    try {
        for (const auto& shader : cluster_variants) {
            check(shader.spirv, std::array { 16u, 16u, 4u, 4u }, 8, 128, shader.tile * (shader.columns * 16 + 4));
        }
        check(candidate_count, std::array { 64u, 4u }, 48, 128, 0);
        check(candidate_scatter, std::array { 64u, 4u, 4u, 4u }, 48, 128, 0);
        check(voxelize, std::array { 64u, 4u, 32u, 4u }, 20, 64, 64 * 64 + 8);
        for (const auto shader : { std::span<const uint8_t>(expand), std::span<const uint8_t>(compact) }) {
            check(shader, std::array { 4u, 4u }, 20, 128, 0);
        }
        check(dilate, std::array { 4u, 4u }, 28, 128, 0);
        std::cout << "All 30 embedded shaders preserve the Vulkan 1.1 storage, push constant, and workgroup ABI\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
