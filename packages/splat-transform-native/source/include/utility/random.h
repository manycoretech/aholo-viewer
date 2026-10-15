#pragma once
#include <random>

namespace splat_transform::utility {
// Each thread seeds its engine on first use and reuses it for subsequent draws.
std::mt19937& default_random();
} // namespace splat_transform::utility
