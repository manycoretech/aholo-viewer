#include <utility/random.h>

namespace splat_transform::utility {
std::mt19937& default_random() {
    thread_local std::mt19937 engine(std::random_device {}());
    return engine;
}
} // namespace splat_transform::utility
