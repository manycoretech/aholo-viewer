#include "candidates.hlsli"

[[vk::push_constant]] ConstantBuffer<CandidateParameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<Gaussian> gaussians;
[[vk::binding(1, 0)]] RWStructuredBuffer<uint> counts;

[numthreads(LINEAR_GROUP_SIZE, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID) {
    uint index = linear_index(thread_id, parameters.groups_x);
    if (index >= parameters.count) {
        return;
    }
    int3 first, last;
    if (!candidate_range(gaussians[index], parameters, first, last)) {
        return;
    }
    for (int z = first.z; z <= last.z; ++z) {
        for (int y = first.y; y <= last.y; ++y) {
            for (int x = first.x; x <= last.x; ++x) {
                InterlockedAdd(counts[x + y * parameters.nx + z * parameters.nx * parameters.ny], 1);
            }
        }
    }
}
