struct Parameters {
    uint point_count;
    uint centroid_count;
    uint point_offset;
    uint label_offset;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<float4> points;
[[vk::binding(1, 0)]] StructuredBuffer<float4> centroids;
[[vk::binding(2, 0)]] StructuredBuffer<float> squared;
[[vk::binding(3, 0)]] RWStructuredBuffer<uint> labels;

// SH1, SH2 and SH3 occupy 3, 6 and 12 padded float4 columns.
[[vk::constant_id(0)]] const uint vec_columns = 12;
static const uint max_columns = 12;
static const uint tile_size = 64;
groupshared float4 tile[tile_size * max_columns];
groupshared float tile_squared[tile_size];

[numthreads(64, 1, 1)] void main(uint3 group : SV_GroupID, uint lane : SV_GroupIndex) {
    // A group covers 128 rows. Each lane reuses a centroid for two dot products.
    uint first = group.x * 128 + lane, second = first + 64;
    float4 x0[max_columns], x1[max_columns];
    [unroll] for (uint d = 0; d < max_columns; ++d) {
        if (d < vec_columns) {
            x0[d] = first < parameters.point_count ? points[(parameters.point_offset + first) * vec_columns + d] : 0;
            x1[d] = second < parameters.point_count ? points[(parameters.point_offset + second) * vec_columns + d] : 0;
        }
    }
    float best0 = asfloat(0x7f800000u), best1 = best0;
    uint label0 = 0, label1 = 0;
    for (uint start = 0; start < parameters.centroid_count; start += tile_size) {
        uint count = min(tile_size, parameters.centroid_count - start);
        for (uint i = lane; i < count * vec_columns; i += 64) {
            tile[i] = centroids[start * vec_columns + i];
        }
        if (lane < count) {
            tile_squared[lane] = squared[start + lane];
        }
        GroupMemoryBarrierWithGroupSync();
        for (uint k = 0; k < count; ++k) {
            float4 product0 = 0, product1 = 0;
            [unroll] for (uint d = 0; d < max_columns; ++d) {
                if (d < vec_columns) {
                    float4 center = tile[k * vec_columns + d];
                    product0 = mad(x0[d], center, product0);
                    product1 = mad(x1[d], center, product1);
                }
            }
            float score0 = tile_squared[k] - 2.0 * dot(product0, float4(1, 1, 1, 1));
            float score1 = tile_squared[k] - 2.0 * dot(product1, float4(1, 1, 1, 1));
            if (score0 < best0) {
                best0 = score0;
                label0 = start + k;
            }
            if (score1 < best1) {
                best1 = score1;
                label1 = start + k;
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (first < parameters.point_count) {
        labels[parameters.label_offset + first] = label0;
    }
    if (second < parameters.point_count) {
        labels[parameters.label_offset + second] = label1;
    }
}
