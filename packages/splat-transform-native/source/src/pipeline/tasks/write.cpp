#include "../lod_support.h"
#include <pipeline/tasks/write.h>
#include <utility/logger.h>
#include <utility/thread_pool.h>

namespace splat_transform::pipeline {
using io::Json;
namespace {
struct SplatWrite {
    std::filesystem::path path;
    SplatPtr data;
    Json options;
    void operator()() const { io::write_splat(path, *data, options); }
};
void write_resource(const Resource& resource, const Json& config) {
    const auto output = config.at("output").get<std::string>();
    const auto path = io::utf8_path(output);
    auto& logger = utility::logger();
    if (const auto* data = std::get_if<SplatPtr>(&resource)) {
        logger.info("writing splat -> file=\"", output, "\" count=", (*data)->size(), " SH=", (*data)->sh_degree);
        io::write_splat(path, **data, config);
        logger.info("writing done");
        return;
    }
    const auto absolute = std::filesystem::absolute(path).lexically_normal();
    if (absolute == absolute.root_path() || absolute == std::filesystem::current_path()) {
        throw std::runtime_error("Refusing to replace the root or current directory");
    }
    if (std::filesystem::exists(path)) {
        std::filesystem::remove_all(path);
        logger.info("exist dir ", output, ", removed");
    }
    std::filesystem::create_directories(path);
    const auto& files = std::get<std::vector<SingleFile>>(resource);
    const auto parallel = std::max(1, int(number(config, "parallelCounts", std::max(1, int(std::thread::hardware_concurrency()) - 1))));
    auto& pool = threading::default_pool();
    const auto concurrency = std::min(size_t(parallel), pool.thread_count());
    logger.info("writing bundle -> dir=\"", output, "\" files=", files.size());
    {
        auto quiet = logger.silence();
        threading::TaskGroup<void> pending(pool, files.size());
        std::vector<SplatWrite> gpu_files;
        size_t index = 0;
        auto progress = [&](const std::filesystem::path& file) {
            logger.progress("- ", io::path_utf8(file.lexically_normal()), " (", ++index, '/', files.size(), ')');
        };
        for (const auto& file : files) {
            const auto destination = path / io::utf8_path(file.name);
            if (const auto* text = std::get_if<std::string>(&file.content)) {
                progress(destination);
                io::write_bytes(destination, { reinterpret_cast<const uint8_t*>(text->data()), text->size() });
                continue;
            }
            const auto format = io::create_file(destination.extension().string(), config, io::FileOperation::Write);
            SplatWrite write { destination, std::get<SplatPtr>(file.content), config };
            if (file.preserve_order || format->preserve_bundle_order()) {
                write.options["enableMortonSort"] = false;
            }
            if (format->requires_gpu()) {
                gpu_files.push_back(std::move(write));
                continue;
            }
            progress(destination);
            if (pending.size() >= concurrency) {
                pending.get(pending.size() - concurrency);
            }
            pending.submit(std::move(write));
        }
        for (size_t i = pending.size() > concurrency ? pending.size() - concurrency : 0; i < pending.size(); ++i) {
            pending.get(i);
        }
        for (const auto& write : gpu_files) {
            progress(write.path);
            write();
        }
    }
    logger.info("writing bundle done -> dir=\"", output, "\" files=", files.size());
}
} // namespace
void WriteTask::exec(const Json& config, TaskContext& context) const {
    write_resource(context.input(config), config);
}
bool WriteTask::requires_gpu(const Json& config, const TaskContext& context) const {
    const auto& resource = context.input(config);
    if (std::holds_alternative<SplatPtr>(resource)) {
        return io::create_file(io::utf8_path(config.at("output").get<std::string>()).extension().string(), config, io::FileOperation::Write)->requires_gpu();
    }
    for (const auto& file : std::get<std::vector<SingleFile>>(resource)) {
        if (std::holds_alternative<SplatPtr>(file.content) && io::create_file(io::utf8_path(file.name).extension().string(), config, io::FileOperation::Write)->requires_gpu()) {
            return true;
        }
    }
    return false;
}
} // namespace splat_transform::pipeline
