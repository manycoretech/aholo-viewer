#include <cmath>
#include <iostream>
#include <limits>
#include <pipeline/lod_support.h>
#include <spatial/sh_rotation.h>
#include <voxel/voxelize.h>

using namespace splat_transform;
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
void center_bounds() {
    const auto empty = splat::bounds(splat::Splat());
    require(empty.min().isZero(0) && empty.max().isZero(0), "Empty center bounds must remain the origin");
    require(io::bounds_json(empty).dump() == "{\"min\":[0.0,0.0,0.0],\"max\":[0.0,0.0,0.0]}", "Bounds JSON changed its array schema");
    const auto lod = pipeline::generate({}, io::Json::array({ { { "precision", 1 } } }), 1, splat::block::SplitNormal::None);
    require(lod.blocks.size() == 1 && lod.blocks[0].bounds.min().isZero(0) && lod.blocks[0].bounds.max().isZero(0), "Empty LOD metadata must keep zero bounds");
    splat::Splat data(5, 0);
    data.gaussians[0].mean = { -2, 3, 7 };
    data.gaussians[1].mean = { 4, -1, 5 };
    data.gaussians[2].mean = { 0, 2, -3 };
    data.gaussians[3].mean = { 100, 100, 100 };
    data.gaussians[4].mean = { -1, 1, 2 };
    const auto all = splat::bounds(data);
    require(all.min() == Eigen::Vector3f(-2, -1, -3) && all.max() == Eigen::Vector3f::Constant(100), "Center bounds lost an extremum");
    const std::array<uint32_t, 3> indices { 4, 1, 4 };
    const auto subset = splat::bounds(data, indices);
    require(subset.min() == Eigen::Vector3f(-1, -1, 2) && subset.max() == Eigen::Vector3f(4, 1, 5), "Subset bounds include an unselected point");
    const auto none = splat::bounds(data, {});
    require(none.min().isZero(0) && none.max().isZero(0), "Empty subset bounds must remain the origin");
    require(splat::dense_bounds(data, 1).min() == all.min() && splat::dense_bounds(data, 1).max() == all.max(), "Full-density bounds changed");
    data.gaussians[3].mean.setConstant(std::numeric_limits<float>::quiet_NaN());
    const auto finite = splat::bounds(data);
    require(finite.min() == Eigen::Vector3f(-2, -1, -3) && finite.max() == Eigen::Vector3f(4, 3, 7), "NaN centers changed min/max accumulation");
    data.gaussians[0].mean.x() = -std::numeric_limits<float>::infinity();
    data.gaussians[1].mean.x() = std::numeric_limits<float>::infinity();
    require(std::isinf(splat::bounds(data).min().x()) && std::isinf(splat::bounds(data).max().x()), "Infinite center bounds were narrowed");
    require(splat::morton_order(data) == std::vector<uint32_t> { 0, 1, 2, 3, 4 }, "Nonfinite Morton ranges must preserve input order");
    splat::Splat ties(4, 0);
    ties.gaussians[0].mean.x() = 1;
    ties.gaussians[2].mean.x() = 1;
    require(splat::morton_order(ties) == std::vector<uint32_t> { 1, 3, 0, 2 }, "Morton ties lost stable input order");
}
void gaussian_bounds() {
    splat::Gaussian point;
    point.mean = { 5, -3, 2 };
    point.scale = { -1, 2, -3 };
    point.rotation.setIdentity();
    const auto identity = point.bounding_box();
    require(identity.min() == point.mean - Eigen::Vector3f(3, 6, 9) && identity.max() == point.mean + Eigen::Vector3f(3, 6, 9),
        "Identity Gaussian bounds must use absolute scales and the default three-sigma extent");

    const float pi = std::acos(-1.0f);
    point.rotation = Eigen::Quaternionf(Eigen::AngleAxisf(pi / 2, Eigen::Vector3f::UnitZ()));
    const auto quarter_turn = point.bounding_box();
    require(quarter_turn.min().isApprox(point.mean - Eigen::Vector3f(6, 3, 9), 1e-6f) &&
                quarter_turn.max().isApprox(point.mean + Eigen::Vector3f(6, 3, 9), 1e-6f),
        "Quarter-turn Gaussian bounds must swap the X and Y extents");

    point.rotation = Eigen::Quaternionf(Eigen::AngleAxisf(pi / 4, Eigen::Vector3f::UnitZ()));
    const Eigen::Vector3f expected_extent(2 * std::sqrt(2.5f), 2 * std::sqrt(2.5f), 6);
    const auto oblique = point.bounding_box(2);
    require(oblique.min().isApprox(point.mean - expected_extent, 1e-6f) && oblique.max().isApprox(point.mean + expected_extent, 1e-6f),
        "Oblique Gaussian bounds must tightly enclose the ellipsoid, not its rotated local box");
    const auto zero = point.bounding_box(0);
    require(zero.min() == point.mean && zero.max() == point.mean, "Zero-sigma bounds must collapse to the Gaussian center");

    point.scale.setConstant(2);
    point.rotation = Eigen::Quaternionf(Eigen::AngleAxisf(0.73f, Eigen::Vector3f(1, 2, 3).normalized()));
    const auto sphere = point.bounding_box();
    require(sphere.min().isApprox(point.mean - Eigen::Vector3f::Constant(6), 1e-6f) &&
                sphere.max().isApprox(point.mean + Eigen::Vector3f::Constant(6), 1e-6f),
        "Isotropic Gaussian bounds must not expand under rotation");
}
void compact_block_bounds() {
    for (const auto normal : { splat::block::SplitNormal::None, splat::block::SplitNormal::Y }) {
        splat::Splat input(40, 0);
        for (size_t i = 0; i < input.size(); ++i) {
            auto& point = input.gaussians[i];
            point.mean = { i < 20 ? -20.0f : 20.0f, 0, 0 };
            point.scale = { 0.1f, 0.2f, 0.05f };
            point.rotation = Eigen::Quaternionf(Eigen::AngleAxisf(std::acos(-1.0f) / 4, Eigen::Vector3f::UnitZ()));
            point.opacity = 1;
        }
        // Each leaf keeps all twenty Gaussians, but its bounds exclude the largest one.
        input.gaussians[0].scale = { 2, 1, 0.5f };
        input.gaussians[20].scale = { 2, 1, 0.5f };
        input.prepare_lod();
        const auto blocks = splat::block::split(std::move(input), 0.5f, normal);
        require(blocks.size() == 2, "Separated Gaussian clusters must form two blocks");
        for (const auto& block : blocks) {
            require(block.size() == 20, "Block splitting changed the cluster membership");
            const auto& center = block.gaussians.front().mean;
            const Eigen::Vector3f expected_extent(3 * std::sqrt(0.025f), 3 * std::sqrt(0.025f), 0.15f);
            require(block.bounding_box.min().isApprox(center - expected_extent, 1e-6f) &&
                        block.bounding_box.max().isApprox(center + expected_extent, 1e-6f),
                "Compact block bounds must use the rotated extents of the retained ninety-five percent");
            size_t outside = 0;
            for (const auto& point : block.gaussians) {
                outside += !block.bounding_box.contains(point.bounding_box());
            }
            require(outside == 1, "The largest Gaussian must remain in the block without expanding its compact bounds");
        }
    }
}
void voxel_geometry() {
    splat::Gaussian point;
    point.scale = { 1, 2, 3 };
    point.opacity = 1;
    point.rotation.setIdentity();
    require(voxel::extents(point) == Eigen::Vector3f(3, 6, 9), "Identity voxel extents changed");
    point.rotation = Eigen::Quaternionf(Eigen::AngleAxisf(float(std::acos(-1.0) / 2), Eigen::Vector3f::UnitZ()));
    require(voxel::extents(point).isApprox(Eigen::Vector3f(6, 3, 9), 1e-6f), "Voxel extents lost the rotation");
    point.opacity = voxel::ALPHA_THRESHOLD;
    point.scale.x() = std::numeric_limits<float>::infinity();
    require(voxel::extents(point).isZero(0), "Opacity threshold must precede extent arithmetic");
    splat::Splat invalid(1, 0);
    invalid.gaussians[0] = point;
    invalid.gaussians[0].opacity = 1;
    const auto prepared = voxel::prepare(invalid);
    require(prepared.invalid_extents.size() == 1 && prepared.scene.isEmpty(), "Invalid voxel extents changed the scene bounds");
    require(prepared.gaussians[0].values[11] == 0 && prepared.gaussians[0].values[12] == 0 && prepared.gaussians[0].values[13] == 0, "Invalid extents must be packed as zero");

    voxel::Gaussian packed;
    packed.values[4] = point.rotation.w();
    packed.values[5] = point.rotation.x();
    packed.values[6] = point.rotation.y();
    packed.values[7] = point.rotation.z();
    packed.values[8] = 1;
    packed.values[9] = 2;
    packed.values[10] = 3;
    require(std::abs(voxel::distance_squared(packed, { 4, 3, 6 }) - 17) < 1e-5f, "Packed wxyz rotation changed the Gaussian distance");
    packed.values[4] = packed.values[5] = packed.values[6] = packed.values[7] = 0;
    require(std::abs(voxel::distance_squared(packed, { 1, 2, 3 }) - 3) < 1e-6f, "Zero quaternion distance convention changed");
    packed.values[8] = -1;
    packed.values[9] = 0;
    packed.values[10] = 1e-10f;
    require(std::abs(voxel::distance_squared(packed, Eigen::Vector3f::Constant(1e-8f)) - 3) < 1e-6f, "Distance scale floor changed");
    packed.values[8] = std::numeric_limits<float>::quiet_NaN();
    require(std::isnan(voxel::distance_squared(packed, Eigen::Vector3f::Ones())), "Distance no longer propagates a NaN scale");
}
void voxel_selection() {
    for (unsigned degree = 0; degree <= 3; ++degree) {
        splat::Splat source(12, degree);
        for (size_t i = 0; i < source.size(); ++i) {
            auto& point = source.gaussians[i];
            point.mean = { float(i), float(i % 3), -float(i) };
            point.scale = { 0.1f, 0.2f, 0.3f };
            point.rotation.setIdentity();
            point.opacity = 0.8f;
            for (size_t j = 0; j < point.sh.size(); ++j) {
                point.sh[j] = float(i * 100 + j);
            }
        }
        for (const auto i : { 0, 3, 5, 7, 11 }) {
            source.gaussians[i].scale.x() = std::numeric_limits<float>::infinity();
        }
        source.gaussians[10].opacity = voxel::ALPHA_THRESHOLD;
        const auto original = source;
        for (const std::vector<uint32_t> indices : { std::vector<uint32_t> {}, { 0, 3, 5, 7, 11 }, { 1, 2, 4, 6, 8, 9, 10 }, { 0, 2, 3, 4, 7, 10, 11 } }) {
            auto actual = voxel::prepare(source);
            const auto* allocation = actual.gaussians.data();
            const auto expected = voxel::prepare(source.select(indices));
            actual.select(indices);
            require(actual.gaussians.data() == allocation, "Voxel selection must reuse its geometry allocation");
            require(actual.gaussians.size() == expected.gaussians.size() && actual.invalid_extents == expected.invalid_extents,
                "Voxel selection lost indices or invalid-extent accounting");
            require(actual.scene.min() == expected.scene.min() && actual.scene.max() == expected.scene.max(), "Voxel selection changed scene bounds");
            for (size_t i = 0; i < actual.gaussians.size(); ++i) {
                require(actual.gaussians[i].values == expected.gaussians[i].values, "Voxel selection changed packed geometry or input order");
            }
            // Repeated compaction must also remap the sparse invalid indices.
            if (actual.gaussians.size() > 2) {
                const std::array<uint32_t, 2> subset { 1, 2 };
                actual.select(subset);
                const auto twice = voxel::prepare(source.select(indices).select(subset));
                require(actual.invalid_extents == twice.invalid_extents && actual.scene.min() == twice.scene.min() && actual.scene.max() == twice.scene.max(),
                    "Repeated voxel selection changed invalid-extent bounds");
            }
        }
        for (size_t i = 0; i < source.size(); ++i) {
            require(source.gaussians[i].mean == original.gaussians[i].mean, "Voxel selection mutated shared input positions");
            for (size_t j = 0; j < source.gaussians[i].sh.size(); ++j) {
                require(source.gaussians[i].sh[j] == original.gaussians[i].sh[j], "Voxel selection mutated shared SH coefficients");
            }
        }
    }
}
void sh_rotation() {
    const Eigen::Matrix3f rotation = Eigen::AngleAxisf(0.73f, Eigen::Vector3f(1, 2, 3).normalized()).toRotationMatrix();
    const spatial::ShRotation forward(rotation), backward(rotation.transpose()), identity(Eigen::Matrix3f::Identity());
    for (unsigned degree = 0; degree <= 3; ++degree) {
        splat::ShCoefficients original(3 + splat::SH_COUNTS[degree]);
        for (size_t i = 0; i < original.size(); ++i) {
            original[i] = float(std::sin(double(i) * 0.73)) * 0.3f;
        }
        auto actual = original;
        identity.apply(actual);
        for (size_t i = 0; i < actual.size(); ++i) {
            require(std::abs(actual[i] - original[i]) < 2e-6f, "Identity SH rotation changed a coefficient");
        }
        forward.apply(actual);
        for (size_t c = 0; c < 3; ++c) {
            require(actual[c] == original[c], "SH rotation changed the DC channels");
            for (unsigned band = 1; band <= degree; ++band) {
                double before = 0, after = 0;
                for (unsigned i = band * band; i < (band + 1) * (band + 1); ++i) {
                    before += double(original[i * 3 + c]) * original[i * 3 + c];
                    after += double(actual[i * 3 + c]) * actual[i * 3 + c];
                }
                require(std::abs(before - after) < 2e-5 * (1 + before), "SH rotation changed band energy or RGB order");
            }
        }
        backward.apply(actual);
        for (size_t i = 0; i < actual.size(); ++i) {
            require(std::abs(actual[i] - original[i]) < 2e-5f, "In-place SH inverse rotation lost coefficients");
        }
    }
    splat::ShCoefficients exceptional(48);
    exceptional.set_zero();
    exceptional[3] = std::numeric_limits<float>::quiet_NaN();
    identity.apply(exceptional);
    for (size_t i = 1; i < 16; ++i) {
        require(std::isnan(exceptional[i * 3]) && exceptional[i * 3 + 1] == 0 && exceptional[i * 3 + 2] == 0, "SH nonfinite propagation changed channel or band behavior");
    }
}
float area(const voxel::Mesh& mesh) {
    float result = 0;
    for (size_t i = 0; i < mesh.indices.size(); i += 3) {
        const Eigen::Map<const Eigen::Vector3f> a(mesh.positions.data() + mesh.indices[i] * 3);
        const Eigen::Map<const Eigen::Vector3f> b(mesh.positions.data() + mesh.indices[i + 1] * 3);
        const Eigen::Map<const Eigen::Vector3f> c(mesh.positions.data() + mesh.indices[i + 2] * 3);
        result += (b - a).cross(c - a).norm() * 0.5f;
    }
    return result;
}
void coplanar_mesh() {
    voxel::Mesh mesh { { 0, 0, 0, -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0 }, { 0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1 } };
    for (const bool tilted : { false, true }) {
        if (tilted) {
            const Eigen::Quaternionf rotation(Eigen::AngleAxisf(0.49f, Eigen::Vector3f(2, 3, 1).normalized()));
            for (size_t i = 0; i < mesh.positions.size(); i += 3) {
                Eigen::Map<Eigen::Vector3f> point(mesh.positions.data() + i);
                point = rotation * point + Eigen::Vector3f(3, -2, 1);
            }
        }
        const auto simplified = voxel::merge_coplanar(mesh, 0.05f);
        require(simplified.positions.size() == 12 && simplified.indices.size() == 6, "Coplanar merge did not remove the interior vertex");
        require(std::abs(area(simplified) - area(mesh)) < 1e-5f, "Coplanar merge changed the projected polygon");
    }
}
} // namespace
int main() {
    try {
        center_bounds();
        gaussian_bounds();
        compact_block_bounds();
        voxel_geometry();
        voxel_selection();
        sh_rotation();
        coplanar_mesh();
        std::cout << "Geometry contracts passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
