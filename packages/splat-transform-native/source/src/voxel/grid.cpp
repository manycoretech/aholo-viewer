#include "grid.h"
#include "backend.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <stdexcept>
#include <utility/logger.h>

namespace splat_transform::voxel {
Grid::Grid(Eigen::Vector3i dimensions) : size(dimensions) {
    for (size_t axis = 0; axis < 3; ++axis) {
        if (size[axis] <= 0 || size[axis] % 4) {
            throw std::runtime_error("Voxel grid dimensions must be positive multiples of four");
        }
        blocks[axis] = size[axis] / 4;
    }
    if (block_count() > 0x7fffffff) {
        throw std::runtime_error("Voxel grid exceeds the 31-bit block limit");
    }
    masks = Storage(blocks);
}
uint32_t Grid::block_index(Eigen::Vector3i p) const { return p[0] + p[1] * blocks[0] + static_cast<uint64_t>(p[2]) * blocks[0] * blocks[1]; }
Eigen::Vector3i Grid::block_point(uint32_t index) const {
    return { static_cast<int32_t>(index % blocks[0]),
        static_cast<int32_t>((index / blocks[0]) % blocks[1]),
        static_cast<int32_t>(index / (static_cast<uint64_t>(blocks[0]) * blocks[1])) };
}
uint64_t Grid::block_count() const { return static_cast<uint64_t>(blocks[0]) * blocks[1] * blocks[2]; }
uint64_t Grid::mask(uint32_t index) const { return masks.get(block_point(index)); }
void Grid::set_mask(uint32_t index, uint64_t value) { masks.set(block_point(index), value); }
void Grid::or_mask(Eigen::Vector3i block, uint64_t value) {
    if (value) {
        masks.set(block, masks.get(block) | value);
    }
}
void Grid::set(Eigen::Vector3i p) {
    if (contains(p)) {
        or_mask(p / 4, uint64_t { 1 } << ((p.x() & 3) + 4 * (p.y() & 3) + 16 * (p.z() & 3)));
    }
}
Grid Grid::inverted() const {
    Grid output = *this;
    output.masks.invert();
    return output;
}
Grid Grid::crop(Eigen::Vector3i minimum, Eigen::Vector3i maximum, bool invert) const {
    Grid output((maximum - minimum) * 4);
    if (invert != (masks.background() != 0)) {
        output.masks.invert();
    }
    masks.for_each_block(masks.background(), [&](Eigen::Vector3i p, uint64_t bits) {
        if ((p.array() >= minimum.array()).all() && (p.array() < maximum.array()).all()) {
            output.masks.set(p - minimum, invert ? ~bits : bits);
        }
    });
    return output;
}
std::optional<std::array<Eigen::Vector3i, 2>> Grid::extent(bool navigable) const {
    Eigen::Vector3i minimum = blocks, maximum { -1, -1, -1 };
    masks.for_each_block(navigable ? FULL_BLOCK : 0, [&](Eigen::Vector3i p, uint64_t) {
        minimum = minimum.cwiseMin(p);
        maximum = maximum.cwiseMax(p);
    });
    if (maximum.x() < 0) {
        return std::nullopt;
    }
    return std::array<Eigen::Vector3i, 2> { minimum, maximum };
}
uint64_t Grid::voxel_count() const { return masks.voxel_count(); }
std::vector<uint32_t> Grid::active_blocks() const {
    std::vector<uint32_t> output;
    output.reserve(masks.occupied_blocks());
    masks.for_each_block(0, [&](Eigen::Vector3i p, uint64_t) { output.push_back(block_index(p)); });
    std::sort(output.begin(), output.end());
    return output;
}
Grid unite(const Grid& left, const Grid& right) {
    if (left.size != right.size) {
        throw std::runtime_error("Voxel grid dimensions do not match");
    }
    Grid output(left.size);
    if (left.masks.background() || right.masks.background()) {
        output.masks.invert();
    }
    left.masks.for_each_block(left.masks.background(), [&](Eigen::Vector3i p, uint64_t bits) {
        output.masks.set(p, bits | right.masks.get(p));
    });
    right.masks.for_each_block(right.masks.background(), [&](Eigen::Vector3i p, uint64_t bits) {
        output.masks.set(p, bits | left.masks.get(p));
    });
    return output;
}
Grid flood(const Grid& allowed, const std::vector<Eigen::Vector3i>& seeds, bool boundary) {
    Grid visited(allowed.size);
    std::deque<std::pair<uint32_t, uint64_t>> queue;
    auto enqueue = [&](Eigen::Vector3i p, uint64_t bits) {
        for (size_t a = 0; a < 3; ++a) {
            if (p[a] < 0 || p[a] >= allowed.blocks[a]) {
                return;
            }
        }
        const auto index = allowed.block_index(p);
        bits &= allowed.masks.get(p) & ~visited.masks.get(p);
        if (bits) {
            queue.emplace_back(index, bits);
        }
    };
    for (auto p : seeds) {
        if (allowed.contains(p)) {
            enqueue({ p[0] / 4, p[1] / 4, p[2] / 4 }, uint64_t { 1 } << ((p[0] & 3) + 4 * (p[1] & 3) + 16 * (p[2] & 3)));
        }
    }
    if (boundary) {
        for (int32_t axis = 0; axis < 3; ++axis) {
            const int32_t u = (axis + 1) % 3, v = (axis + 2) % 3;
            for (int32_t j = 0; j < allowed.blocks[v]; ++j) {
                for (int32_t i = 0; i < allowed.blocks[u]; ++i) {
                    Eigen::Vector3i p = Eigen::Vector3i::Zero();
                    p[u] = i;
                    p[v] = j;
                    enqueue(p, face_mask(axis, 0));
                    p[axis] = allowed.blocks[axis] - 1;
                    enqueue(p, face_mask(axis, 3));
                }
            }
        }
    }
    while (!queue.empty()) {
        auto [index, incoming] = queue.front();
        queue.pop_front();
        const auto p = allowed.block_point(index);
        const uint64_t old = visited.masks.get(p), permitted = allowed.masks.get(p);
        if (!(incoming & permitted & ~old)) {
            continue;
        }
        uint64_t reached = old | (incoming & permitted);
        while (true) {
            uint64_t expanded = reached;
            for (int32_t axis = 0; axis < 3; ++axis) {
                expanded |= (reached & ~face_mask(axis, 3)) << BIT_STRIDES[axis];
                expanded |= (reached & ~face_mask(axis, 0)) >> BIT_STRIDES[axis];
            }
            expanded &= permitted;
            if (expanded == reached) {
                break;
            }
            reached = expanded;
        }
        visited.masks.set(p, reached);
        const uint64_t added = reached & ~old;
        for (int32_t axis = 0; axis < 3; ++axis) {
            auto neighbor = p;
            neighbor[axis]--;
            enqueue(neighbor, (added & face_mask(axis, 0)) << (3 * BIT_STRIDES[axis]));
            neighbor[axis] += 2;
            enqueue(neighbor, (added & face_mask(axis, 3)) >> (3 * BIT_STRIDES[axis]));
        }
    }
    return visited;
}
std::optional<Eigen::Vector3i> nearest_cell(const Grid& allowed, Eigen::Vector3i seed, int32_t radius) {
    if (allowed.get(seed)) {
        return seed;
    }
    for (int32_t r = 1; r <= radius; ++r) {
        for (int32_t z = -r; z <= r; ++z) {
            for (int32_t y = -r; y <= r; ++y) {
                for (int32_t x = -r; x <= r; ++x) {
                    if (std::abs(x) != r && std::abs(y) != r && std::abs(z) != r) {
                        continue;
                    }
                    Eigen::Vector3i p { seed[0] + x, seed[1] + y, seed[2] + z };
                    if (allowed.get(p)) {
                        return p;
                    }
                }
            }
        }
    }
    return std::nullopt;
}
Grid filter_blocks(const Grid& grid) {
    constexpr std::array<uint64_t, 3> LOW_FACE { face_mask(0, 0), face_mask(1, 0), face_mask(2, 0) };
    constexpr std::array<uint64_t, 3> HIGH_FACE { face_mask(0, 3), face_mask(1, 3), face_mask(2, 3) };
    Grid output = grid;
    uint64_t removed = 0, filled = 0;
    grid.masks.for_each_block(0, [&](Eigen::Vector3i block, uint64_t bits) {
        if (bits == FULL_BLOCK) {
            return;
        }
        uint64_t any_neighbor = 0, all_neighbors = FULL_BLOCK;
        for (int32_t axis = 0; axis < 3; ++axis) {
            const int32_t stride = BIT_STRIDES[axis];
            // Shift all 64 cells at once, masking intra-block wraparound and
            // adding only the facing cells from the two neighboring blocks.
            uint64_t plus = (bits >> stride) & ~HIGH_FACE[axis];
            uint64_t minus = (bits << stride) & ~LOW_FACE[axis];
            auto adjacent = block;
            if (block[axis] + 1 < grid.blocks[axis]) {
                ++adjacent[axis];
                plus |= (grid.masks.get(adjacent) & LOW_FACE[axis]) << (3 * stride);
            }
            if (block[axis] > 0) {
                adjacent = block;
                --adjacent[axis];
                minus |= (grid.masks.get(adjacent) & HIGH_FACE[axis]) >> (3 * stride);
            }
            any_neighbor |= plus | minus;
            all_neighbors &= plus & minus;
        }
        const uint64_t filtered = (bits & any_neighbor) | all_neighbors;
        output.masks.set(block, filtered);
        removed += std::popcount(bits & ~filtered);
        filled += std::popcount(filtered & ~bits);
    });
    utility::logger().info("voxel filter: ", removed, " voxels removed, ", filled, " voxels filled");
    return output;
}
void crop_grid(Grid& grid, Eigen::AlignedBox3f& bounds, float resolution, bool navigable, int32_t margin) {
    auto extent = grid.extent(navigable);
    if (!extent) {
        return;
    }
    auto [minimum, maximum] = *extent;
    for (int32_t axis = 0; axis < 3; ++axis) {
        minimum[axis] = std::max(0, minimum[axis] - margin);
        maximum[axis] = std::min(grid.blocks[axis], maximum[axis] + 1 + margin);
        bounds.max()[axis] = bounds.min()[axis] + maximum[axis] * 4 * resolution;
        bounds.min()[axis] += minimum[axis] * 4 * resolution;
    }
    grid = grid.crop(minimum, maximum);
}
void navigate(Grid& grid, Eigen::AlignedBox3f& bounds, float resolution, const Navigation& options, const Backend& backend) {
    auto& logger = utility::logger();
    auto seed_cell = [&] {
        Eigen::Vector3i p = Eigen::Vector3i::Zero();
        for (int32_t a = 0; a < 3; ++a) {
            p[a] = static_cast<int32_t>(std::floor(((*options.seed)[a] - bounds.min()[a]) / resolution));
        }
        return p;
    };
    if (options.exterior_radius != 0 && options.seed) {
        auto elapsed = logger.time("Fill exterior");
        const int32_t radius = static_cast<int32_t>(std::ceil(options.exterior_radius / resolution));
        const auto seed = seed_cell();
        const auto blocked = backend.dilate(grid, { radius, radius, radius });
        auto outside = flood(blocked.inverted(), {}, true);
        if (grid.contains(seed) && !outside.get(seed)) {
            grid = unite(grid, backend.dilate(outside, { radius, radius, radius }));
            crop_grid(grid, bounds, resolution, true, 1);
        } else {
            logger.info(grid.contains(seed) ? "fillExteriorMap: seed reachable from outside, skipping" : "fillExteriorMap: seed outside grid bounds, skipping exterior fill");
        }
    }
    if (options.floor_fill) {
        auto elapsed = logger.time("Fill floor");
        const int32_t radius = static_cast<int32_t>(std::ceil(options.floor_dilation / resolution));
        auto blocked = backend.dilate(grid, { radius, 0, radius });
        Grid found(grid.size);
        for (int32_t z = 0; z < grid.size[2]; ++z) {
            for (int32_t x = 0; x < grid.size[0]; ++x) {
                for (int32_t y = 0; y < grid.size[1] && !blocked.get({ x, y, z }); ++y) {
                    found.set({ x, y, z });
                }
            }
        }
        grid = unite(grid, backend.dilate(found, { radius, 0, radius }));
    }
    if (options.capsule_height > 0 && options.seed) {
        auto elapsed = logger.time("Carve nav");
        const int32_t rx = static_cast<int32_t>(std::ceil(options.capsule_radius / resolution)), ry = static_cast<int32_t>(std::ceil(options.capsule_height * 0.5f / resolution));
        if (options.capsule_radius < 0) {
            throw std::runtime_error("navCapsule.radius must be nonnegative");
        }
        auto seed = seed_cell();
        if (!grid.contains(seed)) {
            logger.warn("carve: seed (", (*options.seed)[0], ", ", (*options.seed)[1], ", ", (*options.seed)[2], ") outside grid, skipping");
            return;
        }
        auto allowed = backend.dilate(grid, { rx, ry, rx }).inverted();
        auto start = nearest_cell(allowed, seed, std::max(rx, ry) * 2);
        if (!start) {
            logger.warn("carve: no navigable voxel near seed, skipping");
            return;
        }
        auto reachable = backend.dilate(flood(allowed, { *start }), { rx, ry, rx });
        if (reachable.voxel_count() == 0) {
            logger.warn("carve: no navigable cells remain, returning empty result");
            grid = Grid();
            bounds.max() = bounds.min();
            return;
        }
        crop_grid(reachable, bounds, resolution, false, 1);
        grid = reachable.inverted();
    }
}
} // namespace splat_transform::voxel
