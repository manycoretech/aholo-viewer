#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <limits>
#include <pipeline/runner.h>
#include <pipeline/tasks/voxel.h>
#include <sstream>
#include <utility/thread_pool.h>
#include <voxel/voxel.h>
#include <voxel/voxelize.h>

using namespace splat_transform;
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

// Independent voxel-first reference: double precision matrix rotation and a
// serial scan of every Gaussian, without spatial bins, jobs, or early exit.
voxel::Grid reference(const voxel::PreparedData& data, const Eigen::AlignedBox3f& bounds, float resolution, float cutoff) {
    voxel::Grid output({ int(std::lround(bounds.sizes().x() / resolution)), int(std::lround(bounds.sizes().y() / resolution)), int(std::lround(bounds.sizes().z() / resolution)) });
    const double threshold = -std::log1p(-std::min(double(cutoff), 1.0 - 1e-8));
    for (int z = 0; z < output.size[2]; ++z) {
        for (int y = 0; y < output.size[1]; ++y) {
            for (int x = 0; x < output.size[0]; ++x) {
                const Eigen::Vector3i cell { x, y, z };
                const Eigen::Vector3d center = bounds.min().cast<double>() + (Eigen::Vector3d(x, y, z).array() + 0.5).matrix() * resolution;
                float density = 0;
                bool touched = false;
                for (const auto& gaussian : data.gaussians) {
                    const auto& g = gaussian.values;
                    if (!(g[3] > voxel::ALPHA_THRESHOLD)) {
                        continue;
                    }
                    bool inside = true;
                    for (int a = 0; a < 3; ++a) {
                        inside &= cell[a] >= std::floor((g[a] - g[11 + a] - bounds.min()[a]) / resolution) &&
                                  cell[a] <= std::ceil((g[a] + g[11 + a] - bounds.min()[a]) / resolution);
                    }
                    if (!inside) {
                        continue;
                    }
                    const Eigen::Vector3d mean(g[0], g[1], g[2]);
                    const Eigen::Vector3d difference = mean.cwiseMax((center.array() - resolution * 0.5).matrix()).cwiseMin((center.array() + resolution * 0.5).matrix()) - mean;
                    const Eigen::Quaterniond rotation(g[4], g[5], g[6], g[7]);
                    const Eigen::Vector3d local = (rotation.toRotationMatrix().transpose() * difference).cwiseQuotient(Eigen::Vector3d(g[8], g[9], g[10]).cwiseMax(1e-8));
                    const double distance = local.squaredNorm();
                    if (distance <= -2 * std::log(double(voxel::ALPHA_THRESHOLD) / g[3])) {
                        density += float(g[3] * std::exp(-0.5 * distance));
                        touched = true;
                    }
                }
                if (touched && density >= threshold) {
                    output.set(cell);
                }
            }
        }
    }
    return output;
}

void numerical_contracts() {
    const Eigen::AlignedBox3f bounds(Eigen::Vector3f(-2, -1.5f, -1), Eigen::Vector3f(2, 1.5f, 1.5f));
    splat::Splat source(37, 0);
    for (size_t i = 0; i < source.size(); ++i) {
        auto& g = source.gaussians[i];
        g.mean = { float(int(i % 9) - 4) * 0.5625f, float(int(i % 7) - 3) * 0.4375f, float(int(i % 5) - 2) * 0.3125f };
        g.scale = { 0.125f, 0.25f, 0.1875f };
        g.opacity = 0.05f + float(i % 4) * 0.15f;
        g.rotation = Eigen::Quaternionf(Eigen::AngleAxisf(float(i) * 0.2f, Eigen::Vector3f(1, 2, 3).normalized()));
    }
    const auto prepared = voxel::prepare(source);
    for (float cutoff : { 0.0f, 0.1f, 0.7f, 1.0f }) {
        const auto actual = voxel::cpu_backend()->voxelize(prepared, bounds, 0.125f, cutoff);
        const auto expected = reference(prepared, bounds, 0.125f, cutoff);
        require(actual.masks == expected.masks, "CPU batches differ from serial voxel-first density reference");
    }

    splat::Splat weak(2, 0);
    for (auto& g : weak.gaussians) {
        g.mean.setConstant(0.5f);
        g.scale.setConstant(0.125f);
        g.rotation.setIdentity();
        g.opacity = 0.06f;
    }
    const Eigen::AlignedBox3f unit(Eigen::Vector3f::Zero(), Eigen::Vector3f::Constant(1));
    require(voxel::cpu_backend()->voxelize(voxel::prepare(weak), unit, 0.125f, 0.1f).get({ 3, 3, 3 }),
        "Small CPU input lost the accumulated contribution of weak Gaussians");
    splat::Splat opaque(32, 0);
    for (auto& g : opaque.gaussians) {
        g = weak.gaussians.front();
        g.opacity = 1;
    }
    require(voxel::cpu_backend()->voxelize(voxel::prepare(opaque), unit, 0.125f, 1).get({ 3, 3, 3 }),
        "CPU cutoff=1 inherited the GPU density cap");
    for (auto& g : opaque.gaussians) {
        g.opacity = voxel::ALPHA_THRESHOLD;
    }
    require(voxel::cpu_backend()->voxelize(voxel::prepare(opaque), unit, 0.125f, 0).voxel_count() == 0,
        "CPU alpha threshold must exclude negligible Gaussians");
    opaque.gaussians[0].opacity = 1;
    opaque.gaussians[0].scale.x() = std::numeric_limits<float>::quiet_NaN();
    require(voxel::cpu_backend()->voxelize(voxel::prepare(opaque), unit, 0.125f, 0).voxel_count() == 0,
        "CPU candidate generation accepted nonfinite geometry");
    require(voxel::cpu_backend()->voxelize(voxel::prepare({}), unit, 0.125f, 0.1f).voxel_count() == 0,
        "Empty CPU input generated occupied voxels");
}

void scheduling_contracts() {
    splat::Splat source(8201, 0);
    for (size_t i = 0; i < source.size(); ++i) {
        auto& g = source.gaussians[i];
        g.mean = { float(i % 31) * 0.125f, float(i % 13) * 0.125f, float(i % 17) * 0.125f };
        g.scale.setConstant(0.0625f);
        g.opacity = 0.08f;
        g.rotation.setIdentity();
    }
    const auto prepared = voxel::prepare(source);
    const Eigen::AlignedBox3f bounds(Eigen::Vector3f::Constant(-0.5f), Eigen::Vector3f(4.5f, 2.5f, 2.5f));
    const auto expected = voxel::cpu_backend()->voxelize(prepared, bounds, 0.125f, 0.2f);
    require(expected.voxel_count() > 0, "Parallel CPU fixture must contain occupied voxels");
    auto& pool = threading::default_pool();
    // Fill the same pool with parent jobs; each parent submits its own candidate
    // and evaluation work. This catches nested-wait starvation and map races.
    threading::TaskGroup<void> jobs(pool, pool.thread_count());
    for (size_t i = 0; i < pool.thread_count(); ++i) {
        jobs.submit([&] {
            const auto actual = voxel::cpu_backend()->voxelize(prepared, bounds, 0.125f, 0.2f);
            require(actual.masks == expected.masks, "CPU scheduling changed deterministic occupancy");
        });
    }
    for (size_t i = 0; i < jobs.size(); ++i) {
        jobs.get(i);
    }
}

void pipeline_contracts(const std::filesystem::path& directory) {
    splat::Splat source(32, 3);
    for (size_t i = 0; i < source.size(); ++i) {
        auto& g = source.gaussians[i];
        g.mean.setConstant(i < 16 ? 0.25f : 2.25f);
        g.scale.setConstant(0.2f);
        g.opacity = 0.9f;
        g.rotation.setIdentity();
    }
    const Eigen::AlignedBox3f box(Eigen::Vector3f::Constant(-1), Eigen::Vector3f::Constant(4));
    auto prepared = voxel::prepare(source);
    const io::Json selection { { "seed", { { "x", 2.25 }, { "y", 2.25 }, { "z", 2.25 } } }, { "voxelResolution", 0.25 } };
    voxel::filter_cluster(prepared, selection, box, *voxel::cpu_backend());
    require(prepared.gaussians.size() == 16 && prepared.gaussians.front().values[0] == 2.25f,
        "CPU cluster filtering did not use the requested component");
    pipeline::TaskContext context;
    pipeline::VoxelTask task;
    require(task.requires_gpu(io::Json::object(), context), "Voxel default backend must remain GPU");
    require(task.requires_gpu({ { "backend", "gpu" } }, context), "Explicit GPU backend lost device initialization");
    require(!task.requires_gpu({ { "backend", "cpu" } }, context), "CPU backend requires a GPU");
    auto path = [&](const std::string& file) { return io::path_utf8(directory / file); };
    io::write_splat(directory / "source.ply", source, { { "enableMortonSort", false } });
    for (const std::string encoding : { "raw", "compact" }) {
        for (const std::string compression : { "none", "gzip", "zstd" }) {
            const auto name = encoding + '-' + compression;
            const io::Json config { { "input", "source" }, { "output", path(name) }, { "backend", "cpu" },
                { "voxelResolution", 0.125 }, { "filterCluster", selection }, { "autoDenseBox", false },
                { "nodeEncoding", encoding }, { "compression", compression }, { "collisionMesh", encoding == "raw" ? "faces" : "smooth" },
                { "floorFill", true }, { "floorFillDilation", 0.125 }, { "navExteriorRadius", 0.125 },
                { "navSeed", { { "x", 2 }, { "y", 2 }, { "z", 2 } } },
                { "navCapsule", { { "height", 0.125 }, { "radius", 0.125 } } } };
            pipeline::run({ { "version", 1 }, { "gpu", std::numeric_limits<uint32_t>::max() },
                { "tasks", io::Json::array({ { { "type", "Read" }, { "config", { { "inputs", { path("source.ply") } }, { "output", "source" } } } },
                               { { "type", "Voxel" }, { "id", "cpu" }, { "config", config } },
                               { { "type", "Write" }, { "config", { { "input", "source" }, { "output", path("after.ply") }, { "enableMortonSort", false } } } } }) } });
            require(io::read_bytes(directory / "after.ply") == io::read_bytes(directory / "source.ply"), "CPU voxel processing mutated its source resource");
            const auto metadata = io::read_json(directory / name / "voxel-meta.json");
            require(metadata.at("nodeEncoding") == encoding && metadata.at("compression") == compression, "CPU voxel output options were lost");
            require(metadata.at("nodeCount").get<size_t>() > 0 && std::filesystem::exists(directory / name / metadata.at("files")[0].get<std::string>()),
                "CPU pipeline did not write a nonempty octree");
        }
    }
    bool rejected = false;
    try {
        voxel::write(source, directory / "invalid", { { "backend", "other" } });
    } catch (const std::runtime_error& error) {
        rejected = std::string(error.what()).find("backend must be cpu or gpu") != std::string::npos;
    }
    require(rejected, "Invalid voxel backend was not rejected");
}
} // namespace

int main() {
    const auto directory = std::filesystem::temp_directory_path() / ("splat-voxel-cpu-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(directory);
    try {
        numerical_contracts();
        scheduling_contracts();
        pipeline_contracts(directory);
        std::filesystem::remove_all(directory);
        std::cout << "CPU voxel numerical, nested scheduling, and pipeline contracts passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << "\nArtifacts: " << directory << '\n';
        return 1;
    }
}
