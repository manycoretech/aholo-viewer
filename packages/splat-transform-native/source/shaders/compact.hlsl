#include "linear.hlsli"

struct Parameters {
    uint nx;
    uint ny;
    uint nz;
    uint count;
    uint groups_x;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<uint> dense;
[[vk::binding(1, 0)]] RWStructuredBuffer<uint> blocks;

[numthreads(LINEAR_GROUP_SIZE, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID) {
    uint index = linear_index(thread_id, parameters.groups_x);
    if (index >= parameters.count) {
        return;
    }
    uint nbx = parameters.nx / 4, nby = parameters.ny / 4;
    uint3 base = uint3(index % nbx, (index / nbx) % nby, index / (nbx * nby)) * 4;
    uint2 mask = 0;
    for (uint bit = 0; bit < 64; ++bit) {
        uint3 p = base + uint3(bit % 4, (bit / 4) % 4, bit / 16);
        uint cell = p.x + p.y * parameters.nx + p.z * parameters.nx * parameters.ny;
        if ((dense[cell / 32] & (1u << (cell % 32))) != 0) {
            mask[bit / 32] |= 1u << (bit % 32);
        }
    }
    blocks[index * 2] = mask.x;
    blocks[index * 2 + 1] = mask.y;
}
