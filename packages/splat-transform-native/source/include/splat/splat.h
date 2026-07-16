#pragma once
#include <array>
#include <eigen3/Eigen/Dense>
#include <memory>
#include <vector>

namespace splat {
class SH {
public:
    SH() noexcept;
    SH(size_t size);
    SH(const SH& other);
    SH(SH&& other) noexcept;

    SH& operator=(const SH& other);
    SH& operator=(SH&& other) noexcept;

    void swap(SH& other) noexcept;

    SH& set_zero() noexcept;
    SH& add_multiplied(const SH& other, float scalar) noexcept;

    const float& operator[](size_t index) const;
    float& operator[](size_t index);

    float* data() noexcept;
    size_t size() const noexcept;

    ~SH() noexcept;

private:
    void reset() noexcept;

    size_t size_;
    std::unique_ptr<float[]> ptr;
};

struct Gaussian {
    Eigen::Vector3f mean;
    Eigen::Vector3f scale;
    Eigen::Vector4f rotation;
    Eigen::Matrix3f covariance;
    SH sh;
    float opacity;
    Eigen::AlignedBox3f bounding_box;

    void compute_covariance();
    void decompose_covariance();
    void compute_bounding_box(float k = 3.0f);
    void make_valid();
    bool validate(float opacity_prune = 0.0f) const;
    float area() const;
};

struct Splat {
    std::vector<Gaussian> gaussians;
    Eigen::AlignedBox3f bounding_box;

    void compute_bounding_box();
    void compute_compact_bounding_box();
};
} // namespace splat
