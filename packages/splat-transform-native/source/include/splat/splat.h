#pragma once
#include <Eigen/Dense>
#include <Eigen/Geometry>
#include <array>
#include <cstdint>
#include <memory>
#include <span>
#include <type_traits>
#include <variant>
#include <vector>

namespace splat_transform::splat {
inline constexpr float SH_C0 = 0.28209479177387814f;
inline constexpr std::array<size_t, 4> SH_COUNTS { 0, 9, 24, 45 };
enum Attribute : size_t {
    X,
    Y,
    Z,
    ScaleX,
    ScaleY,
    ScaleZ,
    QuatX,
    QuatY,
    QuatZ,
    QuatW,
    Red,
    Green,
    Blue,
    Alpha,
    ShOffset
};

class ShCoefficients {
public:
    ShCoefficients() noexcept;
    explicit ShCoefficients(size_t size);
    ShCoefficients(const ShCoefficients& other);
    ShCoefficients(ShCoefficients&& other) noexcept;

    ShCoefficients& operator=(const ShCoefficients& other);
    ShCoefficients& operator=(ShCoefficients&& other) noexcept;

    void swap(ShCoefficients& other) noexcept;
    void resize(size_t size);

    ShCoefficients& set_zero() noexcept;
    ShCoefficients& add_multiplied(const ShCoefficients& other, float scalar) noexcept;

    const float& operator[](size_t index) const { return data()[index]; }
    float& operator[](size_t index) { return data()[index]; }

    float* data() noexcept {
        if (auto* heap = std::get_if<Heap>(&storage_)) {
            return heap->get();
        }
        return std::get<Inline>(storage_).data();
    }
    const float* data() const noexcept {
        if (const auto* heap = std::get_if<Heap>(&storage_)) {
            return heap->get();
        }
        return std::get<Inline>(storage_).data();
    }
    size_t size() const noexcept { return size_; }

    ~ShCoefficients() noexcept;

private:
    using Inline = std::array<float, 3>;
    using Heap = std::unique_ptr<float[]>;
    size_t size_ = 0;
    std::variant<Inline, Heap> storage_ { Inline {} };
};

struct Gaussian {
    Eigen::Vector3f mean = Eigen::Vector3f::Zero();
    Eigen::Vector3f scale = Eigen::Vector3f::Zero();
    float opacity = 0;
    Eigen::Quaternionf rotation { 0, 0, 0, 0 };
    ShCoefficients sh;

    float& attribute(size_t index) { return field(*this, index); }
    const float& attribute(size_t index) const { return field(*this, index); }
    void normalize_rotation();
    Eigen::Matrix3f covariance() const;
    void set_covariance(const Eigen::Matrix3f& covariance);
    Eigen::AlignedBox3f bounding_box(float k = 3.0f) const;
    void make_valid();
    bool validate(float opacity_prune = 0.0f) const;
    float area() const;

private:
    template<typename T>
    static std::conditional_t<std::is_const_v<T>, const float&, float&> field(T& point, size_t index) {
        if (index < ScaleX) {
            return point.mean[index];
        }
        if (index < QuatX) {
            return point.scale[index - ScaleX];
        }
        if (index < Red) {
            return point.rotation.coeffs()[index - QuatX];
        }
        if (index < Alpha) {
            return point.sh[index - Red];
        }
        if (index == Alpha) {
            return point.opacity;
        }
        return point.sh[index - ShOffset + 3];
    }
};

struct Splat {
    std::vector<Gaussian> gaussians;
    Eigen::AlignedBox3f bounding_box;
    unsigned sh_degree = 0;
    std::vector<size_t> block_offsets;
    std::vector<size_t> block_counts;

    Splat() = default;
    Splat(size_t count, unsigned sh_degree);
    size_t size() const noexcept { return gaussians.size(); }
    size_t sh_count() const { return SH_COUNTS.at(sh_degree); }
    size_t attribute_count() const { return ShOffset + sh_count(); }
    void normalize_rotation(size_t index) { gaussians.at(index).normalize_rotation(); }
    void limit_sh_degree(unsigned maximum);
    Splat select(std::span<const uint32_t> indices) const&;
    Splat select(std::span<const uint32_t> indices) &&;
    void prepare_lod();

    void compute_bounding_box();
    void compute_compact_bounding_box();
};

struct Bounds {
    std::array<float, 3> min {};
    std::array<float, 3> max {};
};
Splat combine(std::vector<Splat>&& source, bool minimum_sh = false);
Bounds bounds(const Splat& splat);
Bounds dense_bounds(const Splat& splat, float ratio = 0.98f);
std::vector<uint32_t> morton_order(const Splat& splat);
} // namespace splat_transform::splat
