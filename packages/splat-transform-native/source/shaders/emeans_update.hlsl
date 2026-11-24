struct Parameters {
    uint entries;
    uint stride;
    float alpha;
    uint mode;
};
[[vk::push_constant]] ConstantBuffer<Parameters> parameters;
[[vk::binding(0, 0)]] StructuredBuffer<float> sums;
[[vk::binding(1, 0)]] RWStructuredBuffer<float> closing;
[[vk::binding(2, 0)]] RWStructuredBuffer<float> centers;
[[vk::binding(3, 0)]] RWStructuredBuffer<float> state;

static const uint INITIALIZE = 0, LAST_EPOCH = 2, FINISH = 3;

[numthreads(128, 1, 1)] void main(uint3 thread_id : SV_DispatchThreadID) {
    uint entry = thread_id.x;
    if (entry >= parameters.entries) {
        return;
    }
    uint base = entry * parameters.stride, offset = base + entry;
    uint mass_index = offset + parameters.stride, usage_index = parameters.entries + entry;
    float mass = 0, mix = 1;
    if (parameters.mode == INITIALIZE) {
        state[usage_index] = 1.0 / 65536.0;
    } else if (parameters.mode == FINISH) {
        mass = closing[mass_index];
        if (mass <= 0) {
            return;
        }
    } else {
        mass = sums[mass_index];
        float retained = state[usage_index] * (1.0 - parameters.alpha);
        if (mass <= 0) {
            if (parameters.alpha != 1) {
                state[usage_index] = retained;
            }
            return;
        }
        float added = parameters.alpha * mass;
        state[usage_index] = retained + added;
        mix = added / (retained + added);
        if (parameters.mode == LAST_EPOCH) {
            closing[mass_index] += mass;
        }
    }
    float norm = 0;
    for (uint column = 0; column < parameters.stride; ++column) {
        float value = centers[base + column];
        if (parameters.mode == FINISH) {
            value = closing[offset + column] / mass;
        } else if (parameters.mode != INITIALIZE) {
            float sum = sums[offset + column];
            float mean = sum / mass;
            value = mix == 1 ? mean : value + mix * (mean - value);
            if (parameters.mode == LAST_EPOCH) {
                closing[offset + column] += sum;
            }
        }
        centers[base + column] = value;
        norm += value * value;
    }
    state[entry] = norm;
}
