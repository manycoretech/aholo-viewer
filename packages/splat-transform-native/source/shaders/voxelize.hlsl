#include "gaussian.hlsli"

struct Batch {
    uint offset;
    uint count;
    uint nx;
    uint ny;
    uint nz;
    float x;
    float y;
    float z;
};
struct Parameters {
    float resolution;
    float cutoff;
    uint max_blocks;
};

[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<Gaussian> gaussians;
[[vk::binding(1, 0)]] StructuredBuffer<uint> indices;
[[vk::binding(2, 0)]] StructuredBuffer<Batch> batches;
[[vk::binding(3, 0)]] RWStructuredBuffer<uint> results;

groupshared Gaussian tile[64];
groupshared uint masks[2];

float evaluate(float3 center, float half_size, Gaussian g) {
    // Preserve intermediate rounding at opacity thresholds across shader backends.
    float3 origin = float3(g.x, g.y, g.z);
    if (any(abs(center - origin) > float3(g.ex, g.ey, g.ez) + half_size)) {
        return 0.0;
    }
    precise float3 difference = clamp(origin, center - half_size, center + half_size) - origin;
    float3 inverse_rotation = -float3(g.qx, g.qy, g.qz);
    precise float3 t = 2.0 * cross(inverse_rotation, difference);
    precise float3 local = difference + g.qw * t + cross(inverse_rotation, t);
    precise float3 inverse_scale = float3(1.0, 1.0, 1.0) / max(float3(g.sx, g.sy, g.sz), float3(1e-8, 1e-8, 1e-8));
    precise float3 scaled = local * inverse_scale;
    return g.opacity * exp(-0.5 * dot(scaled, scaled));
}

[numthreads(64, 1, 1)] void main(uint3 group_id : SV_GroupID, uint local_id : SV_GroupIndex) {
    uint batch_id = group_id.z;
    uint block_id = group_id.x;
    Batch batch = batches[batch_id];
    if (block_id >= batch.nx * batch.ny * batch.nz) {
        return;
    }
    uint3 position = uint3((local_id & 1) | ((local_id >> 2) & 2),
        ((local_id >> 1) & 1) | ((local_id >> 3) & 2),
        ((local_id >> 2) & 1) | ((local_id >> 4) & 2));
    uint3 block = uint3(block_id % batch.nx, (block_id / batch.nx) % batch.ny, block_id / (batch.nx * batch.ny));
    // Keep the original block/voxel addition order instead of folding offsets.
    precise float3 block_offset = float3(block) * 4.0 * parameters.resolution;
    precise float3 center = float3(batch.x, batch.y, batch.z) + block_offset + (float3(position) + 0.5) * parameters.resolution;
    if (local_id < 2) {
        masks[local_id] = 0;
    }
    GroupMemoryBarrierWithGroupSync();
    precise float total = 0.0;
    for (uint start = 0; start < batch.count; start += 64) {
        uint count = min(64u, batch.count - start);
        if (local_id < count) {
            tile[local_id] = gaussians[indices[batch.offset + start + local_id]];
        }
        GroupMemoryBarrierWithGroupSync();
        if (total < 7.0) {
            for (uint j = 0; j < count; ++j) {
                total += evaluate(center, parameters.resolution * 0.5, tile[j]);
                if (total >= 7.0) {
                    break;
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (1.0 - exp(-total) >= parameters.cutoff) {
        uint bit_index = position.z * 16 + position.y * 4 + position.x;
        InterlockedOr(masks[bit_index >> 5], 1u << (bit_index & 31));
    }
    GroupMemoryBarrierWithGroupSync();
    if (local_id < 2) {
        results[(batch_id * parameters.max_blocks + block_id) * 2 + local_id] = masks[local_id];
    }
}
