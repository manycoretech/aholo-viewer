struct Parameters {
    uint entries;
    uint stride;
    uint point_offset;
    uint weight_offset;
    uint groups_x;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<float> points;
[[vk::binding(1, 0)]] StructuredBuffer<uint> bins;
[[vk::binding(2, 0)]] StructuredBuffer<uint> members;
[[vk::binding(3, 0)]] RWStructuredBuffer<float> sums;

groupshared float partials[64 * 49];

float contribution(uint member, uint column) {
    uint row = parameters.point_offset + members[member];
    float weight = points[parameters.weight_offset + row];
    if (column == parameters.stride) {
        return weight;
    }
    return weight * points[row * parameters.stride + column];
}

[numthreads(64, 1, 1)] void main(uint3 group_id : SV_GroupID, uint lane : SV_GroupIndex) {
    uint entry = group_id.x + group_id.y * parameters.groups_x;
    if (entry >= parameters.entries) {
        return;
    }
    uint begin = bins[2 * entry], end = bins[2 * entry + 1];
    if (begin == end) {
        return;
    }
    uint base = entry * (parameters.stride + 1);
    if (end - begin <= 64) {
        if (lane <= parameters.stride) {
            float sum = 0;
            for (uint member = begin; member < end; ++member) {
                sum += contribution(member, lane);
            }
            sums[base + lane] += sum;
        }
        return;
    }
    for (uint column = 0; column <= parameters.stride; ++column) {
        float sum = 0;
        for (uint member = begin + lane; member < end; member += 64) {
            sum += contribution(member, column);
        }
        partials[column * 64 + lane] = sum;
    }
    GroupMemoryBarrierWithGroupSync();
    if (lane <= parameters.stride) {
        float sum = 0;
        for (uint index = 0; index < 64; ++index) {
            sum += partials[lane * 64 + index];
        }
        sums[base + lane] += sum;
    }
}
