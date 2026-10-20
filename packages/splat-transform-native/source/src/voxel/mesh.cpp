#include "grid.h"
#include <algorithm>
#include <io/file.h>
#include <set>
#include <unordered_map>
#include <utility/vector_hash.h>

namespace splat_transform::voxel {
namespace {
Eigen::Vector3i global_point(int axis, int p, int u, int v) {
    if (axis == 0) {
        return { p, u, v };
    }
    if (axis == 1) {
        return { u, p, v };
    }
    return { u, v, p };
}
std::array<int, 2> local_point(int axis, Eigen::Vector3i point) {
    if (axis == 0) {
        return { point[1], point[2] };
    }
    if (axis == 1) {
        return { point[0], point[2] };
    }
    return { point[0], point[1] };
}
Eigen::Vector3i line_key(int axis, Eigen::Vector3i p) {
    if (axis == 0) {
        return { axis, p[1], p[2] };
    }
    if (axis == 1) {
        return { axis, p[0], p[2] };
    }
    return { axis, p[0], p[1] };
}
struct Rectangle {
    int bucket, plane, u0, v0, u1, v1;
    std::array<Eigen::Vector3i, 4> corners() const {
        const int axis = bucket / 2;
        return { global_point(axis, plane, u0, v0), global_point(axis, plane, u1, v0), global_point(axis, plane, u1, v1), global_point(axis, plane, u0, v1) };
    }
};
} // namespace
Mesh voxel_faces(const Grid& grid, const Eigen::AlignedBox3f& bounds, float resolution) {
    // Each plane is independent; cells remain sorted to seed greedy rectangles.
    std::unordered_map<Eigen::Vector2i, std::set<std::array<int, 2>>, utility::VectorHash> planes;
    for (auto index : grid.active_blocks()) {
        const auto block = grid.block_point(index);
        auto bits = grid.mask(index);
        while (bits) {
            const int bit = std::countr_zero(bits);
            bits &= bits - 1;
            Eigen::Vector3i p { block[0] * 4 + bit % 4, block[1] * 4 + bit / 4 % 4, block[2] * 4 + bit / 16 };
            for (int axis = 0; axis < 3; ++axis) {
                for (int side = 0; side < 2; ++side) {
                    auto neighbor = p;
                    neighbor[axis] += side ? 1 : -1;
                    if (grid.get(neighbor)) {
                        continue;
                    }
                    planes[{ axis * 2 + side, p[axis] + side }].insert(local_point(axis, p));
                }
            }
        }
    }
    std::vector<Rectangle> rectangles;
    for (auto& [plane, cells] : planes) {
        while (!cells.empty()) {
            auto [u, v] = *cells.begin();
            int width = 1, height = 1;
            while (cells.contains({ u + width, v })) {
                ++width;
            }
            while (true) {
                bool all = true;
                for (int du = 0; du < width; ++du) {
                    if (!cells.contains({ u + du, v + height })) {
                        all = false;
                        break;
                    }
                }
                if (!all) {
                    break;
                }
                ++height;
            }
            for (int dv = 0; dv < height; ++dv) {
                for (int du = 0; du < width; ++du) {
                    cells.erase({ u + du, v + dv });
                }
            }
            rectangles.push_back({ plane[0], plane[1], u, v, u + width, v + height });
        }
    }
    // Sorted coordinates are required by the perimeter's range queries below.
    std::unordered_map<Eigen::Vector3i, std::set<int>, utility::VectorHash> line_points;
    for (const auto& rectangle : rectangles) {
        auto corners = rectangle.corners();
        for (int edge = 0; edge < 4; ++edge) {
            auto a = corners[edge], b = corners[(edge + 1) % 4];
            const int axis = a[0] != b[0] ? 0 : a[1] != b[1] ? 1
                                                             : 2;
            auto& points = line_points[line_key(axis, a)];
            points.insert(a[axis]);
            points.insert(b[axis]);
        }
    }
    Mesh output;
    std::unordered_map<Eigen::Vector3i, uint32_t, utility::VectorHash> vertices;
    auto vertex = [&](Eigen::Vector3i p) {
        auto found = vertices.find(p);
        if (found != vertices.end()) {
            return found->second;
        }
        const auto index = uint32_t(output.positions.size() / 3);
        vertices[p] = index;
        for (int axis = 0; axis < 3; ++axis) {
            output.positions.push_back(float(bounds.min()[axis] + p[axis] * resolution));
        }
        return index;
    };
    for (const auto& rectangle : rectangles) {
        const int plane_axis = rectangle.bucket / 2;
        const auto corners = rectangle.corners();
        std::vector<uint32_t> perimeter;
        std::vector<std::array<int, 2>> uv;
        for (int edge = 0; edge < 4; ++edge) {
            auto a = corners[edge], b = corners[(edge + 1) % 4];
            const int axis = a[0] != b[0] ? 0 : a[1] != b[1] ? 1
                                                             : 2;
            const auto& points = line_points.at(line_key(axis, a));
            std::vector<int> segment;
            auto begin = points.lower_bound(std::min(a[axis], b[axis])), end = points.upper_bound(std::max(a[axis], b[axis]));
            segment.assign(begin, end);
            if (a[axis] > b[axis]) {
                std::reverse(segment.begin(), segment.end());
            }
            for (int t : segment) {
                auto p = a;
                p[axis] = t;
                const auto v = vertex(p);
                if (!perimeter.empty() && perimeter.back() == v) {
                    continue;
                }
                perimeter.push_back(v);
                uv.push_back(local_point(plane_axis, p));
            }
        }
        if (perimeter.size() > 1 && perimeter.front() == perimeter.back()) {
            perimeter.pop_back();
            uv.pop_back();
        }
        if (perimeter.size() < 3) {
            continue;
        }
        const bool ccw = bool(rectangle.bucket % 2) == (plane_axis != 1);
        auto append = [&](size_t a, size_t b, size_t c) {
            output.indices.insert(output.indices.end(), { perimeter[a], perimeter[ccw ? b : c], perimeter[ccw ? c : b] });
        };
        auto convex = [&](size_t a, size_t b, size_t c) {
            return int64_t(uv[b][0] - uv[a][0]) * (uv[c][1] - uv[a][1]) - int64_t(uv[b][1] - uv[a][1]) * (uv[c][0] - uv[a][0]) > 0;
        };
        std::vector<size_t> previous(perimeter.size()), next(perimeter.size());
        for (size_t i = 0; i < perimeter.size(); ++i) {
            previous[i] = (i + perimeter.size() - 1) % perimeter.size();
            next[i] = (i + 1) % perimeter.size();
        }
        size_t remaining = perimeter.size(), current = 0, attempts = 0;
        while (remaining > 3 && attempts < remaining) {
            const auto prev = previous[current], after = next[current];
            if ((remaining != 4 || convex(prev, after, next[after])) && convex(prev, current, after)) {
                append(prev, current, after);
                next[prev] = after;
                previous[after] = prev;
                current = after;
                --remaining;
                attempts = 0;
            } else {
                current = after;
                ++attempts;
            }
        }
        if (remaining == 3 && convex(current, next[current], next[next[current]])) {
            append(current, next[current], next[next[current]]);
        }
    }
    return output;
}
std::vector<uint8_t> encode_glb(const Mesh& mesh) {
    if (mesh.positions.empty() || mesh.indices.empty()) {
        return {};
    }
    std::array<float, 3> minimum { INFINITY, INFINITY, INFINITY }, maximum { -INFINITY, -INFINITY, -INFINITY };
    for (size_t i = 0; i < mesh.positions.size(); ++i) {
        minimum[i % 3] = std::min(minimum[i % 3], mesh.positions[i]);
        maximum[i % 3] = std::max(maximum[i % 3], mesh.positions[i]);
    }
    const size_t position_bytes = mesh.positions.size() * 4, index_bytes = mesh.indices.size() * 4;
    const io::Json gltf {
        { "asset", { { "version", "2.0" }, { "generator", "splat-transform" } } }, { "scene", 0 },
        { "scenes", io::Json::array({ { { "nodes", io::Json::array({ 0 }) } } }) },
        { "nodes", io::Json::array({ { { "mesh", 0 } } }) },
        { "meshes", io::Json::array({ { { "primitives", io::Json::array({ { { "attributes", { { "POSITION", 0 } } }, { "indices", 1 } } }) } } }) },
        { "accessors", io::Json::array({ { { "bufferView", 0 }, { "componentType", 5126 }, { "count", mesh.positions.size() / 3 }, { "type", "VEC3" }, { "min", minimum }, { "max", maximum } },
                           { { "bufferView", 1 }, { "componentType", 5125 }, { "count", mesh.indices.size() }, { "type", "SCALAR" } } }) },
        { "bufferViews", io::Json::array({ { { "buffer", 0 }, { "byteOffset", 0 }, { "byteLength", position_bytes }, { "target", 34962 } }, { { "buffer", 0 }, { "byteOffset", position_bytes }, { "byteLength", index_bytes }, { "target", 34963 } } }) },
        { "buffers", io::Json::array({ { { "byteLength", position_bytes + index_bytes } } }) }
    };
    auto json = gltf.dump();
    json.resize((json.size() + 3) & ~size_t { 3 }, ' ');
    io::Bytes output;
    for (auto value : { 0x46546c67u, 2u, uint32_t(28 + json.size() + position_bytes + index_bytes), uint32_t(json.size()), 0x4e4f534au }) {
        io::append(output, value);
    }
    output.insert(output.end(), json.begin(), json.end());
    io::append(output, uint32_t(position_bytes + index_bytes));
    io::append(output, 0x004e4942u);
    for (auto value : mesh.positions) {
        io::append(output, value);
    }
    for (auto value : mesh.indices) {
        io::append(output, value);
    }
    return output;
}
} // namespace splat_transform::voxel
