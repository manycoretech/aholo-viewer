#include <chrono>
#include <gpu/context.h>
#include <iostream>
#include <limits>
#include <pipeline/runner.h>
#include <pipeline/tasks/voxel.h>
#include <sstream>
#include <voxel/voxel.h>
#include <voxel/voxelize.h>

using namespace splat_transform;
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

class CaptureErrors {
public:
    std::ostringstream output;
    CaptureErrors() : previous_(std::cerr.rdbuf(output.rdbuf())) {}
    ~CaptureErrors() { std::cerr.rdbuf(previous_); }

private:
    std::streambuf* previous_;
};

void resolution_contracts() {
    gpu::DeviceGuard device_guard;
    gpu::select_device(std::numeric_limits<uint32_t>::max());
    pipeline::VoxelTask task;
    pipeline::TaskContext context;
    {
        CaptureErrors errors;
        require(task.requires_gpu(io::Json::object(), context), "GPU requirement query performed fallback before pipeline device selection");
        require(task.requires_gpu({ { "backend", "gpu" } }, context), "Explicit GPU request was lost before device selection");
        require(!task.requires_gpu({ { "backend", "cpu" } }, context), "Explicit CPU processing requires GPU initialization");
        require(!voxel::resolve_backend({ { "backend", "cpu" } })->requires_gpu(), "Explicit CPU backend changed");
        require(errors.output.str().empty(), "GPU requirement query or CPU resolution attempted GPU initialization");
    }
    const auto backend = voxel::resolve_backend(io::Json::object());
    require(!backend->requires_gpu(), "Unavailable GPU did not resolve to the CPU backend");
    require(!voxel::resolve_backend({ { "backend", "gpu" } })->requires_gpu(), "Explicit GPU request did not fall back during resolution");
    splat::Splat source(2, 0);
    for (auto& gaussian : source.gaussians) {
        gaussian.mean.setConstant(0.5f);
        gaussian.scale.setConstant(0.125f);
        gaussian.rotation.setIdentity();
        gaussian.opacity = 0.06f;
    }
    const auto prepared = voxel::prepare(source);
    const Eigen::AlignedBox3f bounds(Eigen::Vector3f::Zero(), Eigen::Vector3f::Ones());
    const auto expected = voxel::cpu_backend()->voxelize(prepared, bounds, 0.125f, 0.1f);
    require(expected.voxel_count() > 0, "Fallback fixture must accumulate weak Gaussian contributions");
    {
        CaptureErrors errors;
        const auto result = backend->voxelize(prepared, bounds, 0.125f, 0.1f);
        require(result.masks == expected.masks, "Resolved backend changed CPU geometry or thresholds");
        require(backend->dilate(result, { 1, 2, 1 }).masks == voxel::cpu_backend()->dilate(expected, { 1, 2, 1 }).masks,
            "Resolved backend did not keep navigation on CPU");
        require(errors.output.str().empty(), "Resolved CPU backend attempted GPU processing later");
    }
    bool rejected = false;
    try {
        voxel::resolve_backend({ { "backend", "other" } });
    } catch (const std::runtime_error& error) {
        rejected = std::string_view(error.what()) == "Voxel backend must be cpu or gpu";
    }
    require(rejected, "Invalid backend was silently converted to CPU");
}

void pipeline_contracts(const std::filesystem::path& directory) {
    splat::Splat source(32, 0);
    for (size_t i = 0; i < source.size(); ++i) {
        auto& gaussian = source.gaussians[i];
        gaussian.mean.setConstant(i < 16 ? 0.25f : 2.25f);
        gaussian.scale.setConstant(0.2f);
        gaussian.rotation.setIdentity();
        gaussian.opacity = 0.9f;
    }
    const auto path = [&](const std::string& relative) { return io::path_utf8(directory / relative); };
    io::write_splat(directory / "source.ply", source);
    for (bool filter : { false, true }) {
        const std::string suffix = filter ? "filter" : "main";
        io::Json config { { "input", "source" }, { "backend", "cpu" }, { "voxelResolution", 0.125 }, { "autoDenseBox", false },
            { "filterCluster", filter ? io::Json { { "seed", { { "x", 2.25 }, { "y", 2.25 }, { "z", 2.25 } } }, { "voxelResolution", 0.25 } } : io::Json(false) },
            { "nodeEncoding", "compact" }, { "compression", "gzip" }, { "collisionMesh", "faces" },
            { "floorFill", true }, { "floorFillDilation", 0.125 }, { "navExteriorRadius", 0.125 },
            { "navSeed", { { "x", 2 }, { "y", 2 }, { "z", 2 } } },
            { "navCapsule", { { "height", 0.125 }, { "radius", 0.125 } } } };
        for (const std::string backend : { "cpu", "gpu", "default" }) {
            const auto name = backend + '-' + suffix;
            config["output"] = path(name);
            if (backend == "default") {
                config.erase("backend");
            } else {
                config["backend"] = backend;
            }
            // The invalid adapter guarantees an initialization failure even if
            // the missing-driver environment is not honored by the host loader.
            std::string warnings;
            {
                CaptureErrors errors;
                pipeline::run({ { "version", 1 }, { "gpu", std::numeric_limits<uint32_t>::max() },
                    { "tasks", io::Json::array({ { { "type", "Read" }, { "config", { { "inputs", { path("source.ply") } }, { "output", "source" } } } },
                                   { { "type", "Voxel" }, { "id", name }, { "config", config } } }) } });
                warnings = errors.output.str();
            }
            const auto warning = warnings.find("Voxel GPU initialization failed; using CPU for this task");
            require(backend == "cpu" ? warning == std::string::npos : warning != std::string::npos,
                "Voxel task did not report backend resolution correctly");
            require(warning == std::string::npos || warnings.find("Voxel GPU initialization failed", warning + 1) == std::string::npos,
                "Voxel task attempted GPU initialization again after resolving CPU");
            const auto metadata = io::read_json(directory / name / "voxel-meta.json");
            require(metadata.at("nodeCount").get<size_t>() > 0, "Fallback pipeline must write a nonempty octree");
            if (backend == "cpu") {
                continue;
            }
            const auto expected = io::read_json(directory / ("cpu-" + suffix) / "voxel-meta.json");
            require(metadata == expected, "Fallback pipeline metadata differs from explicit CPU output");
            for (const auto& file : metadata.at("files")) {
                const auto filename = io::utf8_path(file.get<std::string>());
                require(io::read_bytes(directory / name / filename) == io::read_bytes(directory / ("cpu-" + suffix) / filename),
                    "Fallback pipeline binary differs from explicit CPU output");
            }
            require(io::read_bytes(directory / name / "collision.glb") == io::read_bytes(directory / ("cpu-" + suffix) / "collision.glb"),
                "Fallback navigation or mesh output differs from explicit CPU output");
        }
    }
    bool rejected = false;
    try {
        voxel::write(source, directory / "invalid", { { "backend", "gpu" }, { "compression", "invalid" } });
    } catch (const std::runtime_error& error) {
        rejected = std::string_view(error.what()) == "Invalid voxel compression";
    }
    require(rejected, "Invalid configuration was hidden by GPU fallback");
}
} // namespace

int main() {
    const auto directory = std::filesystem::temp_directory_path() / ("splat-voxel-fallback-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(directory);
    try {
        resolution_contracts();
        pipeline_contracts(directory);
        const auto cleanup = std::filesystem::weakly_canonical(directory);
        require(cleanup.parent_path() == std::filesystem::weakly_canonical(std::filesystem::temp_directory_path()), "Unexpected test cleanup directory");
        std::filesystem::remove_all(cleanup);
        std::cout << "Voxel backend resolution and unavailable-GPU pipeline contracts passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << "\nArtifacts: " << directory << '\n';
        return 1;
    }
}
