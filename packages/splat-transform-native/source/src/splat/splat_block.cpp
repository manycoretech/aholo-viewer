#include <Eigen/Dense>
#include <algorithm>
#include <array>
#include <iterator>
#include <numeric>
#include <queue>
#include <ranges>
#include <splat/splat_block.h>
#include <utility>
#include <vector>

namespace splat_transform::splat {
namespace {
struct RefSplat {
    splat::Splat& source;
    std::vector<size_t> gaussians;
    Eigen::AlignedBox3f box;
    bool need_split;

    RefSplat(splat::Splat& splat) : source(splat), box(splat.bounding_box), need_split(true) {
        gaussians.resize(splat.gaussians.size());
        std::iota(gaussians.begin(), gaussians.end(), size_t(0));
    }
    RefSplat(RefSplat& splat) : source(splat.source), need_split(true) {}
    RefSplat(RefSplat&& splat) = default;

    void compute_bounding_box() {
        this->box = Eigen::AlignedBox3f();
        for (auto index : this->gaussians) {
            this->box.extend(this->source.gaussians[index].bounding_box());
        }
    }

    void compute_need_split(const Eigen::AlignedBox3f& parent_box, size_t max_block_size) {
        this->need_split = this->gaussians.size() > max_block_size &&
                           ((this->box.min() - parent_box.min()).norm() > 0.001f ||
                               (this->box.max() - parent_box.max()).norm() > 0.001f);
    }

    splat::Splat to_owned() {
        std::vector<splat::Gaussian> gaussians;
        gaussians.reserve(this->gaussians.size());
        for (auto index : this->gaussians) {
            // Each source index belongs to exactly one leaf block.
            gaussians.push_back(std::move(this->source.gaussians[index]));
        }
        {
            auto _ = std::move(this->gaussians);
        }
        splat::Splat result;
        result.gaussians = std::move(gaussians);
        result.bounding_box = this->box;
        result.sh_degree = source.sh_degree;
        return result;
    }
};

// Eigen's CornerType is dim bit encoded.
// bit_n indicates max(1) or min(0) on dim_n.
constexpr std::array<Eigen::AlignedBox3f::CornerType, 8> BOX_CORNERS = {
    Eigen::AlignedBox3f::CornerType::BottomLeftFloor,
    Eigen::AlignedBox3f::CornerType::BottomRightFloor,
    Eigen::AlignedBox3f::CornerType::TopLeftFloor,
    Eigen::AlignedBox3f::CornerType::TopRightFloor,
    Eigen::AlignedBox3f::CornerType::BottomLeftCeil,
    Eigen::AlignedBox3f::CornerType::BottomRightCeil,
    Eigen::AlignedBox3f::CornerType::TopLeftCeil,
    Eigen::AlignedBox3f::CornerType::TopRightCeil
};

std::vector<Eigen::AlignedBox3f> split_box(const Eigen::AlignedBox3f& box, splat::block::SplitNormal normal) {
    Eigen::Vector3f center = box.center();
    auto result = std::vector<Eigen::AlignedBox3f>();

    auto create_box = [&center, &box](Eigen::AlignedBox3f::CornerType corner_type) -> Eigen::AlignedBox3f {
        return Eigen::AlignedBox3f().extend(center).extend(box.corner(corner_type));
    };

    if (normal == splat::block::SplitNormal::None) {
        result.reserve(8);
        std::ranges::transform(BOX_CORNERS, std::back_inserter(result), create_box);
    } else {
        auto dim = static_cast<size_t>(normal) - 1;
        auto flag = 1 << dim;
        center[dim] = box.min()[dim]; // always min in normal dim.
        result.reserve(4);

        // construct splitted from min on dim corner, and max on dim corner.
        // for input dim SplitNormal.X.
        // the filtered corner was [BottomRightFloor, TopRightFloor, BottomRightCeil, TopRightCeil].
        std::ranges::transform(BOX_CORNERS | std::views::filter([flag](Eigen::AlignedBox3f::CornerType corner_type) {
            return (corner_type & flag) != 0;
        }),
            std::back_inserter(result), create_box);
    }
    return result;
}

std::vector<std::pair<size_t, size_t>> find_mergeable_pairs(
    const std::vector<RefSplat>& splats, size_t max_block_size) {
    std::vector<bool> unavailable(splats.size(), false);
    std::vector<std::pair<size_t, size_t>> current;
    std::vector<std::pair<size_t, size_t>> best;

    // from index search max available pairs.
    auto search = [&](auto&& self, size_t index) -> void {
        while (index < splats.size() && unavailable[index]) {
            index++;
        }
        if (index == splats.size()) {
            if (current.size() > best.size()) {
                best = current;
            }
            return;
        }

        unavailable[index] = true;
        if (!splats[index].need_split && !splats[index].gaussians.empty()) {
            // Split boxes follow hypercube corner order. Toggling one index bit selects a face neighbor.
            for (size_t neighbor_mask = 1; neighbor_mask < splats.size(); neighbor_mask <<= 1) {
                auto neighbor = index ^ neighbor_mask;
                if (!unavailable[neighbor] && !splats[neighbor].need_split && !splats[neighbor].gaussians.empty() &&
                    splats[index].gaussians.size() + splats[neighbor].gaussians.size() <= max_block_size) {
                    unavailable[neighbor] = true;
                    current.emplace_back(index, neighbor);
                    self(self, index + 1);
                    current.pop_back();
                    unavailable[neighbor] = false;
                }
            }
        }
        self(self, index + 1);
        unavailable[index] = false;
    };

    search(search, 0);
    return best;
}

std::vector<RefSplat> split_block(RefSplat& splat, size_t max_block_size, splat::block::SplitNormal normal) {
    auto boxes = split_box(splat.box, normal);
    std::vector<RefSplat> result;

    result.reserve(boxes.size());

    for (auto i = 0; i < boxes.size(); i++) {
        result.emplace_back(splat);
    }

    for (auto& r : result) {
        r.gaussians.reserve(splat.gaussians.size() / 4);
    }

    for (auto index : splat.gaussians) {
        const auto box = splat.source.gaussians[index].bounding_box();
        auto max_interaction = 0.0f;
        auto max_interaction_index = 0;
        for (auto i = 0; i < boxes.size(); i++) {
            auto intersection = boxes[i].intersection(box);
            if (!intersection.isEmpty()) {
                auto current = intersection.volume();
                if (current > max_interaction) {
                    max_interaction = current;
                    max_interaction_index = i;
                }
            }
        }
        result[max_interaction_index].gaussians.push_back(index);
    }

    for (auto i = 0; i < result.size(); i++) {
        result[i].box = boxes[i];
        result[i].compute_need_split(splat.box, max_block_size);
    }

    // try merge small block neighbors
    for (auto [i, n] : find_mergeable_pairs(result, max_block_size)) {
        result[i].gaussians.reserve(result[i].gaussians.size() + result[n].gaussians.size());
        // merge neighbor
        std::ranges::copy(result[n].gaussians, std::back_inserter(result[i].gaussians));
        result[i].box.extend(result[n].box);
        // cleanup neighbor result
        result[n].box.setEmpty();
        result[n].gaussians.clear();
    }

    return result;
}
} // namespace
} // namespace splat_transform::splat

namespace splat_transform::splat::block {
std::vector<Splat> split(Splat&& splat, float precision, SplitNormal normal) {
    const auto max_block_size = static_cast<size_t>(static_cast<float>(splat.gaussians.size()) * precision);
    std::vector<Splat> results;
    if (splat.gaussians.size() <= max_block_size) {
        results.emplace_back(std::move(splat));
        return results;
    }

    std::queue<RefSplat> queue;
    queue.emplace(splat);

    while (!queue.empty()) {
        auto r = std::move(queue.front());
        queue.pop();
        if (r.need_split) {
            for (auto& splitted : split_block(r, max_block_size, normal)) {
                queue.emplace(std::move(splitted));
            }
        } else if (r.gaussians.size() > 0) {
            auto&& result = r.to_owned();
            // use compacted bonding box to reduce outlier
            result.compute_compact_bounding_box();
            results.emplace_back(std::move(result));
        }
    }

    return results;
}
} // namespace splat_transform::splat::block
