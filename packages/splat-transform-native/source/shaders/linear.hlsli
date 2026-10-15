#pragma once

static const uint LINEAR_GROUP_SIZE = 128;

uint linear_index(uint3 thread_id, uint groups_x) {
    return thread_id.x + thread_id.y * groups_x * LINEAR_GROUP_SIZE;
}
