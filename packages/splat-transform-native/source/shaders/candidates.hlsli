#pragma once
#include "gaussian.hlsli"
#include "linear.hlsli"

// The common pipeline specializes to zero, retaining its original loops.
// Bit 0 selects a bin window; bit 1 rebases indices for a Gaussian chunk.
[[vk::constant_id(0)]] const uint CANDIDATE_MODE = 0;

struct CandidateParameters {
    float min_x;
    float min_y;
    float min_z;
    float batch_size;
    uint nx;
    uint ny;
    uint nz;
    uint count;
    uint groups_x;
    uint first_bin;
    uint bin_count;
    uint first_point;
};

bool candidate_range(Gaussian g, CandidateParameters parameters, out int3 first, out int3 last) {
    first = last = 0;
    if (g.opacity <= 0) {
        return false;
    }
    float3 origin = float3(parameters.min_x, parameters.min_y, parameters.min_z);
    float3 position = float3(g.x, g.y, g.z);
    float3 extent = float3(g.ex, g.ey, g.ez);
    float3 low = position - extent - origin;
    float3 high = position + extent - origin;
    int3 size = int3(parameters.nx, parameters.ny, parameters.nz);
    if (any(high < 0) || any(low > float3(size) * parameters.batch_size)) {
        return false;
    }
    first = clamp(int3(floor(low / parameters.batch_size)), int3(0, 0, 0), size - 1);
    last = clamp(int3(floor(high / parameters.batch_size)), int3(0, 0, 0), size - 1);
    if ((CANDIDATE_MODE & 1) != 0) {
        uint plane = parameters.nx * parameters.ny;
        first.z = max(first.z, int(parameters.first_bin / plane));
        last.z = min(last.z, int((parameters.first_bin + parameters.bin_count - 1) / plane));
        return first.z <= last.z;
    }
    return true;
}

bool candidate_row(CandidateParameters parameters, int3 first, int3 last, int y, int z, out uint begin, out uint end) {
    uint row = uint(y) * parameters.nx + uint(z) * parameters.nx * parameters.ny;
    begin = max(row + uint(first.x), parameters.first_bin);
    end = min(row + uint(last.x) + 1, parameters.first_bin + parameters.bin_count);
    return begin < end;
}
