#pragma once
#include "gaussian.hlsli"
#include "linear.hlsli"

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
    return true;
}
