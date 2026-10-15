#ifndef VEC_COLUMNS
#error VEC_COLUMNS must be supplied by the shader build.
#endif
#ifndef TILE_SIZE
#error TILE_SIZE must be supplied by the shader build.
#endif

struct Parameters {
    uint point_count;
    uint centroid_count;
};

[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<float4> points;
[[vk::binding(1, 0)]] StructuredBuffer<float4> centroids;
[[vk::binding(2, 0)]] StructuredBuffer<float> squared;
[[vk::binding(3, 0)]] RWStructuredBuffer<uint> labels;

groupshared float4 shared_centroids[VEC_COLUMNS * TILE_SIZE];
groupshared float shared_squared[TILE_SIZE];

[numthreads(128, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID, uint local_id : SV_GroupIndex) {
    uint row = thread_id.x;
    float4 point_values[VEC_COLUMNS];
    if (row < parameters.point_count) {
        for (uint c = 0; c < VEC_COLUMNS; ++c) {
            point_values[c] = points[row * VEC_COLUMNS + c];
        }
    }
    float minimum = 1000000.0;
    uint label = 0;
    for (uint start = 0; start < parameters.centroid_count; start += TILE_SIZE) {
        uint count = min(uint(TILE_SIZE), parameters.centroid_count - start);
        for (uint k = local_id; k < count; k += 128) {
            for (uint c = 0; c < VEC_COLUMNS; ++c) {
                shared_centroids[k * VEC_COLUMNS + c] = centroids[(start + k) * VEC_COLUMNS + c];
            }
            shared_squared[k] = squared[start + k];
        }
        GroupMemoryBarrierWithGroupSync();
        if (row < parameters.point_count) {
            for (uint k = 0; k < count; ++k) {
                float distance = shared_squared[k];
                for (uint c = 0; c < VEC_COLUMNS; ++c) {
                    distance -= 2.0 * dot(point_values[c], shared_centroids[k * VEC_COLUMNS + c]);
                }
                if (distance < minimum) {
                    minimum = distance;
                    label = start + k;
                }
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (row < parameters.point_count) {
        labels[row] = label;
    }
}
