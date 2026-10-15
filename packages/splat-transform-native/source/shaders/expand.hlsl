#include "linear.hlsli"

struct Parameters {
    uint nx;
    uint ny;
    uint nz;
    uint count;
    uint groups_x;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<uint> blocks;
[[vk::binding(1, 0)]] RWStructuredBuffer<uint> dense;

[numthreads(LINEAR_GROUP_SIZE, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID) {
    uint index = linear_index(thread_id, parameters.groups_x);
    if (index >= parameters.count) {
        return;
    }
    uint block = blocks[index * 3];
    uint nbx = parameters.nx / 4, nby = parameters.ny / 4;
    uint3 base = uint3(block % nbx, (block / nbx) % nby, block / (nbx * nby)) * 4;
    for (uint bit = 0; bit < 64; ++bit) {
        if ((blocks[index * 3 + 1 + bit / 32] & (1u << (bit % 32))) == 0) {
            continue;
        }
        uint3 p = base + uint3(bit % 4, (bit / 4) % 4, bit / 16);
        uint cell = p.x + p.y * parameters.nx + p.z * parameters.nx * parameters.ny;
        InterlockedOr(dense[cell / 32], 1u << (cell % 32));
    }
}
