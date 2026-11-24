struct Parameters {
    uint entries;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] RWStructuredBuffer<uint> bins;
groupshared uint group_count;
groupshared uint group_base;

[numthreads(128, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID, uint lane : SV_GroupIndex) {
    uint entry = thread_id.x;
    if (lane == 0) {
        group_count = 0;
    }
    GroupMemoryBarrierWithGroupSync();
    uint offset = 0;
    if (entry < parameters.entries) {
        InterlockedAdd(group_count, bins[2 * entry], offset);
    }
    GroupMemoryBarrierWithGroupSync();
    if (lane == 0) {
        InterlockedAdd(bins[2 * parameters.entries], group_count, group_base);
    }
    GroupMemoryBarrierWithGroupSync();
    if (entry < parameters.entries) {
        uint start = group_base + offset;
        bins[2 * entry] = start;
        bins[2 * entry + 1] = start;
    }
}
