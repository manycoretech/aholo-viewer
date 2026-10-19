#include "version.h"
#include <CLI/CLI.hpp>
#include <gpu/compute.h>
#include <iostream>
#include <pipeline/runner.h>
#include <string>
#include <utility/logger.h>

int main(int argc, char** argv) {
    try {
        CLI::App app { "Execute a Gaussian splat processing pipeline.", "splat-transform" };
        app.allow_windows_style_options(false);
        app.failure_message(CLI::FailureMessage::help);
        app.set_version_flag("--version", splat_transform::VERSION);
        std::string pipeline_file;
        bool list_gpu = false;
        auto* input = app.add_option("pipeline", pipeline_file, "Pipeline JSON file, or '-' to read from stdin")->type_name("FILE");
        app.add_flag("--list-gpu", list_gpu, "List Vulkan adapters as JSON")
            ->excludes(input)
            ->disable_flag_override()
            ->multi_option_policy(CLI::MultiOptionPolicy::Throw);
        argv = app.ensure_utf8(argv);
        try {
            app.parse(argc, argv);
            // Let CLI11 diagnose unknown options before requiring an input.
            if (!list_gpu && app.count("pipeline") == 0) {
                throw CLI::RequiredError("pipeline or --list-gpu");
            }
        } catch (const CLI::ParseError& error) {
            // Help and version exit successfully; keep argument errors at 2.
            return app.exit(error) == 0 ? 0 : 2;
        }
        if (list_gpu) {
            auto devices = splat_transform::io::Json::array();
            for (const auto& device : splat_transform::gpu::enumerate_devices()) {
                devices.push_back({ { "index", device.index }, { "name", device.name }, { "backend", "vulkan" },
                    { "vendorId", device.vendor_id }, { "deviceId", device.device_id }, { "apiVersion", device.api_version }, { "uuid", device.uuid } });
            }
            std::cout << devices.dump() << '\n';
            return 0;
        }
        splat_transform::io::Json config;
        if (pipeline_file == "-") {
            std::cin >> config;
        } else {
            config = splat_transform::io::read_json(splat_transform::io::utf8_path(pipeline_file));
        }
        splat_transform::pipeline::run(config);
        return 0;
    } catch (const std::filesystem::filesystem_error& error) {
        splat_transform::utility::logger().error("splat-transform: ", splat_transform::io::filesystem_error_message(error));
        return 1;
    } catch (const std::exception& error) {
        splat_transform::utility::logger().error("splat-transform: ", error.what());
        return 1;
    }
}
