struct Parameters {
    uint pairs_count;
    uint stride;
    uint entries;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<uint2> pairs;
[[vk::binding(1, 0)]] RWStructuredBuffer<float> centers;
[[vk::binding(2, 0)]] RWStructuredBuffer<float> state;

[numthreads(128, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID) {
    if (thread_id.x >= parameters.pairs_count) {
        return;
    }
    uint2 pair = pairs[thread_id.x];
    uint2 base = pair * parameters.stride;
    float2 norms = 0;
    bool collapsed = true;
    for (uint column = 0; column < parameters.stride; ++column) {
        float value = centers[base.x + column];
        float offset = (column & 1) ? -1e-4 : 1e-4;
        float2 split = value * float2(1.0 - offset, 1.0 + offset);
        centers[base.x + column] = split.x;
        centers[base.y + column] = split.y;
        norms += split * split;
        collapsed = collapsed && split.x == split.y;
    }
    if (collapsed) {
        centers[base.y] += asfloat(0x00800000u);
    }
    state[pair.x] = norms.x;
    state[pair.y] = norms.y;
    float mass = state[parameters.entries + pair.x] * 0.5;
    state[parameters.entries + pair.x] = mass;
    state[parameters.entries + pair.y] = mass;
}
