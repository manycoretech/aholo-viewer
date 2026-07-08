#include <functional>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <thread>
#include <thread_pool.h>
#include <utility>

namespace threading {
ThreadPool::ThreadPool(size_t thread_count)
    : state(std::make_unique<State>()) {
    if (thread_count == 0) {
        thread_count = 1;
    }

    this->state->workers.reserve(thread_count);

    for (auto i = 0; i < thread_count; i++) {
        auto worker = std::make_unique<Worker>();
        worker->thread = std::thread(ThreadPool::worker_loop, this->state.get(), worker.get());
        this->state->workers.push_back(std::move(worker));
    }
}

ThreadPool::ThreadPool(ThreadPool&& other) noexcept
    : state(std::move(other.state)) {
}

ThreadPool& ThreadPool::operator=(ThreadPool&& other) noexcept {
    if (this != &other) {
        this->stop();
        this->state = std::move(other.state);
    }
    return *this;
}

size_t ThreadPool::thread_count() const noexcept {
    if (this->state == nullptr) {
        return 0;
    }

    auto lk = std::shared_lock(this->state->worker_mutex);
    return this->state->workers.size();
}

size_t ThreadPool::task_count() const noexcept {
    if (this->state == nullptr) {
        return 0;
    }

    auto lk = std::shared_lock(this->state->queue_mutex);
    return this->state->tasks.size();
}

void ThreadPool::stop() noexcept {
    if (this->state == nullptr) {
        return;
    }

    this->state->stop();
}

ThreadPool::~ThreadPool() noexcept {
    this->stop();
}

void ThreadPool::State::stop() noexcept {
    bool expected = false;
    if (!this->stopped.compare_exchange_strong(expected, true, std::memory_order_relaxed)) {
        return;
    }

    {
        auto lk = std::lock_guard(this->worker_mutex);
        for (auto& worker : this->workers) {
            worker->stop();
        }
    }

    this->cv.notify_all();

    for (auto& worker : this->workers) {
        worker->clean_up();
    }
}

ThreadPool::State::~State() noexcept {
    this->stop();
}

void ThreadPool::Worker::stop() noexcept {
    this->stopped.store(true, std::memory_order_relaxed);
}

void ThreadPool::Worker::clean_up() noexcept {
    this->stop();

    if (this->thread.joinable()) {
        try {
            this->thread.join();
        } catch (...) {
        }
    }
}

ThreadPool::Worker::~Worker() noexcept {
    this->clean_up();
}

void ThreadPool::worker_loop(ThreadPool::State* state, ThreadPool::Worker* worker) {
    while (true) {
        ThreadPool::Task task;
        {
            auto lk = std::unique_lock(state->queue_mutex);
            state->cv.wait(lk, [&]() {
                return state->stopped.load(std::memory_order_relaxed) || worker->stopped.load(std::memory_order_relaxed) || !state->tasks.empty();
            });

            if (state->stopped.load(std::memory_order_relaxed) || worker->stopped.load(std::memory_order_relaxed) || state->tasks.empty()) {
                return;
            }
            task = std::move(state->tasks.front());
            state->tasks.pop();
        }
        task();
    }
}
} // namespace threading
