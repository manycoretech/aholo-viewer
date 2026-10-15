#include <gpu/compute.h>
#include <iostream>
#include <pipeline/runner.h>
#include <string_view>
#include <utility/logger.h>

int main(int argc, char** argv) {
    try {
        if (argc != 2) {
            splat_transform::utility::logger().error("Usage: splat-transform <pipeline.json|-> | --list-gpu");
            return 2;
        }
        const std::string_view argument(argv[1]);
        if (argument == "--list-gpu") {
            auto devices = splat_transform::io::Json::array();
            for (const auto& device : splat_transform::gpu::enumerate_devices()) {
                devices.push_back({ { "index", device.index }, { "name", device.name }, { "backend", "vulkan" },
                    { "vendorId", device.vendor_id }, { "deviceId", device.device_id }, { "apiVersion", device.api_version }, { "uuid", device.uuid } });
            }
            std::cout << devices.dump() << '\n';
            return 0;
        }
        splat_transform::io::Json config;
        if (argument == "-") {
            std::cin >> config;
        } else {
            config = splat_transform::io::read_json(splat_transform::io::utf8_path(argv[1]));
        }
        splat_transform::pipeline::run(config);
        return 0;
    } catch (const std::exception& error) {
        splat_transform::utility::logger().error("splat-transform: ", error.what());
        return 1;
    }
}
