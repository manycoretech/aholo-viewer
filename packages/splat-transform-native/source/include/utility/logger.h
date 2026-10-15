#pragma once
#include <chrono>
#include <exception>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>

namespace splat_transform::utility {
class Logger {
    struct State {
        std::string prefix;
        bool silent = false;
    };

public:
    class Scope {
    public:
        ~Scope();
        Scope(const Scope&) = delete;
        Scope& operator=(const Scope&) = delete;

    private:
        friend class Logger;
        Scope(Logger& logger, State state);
        Logger& logger_;
        State previous_;
    };

    class Timer {
    public:
        ~Timer();
        Timer(const Timer&) = delete;
        Timer& operator=(const Timer&) = delete;
        void finish();

    private:
        friend class Logger;
        Timer(Logger& logger, std::string label);
        Logger& logger_;
        std::string label_;
        std::chrono::steady_clock::time_point start_;
        int exceptions_;
        bool enabled_;
    };

    Scope scope(std::string prefix) { return Scope(*this, { std::move(prefix), false }); }
    Scope silence();
    Timer time(std::string label) { return Timer(*this, std::move(label)); }

    template<typename... Args>
    void info(Args&&... args) {
        emit(std::cout, false, std::forward<Args>(args)...);
    }
    template<typename... Args>
    void warn(Args&&... args) {
        emit(std::cerr, false, std::forward<Args>(args)...);
    }
    template<typename... Args>
    void error(Args&&... args) {
        emit(std::cerr, true, std::forward<Args>(args)...);
    }
    template<typename... Args>
    void progress(Args&&... args) {
        emit(std::cout, true, std::forward<Args>(args)...);
    }

private:
    State exchange(State state);
    bool enabled();
    void write(std::ostream& stream, const std::string& message, bool force);
    template<typename... Args>
    void emit(std::ostream& stream, bool force, Args&&... args) {
        if (!force && !enabled()) {
            return;
        }
        std::ostringstream message;
        message << std::boolalpha;
        (message << ... << std::forward<Args>(args));
        write(stream, message.str(), force);
    }
    std::mutex mutex_;
    State state_;
};

Logger& logger();
std::string fixed(float value, int precision = 2);
std::string format_size(size_t bytes);
} // namespace splat_transform::utility
