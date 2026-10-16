#include <Eigen/Dense>
#include <algorithm>
#include <cassert>
#include <cmath>
#include <numbers>
#include <numeric>
#include <ranges>
#include <splat/splat.h>
#include <stdexcept>
#include <utility>

namespace splat_transform::splat {
ShCoefficients::ShCoefficients() noexcept = default;

ShCoefficients::ShCoefficients(size_t size) : size_(size) {
    if (size > 3) {
        storage_.emplace<Heap>(std::make_unique<float[]>(size));
    }
}

ShCoefficients::ShCoefficients(const ShCoefficients& other) : ShCoefficients(other.size_) {
    std::copy_n(other.data(), size_, data());
}

ShCoefficients::ShCoefficients(ShCoefficients&& other) noexcept : size_(std::exchange(other.size_, 0)), storage_(std::move(other.storage_)) {
    other.storage_.emplace<Inline>();
}

ShCoefficients& ShCoefficients::operator=(const ShCoefficients& other) {
    if (this != &other) {
        ShCoefficients copy(other);
        swap(copy);
    }
    return *this;
}

ShCoefficients& ShCoefficients::operator=(ShCoefficients&& other) noexcept {
    if (this != &other) {
        size_ = std::exchange(other.size_, 0);
        storage_ = std::move(other.storage_);
        other.storage_.emplace<Inline>();
    }
    return *this;
}

void ShCoefficients::swap(ShCoefficients& other) noexcept {
    std::swap(size_, other.size_);
    storage_.swap(other.storage_);
}

void ShCoefficients::resize(size_t size) {
    if (size == size_) {
        return;
    }
    ShCoefficients replacement(size);
    std::copy_n(data(), std::min(size_, size), replacement.data());
    swap(replacement);
}

ShCoefficients& ShCoefficients::set_zero() noexcept {
    std::fill_n(data(), size_, 0.0f);
    return *this;
}

ShCoefficients& ShCoefficients::add_multiplied(const ShCoefficients& other, float scalar) noexcept {
    assert(other.size_ == size_);
    auto* values = data();
    const auto* input = other.data();
    for (size_t i = 0; i < size_; ++i) {
        values[i] += input[i] * scalar;
    }
    return *this;
}

ShCoefficients::~ShCoefficients() noexcept = default;

void Gaussian::normalize_rotation() {
    rotation.normalize();
    if (rotation.w() < 0) {
        rotation.coeffs() *= -1;
    }
}

Eigen::AlignedBox3f Gaussian::bounding_box(float k) const {
    auto sigma = this->scale.cwiseAbs();
    return Eigen::AlignedBox3f(this->mean - k * sigma, this->mean + k * sigma);
}

Eigen::Matrix3f Gaussian::covariance() const {
    Eigen::Matrix3f s = Eigen::Matrix3f::Identity();

    s(0, 0) = this->scale.x();
    s(1, 1) = this->scale.y();
    s(2, 2) = this->scale.z();

    auto r = this->rotation.toRotationMatrix();

    Eigen::Matrix3f t = r * s;

    return t * t.transpose();
}

void Gaussian::set_covariance(const Eigen::Matrix3f& covariance) {
    auto matrix = covariance;
    Eigen::SelfAdjointEigenSolver<Eigen::Matrix3f> eigen_solver(matrix);
    auto eigen_values = eigen_solver.eigenvalues();
    auto eigen_vectors = eigen_solver.eigenvectors();

    if (eigen_values.hasNaN()) {
        throw std::runtime_error("Found Nans in covariance decomposing!");
    }

    while (eigen_values[0] == 0 || eigen_values[1] == 0 || eigen_values[2] == 0) {
        matrix(0, 0) += std::max(matrix(0, 0) * 0.0001f, std::numeric_limits<float>::epsilon());
        matrix(1, 1) += std::max(matrix(1, 1) * 0.0001f, std::numeric_limits<float>::epsilon());
        matrix(2, 2) += std::max(matrix(2, 2) * 0.0001f, std::numeric_limits<float>::epsilon());

        Eigen::SelfAdjointEigenSolver<Eigen::Matrix3f> eigen_solver2(matrix);
        eigen_values = eigen_solver2.eigenvalues();
        eigen_vectors = eigen_solver2.eigenvectors();
    }

    auto v1 = eigen_vectors.col(0);
    auto v2 = eigen_vectors.col(1);
    auto v3 = eigen_vectors.col(2);

    auto orientation = v1.cross(v2);

    if (orientation.dot(v3) < 0) {
        eigen_vectors.col(2) *= -1;
    }

    float a = std::sqrt(std::abs(eigen_values.x()));
    float b = std::sqrt(std::abs(eigen_values.y()));
    float c = std::sqrt(std::abs(eigen_values.z()));

    this->scale = { a, b, c };
    this->rotation = Eigen::Quaternionf(eigen_vectors);
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

Splat::Splat(size_t count, unsigned degree) : sh_degree(degree) {
    if (degree > 3 || count > std::numeric_limits<uint32_t>::max()) {
        throw std::runtime_error("Unsupported splat size or SH degree");
    }
    gaussians.resize(count);
    for (auto& gaussian : gaussians) {
        gaussian.sh = ShCoefficients(sh_count() + 3);
    }
}

void Splat::limit_sh_degree(unsigned maximum) {
    const auto degree = std::min(sh_degree, std::min(maximum, 3u));
    if (degree == sh_degree) {
        return;
    }
    for (auto& gaussian : gaussians) {
        gaussian.sh.resize(SH_COUNTS[degree] + 3);
    }
    sh_degree = degree;
}

Splat Splat::select(std::span<const uint32_t> indices) const& {
    Splat output;
    output.sh_degree = sh_degree;
    output.gaussians.reserve(indices.size());
    for (auto index : indices) {
        output.gaussians.push_back(gaussians.at(index));
    }
    return output;
}

Splat Splat::select(std::span<const uint32_t> indices) && {
    if (std::adjacent_find(indices.begin(), indices.end(), std::greater_equal<uint32_t>()) != indices.end()) {
        return std::as_const(*this).select(indices);
    }
    if (!indices.empty() && indices.back() >= size()) {
        throw std::out_of_range("Splat selection index out of range");
    }
    for (size_t i = 0; i < indices.size(); ++i) {
        if (i != indices[i]) {
            gaussians[i] = std::move(gaussians[indices[i]]);
        }
    }
    gaussians.resize(indices.size());
    block_offsets.clear();
    block_counts.clear();
    bounding_box = Eigen::AlignedBox3f();
    return std::move(*this);
}

void Splat::prepare_lod() {
    for (auto& gaussian : gaussians) {
        gaussian.rotation.normalize();
        gaussian.make_valid();
    }
    compute_bounding_box();
}

Splat combine(std::vector<Splat>&& source, bool minimum_sh) {
    unsigned degree = minimum_sh ? 3 : 0;
    size_t count = 0;
    for (const auto& part : source) {
        if (part.size() > std::numeric_limits<uint32_t>::max() - count) {
            throw std::runtime_error("Combined splat count exceeds the supported range");
        }
        count += part.size();
        degree = minimum_sh ? std::min(degree, part.sh_degree) : std::max(degree, part.sh_degree);
    }
    Splat output;
    output.sh_degree = source.empty() ? 0 : degree;
    output.gaussians.reserve(count);
    for (auto& part : source) {
        output.block_offsets.push_back(output.size());
        output.block_counts.push_back(part.size());
        for (auto& gaussian : part.gaussians) {
            gaussian.sh.resize(output.sh_count() + 3);
            output.gaussians.push_back(std::move(gaussian));
        }
        std::vector<Gaussian>().swap(part.gaussians);
    }
    return output;
}

void Splat::compute_bounding_box() {
    this->bounding_box = Eigen::AlignedBox3f();
    for (auto& gaussian : this->gaussians) {
        this->bounding_box.extend(gaussian.bounding_box());
    }
}

void Splat::compute_compact_bounding_box() {
    this->bounding_box = Eigen::AlignedBox3f();
    std::vector<std::pair<size_t, float>> ref;
    ref.reserve(this->gaussians.size());
    for (size_t i = 0; i < this->gaussians.size(); ++i) {
        ref.emplace_back(i, this->gaussians[i].area());
    }
    std::ranges::sort(ref, {}, &std::pair<size_t, float>::second);
    auto needed = static_cast<size_t>(static_cast<float>(this->gaussians.size()) * 0.95f);
    if (needed == 0) {
        needed = this->gaussians.size();
    }
    for (size_t i = 0; i < needed; ++i) {
        this->bounding_box.extend(this->gaussians[ref[i].first].bounding_box());
    }
}
namespace {
template<typename Indices>
Eigen::AlignedBox3f center_bounds(const Splat& data, const Indices& indices) {
    // Empty center bounds historically serialize as two zero vectors.
    Eigen::AlignedBox3f result(Eigen::Vector3f::Zero(), Eigen::Vector3f::Zero());
    if (std::ranges::empty(indices)) {
        return result;
    }
    result.min().setConstant(std::numeric_limits<float>::infinity());
    result.max() = -result.min();
    for (auto index : indices) {
        const auto& mean = data.gaussians[index].mean;
        // Match the previous std::min/max accumulator: ignore a NaN input.
        result.min() = result.min().cwiseMin<Eigen::PropagateNumbers>(mean);
        result.max() = result.max().cwiseMax<Eigen::PropagateNumbers>(mean);
    }
    return result;
}
} // namespace
Eigen::AlignedBox3f bounds(const Splat& data) {
    return center_bounds(data, std::views::iota(size_t { 0 }, data.size()));
}
Eigen::AlignedBox3f bounds(const Splat& data, std::span<const uint32_t> indices) {
    return center_bounds(data, indices);
}
Eigen::AlignedBox3f dense_bounds(const Splat& data, float ratio) {
    auto result = bounds(data);
    if (!data.size() || ratio >= 1) {
        return result;
    }
    constexpr int BIN_COUNT = 65535;
    std::array<std::vector<uint32_t>, 3> bins;
    Eigen::Vector3f scale;
    std::array<int, 3> start { 0, 0, 0 }, end { BIN_COUNT - 1, BIN_COUNT - 1, BIN_COUNT - 1 };
    for (size_t axis = 0; axis < 3; ++axis) {
        bins[axis].resize(BIN_COUNT, 0);
        scale[axis] = BIN_COUNT / std::max(result.max()[axis] - result.min()[axis], 1e-9f);
        for (const auto& gaussian : data.gaussians) {
            const float value = gaussian.mean[axis];
            const auto index = static_cast<int>((value - result.min()[axis]) * scale[axis]);
            // The original typed array does not count a point in the upper endpoint bin.
            if (index >= 0 && index < BIN_COUNT) {
                ++bins[axis][index];
            }
        }
    }
    int64_t remaining = static_cast<int64_t>(data.size());
    const auto limit = static_cast<int64_t>(std::ceil(data.size() * (1 - ratio)));
    while (remaining > limit) {
        uint32_t minimum = std::numeric_limits<uint32_t>::max();
        int selected = -1;
        for (int side = 0; side < 6; ++side) {
            int axis = side / 2;
            if (start[axis] > end[axis]) {
                continue;
            }
            uint32_t count = bins[axis][side % 2 ? end[axis] : start[axis]];
            if (count < minimum) {
                minimum = count;
                selected = side;
            }
        }
        if (selected < 0) {
            break;
        }
        if (selected % 2) {
            --end[selected / 2];
        } else {
            ++start[selected / 2];
        }
        remaining -= minimum;
    }
    for (size_t axis = 0; axis < 3; ++axis) {
        result.max()[axis] = end[axis] / scale[axis] + result.min()[axis];
        result.min()[axis] += start[axis] / scale[axis];
    }
    return result;
}
namespace {
uint32_t interleave(uint32_t x) {
    x &= 0x3ff;
    x = (x ^ (x << 16)) & 0xff0000ff;
    x = (x ^ (x << 8)) & 0x0300f00f;
    x = (x ^ (x << 4)) & 0x030c30c3;
    return (x ^ (x << 2)) & 0x09249249;
}
} // namespace
std::vector<uint32_t> morton_order(const Splat& data) {
    std::vector<uint32_t> indices(data.size());
    std::iota(indices.begin(), indices.end(), 0);
    const auto sort = [&](auto&& self, std::span<uint32_t> slice) -> void {
        if (slice.size() < 2) {
            return;
        }
        const auto box = bounds(data, slice);
        const auto& min = box.min();
        const auto& max = box.max();
        Eigen::Vector3f scale;
        for (size_t axis = 0; axis < 3; ++axis) {
            if (!std::isfinite(max[axis] - min[axis])) {
                return;
            }
            scale[axis] = max[axis] == min[axis] ? 0 : 1024 / (max[axis] - min[axis]);
        }
        if (scale[0] == 0 && scale[1] == 0 && scale[2] == 0) {
            return;
        }
        std::vector<std::pair<uint32_t, uint32_t>> codes;
        codes.reserve(slice.size());
        for (uint32_t i : slice) {
            uint32_t code = 0;
            for (size_t axis = 0; axis < 3; ++axis) {
                code |= interleave(static_cast<uint32_t>(std::clamp((data.gaussians[i].attribute(axis) - min[axis]) * scale[axis], 0.0f, 1023.0f))) << axis;
            }
            codes.emplace_back(code, i);
        }
        std::ranges::stable_sort(codes, {}, &std::pair<uint32_t, uint32_t>::first);
        std::ranges::transform(codes, slice.begin(), &std::pair<uint32_t, uint32_t>::second);
        for (size_t start = 0; start < codes.size();) {
            size_t end = start + 1;
            while (end < codes.size() && codes[end].first == codes[start].first) {
                ++end;
            }
            if (end - start > 256 && end - start < codes.size()) {
                self(self, slice.subspan(start, end - start));
            }
            start = end;
        }
    };
    sort(sort, indices);
    return indices;
}
} // namespace splat_transform::splat
