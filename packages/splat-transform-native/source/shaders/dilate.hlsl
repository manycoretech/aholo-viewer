#include "linear.hlsli"

struct Parameters {
    uint nx;
    uint ny;
    uint nz;
    uint rx;
    uint ry;
    uint rz;
    uint groups_x;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<uint> source;
[[vk::binding(1, 0)]] RWStructuredBuffer<uint> destination;

[numthreads(LINEAR_GROUP_SIZE, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID) {
    uint word = linear_index(thread_id, parameters.groups_x);
    uint size = parameters.nx * parameters.ny * parameters.nz;
    if (word >= (size + 31) / 32) {
        return;
    }
    uint mask = 0;
    for (uint bit_index = 0; bit_index < 32; ++bit_index) {
        uint index = word * 32 + bit_index;
        if (index >= size) {
            break;
        }
        int3 p = int3(index % parameters.nx, (index / parameters.nx) % parameters.ny, index / (parameters.nx * parameters.ny));
        bool occupied = false;
        for (int z = -int(parameters.rz); z <= int(parameters.rz) && !occupied; ++z) {
            for (int y = -int(parameters.ry); y <= int(parameters.ry) && !occupied; ++y) {
                for (int x = -int(parameters.rx); x <= int(parameters.rx); ++x) {
                    int3 q = p + int3(x, y, z);
                    if (any(q < 0) || any(q >= int3(parameters.nx, parameters.ny, parameters.nz))) {
                        continue;
                    }
                    uint offset = uint(q.x) + uint(q.y) * parameters.nx + uint(q.z) * parameters.nx * parameters.ny;
                    if ((source[offset >> 5] & (1u << (offset & 31))) != 0) {
                        occupied = true;
                        break;
                    }
                }
            }
        }
        if (occupied) {
            mask |= 1u << bit_index;
        }
    }
    destination[word] = mask;
}
