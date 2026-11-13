#include <pipeline/tasks/write.h>
#include <utility/logger.h>
#include <utility/thread_pool.h>

namespace splat_transform::pipeline {
using io::Json;
namespace {
io::FileOptions file_options(const Json& config) {
    io::FileOptions options;
    options.version = config.value("version", options.version);
    options.compress_level = config.value("compressLevel", options.compress_level);
    options.palette_size = config.value("paletteSize", options.palette_size);
    options.high_precision = config.value("highPrecision", options.high_precision);
    options.enable_morton_sort = config.value("enableMortonSort", options.enable_morton_sort);
    return options;
}
struct SplatWrite {
    std::filesystem::path path;
    SplatPtr data;
    io::FileOptions options;
    void operator()() const { io::write_splat(path, *data, options); }
};
void write_resource(const Resource& resource, const std::filesystem::path& path, const io::FileOptions& options) {
    const auto output = io::path_utf8(path);
    auto& logger = utility::logger();
    if (const auto* data = std::get_if<SplatPtr>(&resource)) {
        logger.info("writing splat -> file=\"", output, "\" count=", (*data)->size(), " SH=", (*data)->sh_degree);
        io::write_splat(path, **data, options);
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
    auto& pool = threading::default_pool();
    const auto concurrency = pool.thread_count();
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
                io::write_bytes(destination, std::as_bytes(std::span(*text)));
                continue;
            }
            const auto format = io::create_file(destination.extension().string(), options, io::FileOperation::Write);
            SplatWrite write { destination, std::get<SplatPtr>(file.content), options };
            if (file.preserve_order || format->preserve_bundle_order()) {
                write.options.enable_morton_sort = false;
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
    const auto& resource = context.input(config);
    write_resource(resource, io::utf8_path(config.at("output").get<std::string>()), file_options(config));
    if (const auto* files = std::get_if<std::vector<SingleFile>>(&resource)) {
        for (const auto& file : *files) {
            if (file.name == "lod-meta.json" && std::holds_alternative<std::string>(file.content)) {
                context.record_lod_metadata(config, io::utf8_path(config.at("output").get<std::string>()) / io::utf8_path(file.name));
            }
        }
    }
}
bool WriteTask::requires_gpu(const Json& config, const TaskContext& context) const {
    const auto& resource = context.input(config);
    if (std::holds_alternative<SplatPtr>(resource)) {
        return io::create_file(io::utf8_path(config.at("output").get<std::string>()).extension().string(), {}, io::FileOperation::Write)->requires_gpu();
    }
    for (const auto& file : std::get<std::vector<SingleFile>>(resource)) {
        if (std::holds_alternative<SplatPtr>(file.content) && io::create_file(io::utf8_path(file.name).extension().string(), {}, io::FileOperation::Write)->requires_gpu()) {
            return true;
        }
    }
    return false;
}
} // namespace splat_transform::pipeline
