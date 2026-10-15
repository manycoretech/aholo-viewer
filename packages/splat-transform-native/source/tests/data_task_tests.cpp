#include <chrono>
#include <cmath>
#include <codec/codec.h>
#include <iostream>
#include <numeric>
#include <pipeline/runner.h>
#include <pipeline/task.h>

using namespace splat_transform;
using io::Json;
namespace {
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
template<typename F>
void rejects(F&& action) {
    bool failed = false;
    try {
        action();
    } catch (const std::exception&) {
        failed = true;
    }
    require(failed, "Invalid task input was accepted");
}
std::shared_ptr<splat::Splat> cloud(size_t count, unsigned degree, float base = 0) {
    auto result = std::make_shared<splat::Splat>(count, degree);
    for (size_t i = 0; i < count; ++i) {
        auto& point = result->gaussians[i];
        point.mean = { base + float(i % 16) * 0.02f, float(i / 16) * 0.02f, float(i % 7) * 0.01f };
        point.scale = { 0.125f, 0.25f, 0.0625f };
        point.rotation.w() = 1;
        point.opacity = 0.75f;
        for (size_t c = 0; c < point.sh.size(); ++c) {
            point.sh[c] = c < 3 ? 0.25f + float(i % 4) * 0.125f : float(std::sin(i + c) * 0.05);
        }
    }
    result->block_offsets = { 0 };
    result->block_counts = { count };
    result->compute_bounding_box();
    return result;
}
void equal_point(const splat::Gaussian& actual, const splat::Gaussian& expected) {
    require(actual.sh.size() == expected.sh.size(), "SH storage size changed");
    for (size_t c = 0; c < splat::ShOffset + actual.sh.size() - 3; ++c) {
        require(actual.attribute(c) == expected.attribute(c), "A complete Gaussian attribute changed");
    }
}
void equal_data(const splat::Splat& actual, const splat::Splat& expected) {
    require(actual.size() == expected.size() && actual.sh_degree == expected.sh_degree, "Splat size or SH degree changed");
    for (size_t i = 0; i < actual.size(); ++i) {
        equal_point(actual.gaussians[i], expected.gaussians[i]);
    }
}
void single_block(const splat::Splat& data) {
    require(data.block_offsets == std::vector<size_t> { 0 } && data.block_counts == std::vector<size_t> { data.size() }, "Output is not a single block");
    if (!data.size()) {
        require(data.bounding_box.isEmpty(), "Empty result has nonempty bounds");
    }
    for (const auto& point : data.gaussians) {
        require(data.bounding_box.contains(point.mean - 3 * point.scale.cwiseAbs()), "Bounds omit a Gaussian minimum");
        require(data.bounding_box.contains(point.mean + 3 * point.scale.cwiseAbs()), "Bounds omit a Gaussian maximum");
    }
}
void save_json(const std::filesystem::path& path, const Json& value) {
    const auto text = value.dump();
    io::write_bytes(path, { reinterpret_cast<const uint8_t*>(text.data()), text.size() });
}
void put_resource(pipeline::TaskContext& context, const char* name, pipeline::Resource resource) {
    context.set({ { "output", name } }, std::move(resource));
}
const pipeline::SplatPtr& get(const pipeline::TaskContext& context, const char* name) {
    return context.splat_ptr({ { "input", name } });
}
void task(std::string_view name, const Json& config, pipeline::TaskContext& context, const Json& release = Json::array()) {
    context.begin_task(release);
    pipeline::create_task(name)->exec(config, context);
    context.finish_task();
}

void modify_contracts(const std::filesystem::path& directory) {
    const auto patch = directory / "modify.json";
    const Json transform = Json::array({ 1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1 });
    save_json(patch, { { "transform", transform }, { "deletedIndices", { 2 } },
                         { "indicesTransform", Json::array({ { { "indices", { 2 } }, { "transform", Json::array({ 0, -2, 0, 0, 2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1 }) } } }) } });
    for (unsigned degree = 0; degree <= 3; ++degree) {
        for (const Json& extension : { Json::object(), Json { { "rgba", { -0.5, 0.25, 2.0, 1.25 } } }, Json { { "maxShDegree", 0 } }, Json { { "rgba", { 0, 0, 0, 1 } }, { "maxShDegree", 1 } } }) {
            auto source = cloud(4, degree);
            pipeline::TaskContext context;
            put_resource(context, "source", source);
            put_resource(context, "alias", source);
            auto expected = *source;
            const Json original { { "input", "source" }, { "output", "result" }, { "modifyPaths", { io::path_utf8(patch) } } };
            pipeline::modify(expected, original);
            if (extension.contains("rgba")) {
                for (auto& point : expected.gaussians) {
                    for (size_t c = 0; c < 4; ++c) {
                        point.attribute(splat::Red + c) = extension.at("rgba")[c].get<float>();
                    }
                }
            }
            if (extension.contains("maxShDegree")) {
                expected.limit_sh_degree(extension.at("maxShDegree").get<unsigned>());
            }
            auto config = original;
            config.update(extension);
            task("Modify", config, context);
            require(get(context, "source") == source && get(context, "alias") == source && get(context, "result") == source, "Modify lost in-place alias semantics");
            equal_data(*source, expected);
            require(source->size() == 3 && source->block_counts == std::vector<size_t> { 4 }, "Legacy Modify deletion/block behavior changed");
        }
        auto source = cloud(4, degree);
        pipeline::TaskContext context;
        put_resource(context, "source", source);
        task("Modify", { { "input", "source" }, { "output", "source" }, { "maxShDegree", 3 } }, context);
        require(source->sh_degree == degree, "Modify generated new SH bands");
        const auto unchanged = *source;
        for (const Json& invalid : { Json { { "rgba", { 0, 1, 2 } } }, Json { { "rgba", { 0, 0, "bad", 1 } } },
                 Json { { "rgba", { 0, 0, true, 1 } } }, Json { { "rgba", { 0, 0, 1e100, 1 } } }, Json { { "rgba", { 0, 0, 1e-100, 1 } } },
                 Json { { "rgba", { 0, 0, std::numeric_limits<double>::infinity(), 1 } } }, Json { { "rgba", { 0, 0, std::numeric_limits<double>::quiet_NaN(), 1 } } },
                 Json { { "maxShDegree", -1 } }, Json { { "maxShDegree", 1.5 } }, Json { { "maxShDegree", 4 } }, Json { { "maxShDegree", true } },
                 Json { { "maxShDegree", nullptr } }, Json { { "rgba", { 0, 0, 0, 1 } }, { "maxShDegree", 99 } } }) {
            Json config { { "input", "source" }, { "output", "bad" }, { "modifyPaths", { io::path_utf8(patch) } } };
            config.update(invalid);
            rejects([&] { task("Modify", config, context); });
            equal_data(*source, unchanged);
            rejects([&] { context.input({ { "input", "bad" } }); });
        }
    }
}

void select_contracts(const std::filesystem::path& directory) {
    const std::array<uint32_t, 4> input { 8, 2, 8, 5 };
    const std::array<uint32_t, 3> expected { 8, 2, 5 };
    io::Bytes bytes;
    for (auto index : input) {
        io::append(bytes, index);
    }
    save_json(directory / "indices.json", input);
    save_json(directory / "object.json", { { "indices", input } });
    io::write_bytes(directory / "indices.bin", bytes);
    io::write_bytes(directory / "indices.zst", codec::zstd_compress(bytes));
    io::write_bytes(directory / "bad.bin", std::span(bytes).first(7));
    io::write_bytes(directory / "bad.zst", codec::zstd_compress(std::span(bytes).first(7)));
    for (unsigned degree = 0; degree <= 3; ++degree) {
        auto source = cloud(10, degree);
        const auto unchanged = *source;
        pipeline::TaskContext context;
        put_resource(context, "source", source);
        put_resource(context, "alias", source);
        for (const auto name : { "", "indices.json", "object.json", "indices.bin", "indices.zst" }) {
            Json config { { "input", "source" }, { "output", "result" } };
            if (std::string_view(name).empty()) {
                config["indices"] = input;
            } else {
                config["indicesPath"] = io::path_utf8(directory / name);
            }
            task("Select", config, context);
            const auto& actual = *get(context, "result");
            require(actual.size() == 3 && actual.sh_degree == degree, "Selection size or SH degree changed");
            single_block(actual);
            for (size_t i = 0; i < expected.size(); ++i) {
                equal_point(actual.gaussians[i], source->gaussians[expected[i]]);
                require(actual.gaussians[i].sh.data() != source->gaussians[expected[i]].sh.data(), "Selection aliases SH storage");
            }
        }
        for (const Json& invalid : { Json::object(), Json { { "indices", input }, { "indicesPath", "missing" } },
                 Json { { "indices", { -1 } } }, Json { { "indices", { 1.5 } } }, Json { { "indices", { 10 } } }, Json { { "indices", { 4294967296ull } } },
                 Json { { "indices", { true } } }, Json { { "indices", nullptr } }, Json { { "indicesPath", io::path_utf8(directory / "bad.bin") } },
                 Json { { "indicesPath", io::path_utf8(directory / "bad.zst") } } }) {
            Json config { { "input", "source" }, { "output", "source" } };
            config.update(invalid);
            rejects([&] { task("Select", config, context); });
            require(get(context, "source") == source, "Invalid selection replaced a resource");
            equal_data(*source, unchanged);
        }
        task("Select", { { "input", "source" }, { "output", "source" }, { "indices", Json::array() } }, context);
        require(get(context, "source")->size() == 0 && get(context, "source")->sh_degree == degree, "Empty selection changed its schema");
        single_block(*get(context, "source"));
        equal_data(*get(context, "alias"), unchanged);
    }
}
void replace_contracts() {
    for (unsigned degree = 0; degree <= 3; ++degree) {
        for (bool same_object : { false, true }) {
            for (const auto output : { "result", "source", "patch", "alias" }) {
                auto source = cloud(5, degree), patch = same_object ? source : cloud(4, degree, 100);
                const auto original_source = *source, original_patch = *patch;
                pipeline::TaskContext context;
                put_resource(context, "source", source);
                put_resource(context, "alias", source);
                put_resource(context, "patch", patch);
                put_resource(context, "result", cloud(1, 0));
                task("ReplaceAppend", { { "input", "source" }, { "patch", same_object ? "alias" : "patch" }, { "output", output }, { "sourceIndices", { 3, 1 } } }, context);
                const auto& actual = *get(context, output);
                require(actual.size() == 5 + patch->size() - 2 && actual.sh_degree == degree, "ReplaceAppend count or SH degree changed");
                single_block(actual);
                for (size_t i = 0; i < source->size(); ++i) {
                    equal_point(actual.gaussians[i], i == 3 ? patch->gaussians[0] : i == 1 ? patch->gaussians[1]
                                                                                           : source->gaussians[i]);
                }
                for (size_t i = 2; i < patch->size(); ++i) {
                    equal_point(actual.gaussians[5 + i - 2], patch->gaussians[i]);
                }
                equal_data(*source, original_source);
                equal_data(*patch, original_patch);
                get(context, output)->gaussians[0].sh[0] = -100;
                equal_data(*source, original_source);
                equal_data(*patch, original_patch);
            }
        }
        auto source = cloud(5, degree), patch = cloud(2, degree, 100);
        pipeline::TaskContext context;
        put_resource(context, "source", source);
        put_resource(context, "patch", patch);
        task("ReplaceAppend", { { "input", "source" }, { "patch", "source" }, { "output", "same" }, { "sourceIndices", { 4, 0 } } }, context);
        require(get(context, "same")->size() == 8, "Same-key source/patch count differs");
        equal_point(get(context, "same")->gaussians[4], source->gaussians[0]);
        equal_point(get(context, "same")->gaussians[0], source->gaussians[1]);
        for (const Json& invalid : { Json { { "sourceIndices", { 1, 1 } } }, Json { { "sourceIndices", { 0, 1, 2 } } },
                 Json { { "sourceIndices", { -1 } } }, Json { { "sourceIndices", { 0.5 } } }, Json { { "sourceIndices", { 5 } } },
                 Json { { "sourceIndices", { 4294967296ull } } }, Json { { "sourceIndices", nullptr } }, Json { { "sourceIndices", { true } } },
                 Json { { "patch", "missing" }, { "sourceIndices", Json::array() } } }) {
            Json config { { "input", "source" }, { "patch", "patch" }, { "output", "source" } };
            config.update(invalid);
            rejects([&] { task("ReplaceAppend", config, context); });
            require(get(context, "source") == source && get(context, "patch") == patch, "Invalid ReplaceAppend changed ownership");
        }
        put_resource(context, "wrong-sh", cloud(1, (degree + 1) % 4));
        rejects([&] { task("ReplaceAppend", { { "input", "source" }, { "patch", "wrong-sh" }, { "output", "source" }, { "sourceIndices", Json::array() } }, context); });
        patch->gaussians[0].sh.resize(2);
        rejects([&] { task("ReplaceAppend", { { "input", "source" }, { "patch", "patch" }, { "output", "source" }, { "sourceIndices", Json::array() } }, context); });
        put_resource(context, "patch", cloud(0, degree));
        task("ReplaceAppend", { { "input", "source" }, { "patch", "patch" }, { "output", "empty-patch" }, { "sourceIndices", Json::array() } }, context);
        equal_data(*get(context, "empty-patch"), *source);
        task("ReplaceAppend", { { "input", "patch" }, { "patch", "source" }, { "output", "appended" }, { "sourceIndices", Json::array() } }, context, { "source", "patch" });
        equal_data(*get(context, "appended"), *source);
        single_block(*get(context, "appended"));
        rejects([&] { get(context, "source"); });
        rejects([&] { get(context, "patch"); });
    }
}

std::vector<pipeline::SingleFile> bundle(unsigned degree) {
    Json tree = Json::array();
    for (const auto ref : { std::array { 0u, 1u, 2u }, std::array { 1u, 3u, 1u }, std::array { 0u, 5u, 2u }, std::array { 0u, 1u, 2u }, std::array { 0u, 8u, 0u } }) {
        Json lods = Json::array({ Json::object(), Json::object(), Json::object(), { { "file", ref[0] }, { "offset", ref[1] }, { "count", ref[2] } }, Json::object() });
        tree.push_back({ { "lods", lods } });
    }
    const Json meta { { "levels", 5 }, { "shDegree", degree }, { "files", { "a.esz", "b.esz" } }, { "tree", tree } };
    return { { "lod-meta.json", meta.dump() }, { "a.esz", cloud(8, degree, 100), true }, { "b.esz", cloud(6, degree, 500) } };
}
void extract_contracts() {
    for (unsigned degree = 0; degree <= 3; ++degree) {
        auto files = bundle(degree);
        auto first = std::get<pipeline::SplatPtr>(files[1].content), second = std::get<pipeline::SplatPtr>(files[2].content);
        const auto original_first = *first, original_second = *second;
        pipeline::TaskContext context;
        put_resource(context, "lod", files);
        put_resource(context, "alias", first);
        const Json config { { "input", "lod" }, { "output", "result" }, { "level", 3 } };
        task("ExtractLodLevel", config, context);
        auto result = get(context, "result");
        require(result->size() == 7 && result->sh_degree == degree, "LOD interval count or SH degree changed");
        single_block(*result);
        const std::array<const splat::Gaussian*, 7> expected { &first->gaussians[1], &first->gaussians[2], &second->gaussians[3], &first->gaussians[5], &first->gaussians[6], &first->gaussians[1], &first->gaussians[2] };
        for (size_t i = 0; i < expected.size(); ++i) {
            equal_point(result->gaussians[i], *expected[i]);
            require(result->gaussians[i].sh.data() != expected[i]->sh.data(), "Extracted SH aliases a chunk");
        }
        task("Modify", { { "input", "result" }, { "output", "pick" }, { "rgba", { 0, 0, 0, 1 } }, { "maxShDegree", 0 } }, context);
        equal_data(*first, original_first);
        equal_data(*second, original_second);
        for (const Json& level : { Json(-1), Json(1.5), Json(5), Json(true), Json(nullptr), Json(4294967296ull) }) {
            auto invalid = config;
            invalid["level"] = level;
            rejects([&] { task("ExtractLodLevel", invalid, context); });
        }
        auto missing = config;
        missing.erase("level");
        rejects([&] { task("ExtractLodLevel", missing, context); });
        auto plain = config;
        plain["input"] = "alias";
        rejects([&] { task("ExtractLodLevel", plain, context); });
        const auto original_meta = Json::parse(std::get<std::string>(files[0].content));
        for (unsigned invalid = 0; invalid < 13; ++invalid) {
            auto meta = original_meta;
            switch (invalid) {
            case 0:
                meta["levels"] = 0;
                break;
            case 1:
                meta["shDegree"] = (degree + 1) % 4;
                break;
            case 2:
                meta["files"][0] = "missing.esz";
                break;
            case 3:
                meta["tree"][0]["lods"][3]["file"] = 2;
                break;
            case 4:
                meta["tree"][0]["lods"][3]["offset"] = 7;
                break;
            case 5:
                meta["tree"][0]["lods"][3]["count"] = 4294967295u;
                break;
            case 6:
                meta["tree"][0]["lods"][3]["file"] = -1;
                break;
            case 7:
                meta["tree"][0]["lods"][3]["offset"] = 0.5;
                break;
            case 8:
                meta["tree"][0]["lods"][3]["count"] = -1;
                break;
            case 9:
                meta["tree"][0]["lods"] = Json::array();
                break;
            case 10:
                meta["tree"] = Json::object();
                break;
            case 11:
                meta["files"] = Json::object();
                break;
            case 12:
                meta["shDegree"] = 4;
                break;
            }
            auto bad = files;
            bad[0].content = meta.dump();
            put_resource(context, "lod", bad);
            rejects([&] { task("ExtractLodLevel", config, context); });
            require(get(context, "result") == result, "Failed extraction replaced its output");
        }
        auto bad = files;
        bad.push_back(files[1]);
        put_resource(context, "lod", bad);
        rejects([&] { task("ExtractLodLevel", config, context); });
        bad = files;
        bad[0].content = "{";
        put_resource(context, "lod", bad);
        rejects([&] { task("ExtractLodLevel", config, context); });
        put_resource(context, "lod", std::vector<pipeline::SingleFile> { files[1] });
        rejects([&] { task("ExtractLodLevel", config, context); });
        put_resource(context, "lod", files);
        first->gaussians[1].sh.resize(2);
        rejects([&] { task("ExtractLodLevel", config, context); });
        *first = original_first;
        auto empty_meta = original_meta;
        empty_meta["tree"] = Json::array();
        files[0].content = empty_meta.dump();
        put_resource(context, "lod", files);
        task("ExtractLodLevel", { { "input", "lod" }, { "output", "lod" }, { "level", 3 } }, context);
        require(get(context, "lod")->size() == 0 && get(context, "lod")->sh_degree == degree, "Empty LOD extraction changed schema");
        single_block(*get(context, "lod"));
    }
    // Valid individual intervals whose combined size exceeds uint32 indexing.
    auto source = cloud(65536, 0);
    Json tree = Json::array();
    const Json node { { "lods", Json::array({ { { "file", 0 }, { "offset", 0 }, { "count", 65536 } } }) } };
    for (size_t i = 0; i < 65536; ++i) {
        tree.push_back(node);
    }
    const Json meta { { "levels", 1 }, { "shDegree", 0 }, { "files", { "a.esz" } }, { "tree", std::move(tree) } };
    pipeline::TaskContext context;
    put_resource(context, "lod", std::vector<pipeline::SingleFile> { { "lod-meta.json", meta.dump() }, { "a.esz", source } });
    rejects([&] { task("ExtractLodLevel", { { "input", "lod" }, { "output", "result" }, { "level", 0 } }, context); });
}

Json esz_meta(const std::filesystem::path& path) {
    const auto decoded = codec::zstd_decompress(io::read_bytes(path));
    io::ByteReader reader(decoded);
    require(reader.read<uint32_t>() == 0x262834, "Invalid ESZ magic");
    const auto bytes = reader.take(reader.read<uint32_t>());
    return Json::parse(bytes.begin(), bytes.end());
}
void shared_lod_contracts(const std::filesystem::path& directory) {
    pipeline::TaskContext context;
    auto source = cloud(256, 3);
    put_resource(context, "source", source);
    const Json levels = Json::array({ { { "precision", 1 }, { "scaleBoost", 1 } }, { { "precision", 0.5 }, { "scaleBoost", 1 } },
        { { "precision", 0.25 }, { "scaleBoost", 1 } }, { { "precision", 0.05 }, { "scaleBoost", 1.01 } }, { { "precision", 0.01 }, { "scaleBoost", 1.02 } } });
    task("AutoChunkLod", { { "input", "source" }, { "output", "lod" }, { "type", "esz" }, { "maxChunkCounts", 128 }, { "levels", levels } }, context, { "source" });
    const auto files = std::get<std::vector<pipeline::SingleFile>>(context.input({ { "input", "lod" } }));
    const auto meta = Json::parse(std::get<std::string>(files[0].content));
    std::vector<splat::Splat> originals;
    for (size_t i = 1; i < files.size(); ++i) {
        originals.push_back(*std::get<pipeline::SplatPtr>(files[i].content));
    }
    size_t count = 0;
    for (const auto& node : meta.at("tree")) {
        count += node.at("lods")[3].at("count").get<size_t>();
    }
    task("ExtractLodLevel", { { "input", "lod" }, { "output", "interactiveL3" }, { "level", 3 } }, context);
    require(get(context, "interactiveL3")->size() == count, "Interactive count is not the sum of level 3 intervals");
    task("Modify", { { "input", "interactiveL3" }, { "output", "interactivePick" }, { "rgba", { 0, 0, 0, 1 } }, { "maxShDegree", 0 } }, context, { "interactiveL3" });
    require(get(context, "interactivePick")->sh_degree == 0, "Interactive data retained SH bands");
    for (const auto& point : get(context, "interactivePick")->gaussians) {
        require(point.sh[0] == 0 && point.sh[1] == 0 && point.sh[2] == 0 && point.opacity == 1, "Interactive RGBA differs");
    }
    task("Write", { { "input", "interactivePick" }, { "output", io::path_utf8(directory / "interactive.esz") }, { "highPrecision", false } }, context, { "interactivePick" });
    for (const auto output : { "low-lod", "high-lod", "repeated-high" }) {
        task("Write", { { "input", "lod" }, { "output", io::path_utf8(directory / output) }, { "highPrecision", std::string_view(output) != "low-lod" }, { "parallelCounts", 2 }, { "enableMortonSort", true } }, context);
        require(io::read_json(directory / output / "lod-meta.json") == meta, "Sequential Write changed LOD metadata");
        for (size_t i = 1; i < files.size(); ++i) {
            equal_data(*std::get<pipeline::SplatPtr>(files[i].content), originals[i - 1]);
        }
    }
    const auto interactive = io::read_splat(directory / "interactive.esz");
    require(interactive.size() == count && interactive.sh_degree == 0, "Interactive ESZ count or SH differs");
    for (size_t i = 1; i < files.size(); ++i) {
        require(esz_meta(directory / "low-lod" / files[i].name).at("layout") == "low", "Low precision output layout differs");
        require(esz_meta(directory / "high-lod" / files[i].name).at("layout") == "high", "High precision output layout differs");
        const auto low = io::read_splat(directory / "low-lod" / files[i].name);
        const auto high = io::read_splat(directory / "high-lod" / files[i].name);
        equal_data(high, io::read_splat(directory / "repeated-high" / files[i].name));
        const auto& original = originals[i - 1];
        require(low.size() == original.size() && high.size() == original.size() && low.sh_degree == 3 && high.sh_degree == 3, "Bundle encoding changed count or SH degree");
        auto order = splat::morton_order(original);
        if (files[i].preserve_order) {
            std::iota(order.begin(), order.end(), 0);
        }
        for (size_t row = 0; row < high.size(); ++row) {
            for (size_t c = 0; c < original.attribute_count(); ++c) {
                const auto expected = original.gaussians[order[row]].attribute(c);
                require(std::abs(high.gaussians[row].attribute(c) - expected) < 0.003, "High ESZ exceeds quantization tolerance or reordered an interval");
                // Low ESZ quantizes SH1 in 1/16 steps and SH2/3 in 1/8 steps,
                // following an initial 1/128 rounding step.
                const double tolerance = c < splat::ShOffset ? 0.02 : c < splat::ShOffset + 9 ? 0.0352
                                                                                              : 0.0665;
                require(std::abs(low.gaussians[row].attribute(c) - expected) < tolerance, "Low ESZ exceeds its quantization tolerance");
            }
        }
    }
    task("ExtractLodLevel", { { "input", "lod" }, { "output", "after-writes" }, { "level", 3 } }, context, { "lod" });
    require(get(context, "after-writes")->size() == count, "Write consumed the LOD resource");
    rejects([&] { context.input({ { "input", "lod" } }); });
}
void preserve_order_contract(const std::filesystem::path& directory) {
    auto source = cloud(3, 0);
    for (size_t i = 0; i < 3; ++i) {
        source->gaussians[i].mean = { float((i + 2) % 3), 0, 0 };
    }
    const auto original = *source;
    pipeline::TaskContext context;
    for (const bool preserve : { false, true }) {
        put_resource(context, "bundle", std::vector<pipeline::SingleFile> { { "order.esz", source, preserve } });
        const auto output = directory / (preserve ? "preserved" : "sorted");
        task("Write", { { "input", "bundle" }, { "output", io::path_utf8(output) }, { "highPrecision", true }, { "enableMortonSort", true } }, context);
        const auto decoded = io::read_splat(output / "order.esz");
        for (size_t i = 0; i < 3; ++i) {
            require(decoded.gaussians[i].mean.x() == float(preserve ? (i + 2) % 3 : i), "Write ignored preserve_order or Morton sorting");
        }
        equal_data(*source, original);
    }
}
} // namespace

int main() {
    const auto directory = std::filesystem::temp_directory_path() / ("splat-data-tasks-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(directory);
    struct Cleanup {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(path, error);
        }
    } cleanup { directory };
    try {
        modify_contracts(directory);
        select_contracts(directory);
        replace_contracts();
        extract_contracts();
        shared_lod_contracts(directory);
        preserve_order_contract(directory);
        std::cout << "Pipeline data tasks preserve attributes, ownership, indices, and LOD intervals\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
