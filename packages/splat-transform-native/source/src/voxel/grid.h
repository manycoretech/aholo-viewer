#pragma once
#include "brick_map.h"
#include <Eigen/Core>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <splat/splat.h>
#include <vector>
#include <voxel/voxel.h>

namespace splat_transform::voxel {
class Backend;
inline constexpr std::array<int32_t, 3> BIT_STRIDES { 1, 4, 16 };
constexpr uint64_t face_mask(int32_t axis, int32_t coordinate) {
    uint64_t result = 0;
    for (int32_t i = 0; i < 64; ++i) {
        if ((i / BIT_STRIDES[axis]) % 4 == coordinate) {
            result |= uint64_t { 1 } << i;
        }
    }
    return result;
}

class Grid {
public:
    Eigen::Vector3i size = Eigen::Vector3i::Zero();
    Eigen::Vector3i blocks = Eigen::Vector3i::Zero();
    using Storage = BrickMap<16>;
    Storage masks;
    explicit Grid(Eigen::Vector3i dimensions = { 4, 4, 4 });
    uint32_t block_index(Eigen::Vector3i point) const;
    Eigen::Vector3i block_point(uint32_t index) const;
    uint64_t block_count() const;
    bool contains(Eigen::Vector3i p) const { return (p.array() >= 0).all() && (p.array() < this->size.array()).all(); }
    uint64_t mask(uint32_t index) const;
    void set_mask(uint32_t index, uint64_t value);
    void or_mask(Eigen::Vector3i block, uint64_t value);
    bool get(Eigen::Vector3i p) const {
        return this->contains(p) &&
               ((this->masks.get(p / 4) >> ((p.x() & 3) + 4 * (p.y() & 3) + 16 * (p.z() & 3))) & 1);
    }
    void set(Eigen::Vector3i point);
    Grid inverted() const;
    Grid crop(Eigen::Vector3i minimum, Eigen::Vector3i maximum, bool invert = false) const;
    std::optional<std::array<Eigen::Vector3i, 2>> extent(bool navigable = false) const;
    uint64_t voxel_count() const;
    std::vector<uint32_t> active_blocks() const;
};

struct Occupancy {
    Grid grid;
    Eigen::AlignedBox3f bounds;
    GridSpec spec;
};

Grid unite(const Grid& left, const Grid& right);
Grid flood(const Grid& allowed, const std::vector<Eigen::Vector3i>& seeds, bool boundary = false);
std::optional<Eigen::Vector3i> nearest_cell(const Grid& allowed, Eigen::Vector3i seed, int32_t radius);
Grid filter_blocks(const Grid& grid);
void crop_grid(Grid& grid, Eigen::AlignedBox3f& bounds, float resolution, bool navigable, int32_t margin);
void navigate(
    Grid& grid, Eigen::AlignedBox3f& bounds, float resolution, const Navigation& options, const Backend& backend
);
struct Mesh {
    std::vector<float> positions;
    std::vector<uint32_t> indices;
};
Mesh voxel_faces(const Grid& grid, const Eigen::AlignedBox3f& bounds, float resolution);
Mesh marching_cubes(const Grid& grid, const Eigen::AlignedBox3f& bounds, float resolution);
Mesh merge_coplanar(const Mesh& mesh, float resolution);
std::vector<std::byte> encode_glb(const Mesh& mesh);
} // namespace splat_transform::voxel
