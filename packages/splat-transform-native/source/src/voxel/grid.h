#pragma once
#include <Eigen/Core>
#include <array>
#include <bit>
#include <cstdint>
#include <optional>
#include <splat/splat.h>
#include <unordered_map>
#include <vector>

namespace splat_transform::voxel {
class Backend;
inline constexpr uint64_t FULL_BLOCK = ~uint64_t { 0 };
inline constexpr std::array<int, 3> BIT_STRIDES { 1, 4, 16 };
constexpr uint64_t face_mask(int axis, int coordinate) {
    uint64_t result = 0;
    for (int i = 0; i < 64; ++i) {
        if ((i / BIT_STRIDES[axis]) % 4 == coordinate) {
            result |= uint64_t { 1 } << i;
        }
    }
    return result;
}

// A block stores a 4 x 4 x 4 occupancy mask. Uniform inverted grids retain a
// default mask so navigation does not allocate one entry per empty block.
class Grid {
public:
    Eigen::Vector3i size = Eigen::Vector3i::Zero();
    Eigen::Vector3i blocks = Eigen::Vector3i::Zero();
    uint64_t default_mask = 0;
    std::unordered_map<uint32_t, uint64_t> masks;
    explicit Grid(Eigen::Vector3i dimensions = { 4, 4, 4 });
    uint32_t block_index(Eigen::Vector3i point) const;
    Eigen::Vector3i block_point(uint32_t index) const;
    uint64_t block_count() const;
    bool contains(Eigen::Vector3i point) const;
    uint64_t mask(uint32_t index) const;
    void set_mask(uint32_t index, uint64_t value);
    void or_mask(uint32_t index, uint64_t value);
    bool get(Eigen::Vector3i point) const;
    void set(Eigen::Vector3i point);
    Grid inverted() const;
    Grid crop(Eigen::Vector3i minimum, Eigen::Vector3i maximum, bool invert = false) const;
    std::optional<std::array<Eigen::Vector3i, 2>> extent(bool navigable = false) const;
    uint64_t voxel_count() const;
    std::vector<uint32_t> active_blocks() const;
};

Grid unite(const Grid& left, const Grid& right);
Grid flood(const Grid& allowed, const std::vector<Eigen::Vector3i>& seeds, bool boundary = false);
std::optional<Eigen::Vector3i> nearest_cell(const Grid& allowed, Eigen::Vector3i seed, int radius);
Grid filter_blocks(const Grid& grid);
void crop_grid(Grid& grid, Eigen::AlignedBox3f& bounds, float resolution, bool navigable, int margin);
void navigate(Grid& grid, Eigen::AlignedBox3f& bounds, float resolution, const struct Navigation& options, const Backend& backend);

struct Navigation {
    bool floor_fill = false;
    float floor_dilation = 0;
    float exterior_radius = 0;
    float capsule_height = 0;
    float capsule_radius = 0;
    std::optional<Eigen::Vector3f> seed;
};
struct Mesh {
    std::vector<float> positions;
    std::vector<uint32_t> indices;
};
Mesh voxel_faces(const Grid& grid, const Eigen::AlignedBox3f& bounds, float resolution);
Mesh marching_cubes(const Grid& grid, const Eigen::AlignedBox3f& bounds, float resolution);
Mesh merge_coplanar(const Mesh& mesh, float resolution);
std::vector<uint8_t> encode_glb(const Mesh& mesh);
} // namespace splat_transform::voxel
