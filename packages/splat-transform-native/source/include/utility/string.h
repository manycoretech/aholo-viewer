#pragma once
#include <locale>
#include <string>
#include <utility>

namespace splat_transform::utility {
// File formats and option names use ASCII case; preserve every other code unit.
template<typename Char, typename Traits, typename Allocator>
auto& lower(std::basic_string<Char, Traits, Allocator>& value) {
    const auto& locale = std::locale::classic();
    for (auto& ch : value) {
        if (static_cast<char32_t>(ch) <= 0x7f) {
            ch = static_cast<Char>(std::tolower(static_cast<char>(ch), locale));
        }
    }
    return value;
}

template<typename Char, typename Traits, typename Allocator>
auto lower(const std::basic_string<Char, Traits, Allocator>& value) {
    auto copy = value;
    lower(copy);
    return copy;
}

template<typename Char, typename Traits, typename Allocator>
auto lower(std::basic_string<Char, Traits, Allocator>&& value) {
    lower(value);
    return std::move(value);
}
} // namespace splat_transform::utility
