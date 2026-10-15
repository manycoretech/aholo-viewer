#pragma once
#include <atomic>
#include <chrono>
#include <concepts>
#include <condition_variable>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <queue>
#include <stdexcept>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

namespace splat_transform::threading {
size_t default_thread_count() noexcept;
class ThreadPool {
public:
    ThreadPool(size_t thread_count = default_thread_count());
    ThreadPool(ThreadPool&& other) noexcept;

    template<typename F, typename... Args,
        typename ReturnType = std::invoke_result_t<std::decay_t<F>, std::decay_t<Args>...>>
        requires std::invocable<std::decay_t<F>, std::decay_t<Args>...>
    std::future<ReturnType> submit_task(F&& f, Args&&... args);
    size_t thread_count() const noexcept;
    bool owns_current_thread() const noexcept;
    template<typename T>
    void wait(std::future<T>& future);
    template<typename T>
    T get(std::future<T>& future);
    ThreadPool& operator=(ThreadPool&& other) noexcept;
    void stop() noexcept;
    ~ThreadPool() noexcept;

    ThreadPool(const ThreadPool& other) = delete;
    ThreadPool& operator=(const ThreadPool& other) = delete;

private:
    using Task = std::function<void()>;

    struct State {
        std::queue<Task> tasks;
        std::mutex queue_mutex;
        std::condition_variable_any cv;
        std::atomic<bool> stopped { false };
        std::vector<std::jthread> workers;

        void stop() noexcept;
        ~State() noexcept;
    };

    static void worker_loop(std::stop_token token, State* state);
    bool run_one();
    static thread_local State* current_state_;

    std::unique_ptr<State> state_;
};

// C++ initializes this process-wide pool on the first call, including concurrent calls.
ThreadPool& default_pool();

template<typename T>
void ThreadPool::wait(std::future<T>& future) {
    if (!owns_current_thread()) {
        future.wait();
        return;
    }
    // A worker waiting on child work helps the same queue. This avoids starving
    // nested compression jobs when every worker is already writing a file.
    for (;;) {
        const auto status = future.wait_for(std::chrono::seconds(0));
        if (status == std::future_status::ready) {
            return;
        }
        if (status == std::future_status::deferred) {
            future.wait();
            return;
        }
        if (!run_one()) {
            future.wait_for(std::chrono::milliseconds(1));
        }
    }
}

template<typename T>
T ThreadPool::get(std::future<T>& future) {
    wait(future);
    return future.get();
}

// Waits for submitted tasks during exception unwinding as well as normal returns,
// so task captures cannot outlive their caller's input buffers and local state.
template<typename T>
class TaskGroup {
public:
    explicit TaskGroup(ThreadPool& pool, size_t capacity = 0) : pool_(pool) { futures_.reserve(capacity); }
    ~TaskGroup() {
        for (auto& future : futures_) {
            if (future.valid()) {
                pool_.wait(future);
            }
        }
    }
    TaskGroup(const TaskGroup&) = delete;
    TaskGroup& operator=(const TaskGroup&) = delete;
    template<typename F, typename... Args>
        requires std::invocable<std::decay_t<F>, std::decay_t<Args>...> &&
                 std::same_as<std::invoke_result_t<std::decay_t<F>, std::decay_t<Args>...>, T>
    void submit(F&& function, Args&&... args) {
        auto future = pool_.submit_task(std::forward<F>(function), std::forward<Args>(args)...);
        try {
            futures_.push_back(std::move(future));
        } catch (...) {
            if (future.valid()) {
                pool_.wait(future);
            }
            throw;
        }
    }
    size_t size() const noexcept { return futures_.size(); }
    T get(size_t index) { return pool_.get(futures_.at(index)); }

private:
    ThreadPool& pool_;
    std::vector<std::future<T>> futures_;
};

template<typename F, typename... Args, typename ReturnType>
    requires std::invocable<std::decay_t<F>, std::decay_t<Args>...>
std::future<ReturnType> ThreadPool::submit_task(F&& f, Args&&... args) {
    auto* state = this->state_.get();
    if (state == nullptr || state->stopped.load(std::memory_order_relaxed)) {
        throw std::runtime_error("Cannot submit tasks to stopped thread pool");
    }
    auto task = std::make_shared<std::packaged_task<ReturnType()>>(
        [function = std::forward<F>(f), ... arguments = std::forward<Args>(args)]() mutable -> ReturnType {
            return std::invoke(std::move(function), std::move(arguments)...);
        });
    auto future = task->get_future();
    {
        auto lock = std::lock_guard(state->queue_mutex);
        if (state->stopped.load(std::memory_order_relaxed)) {
            throw std::runtime_error("Cannot submit tasks to stopped thread pool");
        }
        state->tasks.emplace([task = std::move(task)] { (*task)(); });
    }
    state->cv.notify_one();
    return future;
}
} // namespace splat_transform::threading
