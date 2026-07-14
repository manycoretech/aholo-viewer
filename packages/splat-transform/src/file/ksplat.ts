import type { SplatData } from '../SplatData.js';
import { SH_MAPS } from '../constant.js';
import { createSingleSplat, fromHalf } from '../utils/index.js';
import type { IFile } from './IFile.js';

interface KSplatCompression {
    bytesPerCenter: number;
    bytesPerScale: number;
    bytesPerRotation: number;
    bytesPerColor: number;
    bytesPerSphericalHarmonicsComponent: number;
    scaleOffsetBytes: number;
    rotationOffsetBytes: number;
    colorOffsetBytes: number;
    sphericalHarmonicsOffsetBytes: number;
    scaleRange: number;
}

const KSPLAT_COMPRESSION: Record<number, KSplatCompression> = {
    0: {
        bytesPerCenter: 12,
        bytesPerScale: 12,
        bytesPerRotation: 16,
        bytesPerColor: 4,
        bytesPerSphericalHarmonicsComponent: 4,
        scaleOffsetBytes: 12,
        rotationOffsetBytes: 24,
        colorOffsetBytes: 40,
        sphericalHarmonicsOffsetBytes: 44,
        scaleRange: 1,
    },
    1: {
        bytesPerCenter: 6,
        bytesPerScale: 6,
        bytesPerRotation: 8,
        bytesPerColor: 4,
        bytesPerSphericalHarmonicsComponent: 2,
        scaleOffsetBytes: 6,
        rotationOffsetBytes: 12,
        colorOffsetBytes: 20,
        sphericalHarmonicsOffsetBytes: 24,
        scaleRange: 32767,
    },
    2: {
        bytesPerCenter: 6,
        bytesPerScale: 6,
        bytesPerRotation: 8,
        bytesPerColor: 4,
        bytesPerSphericalHarmonicsComponent: 1,
        scaleOffsetBytes: 6,
        rotationOffsetBytes: 12,
        colorOffsetBytes: 20,
        sphericalHarmonicsOffsetBytes: 24,
        scaleRange: 32767,
    },
};

interface KSplatHeader {
    versionMajor: number;
    versionMinor: number;
    maxSectionCount: number;
    sectionCount: number;
    maxSplatCount: number;
    splatCount: number;
    compressionLevel: number;
    sceneCenter: [number, number, number];
    shRange: [number, number];
}

interface KSplatSection {
    sectionSplatCount: number;
    sectionMaxSplatCount: number;
    bucketSize: number;
    bucketCount: number;
    bucketBlockSize: number;
    bucketStorageSizeBytes: number;
    compressionScaleRange: number;
    fullBucketCount: number;
    partiallyFilledBucketCount: number;
    shDegree: number;
}

const SHIndex = [
    0,
    3,
    6,
    1,
    4,
    7,
    2,
    5,
    8, // sh1
    9,
    14,
    19,
    10,
    15,
    20,
    11,
    16,
    21,
    12,
    17,
    22,
    13,
    18,
    23, // sh2
    24,
    31,
    38,
    25,
    32,
    39,
    26,
    33,
    40,
    27,
    34,
    41,
    28,
    35,
    42,
    29,
    36,
    43,
    30,
    37,
    44, // sh3
];

const HEADER_BYTES = 4096;
const SECTION_BYTES = 1024;

export class KsplatFile implements IFile {
    private counts: number = 0;
    private shDegree: number = 0;
    private header: KSplatHeader;
    private sections: KSplatSection[];

    private buffer: Uint8Array;

    private load(buffer: Uint8Array) {
        this.buffer = buffer;

        const header = new DataView(buffer.buffer, 0, HEADER_BYTES);
        const versionMajor = header.getUint8(0);
        const versionMinor = header.getUint8(1);
        if (versionMajor !== 0 || versionMinor < 1) {
            throw new Error(`Unsupported .ksplat version: ${versionMajor}.${versionMinor}`);
        }
        const maxSectionCount = header.getUint32(4, true);
        const sectionCount = header.getUint32(8, true);
        const maxSplatCount = header.getUint32(12, true);
        const splatCount = header.getUint32(16, true);
        const compressionLevel = header.getUint16(20, true);
        if (compressionLevel < 0 || compressionLevel > 2) {
            throw new Error(`Invalid .ksplat compression level: ${compressionLevel}`);
        }
        const sceneCenterX = header.getFloat32(24, true);
        const sceneCenterY = header.getFloat32(28, true);
        const sceneCenterZ = header.getFloat32(32, true);
        const minSH = header.getFloat32(36, true) || -1.5;
        const maxSH = header.getFloat32(40, true) || 1.5;

        let maxSHDegree: number = 0;
        const sections: KSplatSection[] = [];
        for (let i = 0; i < maxSectionCount; i++) {
            const section = new DataView(buffer.buffer, HEADER_BYTES + i * SECTION_BYTES, SECTION_BYTES);
            const sectionSplatCount = section.getUint32(0, true);
            const sectionMaxSplatCount = section.getUint32(4, true);
            const bucketSize = section.getUint32(8, true);
            const bucketCount = section.getUint32(12, true);
            const bucketBlockSize = section.getFloat32(16, true);
            const bucketStorageSizeBytes = section.getUint16(20, true);
            const compressionScaleRange = section.getUint32(24, true);
            const fullBucketCount = section.getUint32(32, true);
            const partiallyFilledBucketCount = section.getUint32(36, true);
            const shDegree = section.getUint16(40, true);

            maxSHDegree = Math.max(maxSHDegree, shDegree);
            sections.push({
                sectionSplatCount,
                sectionMaxSplatCount,
                bucketSize,
                bucketCount,
                bucketBlockSize,
                bucketStorageSizeBytes,
                compressionScaleRange: compressionScaleRange || KSPLAT_COMPRESSION[compressionLevel].scaleRange,
                fullBucketCount,
                partiallyFilledBucketCount,
                shDegree,
            });
        }

        this.header = {
            versionMajor,
            versionMinor,
            maxSectionCount,
            sectionCount,
            maxSplatCount,
            splatCount,
            compressionLevel,
            sceneCenter: [sceneCenterX, sceneCenterY, sceneCenterZ],
            shRange: [minSH, maxSH],
        };
        this.sections = sections;
        this.counts = splatCount;
        this.shDegree = maxSHDegree;
    }

    async read(stream: ReadableStream<Uint8Array>, contentLength: number, data: SplatData) {
        let BlockOffset: number = 0;
        {
            const buffer = new Uint8Array(contentLength);
            const reader = stream.getReader();
            let offset = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer.set(value!, offset);
                offset += value!.length;
            }
            this.load(buffer);
            BlockOffset = await data.initBlock(this.counts, this.shDegree);
        }

        const setFn = data.set.bind(data) as SplatData['set'];
        const setShFn = data.setShN.bind(data) as SplatData['setShN'];

        const { buffer, header, sections, shDegree: maxSHDegree } = this;
        const {
            maxSectionCount,
            compressionLevel,
            shRange: [minSH, maxSH],
        } = header;
        const isHighQualitySplatData = compressionLevel === 0;

        const single = createSingleSplat();
        const maxSHSize = SH_MAPS[maxSHDegree];
        const shData = new Array(maxSHSize);

        let sectionBase = HEADER_BYTES + maxSectionCount * SECTION_BYTES;
        for (let i = 0; i < maxSectionCount; i++) {
            const {
                sectionSplatCount,
                sectionMaxSplatCount,
                bucketSize,
                bucketCount,
                bucketBlockSize,
                bucketStorageSizeBytes,
                fullBucketCount,
                partiallyFilledBucketCount,
                compressionScaleRange,
                shDegree,
            } = sections[i];

            const fullBucketSplats = fullBucketCount * bucketSize;
            const bucketsMetaDataSizeBytes = partiallyFilledBucketCount * 4;
            const bucketsStorageSizeBytes = bucketStorageSizeBytes * bucketCount + bucketsMetaDataSizeBytes;
            const shComponents = SH_MAPS[shDegree];
            const {
                bytesPerCenter,
                bytesPerScale,
                bytesPerRotation,
                bytesPerColor,
                bytesPerSphericalHarmonicsComponent,
                scaleOffsetBytes,
                rotationOffsetBytes,
                colorOffsetBytes,
                sphericalHarmonicsOffsetBytes,
            } = KSPLAT_COMPRESSION[compressionLevel];
            const bytesPerSplat =
                bytesPerCenter +
                bytesPerScale +
                bytesPerRotation +
                bytesPerColor +
                shComponents * bytesPerSphericalHarmonicsComponent;
            const splatDataStorageSizeBytes = bytesPerSplat * sectionMaxSplatCount;
            const storageSizeBytes = splatDataStorageSizeBytes + bucketsStorageSizeBytes;

            const compressionScaleFactor = bucketBlockSize / 2 / compressionScaleRange;
            const bucketsBase = sectionBase + bucketsMetaDataSizeBytes;
            const dataBase = sectionBase + bucketsStorageSizeBytes;
            const data = new DataView(buffer.buffer, dataBase, splatDataStorageSizeBytes);
            const bucketArray = new Float32Array(buffer.buffer, bucketsBase, bucketCount * 3);
            const partiallyFilledBucketLengths = new Uint32Array(
                buffer.buffer,
                sectionBase,
                partiallyFilledBucketCount,
            );

            let partialBucketIndex = fullBucketCount;
            let partialBucketBase = fullBucketSplats;
            for (let j = 0; j < sectionSplatCount; j++) {
                const splatOffset = j * bytesPerSplat;

                let bucketIndex: number;
                if (j < fullBucketSplats) {
                    bucketIndex = Math.floor(j / bucketSize);
                } else {
                    const bucketLength = partiallyFilledBucketLengths[partialBucketIndex - fullBucketCount];
                    if (j >= partialBucketBase + bucketLength) {
                        partialBucketIndex += 1;
                        partialBucketBase += bucketLength;
                    }
                    bucketIndex = partialBucketIndex;
                }

                if (isHighQualitySplatData) {
                    single.x = data.getFloat32(splatOffset + 0, true);
                    single.y = data.getFloat32(splatOffset + 4, true);
                    single.z = data.getFloat32(splatOffset + 8, true);
                    single.sx = data.getFloat32(splatOffset + scaleOffsetBytes + 0, true);
                    single.sy = data.getFloat32(splatOffset + scaleOffsetBytes + 4, true);
                    single.sz = data.getFloat32(splatOffset + scaleOffsetBytes + 8, true);
                    single.qw = data.getFloat32(splatOffset + rotationOffsetBytes + 0, true);
                    single.qx = data.getFloat32(splatOffset + rotationOffsetBytes + 4, true);
                    single.qy = data.getFloat32(splatOffset + rotationOffsetBytes + 8, true);
                    single.qz = data.getFloat32(splatOffset + rotationOffsetBytes + 12, true);
                } else {
                    single.x =
                        (data.getUint16(splatOffset + 0, true) - compressionScaleRange) * compressionScaleFactor +
                        bucketArray[3 * bucketIndex + 0];
                    single.y =
                        (data.getUint16(splatOffset + 2, true) - compressionScaleRange) * compressionScaleFactor +
                        bucketArray[3 * bucketIndex + 1];
                    single.z =
                        (data.getUint16(splatOffset + 4, true) - compressionScaleRange) * compressionScaleFactor +
                        bucketArray[3 * bucketIndex + 2];
                    single.sx = fromHalf(data.getUint16(splatOffset + scaleOffsetBytes + 0, true));
                    single.sy = fromHalf(data.getUint16(splatOffset + scaleOffsetBytes + 2, true));
                    single.sz = fromHalf(data.getUint16(splatOffset + scaleOffsetBytes + 4, true));
                    single.qw = fromHalf(data.getUint16(splatOffset + rotationOffsetBytes + 0, true));
                    single.qx = fromHalf(data.getUint16(splatOffset + rotationOffsetBytes + 2, true));
                    single.qy = fromHalf(data.getUint16(splatOffset + rotationOffsetBytes + 4, true));
                    single.qz = fromHalf(data.getUint16(splatOffset + rotationOffsetBytes + 6, true));
                }
                single.r = data.getUint8(splatOffset + colorOffsetBytes + 0) / 255;
                single.g = data.getUint8(splatOffset + colorOffsetBytes + 1) / 255;
                single.b = data.getUint8(splatOffset + colorOffsetBytes + 2) / 255;
                single.a = data.getUint8(splatOffset + colorOffsetBytes + 3) / 255;

                setFn(j + BlockOffset, single);

                const shOffsetBytes = splatOffset + sphericalHarmonicsOffsetBytes;
                for (let k = 0; k < shComponents; k++) {
                    shData[k] =
                        compressionLevel === 0
                            ? data.getFloat32(shOffsetBytes + SHIndex[k] * 4, true)
                            : compressionLevel === 1
                              ? fromHalf(data.getUint16(shOffsetBytes + SHIndex[k] * 2, true))
                              : minSH + (data.getUint8(shOffsetBytes + SHIndex[k]) / 255) * (maxSH - minSH);
                }
                for (let k = maxSHSize - 1; k >= shComponents; k--) {
                    shData[k] = 0;
                }
                setShFn(j + BlockOffset, shData);
            }
            sectionBase += storageSizeBytes;
        }
        data.finishBlock();
    }

    async write(_stream: WritableStream<Uint8Array>, _data: SplatData, _indices: Uint32Array) {
        throw new Error('Method not implemented.');
    }
}
