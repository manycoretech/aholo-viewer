#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <syncstream>
#include <utility/logger.h>

namespace splat_transform::utility {
namespace {
std::string duration_text(float milliseconds) {
    if (milliseconds < 1000) {
        auto text = fixed(milliseconds, 3);
        text.erase(text.find_last_not_of('0') + 1);
        if (text.back() == '.') {
            text.pop_back();
        }
        return text + "ms";
    }
    if (milliseconds < 60000) {
        return fixed(milliseconds / 1000, 3) + 's';
    }
    const auto hours = static_cast<uint64_t>(milliseconds / 3600000);
    const auto minutes = static_cast<uint64_t>(milliseconds / 60000) % 60;
    std::ostringstream text;
    if (hours) {
        text << hours << ':' << std::setfill('0') << std::setw(2);
    }
    text << minutes << ':' << std::setfill('0') << std::setw(6) << fixed(std::fmod(milliseconds, 60000.0f) / 1000.0f, 3)
         << (hours ? " (h:mm:ss.mmm)" : " (m:ss.mmm)");
    return text.str();
}
} // namespace
Logger& logger() {
    static Logger instance;
    return instance;
}
Logger::State Logger::exchange(State state) {
    std::lock_guard lock(this->mutex_);
    return std::exchange(this->state_, std::move(state));
}
bool Logger::enabled() {
    std::lock_guard lock(this->mutex_);
    return !this->state_.silent;
}
void Logger::write(std::ostream& stream, const std::string& message, bool force) {
    std::string prefix;
    {
        std::lock_guard lock(this->mutex_);
        if (this->state_.silent && !force) {
            return;
        }
        prefix = this->state_.prefix;
    }
    std::osyncstream output(stream);
    output.rdbuf()->set_emit_on_sync(true);
    if (!prefix.empty()) {
        output << prefix << ' ';
    }
    output << message << std::endl;
}
Logger::Scope::Scope(Logger& logger, State state) : logger_(logger), previous_(logger.exchange(std::move(state))) {}
Logger::Scope::~Scope() { this->logger_.exchange(std::move(this->previous_)); }
Logger::Scope Logger::silence() {
    State state;
    {
        std::lock_guard lock(this->mutex_);
        state = this->state_;
    }
    state.silent = true;
    return Scope(*this, std::move(state));
}
Logger::Timer::Timer(Logger& logger, std::string label)
    : logger_(logger), label_(std::move(label)), start_(std::chrono::steady_clock::now()),
      exceptions_(std::uncaught_exceptions()), enabled_(logger.enabled()) {}
Logger::Timer::~Timer() {
    if (std::uncaught_exceptions() == this->exceptions_) {
        try {
            this->finish();
        } catch (...) {
            // Logging from a destructor must not interrupt resource cleanup.
        }
    }
}
void Logger::Timer::finish() {
    if (!std::exchange(this->enabled_, false)) {
        return;
    }
    const auto elapsed = std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - this->start_).count();
    this->logger_.info(this->label_, ": ", duration_text(elapsed));
}
std::string fixed(float value, int32_t precision) {
    if (std::isnan(value)) {
        return "NaN";
    }
    if (std::isinf(value)) {
        return value < 0 ? "-Infinity" : "Infinity";
    }
    std::ostringstream output;
    output << std::fixed << std::setprecision(precision) << value;
    return output.str();
}
std::string format_size(size_t bytes) {
    if (bytes < 1024 * 1024) {
        return fixed(static_cast<float>(bytes) / 1024, 1) + " KB";
    }
    return fixed(static_cast<float>(bytes) / (1024 * 1024), 1) + " MB";
}
} // namespace splat_transform::utility
