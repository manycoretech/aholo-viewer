#include "../lod_support.h"
#include <numeric>
#include <pipeline/tasks/skeleton_lod.h>
#include <utility/logger.h>

namespace splat_transform::pipeline {
using io::Json;
namespace {
splat::Splat skeleton(const splat::Splat& data, const Json& config) {
    const size_t target = target_count(data, config, 0.1f, 85000);
    if (!target || !data.size()) {
        return splat::Splat(0, 0);
    }
    auto group = [&](std::span<const uint32_t> indices, const Eigen::Vector3f& origin, const Eigen::Vector3f& scale) {
        std::map<std::array<int64_t, 3>, size_t> lookup;
        std::vector<std::vector<uint32_t>> groups;
        for (auto index : indices) {
            std::array<int64_t, 3> key;
            for (size_t c = 0; c < 3; ++c) {
                key[c] = static_cast<int64_t>((data.gaussians[index].attribute(c) - origin[c]) * scale[c]);
            }
            auto [entry, inserted] = lookup.emplace(key, groups.size());
            if (inserted) {
                groups.emplace_back();
            }
            groups[entry->second].push_back(index);
        }
        return groups;
    };
    std::vector<uint32_t> indices(data.size());
    std::iota(indices.begin(), indices.end(), 0);
    auto groups = group(indices, splat::bounds(data).min(), { 50, 50, 50 });
    float ratio = 0;
    for (const auto& block : groups) {
        ratio += std::pow(float(block.size()), 1.3f);
    }
    ratio /= target * 0.1f;
    std::vector<std::vector<uint32_t>> merged;
    for (auto& block : groups) {
        const size_t size = std::max<size_t>(1, static_cast<size_t>(std::ceil(std::pow(float(block.size()), 1.3f) / ratio)));
        if (size == 1) {
            merged.push_back(std::move(block));
            continue;
        }
        const auto box = splat::bounds(data, block);
        const float count = std::ceil(std::cbrt(float(size)));
        const Eigen::Vector3f scale = count / box.sizes().array().max(1e-9f);
        auto subgroups = group(block, box.min(), scale);
        if (subgroups.size() > size) {
            std::ranges::stable_sort(subgroups, std::ranges::greater {}, &std::vector<uint32_t>::size);
            subgroups.resize(size);
        }
        for (auto& subgroup : subgroups) {
            merged.push_back(std::move(subgroup));
        }
    }
    if (merged.size() > target) {
        std::ranges::stable_sort(merged, std::ranges::greater {}, &std::vector<uint32_t>::size);
        merged.resize(target);
    }
    splat::Splat output(merged.size(), 0);
    for (size_t i = 0; i < merged.size(); ++i) {
        output.gaussians[i].attribute(splat::ScaleX) = output.gaussians[i].attribute(splat::ScaleZ) = 0.005f;
        output.gaussians[i].attribute(splat::QuatW) = 1;
        // Preserve the existing loading-LOD data layout, including its zero Y scale.
        for (size_t c : { size_t(splat::X), size_t(splat::Y), size_t(splat::Z), size_t(splat::Red), size_t(splat::Green), size_t(splat::Blue), size_t(splat::Alpha) }) {
            float sum = 0;
            for (auto index : merged[i]) {
                sum += data.gaussians[index].attribute(c);
            }
            output.gaussians[i].attribute(c) = static_cast<float>(sum / merged[i].size());
        }
    }
    return output;
}
} // namespace
void SkeletonLodTask::exec(const Json& config, TaskContext& context) const {
    auto& logger = utility::logger();
    logger.info("loaded -> \"", config.at("input").get<std::string>(), '"');
    context.set(config, std::make_shared<splat::Splat>(skeleton(*context.splat_ptr(config), config)));
    logger.info("stored -> key=\"", config.at("output").get<std::string>(), '"');
}
} // namespace splat_transform::pipeline
