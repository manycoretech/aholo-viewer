#include <algorithm>
#include <array>
#include <atomic>
#include <barrier>
#include <bit>
#include <codec/codec.h>
#include <iostream>
#include <latch>
#include <pipeline/runner.h>
#include <string_view>
#include <utility/random.h>
#include <utility/thread_pool.h>

using namespace splat_transform;

namespace {
template<typename T, typename F, typename... Args>
concept AcceptsGroupTask = requires(threading::TaskGroup<T>& group, F&& function, Args&&... args) {
    group.submit(std::forward<F>(function), std::forward<Args>(args)...);
};
static_assert(AcceptsGroupTask<int, decltype([](int value) { return value; }), int>);
static_assert(AcceptsGroupTask<void, decltype([] {})>);
static_assert(!AcceptsGroupTask<int, int>);
static_assert(!AcceptsGroupTask<void, decltype([] { return 1; })>);
static_assert(!AcceptsGroupTask<int, decltype([] {})>);
static_assert(!AcceptsGroupTask<int, decltype([](int value) { return value; }), std::string>);
} // namespace

int main(int argc, char** argv) {
    try {
        const auto hardware = std::thread::hardware_concurrency();
        const size_t worker_limit = hardware > 1 ? hardware - 1 : 1;
        size_t expected_workers = std::clamp(std::bit_ceil(hardware) / 2u, 1u, 16u);
        if (threading::default_thread_count() != expected_workers) {
            throw std::runtime_error("Automatic CPU worker count changed");
        }
        // Reject malformed values before any task starts or the shared pool is created.
        for (const auto& value : io::Json::array({ 0, -1, 1.5, true, false, nullptr, "4", io::Json::array(), io::Json::object() })) {
            bool rejected = false;
            try {
                pipeline::run({ { "version", 1 }, { "cpuWorkers", value },
                    { "tasks", io::Json::array({ { { "type", "Read" }, { "config", io::Json::object() } } }) } });
            } catch (const std::runtime_error& error) {
                rejected = std::string_view(error.what()) == "cpuWorkers must be a positive integer";
            }
            if (!rejected) {
                throw std::runtime_error("Invalid cpuWorkers reached task execution");
            }
        }
        if (argc == 2) {
            const auto requested = io::Json::parse(argv[1]);
            expected_workers = size_t(std::min<uint64_t>(requested.get<uint64_t>(), worker_limit));
            pipeline::run({ { "version", 1 }, { "cpuWorkers", requested }, { "tasks", io::Json::array() } });
        }
        std::array<threading::ThreadPool*, 8> instances {};
        std::barrier first_access(instances.size());
        std::atomic<bool> random_isolated { true };
        std::vector<std::thread> callers;
        for (size_t i = 0; i < instances.size(); ++i) {
            callers.emplace_back([&, i] {
                first_access.arrive_and_wait();
                instances[i] = &threading::default_pool();
                auto& engine = utility::default_random();
                auto expected = engine;
                if (&engine != &utility::default_random()) {
                    random_isolated = false;
                }
                first_access.arrive_and_wait();
                for (size_t draw = 0; draw < 1024; ++draw) {
                    if (engine() != expected()) {
                        random_isolated = false;
                    }
                }
            });
        }
        for (auto& caller : callers) {
            caller.join();
        }
        auto& pool = threading::default_pool();
        if (!random_isolated) {
            throw std::runtime_error("Default random engines were reseeded or shared across threads");
        }
        for (const auto* instance : instances) {
            if (instance != &pool) {
                throw std::runtime_error("Concurrent first access created different default pools");
            }
        }
        if (pool.thread_count() != expected_workers || threading::default_thread_count() != expected_workers) {
            throw std::runtime_error("Pipeline cpuWorkers did not configure the shared pool");
        }
        auto owned_task = pool.submit_task([value = std::make_unique<int>(41)]() mutable { return ++*value; });
        if (pool.get(owned_task) != 42) {
            throw std::runtime_error("Move-only task ownership was lost");
        }
        {
            threading::TaskGroup<int> tasks(pool);
            tasks.submit([](std::unique_ptr<int> value) { return *value; }, std::make_unique<int>(42));
            if (tasks.get(0) != 42) {
                throw std::runtime_error("TaskGroup rejected or lost a move-only argument");
            }
        }

        {
            threading::ThreadPool source(1);
            auto pending = source.submit_task([] { return 42; });
            threading::ThreadPool moved(std::move(source));
            if (source.thread_count() || moved.thread_count() != 1 || moved.get(pending) != 42) {
                throw std::runtime_error("Moving a pool lost its worker state or pending result");
            }
            threading::ThreadPool assigned(2);
            assigned = std::move(moved);
            auto result = assigned.submit_task([&] { return assigned.owns_current_thread(); });
            if (moved.thread_count() || assigned.thread_count() != 1 || !assigned.get(result)) {
                throw std::runtime_error("Pool move assignment lost worker ownership");
            }
        }
        {
            threading::ThreadPool stopped_pool(1);
            std::latch started(1), release(1);
            auto running = stopped_pool.submit_task([&] {
                started.count_down();
                release.wait();
                return 7;
            });
            started.wait();
            auto cancelled = stopped_pool.submit_task([] { return 8; });
            std::promise<void> stopped;
            auto stop_completed = stopped.get_future();
            std::jthread stopping([&] {
                stopped_pool.stop();
                stopped.set_value();
            });
            const auto status = cancelled.wait_for(std::chrono::seconds(5));
            const bool returned_early = stop_completed.wait_for(std::chrono::milliseconds(20)) == std::future_status::ready;
            release.count_down();
            stopping.join();
            if (returned_early || status != std::future_status::ready || running.wait_for(std::chrono::seconds(0)) != std::future_status::ready || running.get() != 7) {
                throw std::runtime_error("Stopping did not cancel queued work before joining active tasks");
            }
            bool broken_promise = false;
            try {
                cancelled.get();
            } catch (const std::future_error& error) {
                broken_promise = error.code() == std::make_error_code(std::future_errc::broken_promise);
            }
            if (!broken_promise) {
                throw std::runtime_error("Cancelled task did not report a broken promise");
            }
            bool rejected = false;
            try {
                stopped_pool.submit_task([] {});
            } catch (const std::runtime_error&) {
                rejected = true;
            }
            if (!rejected) {
                throw std::runtime_error("Stopped pool accepted another task");
            }
            stopped_pool.stop();
        }

        {
            threading::ThreadPool nested_pool(2);
            std::barrier occupied(2);
            threading::TaskGroup<int> parents(nested_pool, 2);
            for (int parent = 0; parent < 2; ++parent) {
                parents.submit([&] {
                    occupied.arrive_and_wait();
                    threading::TaskGroup<int> children(nested_pool, 8);
                    for (int value = 0; value < 8; ++value) {
                        children.submit([value] { return value; });
                    }
                    int sum = 0;
                    for (size_t i = 0; i < children.size(); ++i) {
                        sum += children.get(i);
                    }
                    return sum;
                });
            }
            for (size_t i = 0; i < parents.size(); ++i) {
                if (parents.get(i) != 28) {
                    throw std::runtime_error("Nested tasks lost work while the pool was saturated");
                }
            }
        }
        {
            threading::ThreadPool exception_pool(2);
            std::promise<void> release;
            auto released = release.get_future();
            std::atomic<bool> finished = false;
            bool rejected = false;
            try {
                threading::TaskGroup<void> tasks(exception_pool, 2);
                tasks.submit([&] {
                    released.wait();
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                    finished = true;
                });
                tasks.submit([&] {
                    release.set_value();
                    throw std::runtime_error("Task failure");
                });
                tasks.get(1);
            } catch (const std::runtime_error&) {
                rejected = true;
            }
            if (!rejected || !finished) {
                throw std::runtime_error("Task-group failure outlived its captured state");
            }
        }

        // Occupy every default worker with a file-level compression call. gzip
        // submits child jobs to this same pool; zstd shares its native pool.
        const io::Bytes payload(9 * 1024 * 1024 + 117, 42);
        std::barrier compression_started(pool.thread_count());
        threading::TaskGroup<void> files(pool, pool.thread_count());
        for (size_t i = 0; i < pool.thread_count(); ++i) {
            files.submit([&, i] {
                compression_started.arrive_and_wait();
                const auto encoded = i % 2 ? codec::gzip(payload, 6) : codec::zstd_compress(payload, 7);
                const auto decoded = i % 2 ? codec::gunzip(encoded) : codec::zstd_decompress(encoded);
                if (decoded != payload) {
                    throw std::runtime_error("Nested parallel compression changed data");
                }
            });
        }
        for (size_t i = 0; i < files.size(); ++i) {
            files.get(i);
        }
        bool compression_failed = false;
        try {
            codec::gzip(payload, 100);
        } catch (const std::runtime_error&) {
            compression_failed = true;
        }
        if (!compression_failed) {
            throw std::runtime_error("Parallel compression swallowed a worker failure");
        }
        if (&threading::default_pool() != &pool) {
            throw std::runtime_error("Default pool was replaced between operations");
        }
        std::cout << "Global lazy pool, nested scheduling, exception lifetime, and parallel compression passed with " << pool.thread_count() << " workers\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
