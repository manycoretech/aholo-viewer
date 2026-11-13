#pragma once
#include <Eigen/Geometry>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <span>
#include <stdexcept>

namespace splat_transform::codec {
inline float signed_log(float value) { return std::copysign(std::log1p(std::abs(value)), value); }
inline float signed_exp(float value) { return std::copysign(std::expm1(std::abs(value)), value); }
inline std::byte quantize_byte(float value) { return static_cast<std::byte>(std::clamp(std::floor(value + 0.5f), 0.0f, 255.0f)); }
inline std::array<uint32_t, 2> texture_size(size_t count) {
    auto width = std::max(4u, static_cast<uint32_t>(std::ceil(std::sqrt(float(count)) / 4) * 4));
    const auto rows = (count + width - 1) / width;
    auto height = std::max(4u, static_cast<uint32_t>((rows + 3) / 4 * 4));
    return { width, height };
}
inline std::array<std::byte, 4> encode_quaternion(const Eigen::Quaternionf& quaternion, bool round) {
    const std::array<float, 4> q { quaternion.w(), quaternion.x(), quaternion.y(), quaternion.z() };
    size_t largest = 0;
    for (size_t c = 1; c < 4; ++c) {
        if (std::abs(q[c]) > std::abs(q[largest])) {
            largest = c;
        }
    }
    const float sign = q[largest] < 0 ? -1 : 1;
    std::array<std::byte, 4> output {};
    for (size_t c = 0, target = 0; c < 4; ++c) {
        if (c == largest) {
            continue;
        }
        float value = q[c] * sign * std::sqrt(2.0f);
        value = (value * 0.5f + 0.5f) * 255;
        output[target++] = round ? quantize_byte(value) : static_cast<std::byte>(std::clamp(value, 0.0f, 255.0f));
    }
    output[3] = static_cast<std::byte>(252 + largest);
    return output;
}
inline Eigen::Quaternionf decode_quaternion(std::span<const std::byte> bytes) {
    constexpr uint32_t PERM[4][4] { { 0, 1, 2, 3 }, { 3, 1, 2, 0 }, { 1, 3, 2, 0 }, { 1, 2, 3, 0 } };
    std::array<float, 4> q;
    float sum = 0;
    for (size_t c = 0; c < 3; ++c) {
        q[c] = (std::to_integer<uint8_t>(bytes[c]) / 255.0f - 0.5f) * std::sqrt(2.0f);
        sum += q[c] * q[c];
    }
    q[3] = std::sqrt(std::max(0.0f, 1 - sum));
    const auto tag = std::to_integer<uint8_t>(bytes[3]);
    if (tag < 252) {
        throw std::runtime_error("Invalid packed quaternion");
    }
    const auto& permutation = PERM[tag - 252];
    return Eigen::Quaternionf(q[permutation[3]], q[permutation[0]], q[permutation[1]], q[permutation[2]]);
}
inline std::array<std::byte, 3> encode_exp_quaternion(const Eigen::Quaternionf& quaternion) {
    auto rotation = quaternion;
    const float length = rotation.norm();
    if (!(length > 0) || !std::isfinite(length)) {
        return { std::byte { 128 }, std::byte { 128 }, std::byte { 128 } };
    }
    rotation.coeffs() *= (rotation.w() < 0 ? -1.0f : 1.0f) / length;
    const float radius = rotation.vec().norm();
    const float scale = radius > 1e-12f ? std::atan2(radius, rotation.w()) / radius * 2 / std::numbers::pi_v<float> : 2 / std::numbers::pi_v<float>;
    return { quantize_byte(rotation.x() * scale * 127 + 128), quantize_byte(rotation.y() * scale * 127 + 128), quantize_byte(rotation.z() * scale * 127 + 128) };
}
inline Eigen::Quaternionf decode_exp_quaternion(std::span<const std::byte> bytes) {
    const Eigen::Vector3f point((std::to_integer<int32_t>(bytes[0]) - 128) / 127.0f,
        (std::to_integer<int32_t>(bytes[1]) - 128) / 127.0f, (std::to_integer<int32_t>(bytes[2]) - 128) / 127.0f);
    const float radius = point.norm();
    const float angle = radius * std::numbers::pi_v<float> / 2;
    const float scale = radius > 1e-12f ? std::sin(angle) / radius : std::numbers::pi_v<float> / 2;
    return Eigen::Quaternionf(std::cos(angle), point.x() * scale, point.y() * scale, point.z() * scale);
}
inline std::byte encode_sog_opacity(float opacity) {
    return opacity > 0 ? quantize_byte(std::sqrt(opacity) * 204) : std::byte { 0 };
}
inline float decode_sog_opacity(std::byte value) {
    const float opacity = std::to_integer<uint8_t>(value) / 204.0f;
    return opacity * opacity;
}
inline uint32_t encode_oct_quaternion(const Eigen::Quaternionf& quaternion) {
    float x = quaternion.x(), y = quaternion.y(), z = quaternion.z(), w = quaternion.w();
    if (w < 0) {
        x = -x;
        y = -y;
        z = -z;
        w = -w;
    }
    const float angle = 2 * std::acos(std::clamp(w, -1.0f, 1.0f)) / std::numbers::pi_v<float>;
    const float length = std::sqrt(x * x + y * y + z * z);
    if (length < 1e-6f) {
        x = 1;
        y = z = 0;
    } else {
        x /= length;
        y /= length;
        z /= length;
    }
    const float sum = std::abs(x) + std::abs(y) + std::abs(z);
    float u = x / sum, v = y / sum;
    if (z < 0) {
        const float previous = u;
        u = (1 - std::abs(v)) * (u >= 0 ? 1 : -1);
        v = (1 - std::abs(previous)) * (v >= 0 ? 1 : -1);
    }
    return uint32_t(std::clamp((u * 0.5f + 0.5f) * 1023, 0.0f, 1023.0f)) |
           (uint32_t(std::clamp((v * 0.5f + 0.5f) * 1023, 0.0f, 1023.0f)) << 10) |
           (uint32_t(std::clamp(angle * 4095, 0.0f, 4095.0f)) << 20);
}
inline Eigen::Quaternionf decode_oct_quaternion(uint32_t value) {
    float x = (value & 1023) / 1023.0f * 2 - 1;
    float y = ((value >> 10) & 1023) / 1023.0f * 2 - 1;
    const float z = 1 - (std::abs(x) + std::abs(y));
    const float t = std::max(-z, 0.0f);
    x += x >= 0 ? -t : t;
    y += y >= 0 ? -t : t;
    const float length = std::sqrt(x * x + y * y + z * z);
    const float half_angle = ((value >> 20) & 4095) / 4095.0f * std::numbers::pi_v<float> * 0.5f;
    const float scale = std::sin(half_angle) / (length ? length : 1);
    return Eigen::Quaternionf(std::cos(half_angle), x * scale, y * scale, z * scale);
}
} // namespace splat_transform::codec
