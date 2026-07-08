#pragma once
#include <atomic>
#include <concepts>
#include <condition_variable>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <queue>
#include <shared_mutex>
#include <stdexcept>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

namespace threading {
class ThreadPool {
public:
    ThreadPool(size_t thread_count = std::thread::hardware_concurrency());
    ThreadPool(ThreadPool&& other) noexcept;

    template<typename F, typename... Args,
        typename ReturnType = std::invoke_result_t<std::decay_t<F>, std::decay_t<Args>...>>
        requires std::invocable<std::decay_t<F>, std::decay_t<Args>...>
    std::future<ReturnType> submit_task(F&& f, Args&&... args);
    size_t thread_count() const noexcept;
    size_t task_count() const noexcept;
    ThreadPool& operator=(ThreadPool&& other) noexcept;
    void stop() noexcept;
    ~ThreadPool() noexcept;

    ThreadPool(const ThreadPool& other) = delete;
    ThreadPool& operator=(const ThreadPool& other) = delete;

private:
#ifdef __cpp_lib_move_only_function
    using Task = std::move_only_function<void()>;
#else
    using Task = std::function<void()>;
#endif

    struct Worker {
        std::atomic<bool> stopped { false };
        std::thread thread;

        void stop() noexcept;
        void clean_up() noexcept;
        ~Worker() noexcept;
    };

    struct State {
        std::vector<std::unique_ptr<Worker>> workers;
        std::queue<Task> tasks;
        mutable std::shared_mutex queue_mutex;
        mutable std::shared_mutex worker_mutex;
        std::condition_variable_any cv;
        std::atomic<bool> stopped { false };

        void stop() noexcept;
        ~State() noexcept;
    };

    static void worker_loop(State* state, Worker* worker);

    std::unique_ptr<State> state;
};

template<typename F, typename... Args, typename ReturnType>
    requires std::invocable<std::decay_t<F>, std::decay_t<Args>...>
std::future<ReturnType> ThreadPool::submit_task(F&& f, Args&&... args) {
    auto* state = this->state.get();
    if (state == nullptr || state->stopped.load(std::memory_order_relaxed)) {
        throw std::runtime_error("Cannot submit tasks to stopped thread pool");
    }
#ifdef __cpp_lib_move_only_function
    auto promise = std::promise<ReturnType>();
    auto future = promise.get_future();
    {
        auto lk = std::lock_guard(state->queue_mutex);
        if (state->stopped.load(std::memory_order_relaxed)) {
            throw std::runtime_error("Cannot submit tasks to stopped thread pool");
        }
        state->tasks.emplace([f = std::forward<F>(f), ... args = std::forward<Args>(args), promise = std::move(promise)]() mutable noexcept -> void {
            try {
                if constexpr (std::is_void_v<ReturnType>) {
                    std::invoke(std::move(f), std::move(args)...);
                    promise.set_value();
                } else {
                    promise.set_value(std::invoke(std::move(f), std::move(args)...));
                }
            } catch (...) {
                promise.set_exception(std::current_exception());
            }
        });
    }
#else
    auto promise = std::make_shared<std::promise<ReturnType>>();
    auto future = promise->get_future();
    {
        auto lk = std::lock_guard(state->queue_mutex);
        if (state->stopped.load(std::memory_order_relaxed)) {
            throw std::runtime_error("Cannot submit tasks to stopped thread pool");
        }
        state->tasks.emplace([f = std::forward<F>(f), ... args = std::forward<Args>(args), promise = promise]() noexcept -> void {
            try {
                if constexpr (std::is_void_v<ReturnType>) {
                    std::invoke(std::move(f), std::move(args)...);
                    promise->set_value();
                } else {
                    promise->set_value(std::invoke(std::move(f), std::move(args)...));
                }
            } catch (...) {
                promise->set_exception(std::current_exception());
            }
        });
    }
#endif
    state->cv.notify_one();
    return future;
}
} // namespace threading
