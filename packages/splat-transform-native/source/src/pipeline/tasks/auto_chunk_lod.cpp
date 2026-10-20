#include "../lod_support.h"
#include <iomanip>
#include <pipeline/tasks/auto_chunk_lod.h>
#include <unordered_map>
#include <unordered_set>
#include <utility/logger.h>
namespace splat_transform::pipeline {
using io::Json;
namespace {
std::vector<SingleFile> chunk_lod(splat::Splat source, const Json& config) {
    const Json defaults = Json::array({ { { "precision", 1.0f }, { "scaleBoost", 1.0f } }, { { "precision", 0.5f }, { "scaleBoost", 1.0f } },
        { { "precision", 0.25f }, { "scaleBoost", 1.0f } },
        { { "precision", 0.05f }, { "scaleBoost", 1.01f }, { "permanent", true }, { "merged", true } },
        { { "precision", 0.01f }, { "scaleBoost", 1.02f }, { "permanent", true }, { "merged", true } } });
    const auto levels = config.value("levels", defaults);
    const auto type = config.at("type").get<std::string>();
    const auto max_count = number(config, "maxChunkCounts", 400000);
    if (max_count < 1) {
        throw std::runtime_error("maxChunkCounts must be positive");
    }
    const auto source_count = source.size();
    const auto source_degree = source.sh_degree;
    const auto forward = splat::dense_bounds(source, 0.8f);
    auto& logger = utility::logger();
    logger.info("generate lod");
    auto elapsed = logger.time("generate elapsed");
    auto blocked = generate(std::move(source), levels, source_count ? std::min(1.0f, max_count / source_count) : 1, split_normal(config));
    elapsed.finish();
    struct Layout {
        size_t file;
        size_t offset;
        size_t count;
    };
    std::unordered_map<uint32_t, Layout> layout;
    std::vector<SingleFile> files;
    for (size_t level = levels.size(); level-- > 0;) {
        if (!levels[level].value("merged", false)) {
            continue;
        }
        std::vector<uint32_t> refs;
        std::unordered_set<uint32_t> seen;
        for (const auto& block : blocked.blocks) {
            const auto ref = block.references[level];
            if (!layout.contains(ref) && seen.insert(ref).second) {
                refs.push_back(ref);
            }
        }
        if (refs.empty()) {
            continue;
        }
        std::vector<splat::Splat> parts;
        size_t offset = 0;
        for (auto ref : refs) {
            auto& part = blocked.splats[ref];
            layout.emplace(ref, Layout { files.size(), offset, part.size() });
            offset += part.size();
            parts.push_back(std::move(part));
        }
        files.push_back({ "chunk_" + std::to_string(files.size()) + "." + type, std::make_shared<splat::Splat>(splat::combine(std::move(parts))), true });
    }
    for (uint32_t ref = 0; ref < blocked.splats.size(); ++ref) {
        if (layout.contains(ref)) {
            continue;
        }
        layout.emplace(ref, Layout { files.size(), 0, blocked.splats[ref].size() });
        files.push_back({ "chunk_" + std::to_string(files.size()) + "." + type, std::make_shared<splat::Splat>(std::move(blocked.splats[ref])) });
    }
    Json tree = Json::array();
    std::unordered_set<size_t> permanent;
    for (const auto& block : blocked.blocks) {
        Json lods = Json::array();
        for (size_t level = 0; level < levels.size(); ++level) {
            const auto& location = layout.at(block.references[level]);
            lods.push_back({ { "file", location.file }, { "offset", location.offset }, { "count", location.count } });
            if (levels[level].value("permanent", false)) {
                permanent.insert(location.file);
            }
        }
        tree.push_back({ { "bound", io::bounds_json(block.bounds) }, { "lods", lods } });
    }
    Json names = Json::array();
    for (const auto& file : files) {
        names.push_back(file.name);
    }
    logger.info("Total blocks: ", tree.size(), ", files: ", files.size());
    logger.info("Gaussian per level: ");
    size_t count_width = 0;
    for (size_t level = 0; level < levels.size(); ++level) {
        size_t count = 0;
        for (const auto& block : blocked.blocks) {
            count += layout.at(block.references[level]).count;
        }
        const auto count_text = std::to_string(count);
        count_width = std::max(count_width, count_text.size());
        logger.info('\t', "Level ", level, std::setw(9), '(' + utility::fixed(levels[level].at("precision").get<float>() * 100) + "%)",
            ": ", std::setw(static_cast<int>(count_width)), count_text,
            std::setw(9), '(' + utility::fixed(float(count) / source_count * 100) + "%)");
    }
    Json meta { { "magicCode", 0x262834 }, { "type", "lod-splat" }, { "version", "1.0" }, { "counts", source_count },
        { "shDegree", source_degree }, { "levels", levels.size() }, { "forwardBox", io::bounds_json(forward) },
        { "files", names }, { "permanentFiles", permanent }, { "tree", tree } };
    files.insert(files.begin(), { "lod-meta.json", meta.dump() });
    return files;
}
} // namespace
void AutoChunkLodTask::exec(const Json& config, TaskContext& context) const {
    utility::logger().info("loaded -> \"", config.at("input").get<std::string>(), '"');
    context.set(config, chunk_lod(context.take_splat(config), config));
}
} // namespace splat_transform::pipeline
