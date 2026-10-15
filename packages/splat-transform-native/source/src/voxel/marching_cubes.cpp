#include "grid.h"
#include "marching_tables.h"
#include <algorithm>
#include <map>
#include <set>

namespace splat_transform::voxel {
Mesh marching_cubes(const Grid& grid, const splat::Bounds& bounds, float resolution) {
    constexpr Point CORNERS[8] { { 0, 0, 0 }, { 1, 0, 0 }, { 1, 1, 0 }, { 0, 1, 0 }, { 0, 0, 1 }, { 1, 0, 1 }, { 1, 1, 1 }, { 0, 1, 1 } };
    constexpr std::array<int, 4> EDGES[12] {
        { 0, 0, 0, 0 }, { 1, 0, 0, 1 }, { 0, 1, 0, 0 }, { 0, 0, 0, 1 },
        { 0, 0, 1, 0 }, { 1, 0, 1, 1 }, { 0, 1, 1, 0 }, { 0, 0, 1, 1 },
        { 0, 0, 0, 2 }, { 1, 0, 0, 2 }, { 1, 1, 0, 2 }, { 0, 1, 0, 2 }
    };
    std::set<uint32_t> active;
    for (auto index : grid.active_blocks()) {
        const auto p = grid.block_point(index);
        for (int z = -1; z <= 0; ++z) {
            for (int y = -1; y <= 0; ++y) {
                for (int x = -1; x <= 0; ++x) {
                    Point neighbor { p[0] + x, p[1] + y, p[2] + z };
                    if (neighbor[0] >= 0 && neighbor[1] >= 0 && neighbor[2] >= 0) {
                        active.insert(grid.block_index(neighbor));
                    }
                }
            }
        }
    }
    Mesh output;
    std::map<std::array<int, 4>, uint32_t> vertices;
    auto vertex = [&](Point cell, int edge) {
        auto key = EDGES[edge];
        for (int a = 0; a < 3; ++a) {
            key[a] += cell[a];
        }
        auto found = vertices.find(key);
        if (found != vertices.end()) {
            return found->second;
        }
        const auto index = uint32_t(output.positions.size() / 3);
        vertices[key] = index;
        for (int a = 0; a < 3; ++a) {
            float coordinate = bounds.min[a] + key[a] * resolution;
            if (a == key[3]) {
                coordinate += resolution * 0.5f;
            }
            output.positions.push_back(coordinate);
        }
        return index;
    };
    for (auto index : active) {
        const auto block = grid.block_point(index);
        Point minimum, maximum;
        for (int a = 0; a < 3; ++a) {
            minimum[a] = block[a] == 0 ? -1 : block[a] * 4;
            maximum[a] = block[a] * 4 + 4;
        }
        for (int z = minimum[2]; z < maximum[2]; ++z) {
            for (int y = minimum[1]; y < maximum[1]; ++y) {
                for (int x = minimum[0]; x < maximum[0]; ++x) {
                    const Point cell { x, y, z };
                    unsigned cube = 0;
                    for (unsigned corner = 0; corner < 8; ++corner) {
                        const auto p = CORNERS[corner];
                        if (grid.get({ x + p[0], y + p[1], z + p[2] })) {
                            cube |= 1u << corner;
                        }
                    }
                    if (cube == 0 || cube == 255) {
                        continue;
                    }
                    std::array<uint32_t, 12> edge_vertices {};
                    std::array<bool, 12> needed {};
                    for (auto edge : TRI_TABLE[cube]) {
                        if (edge >= 0) {
                            needed[edge] = true;
                        }
                    }
                    for (int edge = 0; edge < 12; ++edge) {
                        if (needed[edge]) {
                            edge_vertices[edge] = vertex(cell, edge);
                        }
                    }
                    for (int i = 0; i < 16 && TRI_TABLE[cube][i] >= 0; i += 3) {
                        output.indices.insert(output.indices.end(), { edge_vertices[TRI_TABLE[cube][i]], edge_vertices[TRI_TABLE[cube][i + 2]], edge_vertices[TRI_TABLE[cube][i + 1]] });
                    }
                }
            }
        }
    }
    return output;
}
} // namespace splat_transform::voxel
