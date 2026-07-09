#pragma once
#include <concepts>
#include <cstddef>
#include <exception>
#include <functional>
#include <future>
#include <ranges>
#include <type_traits>

namespace helpers::future {
namespace detail {
template<typename T>
struct future_value;

template<typename T>
struct future_value<std::future<T>> {
    using type = T;
};

template<typename T>
concept future_range = std::ranges::range<T> && requires {
    typename future_value<std::ranges::range_value_t<std::remove_cvref_t<T>>>::type;
};

template<future_range T>
using future_range_value_t = future_value<std::ranges::range_value_t<std::remove_cvref_t<T>>>::type;
} // namespace detail

struct FailurePolicyDrainAll;
// Stops draining after the first observed failure. This does not cancel remaining
// work; use only when unfinished tasks do not depend on this stack frame.
struct FailurePolicyStopOnFirstFailure;

template<typename T>
concept future_failure_policy = std::same_as<T, FailurePolicyDrainAll> || std::same_as<T, FailurePolicyStopOnFirstFailure>;

template<future_failure_policy P = FailurePolicyDrainAll, detail::future_range T>
    requires std::same_as<detail::future_range_value_t<T>, void>
void drain_futures(T&& futures) {
    std::exception_ptr first_exception;
    for (auto& future : futures) {
        try {
            future.get();
        } catch (...) {
            if (!first_exception) {
                first_exception = std::current_exception();
            }

            if constexpr (std::is_same_v<P, FailurePolicyStopOnFirstFailure>) {
                break;
            }
        }
    }

    if (first_exception) {
        std::rethrow_exception(first_exception);
    }
}

template<future_failure_policy P = FailurePolicyDrainAll, detail::future_range T, typename F>
    requires std::same_as<detail::future_range_value_t<T>, void> &&
             std::invocable<F&, size_t>
void drain_futures(T&& futures, F&& f) {
    std::exception_ptr first_exception;
    size_t index = 0;
    for (auto& future : futures) {
        try {
            future.get();
            std::invoke(f, index);
        } catch (...) {
            if (!first_exception) {
                first_exception = std::current_exception();
            }

            if constexpr (std::is_same_v<P, FailurePolicyStopOnFirstFailure>) {
                break;
            }
        }
        index++;
    }

    if (first_exception) {
        std::rethrow_exception(first_exception);
    }
}

template<future_failure_policy P = FailurePolicyDrainAll, detail::future_range T, typename F>
    requires(!std::same_as<detail::future_range_value_t<T>, void>) &&
            std::invocable<F&, detail::future_range_value_t<T>&&>
void drain_futures(T&& futures, F&& f) {
    std::exception_ptr first_exception;
    for (auto& future : futures) {
        try {
            std::invoke(f, future.get());
        } catch (...) {
            if (!first_exception) {
                first_exception = std::current_exception();
            }
            if constexpr (std::is_same_v<P, FailurePolicyStopOnFirstFailure>) {
                break;
            }
        }
    }

    if (first_exception) {
        std::rethrow_exception(first_exception);
    }
}

template<future_failure_policy P = FailurePolicyDrainAll, detail::future_range T, typename F>
    requires(!std::same_as<detail::future_range_value_t<T>, void>) &&
            std::invocable<F&, detail::future_range_value_t<T>&&, size_t>
void drain_futures(T&& futures, F&& f) {
    std::exception_ptr first_exception;
    size_t index = 0;
    for (auto& future : futures) {
        try {
            std::invoke(f, future.get(), index);
        } catch (...) {
            if (!first_exception) {
                first_exception = std::current_exception();
            }

            if constexpr (std::is_same_v<P, FailurePolicyStopOnFirstFailure>) {
                break;
            }
        }
        index++;
    }

    if (first_exception) {
        std::rethrow_exception(first_exception);
    }
}
} // namespace helpers::future
