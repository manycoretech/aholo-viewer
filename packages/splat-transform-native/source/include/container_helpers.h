#pragma once
#include <initializer_list>
#include <ranges>
#include <vector>

namespace helpers::container {

template<typename R, typename V>
concept range_of = std::ranges::range<R> && std::same_as<std::ranges::range_value_t<R>, V>;

template<std::ranges::range T, std::ranges::range U>
    requires std::same_as<std::ranges::range_value_t<T>, std::ranges::range_value_t<U>> &&
             requires(T&& dst, U&& src) {
#if __cpp_lib_containers_ranges
                 dst.append_range(std::forward<U>(src));
#else
                 dst.insert(dst.end(), src.begin(), src.end());
#endif
             }
inline void append_range(T&& dst, U&& src) {
#if __cpp_lib_containers_ranges
    dst.append_range(std::forward<U>(src));
#else
    dst.insert(dst.end(), src.begin(), src.end());
#endif
}

template<std::ranges::range T>
    requires requires(T&& dst, std::initializer_list<std::ranges::range_value_t<T>>&& src) {
#if __cpp_lib_containers_ranges
        dst.append_range(std::move(src));
#else
        dst.insert(dst.end(), src.begin(), src.end());
#endif
    }
inline void append_range(T&& dst, std::initializer_list<std::ranges::range_value_t<T>>&& src) {
    append_range<T, std::initializer_list<std::ranges::range_value_t<T>>&&>(std::forward<T>(dst), std::move(src));
}
} // namespace helpers::container
