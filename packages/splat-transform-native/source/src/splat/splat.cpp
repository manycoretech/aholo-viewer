#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstring>
#include <eigen3/Eigen/Dense>
#include <numbers>
#include <splat/splat.h>
#include <stdexcept>
#include <tuple>
#include <utility>

namespace splat {
SH::SH() noexcept : size_(0), ptr(nullptr) {
}

SH::SH(size_t size) : size_(size), ptr(size > 0 ? std::make_unique<float[]>(size) : nullptr) {
}

SH::SH(const SH& other) : size_(other.size_), ptr(other.size_ > 0 ? std::make_unique<float[]>(other.size_) : nullptr) {
    if (this->ptr != nullptr) {
        std::copy(other.ptr.get(), other.ptr.get() + this->size_, this->ptr.get());
    }
}

SH::SH(SH&& other) noexcept : size_(std::exchange(other.size_, 0)),
                              ptr(std::exchange(other.ptr, nullptr)) {
}

SH& SH::operator=(const SH& other) {
    if (this != &other) {
        this->reset();
        if (other.size_ > 0) {
            this->ptr = std::make_unique<float[]>(other.size_);
            std::copy(other.ptr.get(), other.ptr.get() + other.size_, this->ptr.get());
        }
        this->size_ = other.size_;
    }
    return *this;
}

SH& SH::operator=(SH&& other) noexcept {
    if (this != &other) {
        this->size_ = std::exchange(other.size_, 0);
        this->ptr = std::exchange(other.ptr, nullptr);
    }
    return *this;
}

void SH::swap(SH& other) noexcept {
    std::swap(this->ptr, other.ptr);
    std::swap(this->size_, other.size_);
}

SH& SH::set_zero() noexcept {
    if (this->ptr) {
        std::memset(this->ptr.get(), 0, sizeof(float) * this->size_);
    }

    return *this;
}

SH& SH::add_multiplied(const SH& other, float scalar) noexcept {
    assert(other.size_ == this->size_);

    for (auto i = 0; i < this->size_; i++) {
        this->ptr[i] += other.ptr[i] * scalar;
    }

    return *this;
}

const float& SH::operator[](size_t index) const {
    return this->ptr[index];
}

float& SH::operator[](size_t index) {
    return this->ptr[index];
}

void SH::reset() noexcept {
    this->ptr.reset();
    this->size_ = 0;
}

float* SH::data() noexcept {
    return this->ptr.get();
}

size_t SH::size() const noexcept {
    return this->size_;
}

SH::~SH() noexcept {
}

void Gaussian::compute_bounding_box(float k) {
    auto sigma = this->scale.cwiseAbs();
    this->bounding_box = Eigen::AlignedBox3f(this->mean - k * sigma, this->mean + k * sigma);
}

void Gaussian::compute_covariance() {
    Eigen::Matrix3f s = Eigen::Matrix3f::Identity();

    s(0, 0) = this->scale.x();
    s(1, 1) = this->scale.y();
    s(2, 2) = this->scale.z();

    auto r = Eigen::Matrix3f(Eigen::Quaternionf(this->rotation));

    Eigen::Matrix3f t = r * s;

    this->covariance = t * t.transpose();
}

void Gaussian::decompose_covariance() {
    auto matrix = this->covariance;
    Eigen::SelfAdjointEigenSolver<Eigen::Matrix3f> eigen_solver(matrix);
    auto eigen_values = eigen_solver.eigenvalues();
    auto eigen_vectors = eigen_solver.eigenvectors();

    if (eigen_values.hasNaN()) {
        throw std::runtime_error("Found Nans in covariance decomposing!");
    }

    int loops = 0;
    while (eigen_values[0] == 0 || eigen_values[1] == 0 || eigen_values[2] == 0) {
        matrix(0, 0) += std::max(matrix(0, 0) * 0.0001f, std::numeric_limits<float>::epsilon());
        matrix(1, 1) += std::max(matrix(1, 1) * 0.0001f, std::numeric_limits<float>::epsilon());
        matrix(2, 2) += std::max(matrix(2, 2) * 0.0001f, std::numeric_limits<float>::epsilon());

        Eigen::SelfAdjointEigenSolver<Eigen::Matrix3f> eigen_solver2(matrix);
        eigen_values = eigen_solver2.eigenvalues();
        eigen_vectors = eigen_solver2.eigenvectors();

        loops++;
    }

    auto v1 = eigen_vectors.col(0);
    auto v2 = eigen_vectors.col(1);
    auto v3 = eigen_vectors.col(2);

    auto test = v1.cross(v2);

    if (test.dot(v3) < 0) {
        eigen_vectors.col(2) *= -1;
    }

    float a = std::sqrt(std::abs(eigen_values.x()));
    float b = std::sqrt(std::abs(eigen_values.y()));
    float c = std::sqrt(std::abs(eigen_values.z()));

    this->scale = { a, b, c };
    auto q = Eigen::Quaternionf(eigen_vectors);
    this->rotation = { q.x(), q.y(), q.z(), q.w() };
    this->rotation.normalize();
}

float Gaussian::area() const {
    constexpr float P = 1.6075f;
    auto numerator = std::pow(this->scale.x() * this->scale.y(), P) + std::pow(this->scale.x() * this->scale.z(), P) +
                     std::pow(this->scale.y() * this->scale.z(), P);
    return 4.0f * std::numbers::pi_v<float> * std::pow(numerator / 3.0f, 1.0f / P);
}

bool Gaussian::validate(float opacity_prune) const {
    return this->scale.allFinite() &&
           this->scale.cwiseGreater(0.0f).all() &&
           std::isfinite(this->opacity) &&
           this->opacity >= opacity_prune;
}

void Gaussian::make_valid() {
    if (!this->scale.allFinite() || !this->scale.cwiseGreater(0.0f).all()) {
        this->scale = Eigen::Vector3f(
            std::numeric_limits<float>::epsilon(),
            std::numeric_limits<float>::epsilon(),
            std::numeric_limits<float>::epsilon());
    }
    if (!std::isfinite(this->opacity)) {
        this->opacity = 0.0f;
    }
}

void Splat::compute_bounding_box() {
    this->bounding_box = Eigen::AlignedBox3f();
    for (auto& gaussian : this->gaussians) {
        this->bounding_box.extend(gaussian.bounding_box);
    }
}

void Splat::compute_compact_bounding_box() {
    this->bounding_box = Eigen::AlignedBox3f();
    auto ref = std::vector<std::tuple<size_t, float>>();
    ref.reserve(this->gaussians.size());
    for (auto i = 0; i < this->gaussians.size(); i++) {
        ref.emplace_back(i, this->gaussians[i].area());
    }
    std::sort(ref.begin(), ref.end(), [](auto& a, auto& b) -> bool { return std::get<1>(a) < std::get<1>(b); });
    auto needed = static_cast<size_t>(static_cast<double>(this->gaussians.size()) * 0.95);
    if (needed == 0) {
        needed = this->gaussians.size();
    }
    for (auto i = 0; i < needed; i++) {
        this->bounding_box.extend(this->gaussians[std::get<0>(ref[i])].bounding_box);
    }
}
} // namespace splat
