#include <iostream>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <unordered_set>
#include <utility/logger.h>
#include <vector>

using namespace splat_transform;
namespace {
class Capture {
public:
    explicit Capture(std::ostream& stream) : stream_(stream), previous_(stream.rdbuf(&output_)) {}
    ~Capture() { stream_.rdbuf(previous_); }
    std::string text() const { return output_.str(); }
    size_t flush_count() const { return output_.flush_count; }

private:
    struct Buffer : std::stringbuf {
        size_t flush_count = 0;

    private:
        int sync() override {
            ++flush_count;
            return std::stringbuf::sync();
        }
    };
    Buffer output_;
    std::ostream& stream_;
    std::streambuf* previous_;
};
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}
} // namespace

int main() {
    try {
        Capture capture(std::cout);
        Capture errors(std::cerr);
        utility::Logger logger;
        {
            auto task = logger.scope("[Task:Write#2]");
            logger.info("writing bundle -> dir=\"out\" files=2");
            try {
                auto quiet = logger.silence();
                logger.info("hidden detail");
                logger.warn("hidden warning");
                auto hidden_time = logger.time("hidden timer");
                logger.progress("- out/chunk_0.spz (1/2)");
                logger.error("write error");
                throw std::runtime_error("write failed");
            } catch (const std::runtime_error&) {
                logger.warn("write failed");
            }
            logger.info("visible after failure");
            auto elapsed = logger.time("elapsed time");
            elapsed.finish();
            elapsed.finish();
        }
        const auto flushes = capture.flush_count();
        logger.info("Total elapsed time: complete");
        require(capture.flush_count() > flushes, "Completed log line did not flush its output");
        const auto text = capture.text();
        require(errors.text() == "[Task:Write#2] write error\n[Task:Write#2] write failed\n", "Warnings or errors used the wrong output stream or silence policy");
        require(text.find("[Task:Write#2] - out/chunk_0.spz (1/2)\n") != std::string::npos, "Bundle progress disappeared while detail logs were muted");
        require(text.find("hidden") == std::string::npos, "Muted detail or timer leaked into output");
        require(text.find("[Task:Write#2] visible after failure\n") != std::string::npos, "Failed write did not restore logger state");
        const auto elapsed = text.find("[Task:Write#2] elapsed time: ");
        require(elapsed != std::string::npos && text.find("[Task:Write#2] elapsed time: ", elapsed + 1) == std::string::npos, "Timer did not finish exactly once");
        require(text.ends_with("\nTotal elapsed time: complete\n"), "Task prefix escaped its scope");
        {
            auto task = logger.scope("[Task:Parallel#3]");
            std::vector<std::jthread> workers;
            for (int worker = 0; worker < 4; ++worker) {
                workers.emplace_back([&, worker] {
                    for (int index = 0; index < 25; ++index) {
                        logger.info("worker=", worker, " item=", index);
                    }
                });
            }
        }
        std::istringstream lines(capture.text().substr(text.size()));
        std::unordered_set<std::string> messages;
        for (std::string line; std::getline(lines, line);) {
            messages.insert(std::move(line));
        }
        require(messages.size() == 100, "Concurrent logging lost or interleaved messages");
        for (int worker = 0; worker < 4; ++worker) {
            for (int index = 0; index < 25; ++index) {
                require(messages.contains("[Task:Parallel#3] worker=" + std::to_string(worker) + " item=" + std::to_string(index)), "Concurrent logging changed a task prefix or message");
            }
        }
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    std::cout << "Logger streams, flushing, prefixes, silence restoration, timers, and concurrent lines passed\n";
}
