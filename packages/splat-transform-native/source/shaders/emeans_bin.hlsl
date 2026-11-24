struct Parameters {
    uint count;
    uint first;
    uint scatter;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<uint> labels;
[[vk::binding(1, 0)]] RWStructuredBuffer<uint> bins;
[[vk::binding(2, 0)]] RWStructuredBuffer<uint> members;

[numthreads(128, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID) {
    uint row = thread_id.x;
    if (row < parameters.count) {
        uint entry = labels[parameters.first + row];
        if (parameters.scatter == 0) {
            InterlockedAdd(bins[2 * entry], 1);
        } else {
            uint position;
            InterlockedAdd(bins[2 * entry + 1], 1, position);
            members[position] = row;
        }
    }
}
