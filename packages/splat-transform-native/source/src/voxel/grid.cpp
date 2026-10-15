#include "grid.h"
#include <algorithm>
#include <cmath>
#include <deque>
#include <gpu/compute.h>
#include <limits>
#include <stdexcept>
#include <utility/logger.h>

namespace splat_transform::voxel {
Grid::Grid(Point dimensions) : size(dimensions) {
    for (size_t axis = 0; axis < 3; ++axis) {
        if (size[axis] <= 0 || size[axis] % 4) {
            throw std::runtime_error("Voxel grid dimensions must be positive multiples of four");
        }
        blocks[axis] = size[axis] / 4;
    }
    if (block_count() > 0x7fffffff) {
        throw std::runtime_error("Voxel grid exceeds the 31-bit block limit");
    }
}
uint32_t Grid::block_index(Point p) const { return p[0] + p[1] * blocks[0] + uint64_t(p[2]) * blocks[0] * blocks[1]; }
Point Grid::block_point(uint32_t index) const { return { int(index % blocks[0]), int((index / blocks[0]) % blocks[1]), int(index / (uint64_t(blocks[0]) * blocks[1])) }; }
uint64_t Grid::block_count() const { return uint64_t(blocks[0]) * blocks[1] * blocks[2]; }
bool Grid::contains(Point p) const { return p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < size[0] && p[1] < size[1] && p[2] < size[2]; }
uint64_t Grid::mask(uint32_t index) const {
    const auto found = masks.find(index);
    return found == masks.end() ? default_mask : found->second;
}
void Grid::set_mask(uint32_t index, uint64_t value) {
    if (value == default_mask) {
        masks.erase(index);
    } else {
        masks[index] = value;
    }
}
void Grid::or_mask(uint32_t index, uint64_t value) { set_mask(index, mask(index) | value); }
bool Grid::get(Point p) const {
    if (!contains(p)) {
        return false;
    }
    return (mask(block_index({ p[0] / 4, p[1] / 4, p[2] / 4 })) >> ((p[0] & 3) + 4 * (p[1] & 3) + 16 * (p[2] & 3))) & 1;
}
void Grid::set(Point p) {
    if (contains(p)) {
        or_mask(block_index({ p[0] / 4, p[1] / 4, p[2] / 4 }), uint64_t { 1 } << ((p[0] & 3) + 4 * (p[1] & 3) + 16 * (p[2] & 3)));
    }
}
Grid Grid::inverted() const {
    Grid output = *this;
    output.default_mask = ~default_mask;
    for (auto& [index, bits] : output.masks) {
        bits = ~bits;
    }
    return output;
}
Grid Grid::crop(Point minimum, Point maximum, bool invert) const {
    Grid output({ (maximum[0] - minimum[0]) * 4, (maximum[1] - minimum[1]) * 4, (maximum[2] - minimum[2]) * 4 });
    output.default_mask = invert ? ~default_mask : default_mask;
    for (auto [index, bits] : masks) {
        auto p = block_point(index);
        bool inside = true;
        for (size_t a = 0; a < 3; ++a) {
            inside &= p[a] >= minimum[a] && p[a] < maximum[a];
            p[a] -= minimum[a];
        }
        if (inside) {
            output.set_mask(output.block_index(p), invert ? ~bits : bits);
        }
    }
    return output;
}
std::optional<std::array<Point, 2>> Grid::extent(bool navigable) const {
    Point minimum = blocks, maximum { -1, -1, -1 };
    auto visit = [&](uint32_t index, uint64_t bits) {
        if (!(navigable ? bits != FULL_BLOCK : bits != 0)) {
            return;
        }
        const auto p = block_point(index);
        for (size_t a = 0; a < 3; ++a) {
            minimum[a] = std::min(minimum[a], p[a]);
            maximum[a] = std::max(maximum[a], p[a]);
        }
    };
    if (navigable ? default_mask != FULL_BLOCK : default_mask != 0) {
        for (uint32_t index = 0; index < block_count(); ++index) {
            visit(index, mask(index));
        }
    } else {
        for (auto [index, bits] : masks) {
            visit(index, bits);
        }
    }
    if (maximum[0] < 0) {
        return std::nullopt;
    }
    return std::array<Point, 2> { minimum, maximum };
}
uint64_t Grid::voxel_count() const {
    int64_t total = int64_t(block_count()) * std::popcount(default_mask);
    for (auto [index, bits] : masks) {
        total += std::popcount(bits) - std::popcount(default_mask);
    }
    return static_cast<uint64_t>(total);
}
std::vector<uint32_t> Grid::active_blocks() const {
    std::vector<uint32_t> output;
    if (default_mask) {
        for (uint32_t index = 0; index < block_count(); ++index) {
            if (mask(index)) {
                output.push_back(index);
            }
        }
    } else {
        output.reserve(masks.size());
        for (auto [index, bits] : masks) {
            if (bits) {
                output.push_back(index);
            }
        }
        std::sort(output.begin(), output.end());
    }
    return output;
}
Grid unite(const Grid& left, const Grid& right) {
    if (left.size != right.size) {
        throw std::runtime_error("Voxel grid dimensions do not match");
    }
    Grid output(left.size);
    output.default_mask = left.default_mask | right.default_mask;
    for (auto [index, bits] : left.masks) {
        output.set_mask(index, bits | right.mask(index));
    }
    for (auto [index, bits] : right.masks) {
        output.set_mask(index, bits | left.mask(index));
    }
    return output;
}
Grid flood(const Grid& allowed, const std::vector<Point>& seeds, bool boundary) {
    Grid visited(allowed.size);
    std::deque<std::pair<uint32_t, uint64_t>> queue;
    auto enqueue = [&](Point p, uint64_t bits) {
        for (size_t a = 0; a < 3; ++a) {
            if (p[a] < 0 || p[a] >= allowed.blocks[a]) {
                return;
            }
        }
        const auto index = allowed.block_index(p);
        bits &= allowed.mask(index) & ~visited.mask(index);
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
        for (int axis = 0; axis < 3; ++axis) {
            const int u = (axis + 1) % 3, v = (axis + 2) % 3;
            for (int j = 0; j < allowed.blocks[v]; ++j) {
                for (int i = 0; i < allowed.blocks[u]; ++i) {
                    Point p {};
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
        const uint64_t old = visited.mask(index), permitted = allowed.mask(index);
        if (!(incoming & permitted & ~old)) {
            continue;
        }
        uint64_t reached = old | (incoming & permitted);
        while (true) {
            uint64_t expanded = reached;
            for (int axis = 0; axis < 3; ++axis) {
                expanded |= (reached & ~face_mask(axis, 3)) << BIT_STRIDES[axis];
                expanded |= (reached & ~face_mask(axis, 0)) >> BIT_STRIDES[axis];
            }
            expanded &= permitted;
            if (expanded == reached) {
                break;
            }
            reached = expanded;
        }
        visited.set_mask(index, reached);
        const auto p = allowed.block_point(index);
        const uint64_t added = reached & ~old;
        for (int axis = 0; axis < 3; ++axis) {
            auto neighbor = p;
            neighbor[axis]--;
            enqueue(neighbor, (added & face_mask(axis, 0)) << (3 * BIT_STRIDES[axis]));
            neighbor[axis] += 2;
            enqueue(neighbor, (added & face_mask(axis, 3)) >> (3 * BIT_STRIDES[axis]));
        }
    }
    return visited;
}
std::optional<Point> nearest_cell(const Grid& allowed, Point seed, int radius) {
    if (allowed.get(seed)) {
        return seed;
    }
    for (int r = 1; r <= radius; ++r) {
        for (int z = -r; z <= r; ++z) {
            for (int y = -r; y <= r; ++y) {
                for (int x = -r; x <= r; ++x) {
                    if (std::abs(x) != r && std::abs(y) != r && std::abs(z) != r) {
                        continue;
                    }
                    Point p { seed[0] + x, seed[1] + y, seed[2] + z };
                    if (allowed.get(p)) {
                        return p;
                    }
                }
            }
        }
    }
    return std::nullopt;
}
Grid dilate(const Grid& grid, Point radius) {
    const uint64_t cells = grid.block_count() * 64;
    if (cells <= 256ull * 1024 * 1024) {
        try {
            std::vector<uint32_t> packed;
            const auto active = grid.active_blocks();
            packed.reserve(active.size() * 3);
            for (auto index : active) {
                const auto bits = grid.mask(index);
                packed.insert(packed.end(), { index, uint32_t(bits), uint32_t(bits >> 32) });
            }
            const auto masks = gpu::dilate_blocks(packed, { uint32_t(grid.size[0]), uint32_t(grid.size[1]), uint32_t(grid.size[2]) },
                { uint32_t(radius[0]), uint32_t(radius[1]), uint32_t(radius[2]) });
            Grid output(grid.size);
            for (uint32_t index = 0; index < grid.block_count(); ++index) {
                output.set_mask(index, uint64_t(masks[index * 2]) | (uint64_t(masks[index * 2 + 1]) << 32));
            }
            return output;
        } catch (const std::exception& error) {
            utility::logger().warn("Vulkan dilation failed; using CPU: ", error.what());
        }
    }
    Grid output = grid;
    for (int axis = 0; axis < 3; ++axis) {
        for (int distance = 0; distance < radius[axis]; ++distance) {
            Grid next = output;
            for (auto index : output.active_blocks()) {
                auto p = output.block_point(index);
                const uint64_t bits = output.mask(index);
                next.or_mask(index, ((bits & ~face_mask(axis, 3)) << BIT_STRIDES[axis]) | ((bits & ~face_mask(axis, 0)) >> BIT_STRIDES[axis]));
                if (p[axis] > 0) {
                    --p[axis];
                    next.or_mask(next.block_index(p), (bits & face_mask(axis, 0)) << (3 * BIT_STRIDES[axis]));
                    ++p[axis];
                }
                if (p[axis] + 1 < output.blocks[axis]) {
                    ++p[axis];
                    next.or_mask(next.block_index(p), (bits & face_mask(axis, 3)) >> (3 * BIT_STRIDES[axis]));
                }
            }
            output = std::move(next);
        }
    }
    return output;
}
Grid filter_blocks(const Grid& grid) {
    Grid output = grid;
    uint64_t removed = 0, filled = 0;
    for (auto index : grid.active_blocks()) {
        const uint64_t bits = grid.mask(index);
        if (bits == FULL_BLOCK) {
            continue;
        }
        const auto block = grid.block_point(index);
        uint64_t filtered = 0;
        for (int b = 0; b < 64; ++b) {
            Point p { block[0] * 4 + b % 4, block[1] * 4 + b / 4 % 4, block[2] * 4 + b / 16 };
            int neighbors = 0;
            for (int axis = 0; axis < 3; ++axis) {
                --p[axis];
                neighbors += grid.get(p);
                p[axis] += 2;
                neighbors += grid.get(p);
                --p[axis];
            }
            if (((bits >> b) & 1) ? neighbors != 0 : neighbors == 6) {
                filtered |= uint64_t { 1 } << b;
            }
        }
        output.set_mask(index, filtered);
        removed += std::popcount(bits & ~filtered);
        filled += std::popcount(filtered & ~bits);
    }
    utility::logger().info("voxel filter: ", removed, " voxels removed, ", filled, " voxels filled");
    return output;
}
void crop_grid(Grid& grid, splat::Bounds& bounds, float resolution, bool navigable, int margin) {
    auto extent = grid.extent(navigable);
    if (!extent) {
        return;
    }
    auto [minimum, maximum] = *extent;
    for (int axis = 0; axis < 3; ++axis) {
        minimum[axis] = std::max(0, minimum[axis] - margin);
        maximum[axis] = std::min(grid.blocks[axis], maximum[axis] + 1 + margin);
        bounds.max[axis] = bounds.min[axis] + maximum[axis] * 4 * resolution;
        bounds.min[axis] += minimum[axis] * 4 * resolution;
    }
    grid = grid.crop(minimum, maximum);
}
void navigate(Grid& grid, splat::Bounds& bounds, float resolution, const Navigation& options) {
    auto& logger = utility::logger();
    auto seed_cell = [&] {
        Point p {};
        for (int a = 0; a < 3; ++a) {
            p[a] = int(std::floor(((*options.seed)[a] - bounds.min[a]) / resolution));
        }
        return p;
    };
    if (options.exterior_radius != 0 && options.seed) {
        auto elapsed = logger.time("Fill exterior");
        const int radius = int(std::ceil(options.exterior_radius / resolution));
        const auto seed = seed_cell();
        const auto blocked = dilate(grid, { radius, radius, radius });
        auto outside = flood(blocked.inverted(), {}, true);
        if (grid.contains(seed) && !outside.get(seed)) {
            grid = unite(grid, dilate(outside, { radius, radius, radius }));
            crop_grid(grid, bounds, resolution, true, 1);
        } else {
            logger.info(grid.contains(seed) ? "fillExteriorMap: seed reachable from outside, skipping" : "fillExteriorMap: seed outside grid bounds, skipping exterior fill");
        }
    }
    if (options.floor_fill) {
        auto elapsed = logger.time("Fill floor");
        const int radius = int(std::ceil(options.floor_dilation / resolution));
        auto blocked = dilate(grid, { radius, 0, radius });
        Grid found(grid.size);
        for (int z = 0; z < grid.size[2]; ++z) {
            for (int x = 0; x < grid.size[0]; ++x) {
                for (int y = 0; y < grid.size[1] && !blocked.get({ x, y, z }); ++y) {
                    found.set({ x, y, z });
                }
            }
        }
        grid = unite(grid, dilate(found, { radius, 0, radius }));
    }
    if (options.capsule_height > 0 && options.seed) {
        auto elapsed = logger.time("Carve nav");
        const int rx = int(std::ceil(options.capsule_radius / resolution)), ry = int(std::ceil(options.capsule_height * 0.5f / resolution));
        if (options.capsule_radius < 0) {
            throw std::runtime_error("navCapsule.radius must be nonnegative");
        }
        auto seed = seed_cell();
        if (!grid.contains(seed)) {
            logger.warn("carve: seed (", (*options.seed)[0], ", ", (*options.seed)[1], ", ", (*options.seed)[2], ") outside grid, skipping");
            return;
        }
        auto allowed = dilate(grid, { rx, ry, rx }).inverted();
        auto start = nearest_cell(allowed, seed, std::max(rx, ry) * 2);
        if (!start) {
            logger.warn("carve: no navigable voxel near seed, skipping");
            return;
        }
        auto reachable = dilate(flood(allowed, { *start }), { rx, ry, rx });
        if (reachable.voxel_count() == 0) {
            logger.warn("carve: no navigable cells remain, returning empty result");
            grid = Grid();
            bounds.max = bounds.min;
            return;
        }
        crop_grid(reachable, bounds, resolution, false, 1);
        grid = reachable.inverted();
    }
}
} // namespace splat_transform::voxel
