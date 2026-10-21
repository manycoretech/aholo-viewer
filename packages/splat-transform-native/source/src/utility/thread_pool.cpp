#include <algorithm>
#include <bit>
#include <utility/thread_pool.h>

namespace splat_transform::threading {
namespace {
// Pipeline startup may override this before any CPU work starts.
size_t default_pool_thread_count = std::clamp(std::bit_ceil(std::thread::hardware_concurrency()) / 2u, 1u, 16u);
} // namespace

thread_local ThreadPool::State* ThreadPool::current_state_ = nullptr;

size_t default_thread_count() noexcept {
    return default_pool_thread_count;
}

void configure_default_pool(size_t thread_count) noexcept {
    const auto hardware = std::thread::hardware_concurrency();
    default_pool_thread_count = std::clamp<size_t>(thread_count, 1, hardware > 1 ? hardware - 1 : 1);
}

ThreadPool& default_pool() {
    static ThreadPool pool(default_pool_thread_count);
    return pool;
}

ThreadPool::ThreadPool(size_t thread_count)
    : state_(std::make_unique<State>()) {
    thread_count = std::max(thread_count, size_t(1));
    state_->workers.reserve(thread_count);
    for (size_t i = 0; i < thread_count; ++i) {
        state_->workers.emplace_back(worker_loop, state_.get());
    }
}

ThreadPool::ThreadPool(ThreadPool&& other) noexcept = default;
ThreadPool& ThreadPool::operator=(ThreadPool&& other) noexcept = default;
ThreadPool::~ThreadPool() noexcept = default;

size_t ThreadPool::thread_count() const noexcept {
    return state_ ? state_->workers.size() : 0;
}

bool ThreadPool::owns_current_thread() const noexcept {
    return state_ && current_state_ == state_.get();
}

bool ThreadPool::run_one() {
    Task task;
    {
        auto lock = std::lock_guard(state_->queue_mutex);
        if (state_->stopped.load(std::memory_order_relaxed) || state_->tasks.empty()) {
            return false;
        }
        task = std::move(state_->tasks.front());
        state_->tasks.pop();
    }
    task();
    return true;
}

void ThreadPool::stop() noexcept {
    if (state_) {
        state_->stop();
    }
}

void ThreadPool::State::stop() noexcept {
    if (stopped.exchange(true, std::memory_order_relaxed)) {
        return;
    }
    {
        // Destroy cancelled tasks after unlocking, before joining workers that
        // may be waiting for their futures.
        std::queue<Task> cancelled;
        std::lock_guard lock(queue_mutex);
        cancelled.swap(tasks);
    }
    for (auto& worker : workers) {
        worker.request_stop();
    }
    workers.clear();
}

ThreadPool::State::~State() noexcept {
    stop();
}

void ThreadPool::worker_loop(std::stop_token token, State* state) {
    current_state_ = state;
    while (true) {
        ThreadPool::Task task;
        {
            auto lk = std::unique_lock(state->queue_mutex);
            if (!state->cv.wait(lk, token, [&] { return !state->tasks.empty(); }) || state->stopped.load(std::memory_order_relaxed)) {
                break;
            }
            task = std::move(state->tasks.front());
            state->tasks.pop();
        }
        task();
    }
    current_state_ = nullptr;
}
} // namespace splat_transform::threading
