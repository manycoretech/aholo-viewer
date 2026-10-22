#pragma once

// Matches voxel::Gaussian: sixteen tightly packed 32-bit floats.
struct Gaussian {
    float x;
    float y;
    float z;
    float opacity;
    float qw;
    float qx;
    float qy;
    float qz;
    float sx;
    float sy;
    float sz;
    float ex;
    float ey;
    float ez;
    float padding0;
    float padding1;
};
