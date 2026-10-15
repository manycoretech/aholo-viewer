#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>
#include <splat/splat.h>

namespace splat_transform::codec {
inline float signed_log(float value) { return std::copysign(std::log1p(std::abs(value)), value); }
inline float signed_exp(float value) { return std::copysign(std::expm1(std::abs(value)), value); }
inline uint8_t quantize_byte(float value) { return static_cast<uint8_t>(std::clamp(std::floor(value + 0.5f), 0.0f, 255.0f)); }
inline std::array<uint32_t, 2> texture_size(size_t count) {
    auto width = std::max(4u, static_cast<uint32_t>(std::ceil(std::sqrt(float(count)) / 4) * 4));
    const auto rows = (count + width - 1) / width;
    auto height = std::max(4u, static_cast<uint32_t>((rows + 3) / 4 * 4));
    return { width, height };
}
inline std::array<uint8_t, 4> encode_quaternion(const splat::Splat& data, size_t i, bool round) {
    const auto rotation = data.gaussians[i].rotation.normalized();
    const std::array<float, 4> q { rotation.w(), rotation.x(), rotation.y(), rotation.z() };
    size_t largest = 0;
    for (size_t c = 1; c < 4; ++c) {
        if (std::abs(q[c]) > std::abs(q[largest])) {
            largest = c;
        }
    }
    const float sign = q[largest] < 0 ? -1 : 1;
    std::array<uint8_t, 4> output {};
    for (size_t c = 0, target = 0; c < 4; ++c) {
        if (c == largest) {
            continue;
        }
        float value = q[c] * sign * std::sqrt(2.0f);
        value = (value * 0.5f + 0.5f) * 255;
        output[target++] = round ? quantize_byte(value) : static_cast<uint8_t>(std::clamp(value, 0.0f, 255.0f));
    }
    output[3] = static_cast<uint8_t>(252 + largest);
    return output;
}
inline void decode_quaternion(std::span<const uint8_t> bytes, splat::Splat& data, size_t i) {
    constexpr unsigned PERM[4][4] { { 0, 1, 2, 3 }, { 3, 1, 2, 0 }, { 1, 3, 2, 0 }, { 1, 2, 3, 0 } };
    std::array<float, 4> q;
    float sum = 0;
    for (size_t c = 0; c < 3; ++c) {
        q[c] = (bytes[c] / 255.0f - 0.5f) * std::sqrt(2.0f);
        sum += q[c] * q[c];
    }
    q[3] = std::sqrt(std::max(0.0f, 1 - sum));
    if (bytes[3] < 252) {
        throw std::runtime_error("Invalid packed quaternion");
    }
    for (size_t c = 0; c < 4; ++c) {
        data.gaussians[i].attribute(splat::QuatX + c) = q[PERM[bytes[3] - 252][c]];
    }
    data.normalize_rotation(i);
}
inline uint32_t encode_oct_quaternion(const splat::Splat& data, size_t i) {
    float x = data.gaussians[i].attribute(splat::QuatX), y = data.gaussians[i].attribute(splat::QuatY), z = data.gaussians[i].attribute(splat::QuatZ), w = data.gaussians[i].attribute(splat::QuatW);
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
inline void decode_oct_quaternion(uint32_t value, splat::Splat& data, size_t i) {
    float x = (value & 1023) / 1023.0f * 2 - 1;
    float y = ((value >> 10) & 1023) / 1023.0f * 2 - 1;
    const float z = 1 - (std::abs(x) + std::abs(y));
    const float t = std::max(-z, 0.0f);
    x += x >= 0 ? -t : t;
    y += y >= 0 ? -t : t;
    const float length = std::sqrt(x * x + y * y + z * z);
    const float half_angle = ((value >> 20) & 4095) / 4095.0f * std::numbers::pi_v<float> * 0.5f;
    const float scale = std::sin(half_angle) / (length ? length : 1);
    data.gaussians[i].attribute(splat::QuatX) = static_cast<float>(x * scale);
    data.gaussians[i].attribute(splat::QuatY) = static_cast<float>(y * scale);
    data.gaussians[i].attribute(splat::QuatZ) = static_cast<float>(z * scale);
    data.gaussians[i].attribute(splat::QuatW) = std::cos(half_angle);
    data.normalize_rotation(i);
}
} // namespace splat_transform::codec
