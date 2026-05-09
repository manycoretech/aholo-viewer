import { getOrCreateDevice } from '../webgpu.js';
import { BLOCK_EMPTY, BLOCK_MIXED, BLOCK_SOLID, SparseVoxelGrid, readBlockType } from './common.js';
const GPU_BUFFER_USAGE_STORAGE = 128;
const GPU_BUFFER_USAGE_COPY_DST = 8;
const GPU_BUFFER_USAGE_COPY_SRC = 4;
const GPU_BUFFER_USAGE_UNIFORM = 64;
const GPU_BUFFER_USAGE_MAP_READ = 1;
const GPU_MAP_MODE_READ = 1;
const CHUNK_INNER = 512;
const SOLID_WORD = 0x55555555 >>> 0;
const extractWgsl = () => /* wgsl */ `
struct ExtractUniforms {
    minBx: i32,
    minBy: i32,
    minBz: i32,
    outerBx: u32,
    outerBy: u32,
    outerBz: u32,
    numXWords: u32,
    srcNbx: u32,
    srcNby: u32,
    srcNbz: u32,
    srcBStride: u32,
    srcCapMinusOne: u32
}

@group(0) @binding(0) var<uniform> u: ExtractUniforms;
@group(0) @binding(1) var<storage, read> srcTypes: array<u32>;
@group(0) @binding(2) var<storage, read> srcKeys: array<u32>;
@group(0) @binding(3) var<storage, read> srcLo: array<u32>;
@group(0) @binding(4) var<storage, read> srcHi: array<u32>;
@group(0) @binding(5) var<storage, read_write> dstDense: array<atomic<u32>>;

@compute @workgroup_size(8, 4, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= u.outerBx || gid.y >= u.outerBy || gid.z >= u.outerBz) { return; }

    let chunkBx = i32(gid.x);
    let chunkBy = i32(gid.y);
    let chunkBz = i32(gid.z);
    let globalBx = u.minBx + chunkBx;
    let globalBy = u.minBy + chunkBy;
    let globalBz = u.minBz + chunkBz;
    if (globalBx < 0 || globalBy < 0 || globalBz < 0) { return; }
    if (globalBx >= i32(u.srcNbx) || globalBy >= i32(u.srcNby) || globalBz >= i32(u.srcNbz)) { return; }

    let blockIdx = u32(globalBx) + u32(globalBy) * u.srcNbx + u32(globalBz) * u.srcBStride;
    let typeWord = srcTypes[blockIdx >> 4u];
    let bt = (typeWord >> ((blockIdx & 15u) * 2u)) & 3u;
    if (bt == 0u) { return; }

    var lo: u32;
    var hi: u32;
    if (bt == 1u) {
        lo = 0xFFFFFFFFu;
        hi = 0xFFFFFFFFu;
    } else {
        var i = (blockIdx * 0x9E3779B9u) & u.srcCapMinusOne;
        loop {
            let k = srcKeys[i];
            if (k == blockIdx) {
                lo = srcLo[i];
                hi = srcHi[i];
                break;
            }
            if (k == 0xFFFFFFFFu) { return; }
            i = (i + 1u) & u.srcCapMinusOne;
        }
    }

    let dx0 = u32(chunkBx) * 4u;
    let wordOffsetX = dx0 / 32u;
    let bitShiftX = dx0 & 31u;
    let outerNy = u.outerBy * 4u;
    let planeWords = u.numXWords * outerNy;

    for (var lz = 0u; lz < 4u; lz = lz + 1u) {
        let dz = u32(chunkBz) * 4u + lz;
        let zBitBase = (lz & 1u) * 16u;
        let word = select(lo, hi, lz >= 2u);
        for (var ly = 0u; ly < 4u; ly = ly + 1u) {
            let dy = u32(chunkBy) * 4u + ly;
            let bitBase = zBitBase + ly * 4u;
            let pattern = (word >> bitBase) & 0xFu;
            if (pattern == 0u) { continue; }
            let wordIdx = wordOffsetX + dy * u.numXWords + dz * planeWords;
            atomicOr(&dstDense[wordIdx], pattern << bitShiftX);
        }
    }
}
`;
const compactWgsl = () => /* wgsl */ `
struct CompactUniforms {
    haloBx: u32,
    haloBy: u32,
    haloBz: u32,
    numXWords: u32,
    innerBx: u32,
    innerBy: u32,
    innerBz: u32,
    outerBy: u32
}

@group(0) @binding(0) var<uniform> u: CompactUniforms;
@group(0) @binding(1) var<storage, read> dilatedDense: array<u32>;
@group(0) @binding(2) var<storage, read_write> typesOut: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> masksOut: array<u32>;

@compute @workgroup_size(8, 4, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= u.innerBx || gid.y >= u.innerBy || gid.z >= u.innerBz) { return; }

    let innerBlockIdx = gid.x + gid.y * u.innerBx + gid.z * u.innerBx * u.innerBy;
    let outerBx = gid.x + u.haloBx;
    let outerBy = gid.y + u.haloBy;
    let outerBz = gid.z + u.haloBz;
    let dx0 = outerBx * 4u;
    let wordOffsetX = dx0 / 32u;
    let bitShiftX = dx0 & 31u;
    let outerNy = u.outerBy * 4u;
    let planeWords = u.numXWords * outerNy;

    var lo = 0u;
    var hi = 0u;
    for (var lz = 0u; lz < 4u; lz = lz + 1u) {
        let dz = outerBz * 4u + lz;
        let zBitBase = (lz & 1u) * 16u;
        let inHi = lz >= 2u;
        let planeBase = dz * planeWords;
        for (var ly = 0u; ly < 4u; ly = ly + 1u) {
            let dy = outerBy * 4u + ly;
            let bitBase = zBitBase + ly * 4u;
            let wordIdx = wordOffsetX + dy * u.numXWords + planeBase;
            let pattern = (dilatedDense[wordIdx] >> bitShiftX) & 0xFu;
            let bits = pattern << bitBase;
            if (inHi) { hi = hi | bits; } else { lo = lo | bits; }
        }
    }

    masksOut[innerBlockIdx * 2u] = lo;
    masksOut[innerBlockIdx * 2u + 1u] = hi;

    var bt = 0u;
    if (lo != 0u || hi != 0u) {
        if (lo == 0xFFFFFFFFu && hi == 0xFFFFFFFFu) { bt = 1u; } else { bt = 2u; }
    }
    let typeWordIdx = innerBlockIdx >> 4u;
    let typeBitShift = (innerBlockIdx & 15u) * 2u;
    atomicOr(&typesOut[typeWordIdx], bt << typeBitShift);
}
`;
const dilateXWgsl = () => /* wgsl */ `
struct DilateXUniforms {
    numXWords: u32,
    ny: u32,
    nz: u32,
    halfExtent: u32
}

@group(0) @binding(0) var<uniform> u: DilateXUniforms;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

fn readWord(rowOffset: u32, word: i32) -> u32 {
    if (word < 0 || word >= i32(u.numXWords)) { return 0u; }
    return src[rowOffset + u32(word)];
}

@compute @workgroup_size(8, 4, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= u.numXWords || gid.y >= u.ny || gid.z >= u.nz) { return; }

    let xWord = gid.x;
    let y = gid.y;
    let z = gid.z;
    let rowStride = u.numXWords;
    let planeStride = rowStride * u.ny;
    let rowOffset = y * rowStride + z * planeStride;
    var output = src[rowOffset + xWord];
    let rowBits = u.numXWords * 32u;
    let r = min(u.halfExtent, rowBits);
    for (var d = 1u; d <= r; d = d + 1u) {
        let wordOffset = i32(d >> 5u);
        let bitShift = d & 31u;
        let baseWord = i32(xWord);
        var shiftedPos = readWord(rowOffset, baseWord + wordOffset);
        if (bitShift != 0u) {
            shiftedPos = (shiftedPos >> bitShift) | (readWord(rowOffset, baseWord + wordOffset + 1) << (32u - bitShift));
        }
        var shiftedNeg = readWord(rowOffset, baseWord - wordOffset);
        if (bitShift != 0u) {
            shiftedNeg = (shiftedNeg << bitShift) | (readWord(rowOffset, baseWord - wordOffset - 1) >> (32u - bitShift));
        }
        output = output | shiftedPos | shiftedNeg;
        if (output == 0xFFFFFFFFu) { break; }
    }
    dst[rowOffset + xWord] = output;
}
`;
const dilateYZWgsl = () => /* wgsl */ `
struct DilateYZUniforms {
    numXWords: u32,
    ny: u32,
    nz: u32,
    halfExtent: u32,
    stride: u32,
    axisLen: u32
}

@group(0) @binding(0) var<uniform> u: DilateYZUniforms;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

@compute @workgroup_size(8, 4, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    if (gid.x >= u.numXWords || gid.y >= u.ny || gid.z >= u.nz) { return; }

    let xWord = gid.x;
    let y = gid.y;
    let z = gid.z;
    let rowStride = u.numXWords;
    let planeStride = rowStride * u.ny;
    let outIdx = i32(xWord) + i32(y) * i32(rowStride) + i32(z) * i32(planeStride);
    let pos = select(z, y, u.stride == rowStride);
    let r = i32(u.halfExtent);
    let lo = max(0, i32(pos) - r);
    let hi = min(i32(u.axisLen) - 1, i32(pos) + r);
    let baseIdx = outIdx - i32(pos) * i32(u.stride);
    var output = 0u;
    for (var p = lo; p <= hi; p = p + 1) {
        output = output | src[baseIdx + p * i32(u.stride)];
        if (output == 0xFFFFFFFFu) { break; }
    }
    dst[outIdx] = output;
}
`;
const makeBuffer = (device, size, usage) => (device.createBuffer({ size: Math.max(4, size), usage }));
const writeUniform = (device, values) => {
    const buffer = makeBuffer(device, 256, GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST);
    device.queue.writeBuffer(buffer, 0, values.buffer, values.byteOffset, values.byteLength);
    return buffer;
};
const createStoragePipeline = (device, code) => (device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code }), entryPoint: 'main' }
}));
const blockAlignedExtent = (halfExtent) => (halfExtent === 0 ? 0 : Math.ceil(halfExtent / 4) * 4);
const chunkIsEmpty = (src, ox, oy, oz, cx, cy, cz) => {
    const minBx = Math.max(0, Math.floor(ox / 4));
    const minBy = Math.max(0, Math.floor(oy / 4));
    const minBz = Math.max(0, Math.floor(oz / 4));
    const maxBx = Math.min(src.nbx, Math.ceil((ox + cx) / 4));
    const maxBy = Math.min(src.nby, Math.ceil((oy + cy) / 4));
    const maxBz = Math.min(src.nbz, Math.ceil((oz + cz) / 4));
    if (maxBx <= minBx || maxBy <= minBy || maxBz <= minBz) {
        return true;
    }
    for (let bz = minBz; bz < maxBz; bz++) {
        for (let by = minBy; by < maxBy; by++) {
            for (let bx = minBx; bx < maxBx; bx++) {
                const blockIdx = bx + by * src.nbx + bz * src.bStride;
                if (readBlockType(src.types, blockIdx) !== BLOCK_EMPTY) {
                    return false;
                }
            }
        }
    }
    return true;
};
const chunkIsSaturated = (src, ox, oy, oz, cx, cy, cz) => {
    if (ox < 0 || oy < 0 || oz < 0) {
        return false;
    }
    if (ox + cx > src.nx || oy + cy > src.ny || oz + cz > src.nz) {
        return false;
    }
    const minBx = ox >> 2;
    const minBy = oy >> 2;
    const minBz = oz >> 2;
    const maxBx = (ox + cx + 3) >> 2;
    const maxBy = (oy + cy + 3) >> 2;
    const maxBz = (oz + cz + 3) >> 2;
    for (let bz = minBz; bz < maxBz; bz++) {
        for (let by = minBy; by < maxBy; by++) {
            for (let bx = minBx; bx < maxBx; bx++) {
                const blockIdx = bx + by * src.nbx + bz * src.bStride;
                if (readBlockType(src.types, blockIdx) !== BLOCK_SOLID) {
                    return false;
                }
            }
        }
    }
    return true;
};
const insertSaturatedInner = (dst, innerOx, innerOy, innerOz, innerCx, innerCy, innerCz) => {
    const minBx = Math.max(0, innerOx >> 2);
    const minBy = Math.max(0, innerOy >> 2);
    const minBz = Math.max(0, innerOz >> 2);
    const maxBx = Math.min(dst.nbx, (innerOx + innerCx + 3) >> 2);
    const maxBy = Math.min(dst.nby, (innerOy + innerCy + 3) >> 2);
    const maxBz = Math.min(dst.nbz, (innerOz + innerCz + 3) >> 2);
    for (let bz = minBz; bz < maxBz; bz++) {
        for (let by = minBy; by < maxBy; by++) {
            const rowBase = by * dst.nbx + bz * dst.bStride;
            let blockIdx = rowBase + minBx;
            const endIdx = rowBase + maxBx;
            while (blockIdx < endIdx) {
                const w = blockIdx >>> 4;
                const shift = (blockIdx & 15) << 1;
                const remainingInWord = 16 - (blockIdx & 15);
                const remainingInRow = endIdx - blockIdx;
                const blocksToWrite = Math.min(remainingInWord, remainingInRow);
                if (blocksToWrite === 16) {
                    dst.types[w] = SOLID_WORD;
                }
                else {
                    const bits = blocksToWrite << 1;
                    const mask = (((1 << bits) - 1) >>> 0) << shift;
                    dst.types[w] = ((dst.types[w] & ~mask) | (SOLID_WORD & mask)) >>> 0;
                }
                blockIdx += blocksToWrite;
            }
        }
    }
};
const applyChunkToDst = (dst, typesOut, masksOut, cx, cy, cz, innerNx, innerNy, innerNz) => {
    const innerBx = innerNx >> 2;
    const innerBy = innerNy >> 2;
    const innerBz = innerNz >> 2;
    const baseBx = cx >> 2;
    const baseBy = cy >> 2;
    const baseBz = cz >> 2;
    let innerIdx = 0;
    for (let bz = 0; bz < innerBz; bz++) {
        const globalBz = baseBz + bz;
        for (let by = 0; by < innerBy; by++) {
            const globalBy = baseBy + by;
            const baseGlobalIdx = baseBx + globalBy * dst.nbx + globalBz * dst.bStride;
            for (let bx = 0; bx < innerBx; bx++, innerIdx++) {
                const wordIdx = innerIdx >>> 4;
                const bitShift = (innerIdx & 15) << 1;
                const bt = (typesOut[wordIdx] >>> bitShift) & 3;
                if (bt === BLOCK_EMPTY) {
                    continue;
                }
                const globalBlockIdx = baseGlobalIdx + bx;
                const w = globalBlockIdx >>> 4;
                const shift = (globalBlockIdx & 15) << 1;
                dst.types[w] |= bt << shift;
                if (bt === BLOCK_MIXED) {
                    const m2 = innerIdx * 2;
                    dst.masks.set(globalBlockIdx, masksOut[m2], masksOut[m2 + 1]);
                }
            }
        }
    }
};
class GpuDilation {
    device;
    extractPipeline;
    compactPipeline;
    dilateXPipeline;
    dilateYZPipeline;
    slots = [];
    srcTypesBuffer;
    srcKeysBuffer;
    srcLoBuffer;
    srcHiBuffer;
    srcMeta = { nbx: 0, nby: 0, nbz: 0, bStride: 0, capMinusOne: 0 };
    static NUM_SLOTS = 2;
    constructor(device) {
        this.device = device;
        this.extractPipeline = createStoragePipeline(device, extractWgsl());
        this.compactPipeline = createStoragePipeline(device, compactWgsl());
        this.dilateXPipeline = createStoragePipeline(device, dilateXWgsl());
        this.dilateYZPipeline = createStoragePipeline(device, dilateYZWgsl());
        for (let i = 0; i < GpuDilation.NUM_SLOTS; i++) {
            const capacity = 1024 * 1024 * 4;
            const typesOutCapacity = 64 * 1024;
            const masksOutCapacity = 1024 * 1024;
            this.slots.push({
                bufferA: makeBuffer(device, capacity, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC),
                bufferB: makeBuffer(device, capacity, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC),
                readTypesBuffer: makeBuffer(device, typesOutCapacity, GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ),
                readMasksBuffer: makeBuffer(device, masksOutCapacity, GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ),
                typesOutBuffer: makeBuffer(device, typesOutCapacity, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC),
                masksOutBuffer: makeBuffer(device, masksOutCapacity, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC),
                capacity,
                typesOutCapacity,
                masksOutCapacity
            });
        }
    }
    replaceBuffer(slot, key, size, usage) {
        slot[key].destroy();
        slot[key] = makeBuffer(this.device, size, usage);
    }
    ensureSlotBuffers(slot, numWords) {
        const neededBytes = numWords * 4;
        if (neededBytes <= slot.capacity) {
            return;
        }
        let cap = slot.capacity;
        while (cap < neededBytes) {
            cap *= 2;
        }
        this.replaceBuffer(slot, 'bufferA', cap, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC);
        this.replaceBuffer(slot, 'bufferB', cap, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC);
        slot.capacity = cap;
    }
    ensureSlotOutputBuffers(slot, innerBlocks) {
        const typesBytes = ((innerBlocks + 15) >>> 4) * 4;
        if (slot.typesOutCapacity < typesBytes) {
            this.replaceBuffer(slot, 'typesOutBuffer', typesBytes, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC);
            this.replaceBuffer(slot, 'readTypesBuffer', typesBytes, GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ);
            slot.typesOutCapacity = typesBytes;
        }
        const masksBytes = innerBlocks * 8;
        if (slot.masksOutCapacity < masksBytes) {
            this.replaceBuffer(slot, 'masksOutBuffer', masksBytes, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_COPY_SRC);
            this.replaceBuffer(slot, 'readMasksBuffer', masksBytes, GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ);
            slot.masksOutCapacity = masksBytes;
        }
    }
    uploadSrc(src) {
        this.releaseSrc();
        this.srcTypesBuffer = makeBuffer(this.device, src.types.byteLength, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST);
        this.device.queue.writeBuffer(this.srcTypesBuffer, 0, src.types.buffer, src.types.byteOffset, src.types.byteLength);
        const keysU32 = new Uint32Array(src.masks.keys.buffer, src.masks.keys.byteOffset, src.masks.keys.length);
        this.srcKeysBuffer = makeBuffer(this.device, keysU32.byteLength, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST);
        this.srcLoBuffer = makeBuffer(this.device, src.masks.lo.byteLength, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST);
        this.srcHiBuffer = makeBuffer(this.device, src.masks.hi.byteLength, GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST);
        this.device.queue.writeBuffer(this.srcKeysBuffer, 0, keysU32.buffer, keysU32.byteOffset, keysU32.byteLength);
        this.device.queue.writeBuffer(this.srcLoBuffer, 0, src.masks.lo.buffer, src.masks.lo.byteOffset, src.masks.lo.byteLength);
        this.device.queue.writeBuffer(this.srcHiBuffer, 0, src.masks.hi.buffer, src.masks.hi.byteOffset, src.masks.hi.byteLength);
        this.srcMeta = {
            nbx: src.nbx,
            nby: src.nby,
            nbz: src.nbz,
            bStride: src.bStride,
            capMinusOne: src.masks.keys.length - 1
        };
    }
    releaseSrc() {
        this.srcTypesBuffer?.destroy();
        this.srcKeysBuffer?.destroy();
        this.srcLoBuffer?.destroy();
        this.srcHiBuffer?.destroy();
        this.srcTypesBuffer = undefined;
        this.srcKeysBuffer = undefined;
        this.srcLoBuffer = undefined;
        this.srcHiBuffer = undefined;
    }
    submitChunkSparse(slotIdx, minBx, minBy, minBz, outerBx, outerBy, outerBz, haloBx, haloBy, haloBz, innerBx, innerBy, innerBz, halfExtentXZ, halfExtentY) {
        if (!this.srcTypesBuffer || !this.srcKeysBuffer || !this.srcLoBuffer || !this.srcHiBuffer) {
            throw new Error('GpuDilation: must call uploadSrc() before submitChunkSparse()');
        }
        const slot = this.slots[slotIdx];
        const outerNx = outerBx * 4;
        const outerNy = outerBy * 4;
        const outerNz = outerBz * 4;
        const numXWords = (outerNx + 31) >>> 5;
        const numWords = numXWords * outerNy * outerNz;
        const innerBlocks = innerBx * innerBy * innerBz;
        const typesOutWords = (innerBlocks + 15) >>> 4;
        this.ensureSlotBuffers(slot, numWords);
        this.ensureSlotOutputBuffers(slot, innerBlocks);
        const uniformBuffers = [];
        const makeUniform = (values) => {
            const buffer = writeUniform(this.device, values);
            uniformBuffers.push(buffer);
            return buffer;
        };
        {
            const encoder = this.device.createCommandEncoder();
            encoder.clearBuffer(slot.bufferA, 0, numWords * 4);
            const uniforms = new Uint32Array([
                minBx >>> 0, minBy >>> 0, minBz >>> 0,
                outerBx, outerBy, outerBz, numXWords,
                this.srcMeta.nbx, this.srcMeta.nby, this.srcMeta.nbz,
                this.srcMeta.bStride, this.srcMeta.capMinusOne
            ]);
            const uniformBuffer = makeUniform(uniforms);
            const bindGroup = this.device.createBindGroup({
                layout: this.extractPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: { buffer: this.srcTypesBuffer } },
                    { binding: 2, resource: { buffer: this.srcKeysBuffer } },
                    { binding: 3, resource: { buffer: this.srcLoBuffer } },
                    { binding: 4, resource: { buffer: this.srcHiBuffer } },
                    { binding: 5, resource: { buffer: slot.bufferA } }
                ]
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.extractPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(outerBx / 8), Math.ceil(outerBy / 4), Math.ceil(outerBz / 8));
            pass.end();
            this.device.queue.submit([encoder.finish()]);
        }
        {
            const encoder = this.device.createCommandEncoder();
            const dispatch = (pipeline, src, dst, uniforms, wgX, wgY, wgZ) => {
                const uniformBuffer = makeUniform(uniforms);
                const bindGroup = this.device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: uniformBuffer } },
                        { binding: 1, resource: { buffer: src } },
                        { binding: 2, resource: { buffer: dst } }
                    ]
                });
                const pass = encoder.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.dispatchWorkgroups(wgX, wgY, wgZ);
                pass.end();
            };
            dispatch(this.dilateXPipeline, slot.bufferA, slot.bufferB, new Uint32Array([numXWords, outerNy, outerNz, halfExtentXZ]), Math.ceil(numXWords / 8), Math.ceil(outerNy / 4), Math.ceil(outerNz / 8));
            dispatch(this.dilateYZPipeline, slot.bufferB, slot.bufferA, new Uint32Array([numXWords, outerNy, outerNz, halfExtentXZ, numXWords * outerNy, outerNz]), Math.ceil(numXWords / 8), Math.ceil(outerNy / 4), Math.ceil(outerNz / 8));
            dispatch(this.dilateYZPipeline, slot.bufferA, slot.bufferB, new Uint32Array([numXWords, outerNy, outerNz, halfExtentY, numXWords, outerNy]), Math.ceil(numXWords / 8), Math.ceil(outerNy / 4), Math.ceil(outerNz / 8));
            encoder.clearBuffer(slot.typesOutBuffer, 0, typesOutWords * 4);
            const compactUniformBuffer = makeUniform(new Uint32Array([
                haloBx, haloBy, haloBz, numXWords, innerBx, innerBy, innerBz, outerBy
            ]));
            const compactBindGroup = this.device.createBindGroup({
                layout: this.compactPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: compactUniformBuffer } },
                    { binding: 1, resource: { buffer: slot.bufferB } },
                    { binding: 2, resource: { buffer: slot.typesOutBuffer } },
                    { binding: 3, resource: { buffer: slot.masksOutBuffer } }
                ]
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.compactPipeline);
            pass.setBindGroup(0, compactBindGroup);
            pass.dispatchWorkgroups(Math.ceil(innerBx / 8), Math.ceil(innerBy / 4), Math.ceil(innerBz / 8));
            pass.end();
            encoder.copyBufferToBuffer(slot.typesOutBuffer, 0, slot.readTypesBuffer, 0, typesOutWords * 4);
            encoder.copyBufferToBuffer(slot.masksOutBuffer, 0, slot.readMasksBuffer, 0, innerBlocks * 8);
            this.device.queue.submit([encoder.finish()]);
        }
        const typesPromise = (async () => {
            await slot.readTypesBuffer.mapAsync(GPU_MAP_MODE_READ, 0, typesOutWords * 4);
            const mapped = new Uint32Array(slot.readTypesBuffer.getMappedRange(0, typesOutWords * 4));
            const out = new Uint32Array(typesOutWords);
            out.set(mapped);
            slot.readTypesBuffer.unmap();
            return out;
        })();
        const masksPromise = (async () => {
            await slot.readMasksBuffer.mapAsync(GPU_MAP_MODE_READ, 0, innerBlocks * 8);
            const mapped = new Uint32Array(slot.readMasksBuffer.getMappedRange(0, innerBlocks * 8));
            const out = new Uint32Array(innerBlocks * 2);
            out.set(mapped);
            slot.readMasksBuffer.unmap();
            return out;
        })();
        void Promise.all([typesPromise, masksPromise]).then(() => {
            for (const buffer of uniformBuffers) {
                buffer.destroy();
            }
        });
        return { types: typesPromise, masks: masksPromise };
    }
    destroy() {
        this.releaseSrc();
        for (const slot of this.slots) {
            slot.bufferA.destroy();
            slot.bufferB.destroy();
            slot.readTypesBuffer.destroy();
            slot.readMasksBuffer.destroy();
            slot.typesOutBuffer.destroy();
            slot.masksOutBuffer.destroy();
        }
    }
}
export const gpuDilate3 = async (src, halfExtentXZ, halfExtentY) => {
    if (halfExtentXZ === 0 && halfExtentY === 0) {
        return src.clone();
    }
    if (!Number.isInteger(halfExtentXZ) || halfExtentXZ < 0) {
        throw new Error(`gpuDilate3: halfExtentXZ=${halfExtentXZ} must be a non-negative integer`);
    }
    if (!Number.isInteger(halfExtentY) || halfExtentY < 0) {
        throw new Error(`gpuDilate3: halfExtentY=${halfExtentY} must be a non-negative integer`);
    }
    const device = await getOrCreateDevice();
    const gpu = new GpuDilation(device);
    const dst = new SparseVoxelGrid(src.nx, src.ny, src.nz);
    const haloX = blockAlignedExtent(halfExtentXZ);
    const haloY = blockAlignedExtent(halfExtentY);
    const haloZ = haloX;
    const haloBx = haloX / 4;
    const haloBy = haloY / 4;
    const haloBz = haloZ / 4;
    const innerStep = CHUNK_INNER & ~3;
    let currentSlot = 0;
    let inflight;
    const drainInflight = async () => {
        if (!inflight) {
            return;
        }
        const f = inflight;
        inflight = undefined;
        const [typesOut, masksOut] = await Promise.all([f.typesPromise, f.masksPromise]);
        applyChunkToDst(dst, typesOut, masksOut, f.cx, f.cy, f.cz, f.innerNx, f.innerNy, f.innerNz);
    };
    gpu.uploadSrc(src);
    try {
        for (let cz = 0; cz < src.nz; cz += innerStep) {
            for (let cy = 0; cy < src.ny; cy += innerStep) {
                for (let cx = 0; cx < src.nx; cx += innerStep) {
                    const innerNx = Math.min(innerStep, src.nx - cx);
                    const innerNy = Math.min(innerStep, src.ny - cy);
                    const innerNz = Math.min(innerStep, src.nz - cz);
                    const ox = cx - haloX;
                    const oy = cy - haloY;
                    const oz = cz - haloZ;
                    const outerNx = innerNx + 2 * haloX;
                    const outerNy = innerNy + 2 * haloY;
                    const outerNz = innerNz + 2 * haloZ;
                    if (chunkIsEmpty(src, ox, oy, oz, outerNx, outerNy, outerNz)) {
                        continue;
                    }
                    if (chunkIsSaturated(src, ox, oy, oz, outerNx, outerNy, outerNz)) {
                        insertSaturatedInner(dst, cx, cy, cz, innerNx, innerNy, innerNz);
                        continue;
                    }
                    const innerBx = innerNx >> 2;
                    const innerBy = innerNy >> 2;
                    const innerBz = innerNz >> 2;
                    const outerBx = outerNx >> 2;
                    const outerBy = outerNy >> 2;
                    const outerBz = outerNz >> 2;
                    const minBx = Math.floor(ox / 4);
                    const minBy = Math.floor(oy / 4);
                    const minBz = Math.floor(oz / 4);
                    const { types, masks } = gpu.submitChunkSparse(currentSlot, minBx, minBy, minBz, outerBx, outerBy, outerBz, haloBx, haloBy, haloBz, innerBx, innerBy, innerBz, halfExtentXZ, halfExtentY);
                    if (inflight) {
                        await drainInflight();
                    }
                    inflight = {
                        typesPromise: types,
                        masksPromise: masks,
                        cx,
                        cy,
                        cz,
                        innerNx,
                        innerNy,
                        innerNz
                    };
                    currentSlot = (currentSlot + 1) % GpuDilation.NUM_SLOTS;
                }
            }
        }
        await drainInflight();
    }
    finally {
        gpu.destroy();
    }
    return dst;
};
