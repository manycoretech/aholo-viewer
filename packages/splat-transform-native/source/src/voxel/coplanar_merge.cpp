#include "grid.h"
#include <Eigen/Core>
#include <Eigen/Geometry>
#include <algorithm>
#include <deque>
#include <numeric>

namespace splat_transform::voxel {
namespace {
struct Triangle {
    std::array<uint32_t, 3> vertices;
    Eigen::Vector3f normal = Eigen::Vector3f::Zero();
    float plane = 0;
    bool alive = true;
};
std::vector<std::array<uint32_t, 3>> triangulate(const std::vector<uint32_t>& polygon, const std::vector<Eigen::Vector2f>& points) {
    const size_t n = polygon.size();
    if (n < 3) {
        return {};
    }
    if (n == 3) {
        return { { polygon[0], polygon[1], polygon[2] } };
    }
    float area = 0;
    for (size_t i = 0; i < n; ++i) {
        area += points[i][0] * points[(i + 1) % n][1] - points[(i + 1) % n][0] * points[i][1];
    }
    if (area <= 0) {
        return {};
    }
    std::vector<size_t> previous(n), next(n);
    for (size_t i = 0; i < n; ++i) {
        previous[i] = (i + n - 1) % n;
        next[i] = (i + 1) % n;
    }
    auto convex = [&](size_t a, size_t b, size_t c) {
        return (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0]) > 0;
    };
    auto inside = [&](size_t p, size_t a, size_t b, size_t c) {
        const auto point = points[p];
        auto cross = [&](size_t u, size_t v) { return (point[0] - points[v][0]) * (points[u][1] - points[v][1]) - (points[u][0] - points[v][0]) * (point[1] - points[v][1]); };
        const float d1 = cross(a, b), d2 = cross(b, c), d3 = cross(c, a);
        return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
    std::vector<std::array<uint32_t, 3>> result;
    size_t count = n, current = 0, stalls = 0;
    while (count > 3) {
        if (stalls > count) {
            return {};
        }
        const size_t p = previous[current], after = next[current];
        bool ear = convex(p, current, after);
        for (size_t other = next[after]; ear && other != p; other = next[other]) {
            if (inside(other, p, current, after)) {
                ear = false;
            }
        }
        if (ear) {
            result.push_back({ polygon[p], polygon[current], polygon[after] });
            next[p] = after;
            previous[after] = p;
            --count;
            current = after;
            stalls = 0;
        } else {
            current = after;
            ++stalls;
        }
    }
    result.push_back({ polygon[previous[current]], polygon[current], polygon[next[current]] });
    return result;
}
} // namespace
Mesh merge_coplanar(const Mesh& mesh, float resolution) {
    const size_t count = mesh.positions.size() / 3;
    if (mesh.indices.empty()) {
        return {};
    }
    auto position = [&](uint32_t index) -> Eigen::Vector3f { return { mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2] }; };
    std::vector<Triangle> triangles;
    std::vector<std::vector<uint32_t>> incident(count);
    auto append = [&](Triangle triangle) {
        const auto index = uint32_t(triangles.size());
        triangles.push_back(triangle);
        if (triangle.alive) {
            for (auto vertex : triangle.vertices) {
                incident[vertex].push_back(index);
            }
        }
    };
    for (size_t i = 0; i < mesh.indices.size(); i += 3) {
        Triangle triangle { { mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2] } };
        const Eigen::Vector3f a = position(triangle.vertices[0]), b = position(triangle.vertices[1]), c = position(triangle.vertices[2]);
        Eigen::Vector3f normal = (b - a).cross(c - a);
        const float length = normal.norm();
        if (length < 1e-12f) {
            triangle.alive = false;
        } else {
            normal /= length;
            triangle.normal = normal;
            triangle.plane = normal.dot(a);
        }
        append(triangle);
    }
    auto coplanar = [&](uint32_t a, uint32_t b) {
        const auto& first = triangles[a];
        const auto& second = triangles[b];
        const float dot = first.normal.dot(second.normal);
        return dot >= 1 - 1e-3f && std::abs(first.plane - second.plane) <= 1e-3f * (resolution + std::max(std::abs(first.plane), std::abs(second.plane)));
    };
    std::deque<uint32_t> queue;
    std::vector<bool> queued(count, true);
    for (uint32_t i = 0; i < count; ++i) {
        queue.push_back(i);
    }
    while (!queue.empty()) {
        const auto vertex = queue.front();
        queue.pop_front();
        queued[vertex] = false;
        const auto& fan = incident[vertex];
        if (fan.size() < 3) {
            continue;
        }
        struct Link {
            uint32_t from, to, triangle;
        };
        std::vector<Link> links;
        bool valid = true;
        for (auto it = fan.rbegin(); it != fan.rend(); ++it) {
            const auto& v = triangles[*it].vertices;
            const int offset = v[0] == vertex ? 0 : v[1] == vertex ? 1
                                                                   : 2;
            Link link { v[(offset + 1) % 3], v[(offset + 2) % 3], *it };
            if (std::ranges::find(links, link.from, &Link::from) != links.end()) {
                valid = false;
                break;
            }
            links.push_back(link);
        }
        if (!valid) {
            continue;
        }
        std::vector<uint32_t> ring, ordered;
        auto current = links.front().from;
        for (size_t step = 0; step < links.size(); ++step) {
            const auto found = std::ranges::find(links, current, &Link::from);
            if (found == links.end()) {
                valid = false;
                break;
            }
            ring.push_back(current);
            ordered.push_back(found->triangle);
            current = found->to;
            if (current == ring.front() && step + 1 < links.size()) {
                valid = false;
                break;
            }
        }
        if (!valid || current != ring.front()) {
            continue;
        }
        struct Arc {
            size_t start, size;
            uint32_t plane;
        };
        std::vector<Arc> arcs;
        bool flat = true;
        for (size_t i = 1; i < ordered.size(); ++i) {
            flat &= coplanar(ordered[0], ordered[i]);
        }
        if (flat) {
            arcs.push_back({ 0, ring.size(), ordered[0] });
        } else {
            std::vector<size_t> transitions;
            for (size_t i = 0; i < ordered.size(); ++i) {
                if (!coplanar(ordered[i], ordered[(i + ordered.size() - 1) % ordered.size()])) {
                    transitions.push_back(i);
                }
            }
            if (transitions.size() != 2) {
                continue;
            }
            const Eigen::Vector3f a = position(ring[transitions[0]]) - position(vertex), b = position(ring[transitions[1]]) - position(vertex);
            if (a.norm() < 1e-12f || b.norm() < 1e-12f || a.dot(b) / (a.norm() * b.norm()) > -1 + 1e-3f) {
                continue;
            }
            arcs.push_back({ transitions[0], transitions[1] - transitions[0] + 1, ordered[transitions[0]] });
            arcs.push_back({ transitions[1], ring.size() - (transitions[1] - transitions[0]) + 1, ordered[transitions[1]] });
        }
        std::vector<Triangle> replacements;
        for (auto arc : arcs) {
            const auto plane = triangles[arc.plane];
            const auto& n = plane.normal;
            Eigen::Vector3f tangent;
            const auto absolute = n.cwiseAbs();
            if (absolute[0] <= absolute[1] && absolute[0] <= absolute[2]) {
                tangent = Eigen::Vector3f(0, -n[2], n[1]);
            } else if (absolute[1] <= absolute[2]) {
                tangent = Eigen::Vector3f(n[2], 0, -n[0]);
            } else {
                tangent = Eigen::Vector3f(-n[1], n[0], 0);
            }
            tangent.normalize();
            const Eigen::Vector3f bitangent = n.cross(tangent);
            std::vector<uint32_t> polygon;
            std::vector<Eigen::Vector2f> projected;
            for (size_t i = 0; i < arc.size; ++i) {
                const auto v = ring[(arc.start + i) % ring.size()];
                polygon.push_back(v);
                const auto p = position(v);
                projected.push_back({ p.dot(tangent), p.dot(bitangent) });
            }
            auto ears = triangulate(polygon, projected);
            if (arc.size < 3 || ears.size() != arc.size - 2) {
                valid = false;
                break;
            }
            for (const auto& triangle : ears) {
                replacements.push_back({ triangle, plane.normal, plane.plane, true });
            }
        }
        if (!valid) {
            continue;
        }
        auto removed = incident[vertex];
        for (auto index : removed) {
            triangles[index].alive = false;
            for (auto other : triangles[index].vertices) {
                if (other != vertex) {
                    std::erase(incident[other], index);
                }
            }
        }
        incident[vertex].clear();
        for (auto triangle : replacements) {
            append(triangle);
        }
        for (auto neighbor : ring) {
            if (!queued[neighbor]) {
                queued[neighbor] = true;
                queue.push_back(neighbor);
            }
        }
    }
    Mesh output;
    std::vector<uint32_t> remap(count, UINT32_MAX);
    for (const auto& triangle : triangles) {
        if (triangle.alive) {
            for (auto vertex : triangle.vertices) {
                remap[vertex] = 0;
            }
        }
    }
    for (size_t i = 0; i < count; ++i) {
        if (remap[i] != UINT32_MAX) {
            remap[i] = uint32_t(output.positions.size() / 3);
            output.positions.insert(output.positions.end(), mesh.positions.begin() + i * 3, mesh.positions.begin() + i * 3 + 3);
        }
    }
    for (const auto& triangle : triangles) {
        if (triangle.alive) {
            for (auto vertex : triangle.vertices) {
                output.indices.push_back(remap[vertex]);
            }
        }
    }
    return output;
}
} // namespace splat_transform::voxel
