#include <array>
#include <container_helpers.h>
#include <eigen3/Eigen/Dense>
#include <queue>
#include <ranges>
#include <splat/splat_block.h>
#include <utility>
#include <vector>

namespace {
struct RefSplat {
    const splat::Splat& source;
    std::vector<size_t> gaussians;
    Eigen::AlignedBox3f box;
    bool need_split;

    RefSplat(const splat::Splat& splat) : source(splat), box(splat.bounding_box), need_split(true) {
        this->gaussians.reserve(splat.gaussians.size());
        for (auto i = 0; i < splat.gaussians.size(); i++) {
            this->gaussians.push_back(i);
        }
    }
    RefSplat(RefSplat& splat) : source(splat.source), need_split(true) {}
    RefSplat(RefSplat&& splat) = default;

    void compute_bounding_box() {
        this->box = Eigen::AlignedBox3f();
        for (auto index : this->gaussians) {
            this->box.extend(this->source.gaussians[index].bounding_box);
        }
    }

    void compute_need_split(const Eigen::AlignedBox3f& parent_box, size_t max_block_size) {
        this->need_split = this->gaussians.size() > max_block_size &&
                           ((this->box.min() - parent_box.min()).norm() > 0.001 ||
                               (this->box.max() - parent_box.max()).norm() > 0.001);
    }

    splat::Splat to_owned() {
        std::vector<splat::Gaussian> gaussians;
        std::vector<float> sh;
        gaussians.reserve(this->gaussians.size());
        for (auto index : this->gaussians) {
            gaussians.push_back(this->source.gaussians[index]);
        }
        {
            auto _ = std::move(this->gaussians);
        }
        auto result = splat::Splat {
            .gaussians = std::move(gaussians),
            .bounding_box = this->box,
        };
        result.compute_compact_bounding_box();
        return result;
    }
};

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
    if (normal == splat::block::SplitNormal::None) {
        return {
            Eigen::AlignedBox3f().extend(center).extend(box.corner(Eigen::AlignedBox3f::CornerType::BottomLeftFloor)),
            Eigen::AlignedBox3f().extend(center).extend(box.corner(Eigen::AlignedBox3f::CornerType::BottomRightFloor)),
            Eigen::AlignedBox3f().extend(center).extend(box.corner(Eigen::AlignedBox3f::CornerType::TopLeftFloor)),
            Eigen::AlignedBox3f().extend(center).extend(box.corner(Eigen::AlignedBox3f::CornerType::TopRightFloor)),
            Eigen::AlignedBox3f().extend(center).extend(box.corner(Eigen::AlignedBox3f::CornerType::BottomLeftCeil)),
            Eigen::AlignedBox3f().extend(center).extend(box.corner(Eigen::AlignedBox3f::CornerType::BottomRightCeil)),
            Eigen::AlignedBox3f().extend(center).extend(box.corner(Eigen::AlignedBox3f::CornerType::TopLeftCeil)),
            Eigen::AlignedBox3f().extend(center).extend(box.corner(Eigen::AlignedBox3f::CornerType::TopRightCeil)),
        };
    } else {
        auto dim = static_cast<size_t>(normal) - 1;
        auto flag = 1 << dim;
        center[dim] = box.min()[dim]; // always min in normal dim.
        auto result = std::vector<Eigen::AlignedBox3f>();
        result.reserve(4);
        helpers::container::append_range(result, BOX_CORNERS | std::views::filter([flag](Eigen::AlignedBox3f::CornerType corner_type) -> bool {
            return corner_type & flag != 0;
        }) | std::views::transform([&center, &box](Eigen::AlignedBox3f::CornerType corner_type) -> Eigen::AlignedBox3f {
            return Eigen::AlignedBox3f().extend(center).extend(box.corner(corner_type));
        }));
        return result;
    }
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
        auto& box = splat.source.gaussians[index].bounding_box;
        auto max_interaction = 0.0;
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

    return result;
}
} // namespace

namespace splat::block::detail {
std::vector<Splat> split(const Splat& splat, size_t max_block_size, SplitNormal normal) {
    if (splat.gaussians.size() <= max_block_size) {
        return std::vector({ splat });
    }

    std::queue<RefSplat> queue;
    std::vector<Splat> results;
    queue.emplace(splat);

    while (!queue.empty()) {
        auto r = std::move(queue.front());
        queue.pop();
        if (r.need_split) {
            for (auto& splitted : split_block(r, max_block_size, normal)) {
                queue.emplace(std::move(splitted));
            }
        } else if (r.gaussians.size() > 0) {
            results.emplace_back(r.to_owned());
        }
    }

    return results;
}
} // namespace splat::block::detail
