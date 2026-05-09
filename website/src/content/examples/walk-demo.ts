/**
 * @file Walk demo: splats + collision + {@link ViewerWalkMode}.
 *
 * @remarks
 * **Upstream:** This file incorporates logic derived from
 * [SuperSplat Viewer](https://github.com/playcanvas/supersplat-viewer)
 * (PlayCanvas) at commit
 * [`9e7e51f658534a81a377bb9d818e872984448a50`](https://github.com/playcanvas/supersplat-viewer/tree/9e7e51f658534a81a377bb9d818e872984448a50),
 * then modified for Aholo Viewer (`@manycore/aholo-viewer`) and the render runtime entry,
 * walk mode, voxel collision, and site-specific assets under `public/walk-demo/`.
 * The upstream project is released under the [MIT License](https://github.com/playcanvas/supersplat-viewer/blob/9e7e51f658534a81a377bb9d818e872984448a50/LICENSE);
 * retain applicable notices when redistributing derived portions.
 *
 * Scene presets (`WALK_DEMO_SCHEMES`) and spawn poses are defined below. Scheme and first/third-person are controlled via the runtime config panel (Tweakpane), same as other samples.
 * Per-scene attribution and asset notes live in `walk-demo.json` (`sceneNotes`).
 * To regenerate from split sources, restore `website/src/utils/walk-viewer/` from git and run `node scripts/merge-walk-unified.mjs`.
 */
import type { RenderRuntime, RuntimeIndexedDBStorage } from '../../client/render-runtime';
import {
    AmbientLight,
    Animation,
    BackgroundMode,
    DirectionalLight,
    createViewerContext,
    downloadTexture,
    Events,
    SplatLoader,
    GLTFLoader,
    Object3D,
    PerspectiveCamera,
    setViewerConfig,
    TypeAssert,
    SplatUtils,
    Vector3,
    Euler,
    Quaternion,
    Box3,
    Color,
} from '@manycore/aholo-viewer';
import type { Scene3D, Splat, Viewer } from '@manycore/aholo-viewer';

const AnimationPlugin = Animation.AnimationPlugin;
const AnimationMixer = Animation.AnimationMixer;
const Skeleton = Animation.Skeleton;
const Loop = Animation.Loop;

const { CompressedSplatData, parseSplatData, detectSplatFileType, SplatPackType } = SplatLoader;
type SerializedCompressedSplatData = Parameters<InstanceType<typeof CompressedSplatData>['deserialize']>[0];
const { createSplat, LodSplat } = SplatUtils;
const { loadGLTF } = GLTFLoader;

const SplatRenderingStabilityChangedEvent = Events.SplatRenderingStabilityChangedEvent;

type Texture2D = Awaited<ReturnType<typeof downloadTexture>>;
type AnimationClip = Animation.AnimationClip;

/** Space-bar jump; off by default — jump clip is stiff for this demo. */
const WALK_JUMP_ENABLED = false;

/**
 * When third-person is active, optionally hide the OS cursor over the walk surface (`cursor: none`).
 * Default `false` so the pointer stays visible; set `true` for a game-style locked look.
 */
const WALK_THIRD_PERSON_HIDE_CURSOR = false;

const SOLID_LEAF_MARKER = 0xff000000 >>> 0;
const PENETRATION_EPSILON = 1e-4;
const MAX_RESOLVE_ITERATIONS = 4;

export interface VoxelMetadata {
    version: string;
    gridBounds: { min: number[]; max: number[] };
    sceneBounds: { min: number[]; max: number[] };
    voxelResolution: number;
    leafSize: number;
    treeDepth: number;
    numInteriorNodes: number;
    numMixedLeaves: number;
    nodeCount: number;
    leafDataCount: number;
}

interface VoxelPushOut {
    x: number;
    y: number;
    z: number;
}

const popcount = (n: number) => {
    n >>>= 0;
    n -= (n >>> 1) & 0x55555555;
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

export class VoxelCollision {
    private _gridMinX: number;
    private _gridMinY: number;
    private _gridMinZ: number;
    private _numVoxelsX: number;
    private _numVoxelsY: number;
    private _numVoxelsZ: number;
    private _voxelResolution: number;
    private _leafSize: number;
    private _treeDepth: number;
    private _nodes: Uint32Array;
    private _leafData: Uint32Array;
    private _push: VoxelPushOut = { x: 0, y: 0, z: 0 };
    private _constraints: VoxelPushOut[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
    ];

    constructor(metadata: VoxelMetadata, nodes: Uint32Array, leafData: Uint32Array) {
        this._gridMinX = metadata.gridBounds.min[0];
        this._gridMinY = metadata.gridBounds.min[1];
        this._gridMinZ = metadata.gridBounds.min[2];
        const res = metadata.voxelResolution;
        this._numVoxelsX = Math.round((metadata.gridBounds.max[0] - metadata.gridBounds.min[0]) / res);
        this._numVoxelsY = Math.round((metadata.gridBounds.max[1] - metadata.gridBounds.min[1]) / res);
        this._numVoxelsZ = Math.round((metadata.gridBounds.max[2] - metadata.gridBounds.min[2]) / res);
        this._voxelResolution = res;
        this._leafSize = metadata.leafSize;
        this._treeDepth = metadata.treeDepth;
        this._nodes = nodes;
        this._leafData = leafData;
    }

    get voxelResolution() {
        return this._voxelResolution;
    }
    get gridMinX() {
        return this._gridMinX;
    }
    get gridMinY() {
        return this._gridMinY;
    }
    get gridMinZ() {
        return this._gridMinZ;
    }
    get numVoxelsX() {
        return this._numVoxelsX;
    }
    get numVoxelsY() {
        return this._numVoxelsY;
    }
    get numVoxelsZ() {
        return this._numVoxelsZ;
    }
    get nodes() {
        return this._nodes;
    }
    get leafData() {
        return this._leafData;
    }

    isVoxelSolid(ix: number, iy: number, iz: number): boolean {
        if (
            this._nodes.length === 0 ||
            ix < 0 ||
            iy < 0 ||
            iz < 0 ||
            ix >= this._numVoxelsX ||
            iy >= this._numVoxelsY ||
            iz >= this._numVoxelsZ
        ) {
            return false;
        }
        const blockX = Math.floor(ix / this._leafSize);
        const blockY = Math.floor(iy / this._leafSize);
        const blockZ = Math.floor(iz / this._leafSize);
        let nodeIndex = 0;
        for (let level = this._treeDepth - 1; level >= 0; level--) {
            const node = this._nodes[nodeIndex] >>> 0;
            if (node === SOLID_LEAF_MARKER) {
                return true;
            }
            const childMask = (node >>> 24) & 0xff;
            if (childMask === 0) {
                return this.checkLeafByIndex(node, ix, iy, iz);
            }
            const bitX = (blockX >>> level) & 1;
            const bitY = (blockY >>> level) & 1;
            const bitZ = (blockZ >>> level) & 1;
            const octant = (bitZ << 2) | (bitY << 1) | bitX;
            if ((childMask & (1 << octant)) === 0) {
                return false;
            }
            const baseOffset = node & 0x00ffffff;
            const prefix = (1 << octant) - 1;
            nodeIndex = baseOffset + popcount(childMask & prefix);
        }
        const node = this._nodes[nodeIndex] >>> 0;
        if (node === SOLID_LEAF_MARKER) {
            return true;
        }
        return this.checkLeafByIndex(node, ix, iy, iz);
    }

    queryRay(
        ox: number,
        oy: number,
        oz: number,
        dx: number,
        dy: number,
        dz: number,
        maxDist: number,
    ): { x: number; y: number; z: number } | null {
        if (this._nodes.length === 0) {
            return null;
        }
        const res = this._voxelResolution;
        const gMinX = this._gridMinX;
        const gMinY = this._gridMinY;
        const gMinZ = this._gridMinZ;
        const gMaxX = gMinX + this._numVoxelsX * res;
        const gMaxY = gMinY + this._numVoxelsY * res;
        const gMaxZ = gMinZ + this._numVoxelsZ * res;
        const EPS = 1e-12;

        let tNear = 0;
        let tFar = maxDist;
        const slab = (o: number, d: number, min: number, max: number) => {
            if (Math.abs(d) <= EPS) {
                return o >= min && o < max;
            }
            let t1 = (min - o) / d;
            let t2 = (max - o) / d;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tNear) {
                tNear = t1;
            }
            tFar = Math.min(tFar, t2);
            return tNear <= tFar;
        };
        if (!slab(ox, dx, gMinX, gMaxX) || !slab(oy, dy, gMinY, gMaxY) || !slab(oz, dz, gMinZ, gMaxZ)) {
            return null;
        }
        const entryX = ox + dx * tNear;
        const entryY = oy + dy * tNear;
        const entryZ = oz + dz * tNear;
        let ix = Math.max(0, Math.min(Math.floor((entryX - gMinX) / res), this._numVoxelsX - 1));
        let iy = Math.max(0, Math.min(Math.floor((entryY - gMinY) / res), this._numVoxelsY - 1));
        let iz = Math.max(0, Math.min(Math.floor((entryZ - gMinZ) / res), this._numVoxelsZ - 1));

        const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
        const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
        const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
        const invDx = Math.abs(dx) > EPS ? 1 / dx : 0;
        const invDy = Math.abs(dy) > EPS ? 1 / dy : 0;
        const invDz = Math.abs(dz) > EPS ? 1 / dz : 0;
        let tMaxX = Math.abs(dx) > EPS ? (gMinX + (ix + (dx > 0 ? 1 : 0)) * res - ox) * invDx : Infinity;
        let tMaxY = Math.abs(dy) > EPS ? (gMinY + (iy + (dy > 0 ? 1 : 0)) * res - oy) * invDy : Infinity;
        let tMaxZ = Math.abs(dz) > EPS ? (gMinZ + (iz + (dz > 0 ? 1 : 0)) * res - oz) * invDz : Infinity;
        const tDeltaX = Math.abs(dx) > EPS ? res * Math.abs(invDx) : Infinity;
        const tDeltaY = Math.abs(dy) > EPS ? res * Math.abs(invDy) : Infinity;
        const tDeltaZ = Math.abs(dz) > EPS ? res * Math.abs(invDz) : Infinity;
        let currentT = tNear;

        const maxSteps = this._numVoxelsX + this._numVoxelsY + this._numVoxelsZ;
        for (let i = 0; i < maxSteps; i++) {
            if (this.isVoxelSolid(ix, iy, iz)) {
                return { x: ox + dx * currentT, y: oy + dy * currentT, z: oz + dz * currentT };
            }
            if (tMaxX < tMaxY) {
                if (tMaxX < tMaxZ) {
                    currentT = tMaxX;
                    ix += stepX;
                    tMaxX += tDeltaX;
                } else {
                    currentT = tMaxZ;
                    iz += stepZ;
                    tMaxZ += tDeltaZ;
                }
            } else if (tMaxY < tMaxZ) {
                currentT = tMaxY;
                iy += stepY;
                tMaxY += tDeltaY;
            } else {
                currentT = tMaxZ;
                iz += stepZ;
                tMaxZ += tDeltaZ;
            }
            if (
                ix < 0 ||
                iy < 0 ||
                iz < 0 ||
                ix >= this._numVoxelsX ||
                iy >= this._numVoxelsY ||
                iz >= this._numVoxelsZ ||
                currentT > maxDist
            ) {
                return null;
            }
        }
        return null;
    }

    queryCapsule(cx: number, cy: number, cz: number, halfHeight: number, radius: number, out: VoxelPushOut): boolean {
        return this.resolveIterative(
            cx,
            cy,
            cz,
            (rx, ry, rz, push) => this.resolveDeepestPenetrationCapsule(rx, ry, rz, halfHeight, radius, push),
            out,
        );
    }

    enumerateSolidVoxelCenters(maxCount = 120000): Float32Array {
        const out: number[] = [];
        const res = this._voxelResolution;
        const leaf = this._leafSize;
        const nbx = Math.floor(this._numVoxelsX / leaf);
        const nby = Math.floor(this._numVoxelsY / leaf);
        const nbz = Math.floor(this._numVoxelsZ / leaf);

        const pushSolidBlock = (bx: number, by: number, bz: number) => {
            const baseX = this._gridMinX + bx * leaf * res;
            const baseY = this._gridMinY + by * leaf * res;
            const baseZ = this._gridMinZ + bz * leaf * res;
            for (let lz = 0; lz < 4; lz++) {
                for (let ly = 0; ly < 4; ly++) {
                    for (let lx = 0; lx < 4; lx++) {
                        out.push(baseX + (lx + 0.5) * res, baseY + (ly + 0.5) * res, baseZ + (lz + 0.5) * res);
                    }
                }
            }
        };

        const pushMixedBlock = (bx: number, by: number, bz: number, leafDataIndex: number) => {
            const baseX = this._gridMinX + bx * leaf * res;
            const baseY = this._gridMinY + by * leaf * res;
            const baseZ = this._gridMinZ + bz * leaf * res;
            const lo = this._leafData[leafDataIndex * 2] >>> 0;
            const hi = this._leafData[leafDataIndex * 2 + 1] >>> 0;
            for (let lz = 0; lz < 4; lz++) {
                for (let ly = 0; ly < 4; ly++) {
                    for (let lx = 0; lx < 4; lx++) {
                        const bitIndex = lz * 16 + ly * 4 + lx;
                        const bit = bitIndex < 32 ? (lo >>> bitIndex) & 1 : (hi >>> (bitIndex - 32)) & 1;
                        if (bit === 0) {
                            continue;
                        }
                        out.push(baseX + (lx + 0.5) * res, baseY + (ly + 0.5) * res, baseZ + (lz + 0.5) * res);
                    }
                }
            }
        };

        for (let bz = 0; bz < nbz; bz++) {
            for (let by = 0; by < nby; by++) {
                for (let bx = 0; bx < nbx; bx++) {
                    const block = this.queryBlock(bx, by, bz);
                    if (block.kind === 0) {
                        continue;
                    }
                    if (block.kind === 1) {
                        pushSolidBlock(bx, by, bz);
                    } else {
                        pushMixedBlock(bx, by, bz, block.leafDataIndex);
                    }
                    if (out.length / 3 >= maxCount) {
                        return new Float32Array(out);
                    }
                }
            }
        }
        return new Float32Array(out);
    }

    /**
     * Surface voxel centers for debug overlay. Uses sparse block traversal (same as solid enumeration)
     * instead of scanning the full axis-aligned grid — large speedup on big volumes.
     */
    enumerateSurfaceVoxelCenters(maxCount = 120000): Float32Array {
        const out: number[] = [];
        const res = this._voxelResolution;
        const leaf = this._leafSize;
        const nbx = Math.floor(this._numVoxelsX / leaf);
        const nby = Math.floor(this._numVoxelsY / leaf);
        const nbz = Math.floor(this._numVoxelsZ / leaf);

        const gmx = this._gridMinX;
        const gmy = this._gridMinY;
        const gmz = this._gridMinZ;

        const isOpenFace = (ix: number, iy: number, iz: number) =>
            !this.isVoxelSolid(ix - 1, iy, iz) ||
            !this.isVoxelSolid(ix + 1, iy, iz) ||
            !this.isVoxelSolid(ix, iy - 1, iz) ||
            !this.isVoxelSolid(ix, iy + 1, iz) ||
            !this.isVoxelSolid(ix, iy, iz - 1) ||
            !this.isVoxelSolid(ix, iy, iz + 1);

        for (let bz = 0; bz < nbz; bz++) {
            for (let by = 0; by < nby; by++) {
                for (let bx = 0; bx < nbx; bx++) {
                    const block = this.queryBlock(bx, by, bz);
                    if (block.kind === 0) {
                        continue;
                    }

                    const ix0 = bx * leaf;
                    const iy0 = by * leaf;
                    const iz0 = bz * leaf;

                    if (block.kind === 1) {
                        for (let lz = 0; lz < leaf; lz++) {
                            for (let ly = 0; ly < leaf; ly++) {
                                for (let lx = 0; lx < leaf; lx++) {
                                    if (
                                        leaf >= 3 &&
                                        lx >= 1 &&
                                        lx <= leaf - 2 &&
                                        ly >= 1 &&
                                        ly <= leaf - 2 &&
                                        lz >= 1 &&
                                        lz <= leaf - 2
                                    ) {
                                        continue;
                                    }
                                    const ix = ix0 + lx;
                                    const iy = iy0 + ly;
                                    const iz = iz0 + lz;
                                    if (isOpenFace(ix, iy, iz)) {
                                        out.push(
                                            gmx + (ix + 0.5) * res,
                                            gmy + (iy + 0.5) * res,
                                            gmz + (iz + 0.5) * res,
                                        );
                                        if (out.length / 3 >= maxCount) {
                                            return new Float32Array(out);
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        const leafDataIndex = block.leafDataIndex;
                        const lo = this._leafData[leafDataIndex * 2] >>> 0;
                        const hi = this._leafData[leafDataIndex * 2 + 1] >>> 0;
                        for (let lz = 0; lz < 4; lz++) {
                            for (let ly = 0; ly < 4; ly++) {
                                for (let lx = 0; lx < 4; lx++) {
                                    const bitIndex = lz * 16 + ly * 4 + lx;
                                    const bit = bitIndex < 32 ? (lo >>> bitIndex) & 1 : (hi >>> (bitIndex - 32)) & 1;
                                    if (bit === 0) {
                                        continue;
                                    }
                                    const ix = ix0 + lx;
                                    const iy = iy0 + ly;
                                    const iz = iz0 + lz;
                                    if (isOpenFace(ix, iy, iz)) {
                                        out.push(
                                            gmx + (ix + 0.5) * res,
                                            gmy + (iy + 0.5) * res,
                                            gmz + (iz + 0.5) * res,
                                        );
                                        if (out.length / 3 >= maxCount) {
                                            return new Float32Array(out);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return new Float32Array(out);
    }

    private checkLeafByIndex(node: number, ix: number, iy: number, iz: number) {
        const leafDataIndex = node & 0x00ffffff;
        const vx = ix & 3;
        const vy = iy & 3;
        const vz = iz & 3;
        const bitIndex = vz * 16 + vy * 4 + vx;
        if (bitIndex < 32) {
            const lo = this._leafData[leafDataIndex * 2] >>> 0;
            return ((lo >>> bitIndex) & 1) === 1;
        }
        const hi = this._leafData[leafDataIndex * 2 + 1] >>> 0;
        return ((hi >>> (bitIndex - 32)) & 1) === 1;
    }

    private resolveDeepestPenetrationCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: VoxelPushOut,
    ): boolean {
        const res = this._voxelResolution;
        const radiusSq = radius * radius;
        const segBottomY = cy - halfHeight;
        const segTopY = cy + halfHeight;
        const ixMin = Math.floor((cx - radius - this._gridMinX) / res);
        const iyMin = Math.floor((segBottomY - radius - this._gridMinY) / res);
        const izMin = Math.floor((cz - radius - this._gridMinZ) / res);
        const ixMax = Math.floor((cx + radius - this._gridMinX) / res);
        const iyMax = Math.floor((segTopY + radius - this._gridMinY) / res);
        const izMax = Math.floor((cz + radius - this._gridMinZ) / res);
        let bestPushX = 0;
        let bestPushY = 0;
        let bestPushZ = 0;
        let bestPen = PENETRATION_EPSILON;
        let found = false;

        for (let iz = izMin; iz <= izMax; iz++) {
            for (let iy = iyMin; iy <= iyMax; iy++) {
                for (let ix = ixMin; ix <= ixMax; ix++) {
                    if (!this.isVoxelSolid(ix, iy, iz)) {
                        continue;
                    }
                    const vMinX = this._gridMinX + ix * res;
                    const vMinY = this._gridMinY + iy * res;
                    const vMinZ = this._gridMinZ + iz * res;
                    const vMaxX = vMinX + res;
                    const vMaxY = vMinY + res;
                    const vMaxZ = vMinZ + res;
                    let segY: number;
                    if (segTopY < vMinY) {
                        segY = segTopY;
                    } else if (segBottomY > vMaxY) {
                        segY = segBottomY;
                    } else {
                        segY = Math.max(segBottomY, Math.min(segTopY, (vMinY + vMaxY) * 0.5));
                    }
                    const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
                    const nearY = Math.max(vMinY, Math.min(segY, vMaxY));
                    const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));
                    const dx = cx - nearX;
                    const dy = segY - nearY;
                    const dz = cz - nearZ;
                    const distSq = dx * dx + dy * dy + dz * dz;
                    if (distSq >= radiusSq) {
                        continue;
                    }
                    let px = 0;
                    let py = 0;
                    let pz = 0;
                    let penetration: number;
                    if (distSq > 1e-12) {
                        const dist = Math.sqrt(distSq);
                        penetration = radius - dist;
                        const invDist = 1 / dist;
                        px = dx * invDist * penetration;
                        py = dy * invDist * penetration;
                        pz = dz * invDist * penetration;
                    } else {
                        const escapeX = Math.min(cx - vMinX, vMaxX - cx) + radius;
                        const escapeY = Math.min(segY - vMinY, vMaxY - segY) + radius;
                        const escapeZ = Math.min(cz - vMinZ, vMaxZ - cz) + radius;
                        if (escapeX <= escapeY && escapeX <= escapeZ) {
                            px = cx - vMinX < vMaxX - cx ? -escapeX : escapeX;
                            penetration = escapeX;
                        } else if (escapeY <= escapeZ) {
                            py = segY - vMinY < vMaxY - segY ? -escapeY : escapeY;
                            penetration = escapeY;
                        } else {
                            pz = cz - vMinZ < vMaxZ - cz ? -escapeZ : escapeZ;
                            penetration = escapeZ;
                        }
                    }
                    if (penetration > bestPen) {
                        bestPen = penetration;
                        bestPushX = px;
                        bestPushY = py;
                        bestPushZ = pz;
                        found = true;
                    }
                }
            }
        }
        if (found) {
            out.x = bestPushX;
            out.y = bestPushY;
            out.z = bestPushZ;
        }
        return found;
    }

    private queryBlock(blockX: number, blockY: number, blockZ: number): { kind: 0 | 1 | 2; leafDataIndex: number } {
        let nodeIndex = 0;
        for (let level = this._treeDepth - 1; level >= 0; level--) {
            const node = this._nodes[nodeIndex] >>> 0;
            if (node === SOLID_LEAF_MARKER) {
                return { kind: 1, leafDataIndex: -1 };
            }
            const childMask = (node >>> 24) & 0xff;
            if (childMask === 0) {
                return { kind: 2, leafDataIndex: node & 0x00ffffff };
            }
            const bitX = (blockX >>> level) & 1;
            const bitY = (blockY >>> level) & 1;
            const bitZ = (blockZ >>> level) & 1;
            const octant = (bitZ << 2) | (bitY << 1) | bitX;
            if ((childMask & (1 << octant)) === 0) {
                return { kind: 0, leafDataIndex: -1 };
            }
            const baseOffset = node & 0x00ffffff;
            const prefix = (1 << octant) - 1;
            nodeIndex = baseOffset + popcount(childMask & prefix);
        }
        const node = this._nodes[nodeIndex] >>> 0;
        if (node === SOLID_LEAF_MARKER) {
            return { kind: 1, leafDataIndex: -1 };
        }
        return { kind: 2, leafDataIndex: node & 0x00ffffff };
    }

    private resolveIterative(
        cx: number,
        cy: number,
        cz: number,
        findPenetration: (x: number, y: number, z: number, out: VoxelPushOut) => boolean,
        out: VoxelPushOut,
    ): boolean {
        let resolvedX = cx;
        let resolvedY = cy;
        let resolvedZ = cz;
        let totalPushX = 0;
        let totalPushY = 0;
        let totalPushZ = 0;
        let hadCollision = false;
        let numNormals = 0;

        for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
            if (!findPenetration(resolvedX, resolvedY, resolvedZ, this._push)) {
                break;
            }
            hadCollision = true;
            let px = this._push.x;
            let py = this._push.y;
            let pz = this._push.z;

            for (let i = 0; i < numNormals; i++) {
                const n = this._constraints[i];
                const dot = px * n.x + py * n.y + pz * n.z;
                if (dot < 0) {
                    px -= dot * n.x;
                    py -= dot * n.y;
                    pz -= dot * n.z;
                }
            }

            const len = Math.sqrt(
                this._push.x * this._push.x + this._push.y * this._push.y + this._push.z * this._push.z,
            );
            if (len > PENETRATION_EPSILON && numNormals < 3) {
                const invLen = 1 / len;
                const n = this._constraints[numNormals];
                n.x = this._push.x * invLen;
                n.y = this._push.y * invLen;
                n.z = this._push.z * invLen;
                numNormals++;
            }

            resolvedX += px;
            resolvedY += py;
            resolvedZ += pz;
            totalPushX += px;
            totalPushY += py;
            totalPushZ += pz;
        }

        const totalPushSq = totalPushX * totalPushX + totalPushY * totalPushY + totalPushZ * totalPushZ;
        const hasSignificantPush = hadCollision && totalPushSq > PENETRATION_EPSILON * PENETRATION_EPSILON;
        if (hasSignificantPush) {
            out.x = totalPushX;
            out.y = totalPushY;
            out.z = totalPushZ;
        }
        return hasSignificantPush;
    }
}

/**
 * Builds triangle soup for walk collision from a glTF URL (no three.js).
 */
export async function buildCollisionMeshFromGltfUrl(
    url: string,
): Promise<{ positions: Float32Array; indices: Uint32Array }> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`[walk] Failed to fetch collision GLB: ${url} (${response.status})`);
    }
    const buffer = await response.arrayBuffer();

    const parseResult = await loadGLTF(buffer, {
        textureLoader: (textureUrl: string) => downloadTexture(textureUrl),
    });

    const scene = parseResult.scene;
    scene.updateMatrixWorld(true);

    const positions: number[] = [];
    const indices: number[] = [];
    let vertexOffset = 0;
    const v = new Vector3();

    scene.traverse((o: Object3D) => {
        if (!TypeAssert.isMesh(o) || !o.geometry) {
            return;
        }
        const mesh = o;
        const geo = mesh.geometry;
        const posAttr = geo.attributes.position;
        if (!posAttr) {
            return;
        }
        const world = mesh.matrixWorld;
        for (let i = 0; i < posAttr.count; i++) {
            v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
            v.applyMatrix4(world);
            positions.push(v.x, v.y, v.z);
        }
        const indexAttr = geo.index;
        if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i++) {
                indices.push(indexAttr.getX(i) + vertexOffset);
            }
        } else {
            for (let i = 0; i < posAttr.count; i++) {
                indices.push(i + vertexOffset);
            }
        }
        vertexOffset += posAttr.count;
    });

    return {
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
    };
}

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 10;
const DEFAULT_MOVE_SPEED = 7;
const DEFAULT_JUMP_SPEED = 4;

/** Embedded walk demo horizontal speeds (m/s); first-person uses 2× third. */
const WALK_DEMO_LOCOMOTION = {
    moveThirdMps: 1.35,
    moveFirstMps: 2.7,
    moveOutdoorMps: 2.15,
} as const;

const GROUND_ACCEL = 24;
const AIR_ACCEL = 6;
const THIRD_PERSON_BASE_ELEVATION = 0.35;
/**
 * When `thirdPersonModelScale` is very small, the legacy pivot still sits ~0.7 m above the feet while the mesh is
 * only millimetres tall — the orbit target floats in empty air and the character appears in the lower half of the
 * frame. Vertical framing uses at least this notional height (m) so we still nudge the pivot down meaningfully.
 */
const THIRD_PERSON_PIVOT_FRAMING_MESH_FLOOR = 0.32;
/** Lower the orbit pivot by this fraction of `max(meshWorldHeight, FRAMING_MESH_FLOOR)` so more of the body stays in frame. */
const THIRD_PERSON_PIVOT_LOWER_FRAC = 0.22;
const THIRD_PERSON_ZOOM_SENSITIVITY = 0.002;
const THIRD_PERSON_BOUNCE_SPRING = 70;
const THIRD_PERSON_BOUNCE_DAMPING = 12;
const THIRD_PERSON_BOUNCE_MAX = 0.5;
const THIRD_PERSON_CAMERA_COLLISION_MARGIN = 0.18;
const THIRD_PERSON_CAMERA_MIN_FOOT_OFFSET = 0.12;
/** Pull camera in when occluded; lower = less snap toward the character on hit. */
const THIRD_PERSON_CAMERA_COLLISION_IN_RATE = 14;
const THIRD_PERSON_CAMERA_COLLISION_OUT_RATE = 7;
const THIRD_PERSON_CAMERA_OCCLUSION_RELEASE_HOLD = 0.1;

/**
 * Third-person orbit framing. `legacy` keeps the original chest pivot + downward nudge (indoor).
 * `lowerThird` looks at upper torso so the avatar sits lower in frame (common action-game TPS).
 */
type WalkThirdPersonFramingMode = 'legacy' | 'lowerThird';

interface WalkThirdPersonFraming {
    mode: WalkThirdPersonFramingMode;
    /** `lowerThird`: pivot height above feet as a fraction of normalized mesh height (≈0.65–0.75 = upper chest). */
    pivotHeightFraction?: number;
    /** `lowerThird`: optional extra downward nudge as a fraction of mesh height (usually 0 outdoors). */
    pivotLowerFrac?: number;
    /** Override {@link THIRD_PERSON_BASE_ELEVATION} (radians). */
    baseElevation?: number;
}

const WALK_THIRD_PERSON_FRAMING_INDOOR: WalkThirdPersonFraming = { mode: 'legacy' };

const WALK_THIRD_PERSON_FRAMING_OUTDOOR: WalkThirdPersonFraming = {
    mode: 'lowerThird',
    pivotHeightFraction: 0.92,
    pivotLowerFrac: 0,
    baseElevation: 0.4,
};

interface PushOut {
    x: number;
    y: number;
    z: number;
}

export interface ViewerWalkCharacterState {
    position: InstanceType<typeof Vector3>;
    yaw: number;
    speed: number;
    walkSpeed: number;
    verticalVelocity: number;
    grounded: boolean;
    sprinting: boolean;
}

interface BvhNode {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    left: BvhNode | null;
    right: BvhNode | null;
    triStart: number;
    triCount: number;
}

interface Tris {
    v0x: Float32Array;
    v0y: Float32Array;
    v0z: Float32Array;
    v1x: Float32Array;
    v1y: Float32Array;
    v1z: Float32Array;
    v2x: Float32Array;
    v2y: Float32Array;
    v2z: Float32Array;
    nx: Float32Array;
    ny: Float32Array;
    nz: Float32Array;
    indices: Uint32Array;
    count: number;
}

const rayAABB = (
    ox: number,
    oy: number,
    oz: number,
    idx: number,
    idy: number,
    idz: number,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    maxDist: number,
) => {
    const t1x = (minX - ox) * idx;
    const t2x = (maxX - ox) * idx;
    const t1y = (minY - oy) * idy;
    const t2y = (maxY - oy) * idy;
    const t1z = (minZ - oz) * idz;
    const t2z = (maxZ - oz) * idz;
    const tmin = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z));
    const tmax = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z));
    if (tmax < 0 || tmin > tmax || tmin > maxDist) {
        return -1;
    }
    return tmin >= 0 ? tmin : 0;
};

const rayTriangle = (
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
) => {
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-10) {
        return -1;
    }
    const invDet = 1 / det;
    const tx = ox - ax;
    const ty = oy - ay;
    const tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) {
        return -1;
    }
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1) {
        return -1;
    }
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    return t >= 0 ? t : -1;
};

const closestPointOnSegment = (
    px: number,
    py: number,
    pz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    out: PushOut,
) => {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const lenSq = abx * abx + aby * aby + abz * abz;
    if (lenSq < 1e-20) {
        out.x = ax;
        out.y = ay;
        out.z = az;
        return;
    }
    const apx = px - ax;
    const apy = py - ay;
    const apz = pz - az;
    let t = (apx * abx + apy * aby + apz * abz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    out.x = ax + abx * t;
    out.y = ay + aby * t;
    out.z = az + abz * t;
};

const _segPt: PushOut = { x: 0, y: 0, z: 0 };
const _triPt: PushOut = { x: 0, y: 0, z: 0 };
const _tmpSegPt: PushOut = { x: 0, y: 0, z: 0 };
const _tmpTriPt: PushOut = { x: 0, y: 0, z: 0 };
const closestSegmentTriangle = (
    s0x: number,
    s0y: number,
    s0z: number,
    s1x: number,
    s1y: number,
    s1z: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    outSeg: PushOut,
    outTri: PushOut,
) => {
    const SAMPLES = 5;
    let bestDistSq = Infinity;
    for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        const sx = s0x + (s1x - s0x) * t;
        const sy = s0y + (s1y - s0y) * t;
        const sz = s0z + (s1z - s0z) * t;
        closestPointOnTriangle(sx, sy, sz, ax, ay, az, bx, by, bz, cx, cy, cz, _tmpTriPt);
        const dx = sx - _tmpTriPt.x;
        const dy = sy - _tmpTriPt.y;
        const dz = sz - _tmpTriPt.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            _segPt.x = sx;
            _segPt.y = sy;
            _segPt.z = sz;
            _triPt.x = _tmpTriPt.x;
            _triPt.y = _tmpTriPt.y;
            _triPt.z = _tmpTriPt.z;
        }
    }
    closestPointOnSegment(_triPt.x, _triPt.y, _triPt.z, s0x, s0y, s0z, s1x, s1y, s1z, _tmpSegPt);
    closestPointOnTriangle(_tmpSegPt.x, _tmpSegPt.y, _tmpSegPt.z, ax, ay, az, bx, by, bz, cx, cy, cz, _tmpTriPt);
    const dx = _tmpSegPt.x - _tmpTriPt.x;
    const dy = _tmpSegPt.y - _tmpTriPt.y;
    const dz = _tmpSegPt.z - _tmpTriPt.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
        _segPt.x = _tmpSegPt.x;
        _segPt.y = _tmpSegPt.y;
        _segPt.z = _tmpSegPt.z;
        _triPt.x = _tmpTriPt.x;
        _triPt.y = _tmpTriPt.y;
        _triPt.z = _tmpTriPt.z;
    }
    outSeg.x = _segPt.x;
    outSeg.y = _segPt.y;
    outSeg.z = _segPt.z;
    outTri.x = _triPt.x;
    outTri.y = _triPt.y;
    outTri.z = _triPt.z;
};

const closestPointOnTriangle = (
    px: number,
    py: number,
    pz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    out: PushOut,
) => {
    const abx = bx - ax,
        aby = by - ay,
        abz = bz - az;
    const acx = cx - ax,
        acy = cy - ay,
        acz = cz - az;
    const apx = px - ax,
        apy = py - ay,
        apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) {
        out.x = ax;
        out.y = ay;
        out.z = az;
        return;
    }
    const bpx = px - bx,
        bpy = py - by,
        bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
        out.x = bx;
        out.y = by;
        out.z = bz;
        return;
    }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out.x = ax + abx * v;
        out.y = ay + aby * v;
        out.z = az + abz * v;
        return;
    }
    const cpx = px - cx,
        cpy = py - cy,
        cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) {
        out.x = cx;
        out.y = cy;
        out.z = cz;
        return;
    }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        out.x = ax + acx * w;
        out.y = ay + acy * w;
        out.z = az + acz * w;
        return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        out.x = bx + (cx - bx) * w;
        out.y = by + (cy - by) * w;
        out.z = bz + (cz - bz) * w;
        return;
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    out.x = ax + abx * v + acx * w;
    out.y = ay + aby * v + acy * w;
    out.z = az + abz * v + acz * w;
};

const computeTriangleBounds = (tris: Tris, idx: number, out: BvhNode) => {
    const minX = Math.min(tris.v0x[idx], tris.v1x[idx], tris.v2x[idx]);
    const minY = Math.min(tris.v0y[idx], tris.v1y[idx], tris.v2y[idx]);
    const minZ = Math.min(tris.v0z[idx], tris.v1z[idx], tris.v2z[idx]);
    const maxX = Math.max(tris.v0x[idx], tris.v1x[idx], tris.v2x[idx]);
    const maxY = Math.max(tris.v0y[idx], tris.v1y[idx], tris.v2y[idx]);
    const maxZ = Math.max(tris.v0z[idx], tris.v1z[idx], tris.v2z[idx]);
    out.minX = minX;
    out.minY = minY;
    out.minZ = minZ;
    out.maxX = maxX;
    out.maxY = maxY;
    out.maxZ = maxZ;
};

const buildBVH = (tris: Tris, start: number, count: number): BvhNode => {
    const bounds: BvhNode = {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
        left: null,
        right: null,
        triStart: start,
        triCount: count,
    };
    const tmp: BvhNode = { ...bounds };
    for (let i = start; i < start + count; i++) {
        computeTriangleBounds(tris, tris.indices[i], tmp);
        bounds.minX = Math.min(bounds.minX, tmp.minX);
        bounds.minY = Math.min(bounds.minY, tmp.minY);
        bounds.minZ = Math.min(bounds.minZ, tmp.minZ);
        bounds.maxX = Math.max(bounds.maxX, tmp.maxX);
        bounds.maxY = Math.max(bounds.maxY, tmp.maxY);
        bounds.maxZ = Math.max(bounds.maxZ, tmp.maxZ);
    }
    if (count <= 16) {
        return bounds;
    }
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
    const mid =
        axis === 0
            ? (bounds.minX + bounds.maxX) * 0.5
            : axis === 1
              ? (bounds.minY + bounds.maxY) * 0.5
              : (bounds.minZ + bounds.maxZ) * 0.5;
    let left = start;
    let right = start + count - 1;
    while (left <= right) {
        const i = tris.indices[left];
        const cx =
            axis === 0
                ? (tris.v0x[i] + tris.v1x[i] + tris.v2x[i]) / 3
                : axis === 1
                  ? (tris.v0y[i] + tris.v1y[i] + tris.v2y[i]) / 3
                  : (tris.v0z[i] + tris.v1z[i] + tris.v2z[i]) / 3;
        if (cx < mid) {
            left++;
        } else {
            const t = tris.indices[left];
            tris.indices[left] = tris.indices[right];
            tris.indices[right] = t;
            right--;
        }
    }
    let leftCount = left - start;
    if (leftCount === 0 || leftCount === count) {
        leftCount = count >> 1;
    }
    bounds.left = buildBVH(tris, start, leftCount);
    bounds.right = buildBVH(tris, start + leftCount, count - leftCount);
    bounds.triStart = 0;
    bounds.triCount = 0;
    return bounds;
};

class MeshCollision {
    private tris: Tris;
    private root: BvhNode;
    private stack: BvhNode[] = [];
    private segClosest: PushOut = { x: 0, y: 0, z: 0 };
    private triClosest: PushOut = { x: 0, y: 0, z: 0 };
    private constraints: PushOut[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
    ];

    constructor(positions: Float32Array, indices: Uint32Array) {
        const count = Math.floor(indices.length / 3);
        const tris: Tris = {
            v0x: new Float32Array(count),
            v0y: new Float32Array(count),
            v0z: new Float32Array(count),
            v1x: new Float32Array(count),
            v1y: new Float32Array(count),
            v1z: new Float32Array(count),
            v2x: new Float32Array(count),
            v2y: new Float32Array(count),
            v2z: new Float32Array(count),
            nx: new Float32Array(count),
            ny: new Float32Array(count),
            nz: new Float32Array(count),
            indices: new Uint32Array(count),
            count,
        };
        for (let i = 0; i < count; i++) {
            const i0 = indices[i * 3] * 3;
            const i1 = indices[i * 3 + 1] * 3;
            const i2 = indices[i * 3 + 2] * 3;
            tris.v0x[i] = positions[i0];
            tris.v0y[i] = positions[i0 + 1];
            tris.v0z[i] = positions[i0 + 2];
            tris.v1x[i] = positions[i1];
            tris.v1y[i] = positions[i1 + 1];
            tris.v1z[i] = positions[i1 + 2];
            tris.v2x[i] = positions[i2];
            tris.v2y[i] = positions[i2 + 1];
            tris.v2z[i] = positions[i2 + 2];
            const e1x = tris.v1x[i] - tris.v0x[i],
                e1y = tris.v1y[i] - tris.v0y[i],
                e1z = tris.v1z[i] - tris.v0z[i];
            const e2x = tris.v2x[i] - tris.v0x[i],
                e2y = tris.v2y[i] - tris.v0y[i],
                e2z = tris.v2z[i] - tris.v0z[i];
            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;
            const len = Math.hypot(nx, ny, nz) || 1;
            tris.nx[i] = nx / len;
            tris.ny[i] = ny / len;
            tris.nz[i] = nz / len;
            tris.indices[i] = i;
        }
        this.tris = tris;
        this.root = buildBVH(tris, 0, count);
    }

    queryCapsule(cx: number, cy: number, cz: number, halfHeight: number, radius: number, out: PushOut): boolean {
        return this.resolveIterative(
            cx,
            cy,
            cz,
            (rx, ry, rz, push) => this.resolveDeepestCapsule(rx, ry, rz, halfHeight, radius, push),
            out,
        );
    }

    queryRay(
        ox: number,
        oy: number,
        oz: number,
        dx: number,
        dy: number,
        dz: number,
        maxDist: number,
    ): { x: number; y: number; z: number } | null {
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-8) {
            return null;
        }
        dx /= len;
        dy /= len;
        dz /= len;
        const idx = 1 / (Math.abs(dx) > 1e-12 ? dx : dx >= 0 ? 1e-12 : -1e-12);
        const idy = 1 / (Math.abs(dy) > 1e-12 ? dy : dy >= 0 ? 1e-12 : -1e-12);
        const idz = 1 / (Math.abs(dz) > 1e-12 ? dz : dz >= 0 ? 1e-12 : -1e-12);
        const hit = this.queryRayBVH(ox, oy, oz, dx, dy, dz, idx, idy, idz, maxDist);
        if (!hit) {
            return null;
        }
        return { x: ox + dx * hit.t, y: oy + dy * hit.t, z: oz + dz * hit.t };
    }

    private resolveDeepestCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: PushOut,
    ): boolean {
        let best = PENETRATION_EPSILON;
        let bx = 0,
            by = 0,
            bz = 0;
        let found = false;
        const s0x = cx;
        const s0y = cy - halfHeight;
        const s0z = cz;
        const s1x = cx;
        const s1y = cy + halfHeight;
        const s1z = cz;
        this.traverseCapsule(cx, cy, cz, halfHeight + radius, radius, triIdx => {
            const t = this.tris;
            closestSegmentTriangle(
                s0x,
                s0y,
                s0z,
                s1x,
                s1y,
                s1z,
                t.v0x[triIdx],
                t.v0y[triIdx],
                t.v0z[triIdx],
                t.v1x[triIdx],
                t.v1y[triIdx],
                t.v1z[triIdx],
                t.v2x[triIdx],
                t.v2y[triIdx],
                t.v2z[triIdx],
                this.segClosest,
                this.triClosest,
            );
            const dx = this.segClosest.x - this.triClosest.x;
            const dy = this.segClosest.y - this.triClosest.y;
            const dz = this.segClosest.z - this.triClosest.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq >= radius * radius) {
                return;
            }
            const dist = Math.sqrt(distSq);
            const penetration = radius - dist;
            if (penetration > best) {
                best = penetration;
                if (dist > 1e-10) {
                    const invDist = 1 / dist;
                    bx = dx * invDist * penetration;
                    by = dy * invDist * penetration;
                    bz = dz * invDist * penetration;
                } else {
                    bx = t.nx[triIdx] * penetration;
                    by = t.ny[triIdx] * penetration;
                    bz = t.nz[triIdx] * penetration;
                }
                found = true;
            }
        });
        out.x = bx;
        out.y = by;
        out.z = bz;
        return found;
    }

    private traverseCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfExtentY: number,
        radius: number,
        cb: (triIdx: number) => void,
    ) {
        const capMinX = cx - radius;
        const capMaxX = cx + radius;
        const capMinY = cy - halfExtentY;
        const capMaxY = cy + halfExtentY;
        const capMinZ = cz - radius;
        const capMaxZ = cz + radius;
        this.stack.length = 0;
        this.stack.push(this.root);
        while (this.stack.length) {
            const node = this.stack.pop()!;
            if (
                capMaxX < node.minX ||
                capMinX > node.maxX ||
                capMaxY < node.minY ||
                capMinY > node.maxY ||
                capMaxZ < node.minZ ||
                capMinZ > node.maxZ
            ) {
                continue;
            }
            if (!node.left) {
                for (let j = node.triStart; j < node.triStart + node.triCount; j++) {
                    cb(this.tris.indices[j]);
                }
            } else {
                this.stack.push(node.right!, node.left);
            }
        }
    }

    private queryRayBVH(
        ox: number,
        oy: number,
        oz: number,
        dx: number,
        dy: number,
        dz: number,
        idx: number,
        idy: number,
        idz: number,
        maxDist: number,
    ): { t: number; triIdx: number } | null {
        if (
            rayAABB(
                ox,
                oy,
                oz,
                idx,
                idy,
                idz,
                this.root.minX,
                this.root.minY,
                this.root.minZ,
                this.root.maxX,
                this.root.maxY,
                this.root.maxZ,
                maxDist,
            ) < 0
        ) {
            return null;
        }
        this.stack.length = 0;
        this.stack.push(this.root);
        let bestT = maxDist + 1;
        let bestTriIdx = -1;
        while (this.stack.length) {
            const node = this.stack.pop()!;
            if (!node.left) {
                for (let j = node.triStart; j < node.triStart + node.triCount; j++) {
                    const i = this.tris.indices[j];
                    const ht = rayTriangle(
                        ox,
                        oy,
                        oz,
                        dx,
                        dy,
                        dz,
                        this.tris.v0x[i],
                        this.tris.v0y[i],
                        this.tris.v0z[i],
                        this.tris.v1x[i],
                        this.tris.v1y[i],
                        this.tris.v1z[i],
                        this.tris.v2x[i],
                        this.tris.v2y[i],
                        this.tris.v2z[i],
                    );
                    if (ht >= 0 && ht <= maxDist && ht < bestT) {
                        bestT = ht;
                        bestTriIdx = i;
                    }
                }
                continue;
            }
            const tLeft = rayAABB(
                ox,
                oy,
                oz,
                idx,
                idy,
                idz,
                node.left.minX,
                node.left.minY,
                node.left.minZ,
                node.left.maxX,
                node.left.maxY,
                node.left.maxZ,
                bestT,
            );
            const tRight = rayAABB(
                ox,
                oy,
                oz,
                idx,
                idy,
                idz,
                node.right!.minX,
                node.right!.minY,
                node.right!.minZ,
                node.right!.maxX,
                node.right!.maxY,
                node.right!.maxZ,
                bestT,
            );
            if (tLeft >= 0 && tRight >= 0) {
                if (tLeft <= tRight) {
                    this.stack.push(node.right!, node.left);
                } else {
                    this.stack.push(node.left, node.right!);
                }
            } else if (tLeft >= 0) {
                this.stack.push(node.left);
            } else if (tRight >= 0) {
                this.stack.push(node.right!);
            }
        }
        if (bestTriIdx < 0) {
            return null;
        }
        return { t: bestT, triIdx: bestTriIdx };
    }

    private resolveIterative(
        cx: number,
        cy: number,
        cz: number,
        findPenetration: (x: number, y: number, z: number, out: PushOut) => boolean,
        out: PushOut,
    ): boolean {
        let resolvedX = cx;
        let resolvedY = cy;
        let resolvedZ = cz;
        let totalPushX = 0;
        let totalPushY = 0;
        let totalPushZ = 0;
        let hadCollision = false;
        let numNormals = 0;
        const scratch: PushOut = { x: 0, y: 0, z: 0 };
        for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
            if (!findPenetration(resolvedX, resolvedY, resolvedZ, scratch)) {
                break;
            }
            hadCollision = true;
            let px = scratch.x;
            let py = scratch.y;
            let pz = scratch.z;
            for (let i = 0; i < numNormals; i++) {
                const n = this.constraints[i];
                const dot = px * n.x + py * n.y + pz * n.z;
                if (dot < 0) {
                    px -= dot * n.x;
                    py -= dot * n.y;
                    pz -= dot * n.z;
                }
            }
            const len = Math.sqrt(scratch.x * scratch.x + scratch.y * scratch.y + scratch.z * scratch.z);
            if (len > PENETRATION_EPSILON && numNormals < 3) {
                const invLen = 1 / len;
                const n = this.constraints[numNormals];
                n.x = scratch.x * invLen;
                n.y = scratch.y * invLen;
                n.z = scratch.z * invLen;
                numNormals++;
            }
            resolvedX += px;
            resolvedY += py;
            resolvedZ += pz;
            totalPushX += px;
            totalPushY += py;
            totalPushZ += pz;
        }
        const sq = totalPushX * totalPushX + totalPushY * totalPushY + totalPushZ * totalPushZ;
        const ok = hadCollision && sq > PENETRATION_EPSILON * PENETRATION_EPSILON;
        if (ok) {
            out.x = totalPushX;
            out.y = totalPushY;
            out.z = totalPushZ;
        }
        return ok;
    }
}

export class ViewerWalkMode {
    private collision: {
        queryRay: (...args: number[]) => { x: number; y: number; z: number } | null;
        queryCapsule: (cx: number, cy: number, cz: number, halfHeight: number, radius: number, out: PushOut) => boolean;
    } | null = null;
    private enabled = false;
    private keys: Record<string, boolean> = {};
    private jumpRequested = false;
    private yaw = 0;
    private pitch = 0;
    private position = new Vector3();
    private velocity = new Vector3();
    private cameraPosition = new Vector3();
    private cameraRotation = new Euler(0, 0, 0, 'YXZ');
    private characterPosition = new Vector3();
    private cameraTarget = new Vector3();
    private cameraIdealPosition = new Vector3();
    private cameraCollisionPosition = new Vector3();
    private cameraRay = new Vector3();
    private accumulator = 0;

    private moveSpeed = DEFAULT_MOVE_SPEED;
    private jumpSpeed = DEFAULT_JUMP_SPEED;
    private capsuleHeight = 1.5;
    private capsuleRadius = 0.12;
    // Distance from top of head down to the eyes (meters); ~10cm matches typical human anthropometry.
    private headTopToEye = 0.1;
    private eyeHeight = 1.5 - 0.1 - 0.2;
    private gravity = 9.8;
    private hoverHeight = 0.2;
    private springStiffness = 800;
    private springDamping = 57;
    private groundProbeRange = 1.0;
    /** Exponential smoothing on sampled ground Y (rad/s); higher = snappier, lower = less vertical bobble on uneven collision. */
    private readonly groundYFilterSpeed = 20;
    private groundYFiltered: number | null = null;
    private velocityDampingGround = 0.99;
    private velocityDampingAir = 0.998;
    private grounded = false;
    private jumping = false;
    private jumpHeld = false;
    private thirdPersonEnabled = false;
    private thirdPersonHideCursor = false;
    private thirdPersonDistance = 3.2;
    private thirdPersonDistanceTarget = 3.2;
    private thirdPersonDistanceMin = 0.8;
    private thirdPersonDistanceMax = 4;
    private thirdPersonBounceOffset = 0;
    private thirdPersonBounceVelocity = 0;
    private thirdPersonTargetHeight = 1.25;
    private thirdPersonModelScale = 1;
    private horizontalSpeed = 0;
    private characterYaw = 0;
    private sprinting = false;
    private mouseLookDragOnly = true;
    private mouseLookDragging = false;
    private thirdPersonCollisionDistance = -1;
    private thirdPersonOcclusionReleaseTimer = 0;
    private thirdPersonFraming: WalkThirdPersonFraming = WALK_THIRD_PERSON_FRAMING_INDOOR;

    constructor(private container: HTMLElement) {
        document.addEventListener('keydown', this.onKeyDown);
        document.addEventListener('keyup', this.onKeyUp);
        document.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mouseup', this.onMouseUp);
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('wheel', this.onWheel, { passive: false });
        // Prevent "stuck key" drift when keyup is lost (UI panel focus, pointer-lock, tab blur).
        document.addEventListener('pointerlockchange', this.onPointerLockChange);
        document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
        document.addEventListener('focusin', this.onDocumentFocusIn, true);
        window.addEventListener('blur', this.onWindowBlur);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    async loadCollisionMesh(url: string): Promise<void> {
        const { positions, indices } = await buildCollisionMeshFromGltfUrl(url);
        this.collision = new MeshCollision(positions, indices);
    }

    loadVoxelCollision(metadata: VoxelMetadata, nodes: Uint32Array, leafData: Uint32Array) {
        this.collision = new VoxelCollision(metadata, nodes, leafData);
    }

    enterFrom(position: InstanceType<typeof Vector3>, rotation: InstanceType<typeof Euler>) {
        this.position.copy(position);
        this.velocity.set(0, 0, 0);
        const dir = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromEuler(rotation));
        this.yaw = Math.atan2(-dir.x, -dir.z);
        this.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        this.finishEnterFrom();
    }

    /**
     * Same ground snap and input reset as {@link enterFrom}, but with explicit walk **yaw** / **pitch** (rad).
     */
    enterFromPose(position: InstanceType<typeof Vector3>, yaw: number, pitch: number) {
        this.position.copy(position);
        this.velocity.set(0, 0, 0);
        this.yaw = yaw;
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
        this.finishEnterFrom();
    }

    private finishEnterFrom() {
        this.enabled = true;
        this.keys = {};
        this.accumulator = 0;
        this.grounded = false;
        this.jumping = false;
        this.jumpHeld = false;
        this.horizontalSpeed = 0;
        this.characterYaw = this.yaw;
        this.sprinting = false;
        this.thirdPersonDistanceTarget = this.thirdPersonDistance;
        this.thirdPersonCollisionDistance = -1;
        this.thirdPersonOcclusionReleaseTimer = 0;
        this.groundYFiltered = null;
        this.resolveSpawnCollision();
        const gy = this.probeGround(this.position);
        if (gy !== null) {
            this.grounded = true;
            this.velocity.y = 0;
            this.position.y = gy + this.hoverHeight + this.eyeHeight;
            this.groundYFiltered = gy;
        }
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
        if (this.usesPointerLock()) {
            this.container.requestPointerLock();
        }
        this.syncThirdPersonCursorStyle();
    }

    disable() {
        this.enabled = false;
        this.clearInputState();
        this.syncThirdPersonCursorStyle();
        if (document.pointerLockElement === this.container) {
            document.exitPointerLock();
        }
    }

    setMoveSpeed(v: number) {
        this.moveSpeed = v;
    }
    setJumpVelocity(v: number) {
        this.jumpSpeed = v;
    }
    setMouseLookDragOnly(v: boolean) {
        this.mouseLookDragOnly = v;
        this.mouseLookDragging = false;
        if (v && document.pointerLockElement === this.container) {
            document.exitPointerLock();
        }
    }
    usesPointerLock() {
        return !this.mouseLookDragOnly;
    }
    setThirdPersonEnabled(v: boolean) {
        this.thirdPersonEnabled = v;
        this.syncThirdPersonCursorStyle();
    }
    setThirdPersonHideCursor(v: boolean) {
        this.thirdPersonHideCursor = v;
        this.syncThirdPersonCursorStyle();
    }
    setThirdPersonCamera(distance: number, targetHeight: number, minDistance = 0.8, maxDistance = 4) {
        this.thirdPersonDistanceMin = Math.max(0.2, Math.min(4, minDistance));
        const maxCap = 1_000_000;
        this.thirdPersonDistanceMax = Math.max(this.thirdPersonDistanceMin + 0.1, Math.min(maxCap, maxDistance));
        const clampedDistance = Math.max(this.thirdPersonDistanceMin, Math.min(this.thirdPersonDistanceMax, distance));
        this.thirdPersonDistance = clampedDistance;
        this.thirdPersonDistanceTarget = Math.max(
            this.thirdPersonDistanceMin,
            Math.min(this.thirdPersonDistanceMax, this.thirdPersonDistanceTarget || clampedDistance),
        );
        this.thirdPersonTargetHeight = Math.max(0.4, Math.min(maxCap, targetHeight));
    }
    setThirdPersonModelScale(scale: number) {
        this.thirdPersonModelScale = Math.max(0.0001, Math.min(1000, scale));
    }
    setThirdPersonFraming(framing: WalkThirdPersonFraming) {
        this.thirdPersonFraming = framing;
    }
    setPlayerRadius(v: number) {
        this.capsuleRadius = Math.max(0.06, Math.min(0.55, v));
        // Ensure geometric consistency: capsule height should be at least diameter.
        this.capsuleHeight = Math.max(this.capsuleHeight, this.capsuleRadius * 2 + 1e-4);
    }
    setPlayerHeight(v: number) {
        // Keep behavior aligned with WalkMode's UI semantics.
        const h = Math.max(0.8, Math.min(2.5, v));
        // Camera Y = groundY + hoverHeight + eyeHeight; want camera at (h - headTopToEye) above ground.
        this.eyeHeight = Math.max(0.1, h - this.headTopToEye - this.hoverHeight);
        this.capsuleHeight = Math.max(h, this.capsuleRadius * 2 + 1e-4);
    }

    update(dt: number) {
        if (!this.enabled) {
            return;
        }
        const dtClamped = Math.min(Math.max(0, dt), 1 / 20);
        this.accumulator = Math.min(this.accumulator + dtClamped, MAX_SUBSTEPS * FIXED_DT);
        while (this.accumulator >= FIXED_DT) {
            this.step(FIXED_DT);
            this.accumulator -= FIXED_DT;
        }
        this.updateCharacterPosition();
        if (this.thirdPersonEnabled) {
            this.updateThirdPersonCamera(dtClamped);
        } else {
            this.cameraPosition.set(this.position.x, this.position.y, this.position.z);
            this.cameraRotation.set(this.pitch, this.yaw, 0, 'YXZ');
        }
    }

    getCameraState() {
        return { position: this.cameraPosition, rotation: this.cameraRotation, scale: new Vector3(1, 1, 1) };
    }

    getCharacterState(): ViewerWalkCharacterState {
        return {
            position: this.characterPosition,
            yaw: this.characterYaw,
            speed: this.horizontalSpeed,
            walkSpeed: this.moveSpeed,
            verticalVelocity: this.velocity.y,
            grounded: this.grounded,
            sprinting: this.sprinting,
        };
    }

    private step(dt: number) {
        const rawGroundY = this.probeGround(this.position);
        const hasGround = rawGroundY !== null;

        if (hasGround && rawGroundY !== null && !this.jumping) {
            if (this.groundYFiltered === null) {
                this.groundYFiltered = rawGroundY;
            } else {
                const a = 1 - Math.exp(-this.groundYFilterSpeed * dt);
                this.groundYFiltered += (rawGroundY - this.groundYFiltered) * a;
            }
        } else if (!hasGround) {
            this.groundYFiltered = null;
        }

        const groundYStick = hasGround && this.groundYFiltered !== null ? this.groundYFiltered : rawGroundY;

        if (this.velocity.y < 0) {
            this.jumping = false;
        }
        if (WALK_JUMP_ENABLED && this.jumpRequested && !this.jumping && this.grounded && !this.jumpHeld) {
            this.jumping = true;
            this.velocity.y = this.jumpSpeed;
            this.grounded = false;
        }
        this.jumpRequested = false;
        this.jumpHeld = !!this.keys.Space;

        if (hasGround && !this.jumping) {
            const groundYValue = groundYStick as number;
            const targetY = groundYValue + this.hoverHeight + this.eyeHeight;
            const displacement = this.position.y - targetY;
            if (displacement > 0.1) {
                this.velocity.y -= this.gravity * dt;
                const nextY = this.position.y + this.velocity.y * dt;
                if (nextY <= targetY) {
                    this.position.y = targetY;
                    this.velocity.y = 0;
                }
                this.grounded = false;
            } else {
                const spring = -this.springStiffness * displacement - this.springDamping * this.velocity.y;
                this.velocity.y += spring * dt;
                this.grounded = true;
            }
        } else {
            this.velocity.y -= this.gravity * dt;
            this.grounded = false;
        }

        const forwardInput = (this.keys.KeyW ? 1 : 0) - (this.keys.KeyS ? 1 : 0);
        const strafeInput = (this.keys.KeyD ? 1 : 0) - (this.keys.KeyA ? 1 : 0);
        const move = new Vector3();
        const hasMoveInput = forwardInput !== 0 || strafeInput !== 0;
        this.sprinting = false;
        const forward = new Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0));
        if (forwardInput !== 0) {
            move.addScaledVector(forward, forwardInput);
        }
        if (strafeInput !== 0) {
            move.addScaledVector(right, strafeInput);
        }
        if (hasMoveInput) {
            const maxSpeed = this.moveSpeed;
            move.normalize().multiplyScalar(maxSpeed);
            this.characterYaw = Math.atan2(-move.x, -move.z);
        } else {
            move.set(0, 0, 0);
        }
        const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
        const blend = Math.min(1, accel * dt);
        this.velocity.x = this.velocity.x + (move.x - this.velocity.x) * blend;
        this.velocity.z = this.velocity.z + (move.z - this.velocity.z) * blend;
        const dampFactor = this.grounded ? this.velocityDampingGround : this.velocityDampingAir;
        const alpha = this.damp(dampFactor, dt);
        this.velocity.x = this.lerp(this.velocity.x, 0, alpha * 0.35);
        this.velocity.z = this.lerp(this.velocity.z, 0, alpha * 0.35);
        this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);

        this.position.addScaledVector(this.velocity, dt);
        this.resolveCollision();
    }

    private updateThirdPersonCamera(dt: number) {
        this.updateThirdPersonDistance(dt);
        const cameraScale = this.thirdPersonModelScale;
        const meshWorldH = CHARACTER_HEIGHT_METERS * cameraScale;
        const framing = this.thirdPersonFraming;
        let pivotY: number;
        let baseElevation = THIRD_PERSON_BASE_ELEVATION;

        if (framing.mode === 'lowerThird') {
            const pivotFrac = framing.pivotHeightFraction ?? 0.68;
            const framingSpan = Math.max(meshWorldH, THIRD_PERSON_PIVOT_FRAMING_MESH_FLOOR);
            pivotY = this.characterPosition.y + meshWorldH * pivotFrac;
            const lowerFrac = framing.pivotLowerFrac ?? 0;
            if (lowerFrac > 0) {
                pivotY -= lowerFrac * framingSpan;
            }
            baseElevation = framing.baseElevation ?? THIRD_PERSON_BASE_ELEVATION;
        } else {
            const legacyPivotY =
                this.position.y - this.eyeHeight + this.hoverHeight + this.thirdPersonTargetHeight * cameraScale;
            const framingSpan = Math.max(meshWorldH, THIRD_PERSON_PIVOT_FRAMING_MESH_FLOOR);
            const loweredY = legacyPivotY - THIRD_PERSON_PIVOT_LOWER_FRAC * framingSpan;
            pivotY = Math.max(this.characterPosition.y + meshWorldH * 0.06, loweredY);
        }

        this.cameraTarget.set(this.position.x, pivotY, this.position.z);

        const elevation = Math.max((-80 * Math.PI) / 180, Math.min((70 * Math.PI) / 180, baseElevation + this.pitch));
        const activeDistance = Math.max(0.1, (this.thirdPersonDistance + this.thirdPersonBounceOffset) * cameraScale);
        const horizontalDistance = Math.cos(elevation) * activeDistance;
        const verticalOffset = Math.sin(elevation) * activeDistance;
        this.cameraIdealPosition.set(
            this.cameraTarget.x + Math.sin(this.yaw) * horizontalDistance,
            this.cameraTarget.y + verticalOffset,
            this.cameraTarget.z + Math.cos(this.yaw) * horizontalDistance,
        );
        this.resolveCameraCollision(dt, activeDistance);
        this.cameraCollisionPosition.y = Math.max(
            this.cameraCollisionPosition.y,
            this.characterPosition.y + THIRD_PERSON_CAMERA_MIN_FOOT_OFFSET,
        );

        this.cameraPosition.copy(this.cameraCollisionPosition);
        this.cameraRotation.set(-elevation, this.yaw, 0, 'YXZ');
    }

    private updateThirdPersonDistance(dt: number) {
        const alpha = Math.min(1, Math.max(0, 12 * dt));
        this.thirdPersonDistance = this.lerp(this.thirdPersonDistance, this.thirdPersonDistanceTarget, alpha);
        const spring = -this.thirdPersonBounceOffset * THIRD_PERSON_BOUNCE_SPRING;
        const damping = -this.thirdPersonBounceVelocity * THIRD_PERSON_BOUNCE_DAMPING;
        this.thirdPersonBounceVelocity += (spring + damping) * dt;
        this.thirdPersonBounceVelocity = Math.max(-6, Math.min(6, this.thirdPersonBounceVelocity));
        this.thirdPersonBounceOffset += this.thirdPersonBounceVelocity * dt;
        this.thirdPersonBounceOffset = Math.max(
            -THIRD_PERSON_BOUNCE_MAX,
            Math.min(THIRD_PERSON_BOUNCE_MAX, this.thirdPersonBounceOffset),
        );
        if (Math.abs(this.thirdPersonBounceOffset) < 5e-4 && Math.abs(this.thirdPersonBounceVelocity) < 0.005) {
            this.thirdPersonBounceOffset = 0;
            this.thirdPersonBounceVelocity = 0;
        }
    }

    private resolveCameraCollision(dt: number, maxDistance: number) {
        this.cameraRay.subVectors(this.cameraIdealPosition, this.cameraTarget);
        const distance = this.cameraRay.length();
        if (distance < 1e-4) {
            this.cameraCollisionPosition.copy(this.cameraIdealPosition);
            this.thirdPersonCollisionDistance = distance;
            return;
        }
        this.cameraRay.multiplyScalar(1 / distance);
        let blockedDistance = maxDistance;
        let blocked = false;
        if (this.collision) {
            const hit = this.collision.queryRay(
                this.cameraTarget.x,
                this.cameraTarget.y,
                this.cameraTarget.z,
                this.cameraRay.x,
                this.cameraRay.y,
                this.cameraRay.z,
                distance,
            );
            if (hit) {
                blockedDistance = Math.max(
                    0.1,
                    this.cameraTarget.distanceTo(new Vector3(hit.x, hit.y, hit.z)) -
                        THIRD_PERSON_CAMERA_COLLISION_MARGIN,
                );
                blocked = true;
                this.thirdPersonOcclusionReleaseTimer = THIRD_PERSON_CAMERA_OCCLUSION_RELEASE_HOLD;
            }
        }
        if (!blocked && this.thirdPersonOcclusionReleaseTimer > 0) {
            this.thirdPersonOcclusionReleaseTimer = Math.max(0, this.thirdPersonOcclusionReleaseTimer - dt);
            blocked = this.thirdPersonOcclusionReleaseTimer > 0;
        }
        const desiredDistance = blocked ? blockedDistance : maxDistance;
        if (this.thirdPersonCollisionDistance < 0) {
            this.thirdPersonCollisionDistance = desiredDistance;
        } else {
            const rate =
                desiredDistance < this.thirdPersonCollisionDistance
                    ? THIRD_PERSON_CAMERA_COLLISION_IN_RATE
                    : THIRD_PERSON_CAMERA_COLLISION_OUT_RATE;
            const alpha = 1 - Math.exp(-Math.max(0, dt) * rate);
            this.thirdPersonCollisionDistance = this.lerp(this.thirdPersonCollisionDistance, desiredDistance, alpha);
        }
        this.thirdPersonCollisionDistance = Math.max(0.1, Math.min(maxDistance, this.thirdPersonCollisionDistance));
        this.cameraCollisionPosition
            .copy(this.cameraTarget)
            .addScaledVector(this.cameraRay, this.thirdPersonCollisionDistance);
    }

    private updateCharacterPosition() {
        const groundY =
            this.grounded && this.groundYFiltered !== null
                ? this.groundYFiltered
                : this.grounded
                  ? this.probeGround(this.position)
                  : null;
        const footY = groundY !== null ? groundY : this.position.y - this.hoverHeight - this.eyeHeight;
        this.characterPosition.set(this.position.x, footY, this.position.z);
    }

    private probeGround(pos: InstanceType<typeof Vector3>): number | null {
        if (!this.collision) {
            return null;
        }
        const oy = pos.y - this.eyeHeight;
        const r = this.capsuleRadius;
        const samples: Array<[number, number]> = [
            [0, 0],
            [-r, 0],
            [r, 0],
            [0, r],
            [0, -r],
        ];
        const ys: number[] = [];
        for (let i = 0; i < samples.length; i++) {
            const [ox, oz] = samples[i];
            const hit = this.collision.queryRay(pos.x + ox, oy, pos.z + oz, 0, -1, 0, this.groundProbeRange);
            if (!hit) {
                continue;
            }
            ys.push(hit.y);
        }
        if (ys.length === 0) {
            return null;
        }
        ys.sort((a, b) => a - b);
        const mid = Math.floor(ys.length / 2);
        return ys.length % 2 === 1 ? ys[mid]! : (ys[mid - 1]! + ys[mid]!) * 0.5;
    }

    private resolveCollision() {
        if (!this.collision) {
            return;
        }
        const centerY = this.position.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;
        const push: PushOut = { x: 0, y: 0, z: 0 };
        if (this.collision.queryCapsule(this.position.x, centerY, this.position.z, half, this.capsuleRadius, push)) {
            this.position.x += push.x;
            this.position.y += push.y;
            this.position.z += push.z;
            if (push.y < -PENETRATION_EPSILON && this.velocity.y > 0) {
                this.velocity.y = 0;
            }
            if (!this.grounded && push.y > PENETRATION_EPSILON && this.velocity.y < 0) {
                this.velocity.y = 0;
                this.grounded = true;
            }
        }
    }

    private resolveSpawnCollision() {
        if (!this.collision) {
            return;
        }
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;
        const minStep = this.capsuleRadius;
        const push: PushOut = { x: 0, y: 0, z: 0 };
        for (let i = 0; i < 100; i++) {
            const center = this.position.y - this.eyeHeight + this.capsuleHeight * 0.5;
            if (
                !this.collision.queryCapsule(this.position.x, center, this.position.z, half, this.capsuleRadius, push)
            ) {
                break;
            }
            this.position.y += Math.max(push.y, minStep);
        }
    }

    private damp(damping: number, dt: number) {
        return 1 - Math.pow(damping, dt * 1000);
    }

    private lerp(a: number, b: number, t: number) {
        return a + (b - a) * t;
    }

    private syncThirdPersonCursorStyle() {
        if (!this.enabled || !this.thirdPersonEnabled || !this.thirdPersonHideCursor) {
            this.container.style.removeProperty('cursor');
            return;
        }
        this.container.style.cursor = 'none';
    }

    private onKeyDown = (e: KeyboardEvent) => {
        if (!this.enabled) {
            return;
        }
        this.keys[e.code] = true;
        if (WALK_JUMP_ENABLED && e.code === 'Space') {
            this.jumpRequested = true;
        }
        if (e.code === 'Space' || e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') {
            e.preventDefault();
        }
    };

    private onKeyUp = (e: KeyboardEvent) => {
        if (!this.enabled) {
            return;
        }
        this.keys[e.code] = false;
    };

    private onDocumentPointerDown = (e: PointerEvent) => {
        if (!this.enabled) {
            return;
        }
        const target = e.target;
        if (target instanceof Node && !this.container.contains(target)) {
            this.clearInputState();
        }
    };

    private onDocumentFocusIn = (e: FocusEvent) => {
        if (!this.enabled) {
            return;
        }
        const target = e.target;
        if (target instanceof Node && !this.container.contains(target)) {
            this.clearInputState();
        }
    };

    private onPointerLockChange = () => {
        if (document.pointerLockElement !== this.container) {
            this.clearInputState();
        }
    };

    private onWindowBlur = () => {
        this.clearInputState();
    };

    private onVisibilityChange = () => {
        if (document.hidden) {
            this.clearInputState();
        }
    };

    private clearInputState() {
        this.keys = {};
        this.jumpRequested = false;
        this.jumpHeld = false;
        this.mouseLookDragging = false;
    }

    private onMouseDown = (e: MouseEvent) => {
        if (!this.enabled) {
            return;
        }
        if (this.usesPointerLock() && document.pointerLockElement !== this.container) {
            return;
        }
        if (!this.usesPointerLock() && e.target instanceof Node && !this.container.contains(e.target)) {
            return;
        }
        if (e.button === 0) {
            this.mouseLookDragging = true;
            e.preventDefault();
        }
    };

    private onMouseUp = (e: MouseEvent) => {
        if (e.button === 0) {
            this.mouseLookDragging = false;
        }
    };

    private onMouseMove = (e: MouseEvent) => {
        if (!this.enabled) {
            return;
        }
        if (this.usesPointerLock()) {
            if (document.pointerLockElement !== this.container) {
                return;
            }
        } else if (!this.mouseLookDragging || (e.buttons & 1) === 0) {
            this.mouseLookDragging = false;
            return;
        }
        const sensitivity = 0.002;
        this.yaw -= e.movementX * sensitivity;
        this.pitch += (this.thirdPersonEnabled ? 1 : -1) * e.movementY * sensitivity;
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    };

    private onWheel = (e: WheelEvent) => {
        if (!this.enabled || !this.thirdPersonEnabled) {
            return;
        }
        e.preventDefault();
        let next = this.thirdPersonDistanceTarget + e.deltaY * THIRD_PERSON_ZOOM_SENSITIVITY;
        if (next < this.thirdPersonDistanceMin) {
            this.thirdPersonBounceVelocity += (next - this.thirdPersonDistanceMin) * 0.9;
            next = this.thirdPersonDistanceMin;
        } else if (next > this.thirdPersonDistanceMax) {
            this.thirdPersonBounceVelocity += (next - this.thirdPersonDistanceMax) * 0.9;
            next = this.thirdPersonDistanceMax;
        }
        this.thirdPersonBounceVelocity = Math.max(-6, Math.min(6, this.thirdPersonBounceVelocity));
        this.thirdPersonDistanceTarget = next;
    };
}

/** Aholo OSS walk assets (`oss-res` → `node uploader/index.mjs gs:aholo`); indoor `gs_file/room/`, outdoor `gs_file/juguo/`. */
const AHOLO_OSS_GS_FILE_BASE = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file';
const WALK_INDOOR_URL_PREFIX = `${AHOLO_OSS_GS_FILE_BASE}/room/`;
const WALK_OUTDOOR_URL_PREFIX = `${AHOLO_OSS_GS_FILE_BASE}/juguo/`;

/** Third-person GLB assets; tune with `scripts/tune-character-glb-to-walk.mjs`. */
const WALK_CHARACTER_MODEL_URL_MAN = `${AHOLO_OSS_GS_FILE_BASE}/misc/man-final.755ce8ea.glb`;
const WALK_CHARACTER_MODEL_URL_ROBOT = `${AHOLO_OSS_GS_FILE_BASE}/misc/robot.0765006a.glb`;

/**
 * Yaw (rad) added to walk facing when drawing the GLB. Default `Math.PI` matches the
 * previously tuned humanoid (forward vs engine -Z). If the avatar looks sideways while moving, try `0` or `±Math.PI / 2`.
 * This does **not** move the orbit pivot on screen; it only rotates the mesh around the vertical axis at the feet.
 */
const CHARACTER_MODEL_FORWARD_OFFSET_RAD = Math.PI;

/**
 * Why the screen center can miss the “visual center” of the robot:
 * - Third-person **look-at** is not the mesh bounding-box center: {@link ViewerWalkMode.updateThirdPersonCamera} builds
 *   `cameraTarget` from controller height + `thirdPersonTargetHeight` / pivot lowering (`THIRD_PERSON_PIVOT_*`), i.e.
 *   a chest-ish point above the feet — common in action games, so the body sits lower in frame than a true centroid.
 * - Third-person `normalizeModel` centers **XZ** on the union AABB of body drawables (see
 *   `pickBodyDrawableNodes`); large asymmetry (arms, backpack, wide root) shifts that AABB vs what you perceive as center.
 * - Skinned `worldBoundingBox` (after bind) can differ from the visible silhouette until animations settle.
 * Tune: `THIRD_PERSON_MODEL_SCALE`, `thirdPersonCameraForModelScale` inputs via `REF_THIRD_PERSON` / `THIRD_PERSON_MODEL_SCALE`,
 * `CHARACTER_MODEL_FORWARD_OFFSET_RAD`, or re-export the GLB with root at hip/feet and forward along -Z.
 */

/** Normalized third-person GLB height; must match third-person `normalizeModel`. */
const CHARACTER_HEIGHT_METERS = 1.75;

const RUN_SPEED_RATIO = 1.15;
/** When false, movement faster than walk still uses the Walk clip (no separate run state). */
const CHARACTER_RUN_ANIM_ENABLED = false;
const FADE_SECONDS = 0.18;
/** Hysteresis band for Idle ↔ Walk (m/s); avoids walk clip restarts on stairs / spring bobble. */
const CHARACTER_LOCOMOTION_IDLE_ENTER_SPEED = 0.05;
const CHARACTER_LOCOMOTION_WALK_ENTER_SPEED = 0.12;
/** Below this vertical speed, spring “air” steps still use locomotion clips instead of Fall. */
const CHARACTER_STAIR_FALL_VERTICAL_SPEED = -0.85;
type CharacterActionName = 'Idle' | 'Walk' | 'Run' | 'Sprint' | 'Jump' | 'Fall';

function isLocomotionActionName(name: CharacterActionName): boolean {
    return name === 'Idle' || name === 'Walk' || name === 'Run' || name === 'Sprint';
}

interface ActionFade {
    action: InstanceType<typeof Animation.AnimationAction>;
    from: number;
    to: number;
    elapsed: number;
    duration: number;
    deactivateOnComplete: boolean;
}

function stripSkinningShaderComponents(material: unknown): void {
    const m = material as {
        getComponents?: () => { className?: () => string }[];
        deleteComponent?: (index: number) => void;
    };
    if (typeof m.getComponents !== 'function' || typeof m.deleteComponent !== 'function') {
        return;
    }
    const comps = m.getComponents();
    for (let i = comps.length - 1; i >= 0; i--) {
        if (comps[i]?.className?.() === 'SkinningShaderComponent') {
            m.deleteComponent(i);
        }
    }
}

/**
 * Third-person avatar rendered inside {@link Scene3D} so it participates in the same depth buffer as splats (after Gaussian draw).
 */
export class WalkThirdPersonCharacter {
    private readonly scene: Scene3D;
    private readonly viewer: Viewer;
    private readonly animationPlugin: InstanceType<typeof Animation.AnimationPlugin>;

    private readonly characterRoot = new Object3D();
    private readonly lights = new Object3D();
    private mixer: InstanceType<typeof Animation.AnimationMixer> | null = null;
    private actions: Partial<Record<CharacterActionName, InstanceType<typeof Animation.AnimationAction>>> = {};
    private activeAction: InstanceType<typeof Animation.AnimationAction> | null = null;
    private activeActionName: CharacterActionName | null = null;
    private locomotionAnim: 'Idle' | 'Walk' | 'Run' | 'Sprint' = 'Idle';
    private actionFades: ActionFade[] = [];

    private enabled = false;
    private loaded = false;
    private loadError = false;
    private loadPromise: Promise<void> | undefined;
    /** Aborted in {@link dispose}; guards {@link loadCharacter} from re-attaching lights after teardown. */
    private readonly lifetime = new AbortController();

    private smoothedYaw = 0;
    private modelForwardOffset = 0;
    private modelScale = 1;

    private tmpPos = new Vector3();

    constructor(
        scene: Scene3D,
        viewer: Viewer,
        private readonly modelUrl: string,
    ) {
        this.scene = scene;
        this.viewer = viewer;
        this.animationPlugin = new AnimationPlugin();
        this.animationPlugin.registerToViewer({ viewer } as any);

        this.characterRoot.visible = false;
        this.lights.visible = false;

        const ambient = new AmbientLight(0xffffff, 0.72);
        const key = new DirectionalLight(0xffffff, 1.15);
        key.position.set(0.4, 1.0, 0.35);
        const fill = new DirectionalLight(0xffffff, 0.35);
        fill.position.set(-0.7, 0.6, -0.4);
        this.lights.add(ambient);
        this.lights.add(key);
        this.lights.add(fill);
    }

    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        this.characterRoot.visible = enabled && this.loaded && !this.loadError;
        this.lights.visible = enabled && this.loaded && !this.loadError;
        if (enabled) {
            this.ensureLoaded();
        }
    }

    setModelForwardOffset(radians: number) {
        this.modelForwardOffset = radians;
    }

    setModelScale(scale: number) {
        this.modelScale = Math.max(0.0001, Math.min(1000, scale));
        this.characterRoot.scale.setScalar(this.modelScale);
    }

    /** Call after splats are re-added so draw order stays splats → mesh. */
    reattachAfterSplat() {
        if (!this.loaded || this.loadError) {
            return;
        }
        this.attachToScene();
    }

    private attachToScene(): void {
        if (this.lights.parent !== this.scene) {
            this.scene.add(this.lights);
        }
        if (this.characterRoot.parent !== this.scene) {
            this.scene.add(this.characterRoot);
        }
        this.scene.notifySceneChange();
    }

    update(state: ViewerWalkCharacterState, _dt: number) {
        if (!this.enabled || !this.loaded || this.loadError) {
            return;
        }
        const p = state.position;
        this.tmpPos.set(p.x, p.y, p.z);
        this.characterRoot.position.copy(this.tmpPos);
        this.smoothCharacterYaw(state.yaw, _dt);
        this.characterRoot.rotation.y = this.smoothedYaw + this.modelForwardOffset;
        this.characterRoot.updateMatrixWorld(true);

        if (this.mixer) {
            this.playAction(this.resolveActionName(state), state);
            this.updateActionFades(_dt);
        }
    }

    private async textureLoader(url: string): Promise<Texture2D> {
        return downloadTexture(url);
    }

    private ensureLoaded() {
        if (this.loaded || this.loadError || this.loadPromise) {
            return;
        }
        this.loadPromise = this.loadCharacter();
    }

    /** Resolves when the GLB is ready; rejects on load failure or `signal` abort. */
    waitUntilReady(signal: AbortSignal): Promise<void> {
        if (this.loaded) {
            return Promise.resolve();
        }
        if (this.loadError) {
            return Promise.reject(new Error('[walk] Third-person character failed to load.'));
        }
        this.ensureLoaded();
        if (!this.loadPromise) {
            return Promise.reject(new Error('[walk] Third-person character load did not start.'));
        }
        throwIfAborted(signal);
        if (!signal) {
            return this.loadPromise;
        }
        return new Promise<void>((resolve, reject) => {
            const onAbort = () => {
                reject(new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            this.loadPromise!.then(
                () => {
                    signal.removeEventListener('abort', onAbort);
                    if (this.lifetime.signal.aborted) {
                        reject(new DOMException('Aborted', 'AbortError'));
                        return;
                    }
                    if (this.loadError || !this.loaded) {
                        reject(new Error('[walk] Third-person character failed to load.'));
                        return;
                    }
                    resolve();
                },
                error => {
                    signal.removeEventListener('abort', onAbort);
                    reject(error);
                },
            );
        });
    }

    private async loadCharacter() {
        const { signal } = this.lifetime;
        try {
            throwIfAborted(signal);
            const response = await fetch(this.modelUrl, { signal });
            throwIfAborted(signal);
            const buffer = await response.arrayBuffer();
            throwIfAborted(signal);
            const result = await loadGLTF(buffer, {
                textureLoader: (u: string) => this.textureLoader(u),
            } as any);
            throwIfAborted(signal);

            // GLTF loader typings differ; scene graph objects are runtime-compatible with our Scene3D.
            const model = result.scene as any;
            this.characterRoot.removeAllChildren();
            // Several SkinnedMeshes often share one Material; `SkinnedMesh.bind()` adds `SkinningShaderComponent`
            // per material — a second bind on the same instance hits "material is forbidden to add similar component".
            // Clone materials for later meshes, then strip any loader-applied skinning / clear bone textures so
            // `AnimationPlugin.bindSkinned` can bind every mesh (instead of skipping when `boneMatricesTexture` is set).
            this.prepareSkinnedMeshesForAnimationBind(model);
            this.mixer = new AnimationMixer(model);
            this.animationPlugin.add(this.mixer);

            const boundSkinnedMeshes = new WeakSet<object>();
            result.skeletons.forEach((skinnedMeshes: any, iSkeleton: any) => {
                const skeleton = new Skeleton(iSkeleton.bones as any, iSkeleton.inverseBindMatrices as any);
                skinnedMeshes.forEach((skinnedMesh: any) => {
                    if (boundSkinnedMeshes.has(skinnedMesh)) {
                        return;
                    }
                    boundSkinnedMeshes.add(skinnedMesh);
                    this.animationPlugin.bindSkinned(skinnedMesh as any, skeleton, this.mixer as any);
                });
            });
            // After `bindSkinned` → `SkinnedMesh.bind`, `worldBoundingBox` uses bone matrices (not raw POSITION AABB).
            this.normalizeModel(model);
            this.characterRoot.add(model);
            this.characterRoot.scale.setScalar(this.modelScale);
            this.setupActions((result.animations || []) as AnimationClip[]);

            throwIfAborted(signal);
            this.attachToScene();

            this.loaded = true;
            this.characterRoot.visible = this.enabled;
            this.lights.visible = this.enabled;
        } catch (e) {
            if (signal.aborted) {
                return;
            }
            console.error('[walk] Third-person character load failed:', e);
            this.loadError = true;
        }
    }

    /**
     * Duplicates shared materials across skinned meshes, then clears loader-side bone bind so every mesh
     * can go through `AnimationPlugin.bindSkinned` without skipping or duplicate `SkinningShaderComponent`.
     */
    private prepareSkinnedMeshesForAnimationBind(root: Object3D) {
        root.updateMatrixWorld(true);
        this.dedupeSharedMaterialsAcrossSkinnedMeshes(root);
        this.clearLoaderSkinBindOnSkinnedMeshes(root);
    }

    private dedupeSharedMaterialsAcrossSkinnedMeshes(root: Object3D) {
        const seenMat = new Set<object>();
        root.traverse(node => {
            const o = node as {
                isSkinnedMesh?: boolean;
                getMaterials?: () => readonly { clone?: () => unknown }[];
                setMaterials?: (m: unknown | unknown[]) => void;
            };
            if (!o.isSkinnedMesh || typeof o.getMaterials !== 'function' || typeof o.setMaterials !== 'function') {
                return;
            }
            const mats = o.getMaterials();
            if (!mats?.length) {
                return;
            }
            const next = mats.map(m => {
                if (m != null && typeof m === 'object' && seenMat.has(m)) {
                    return this.cloneMaterialForSkinBinding(m);
                }
                if (m != null && typeof m === 'object') {
                    seenMat.add(m);
                }
                return m;
            });
            o.setMaterials(next.length === 1 ? next[0]! : [...next]);
        });
    }

    private clearLoaderSkinBindOnSkinnedMeshes(root: Object3D) {
        root.traverse(node => {
            const o = node as {
                isSkinnedMesh?: boolean;
                getMaterials?: () => readonly unknown[];
                setMaterials?: (m: unknown | unknown[]) => void;
                boneMatricesTexture?: unknown;
                boneMatricesBuffer?: unknown;
                skeleton?: unknown;
            };
            if (!o.isSkinnedMesh || typeof o.getMaterials !== 'function') {
                return;
            }
            for (const m of o.getMaterials()) {
                stripSkinningShaderComponents(m);
            }
            o.boneMatricesTexture = null;
            o.boneMatricesBuffer = null;
            o.skeleton = undefined;
        });
    }

    private cloneMaterialForSkinBinding(source: unknown): unknown {
        const m = source as { clone?: () => unknown };
        if (typeof m.clone !== 'function') {
            return source;
        }
        const cloned = m.clone();
        if (cloned === source) {
            return source;
        }
        stripSkinningShaderComponents(cloned);
        return cloned;
    }

    /**
     * Body drawables for height / origin normalize: prefer `*surface*` (e.g. Beta_Surface), else meshes that are not `*joint*`.
     */
    private pickBodyDrawableNodes(model: Object3D): Object3D[] {
        const surface: Object3D[] = [];
        const nonJoint: Object3D[] = [];
        model.traverse(node => {
            const o = node as { isMesh?: boolean; isSkinnedMesh?: boolean };
            if (!o.isMesh && !o.isSkinnedMesh) {
                return;
            }
            const name = (node.name || '').toLowerCase();
            if (name.includes('surface')) {
                surface.push(node);
            } else if (!name.includes('joint')) {
                nonJoint.push(node);
            }
        });
        return surface.length > 0 ? surface : nonJoint.length > 0 ? nonJoint : [];
    }

    /**
     * Union bounds for normalize. Prefer bound {@link SkinnedMesh} `worldBoundingBox` (bone-matrix hull after
     * `bind`/`update`), else `Box3.setFromObject` on the same nodes, else whole scene.
     */
    private unionCharacterNormalizeBounds(model: Object3D): InstanceType<typeof Box3> {
        const targets = this.pickBodyDrawableNodes(model);
        model.updateMatrixWorld(true);
        const box = new Box3();
        if (targets.length > 0) {
            let first = true;
            for (const n of targets) {
                const sm = n as {
                    isSkinnedMesh?: boolean;
                    update?: () => void;
                    worldBoundingBox?: InstanceType<typeof Box3>;
                };
                if (sm.isSkinnedMesh && typeof sm.update === 'function' && sm.worldBoundingBox) {
                    sm.update();
                    const wb = sm.worldBoundingBox;
                    if (!wb.isEmpty()) {
                        const dy = wb.max.y - wb.min.y;
                        if (Number.isFinite(dy) && dy > 1e-9) {
                            if (first) {
                                box.copy(wb);
                                first = false;
                            } else {
                                box.union(wb);
                            }
                            continue;
                        }
                    }
                }
                const b = new Box3().setFromObject(n);
                const dy = b.max.y - b.min.y;
                if (!Number.isFinite(dy) || dy <= 1e-9) {
                    continue;
                }
                if (first) {
                    box.copy(b);
                    first = false;
                } else {
                    box.union(b);
                }
            }
            if (!first && box.max.y - box.min.y > 1e-6) {
                return box;
            }
        }
        return new Box3().setFromObject(model);
    }

    /**
     * Uniform scale to {@link CHARACTER_HEIGHT_METERS}, then move the union body box so its bottom-center sits at the origin
     * (feet on y = 0, xz centered). Must run after `bindSkinned` so skinned `worldBoundingBox` reflects bone-driven hull.
     */
    private normalizeModel(model: Object3D) {
        model.updateMatrixWorld(true);
        const box = this.unionCharacterNormalizeBounds(model);
        const sourceHeight = Math.max(1e-6, box.max.y - box.min.y);
        const s = CHARACTER_HEIGHT_METERS / sourceHeight;
        model.scale.setScalar(s);
        model.updateMatrixWorld(true);
        const scaled = this.unionCharacterNormalizeBounds(model);
        const midX = (scaled.min.x + scaled.max.x) * 0.5;
        const midZ = (scaled.min.z + scaled.max.z) * 0.5;
        model.position.x -= midX;
        model.position.y -= scaled.min.y;
        model.position.z -= midZ;
    }

    private setupActions(clips: AnimationClip[]) {
        if (!this.mixer) {
            return;
        }
        this.actions = {};
        const map: Partial<Record<CharacterActionName, AnimationClip | null>> = {
            Idle: this.findClip(clips, 'idle'),
            Walk: this.findClip(clips, 'walk') || this.findClip(clips, 'run') || this.findClip(clips, 'mixamo.com'),
            Run: this.findClip(clips, 'run'),
            Sprint:
                this.findClip(clips, 'sprint') ||
                this.findClip(clips, 'run') ||
                this.findClip(clips, 'walk') ||
                this.findClip(clips, 'mixamo.com'),
            Jump: this.findClip(clips, 'jump'),
            Fall: this.findClip(clips, 'fall') || this.findClip(clips, 'jump'),
        };

        (Object.keys(map) as CharacterActionName[]).forEach(name => {
            const clip = map[name];
            if (!clip) {
                return;
            }
            const action = this.mixer!.clipAction(clip);
            if (name === 'Jump') {
                action.setLoop(Loop.Once, 1);
                action.pauseWhenFinished = true;
            }
            action.active = false;
            action.weight = 0;
            this.actions[name] = action;
        });

        const idle = this.actions.Idle || Object.values(this.actions)[0] || null;
        this.activateAction(idle, 0, 'Idle');
    }

    private findClip(clips: AnimationClip[], name: string): AnimationClip | null {
        const normalized = name.toLowerCase();
        return clips.find(c => c.name.toLowerCase().indexOf(normalized) >= 0) || null;
    }

    private resolveActionName(state: ViewerWalkCharacterState): CharacterActionName {
        if (!state.grounded) {
            if (!WALK_JUMP_ENABLED) {
                // Spring step-down sets grounded=false briefly; keep locomotion unless actually falling.
                if (state.speed >= CHARACTER_LOCOMOTION_WALK_ENTER_SPEED) {
                    return this.resolveLocomotionAction(state);
                }
                if (state.verticalVelocity > CHARACTER_STAIR_FALL_VERTICAL_SPEED) {
                    return this.resolveLocomotionAction(state);
                }
                return 'Fall';
            }
            return state.verticalVelocity > 0.2 ? 'Jump' : 'Fall';
        }
        return this.resolveLocomotionAction(state);
    }

    private resolveLocomotionAction(state: ViewerWalkCharacterState): 'Idle' | 'Walk' | 'Run' | 'Sprint' {
        if (this.locomotionAnim === 'Walk' || this.locomotionAnim === 'Run' || this.locomotionAnim === 'Sprint') {
            if (state.speed < CHARACTER_LOCOMOTION_IDLE_ENTER_SPEED) {
                this.locomotionAnim = 'Idle';
            }
        } else if (state.speed > CHARACTER_LOCOMOTION_WALK_ENTER_SPEED) {
            this.locomotionAnim = 'Walk';
        }
        if (CHARACTER_RUN_ANIM_ENABLED && state.speed > state.walkSpeed * RUN_SPEED_RATIO) {
            this.locomotionAnim = 'Run';
        }
        return this.locomotionAnim;
    }

    private playAction(name: CharacterActionName, state: ViewerWalkCharacterState) {
        const next = this.actions[name] || this.actions.Idle || null;
        this.updateActionSpeed(name, next, state);
        this.activateAction(next, FADE_SECONDS, name);
    }

    private activateAction(
        next: InstanceType<typeof Animation.AnimationAction> | null,
        fadeSeconds: number,
        nextName: CharacterActionName,
    ) {
        if (next === this.activeAction) {
            return;
        }
        const prevName = this.activeActionName;
        const softLocomotionHandoff =
            prevName !== null && isLocomotionActionName(prevName) && isLocomotionActionName(nextName);
        if (this.activeAction) {
            this.fadeAction(this.activeAction, 0, fadeSeconds, true);
        }
        this.activeAction = next;
        this.activeActionName = next !== null ? nextName : null;
        if (this.activeAction) {
            if (!softLocomotionHandoff || this.activeAction.weight < 0.02) {
                this.activeAction.reset();
            }
            this.activeAction.active = true;
            this.fadeAction(this.activeAction, 1, fadeSeconds, false);
        }
    }

    private fadeAction(
        action: InstanceType<typeof Animation.AnimationAction>,
        targetWeight: number,
        duration: number,
        deactivateOnComplete: boolean,
    ) {
        this.actionFades = this.actionFades.filter(fade => fade.action !== action);
        if (duration <= 0) {
            action.weight = targetWeight;
            action.active = targetWeight > 0 || !deactivateOnComplete;
            return;
        }
        action.active = true;
        this.actionFades.push({
            action,
            from: action.weight,
            to: targetWeight,
            elapsed: 0,
            duration,
            deactivateOnComplete,
        });
    }

    private updateActionFades(dt: number) {
        if (this.actionFades.length === 0) {
            return;
        }
        const remaining: ActionFade[] = [];
        for (const fade of this.actionFades) {
            fade.elapsed += Math.max(0, dt);
            const t = Math.min(1, fade.elapsed / fade.duration);
            fade.action.weight = fade.from + (fade.to - fade.from) * t;
            if (t < 1) {
                remaining.push(fade);
            } else if (fade.deactivateOnComplete) {
                fade.action.active = false;
            }
        }
        this.actionFades = remaining;
    }

    private updateActionSpeed(
        name: CharacterActionName,
        action: InstanceType<typeof Animation.AnimationAction> | null,
        state: ViewerWalkCharacterState,
    ) {
        if (!action) {
            return;
        }
        if (name === 'Walk') {
            action.speed = Math.max(0.35, Math.min(0.8, state.speed / Math.max(0.001, state.walkSpeed)));
        } else if (name === 'Run' || name === 'Sprint') {
            action.speed = Math.max(0.75, Math.min(1.6, state.speed / Math.max(0.001, state.walkSpeed)));
        } else {
            action.speed = 1;
        }
    }

    private smoothCharacterYaw(targetYaw: number, dt: number) {
        const wrapped = Math.atan2(Math.sin(targetYaw - this.smoothedYaw), Math.cos(targetYaw - this.smoothedYaw));
        const alpha = 1 - Math.exp(-Math.max(0, dt) * 14);
        this.smoothedYaw += wrapped * alpha;
    }

    dispose(): void {
        this.lifetime.abort();
        this.loadPromise = undefined;
        try {
            this.viewer.unregisterPlugin(this.animationPlugin as never);
        } catch {
            /* ignore */
        }
        this.animationPlugin.destroy();
        this.characterRoot.removeFromParent();
        this.lights.removeFromParent();
        this.mixer = null;
        this.actions = {};
        this.activeAction = null;
        this.activeActionName = null;
        this.locomotionAnim = 'Idle';
        this.actionFades = [];
        this.loaded = false;
        this.loadError = false;
    }
}

const WALK_CAMERA = {
    fov: 60,
    aspect: 1,
    near: 0.1,
    /** Large scans use world units ≫ 1e3; keep a generous perspective far plane. */
    far: 1_000_000,
} as const;

const LOD_MAGIC_CODE = 2500660;

interface WalkLodBox {
    min: [number, number, number];
    max: [number, number, number];
}

interface WalkLodMeta {
    magicCode: 2500660;
    type: 'lod-splat';
    version: number;
    counts: number;
    shDegree: number;
    levels: number;
    files: string[];
    forwardBox: WalkLodBox;
    permanentFiles: number[];
    tree: Array<{
        bound: WalkLodBox;
        lods: Array<{
            file: number;
            offset: number;
            count: number;
        }>;
    }>;
}

type LodSplatInstance = InstanceType<typeof LodSplat>;

/**
 * Baseline third-person tuning (historical inline: `setThirdPersonCamera(3.2, 1.25, 0.8, 4)` + scale `0.3`).
 * Walk applies orbit as `(thirdPersonDistance + bounce) * thirdPersonModelScale`, so the **world** orbit radius is
 * `REF.cameraDistance * REF.modelScale` when `thirdPersonDistance === REF.cameraDistance` and scale matches ref.
 */
const REF_THIRD_PERSON = {
    modelScale: 0.3,
    cameraDistance: 3.2,
    targetHeight: 1.25,
} as const;

/** Avatar + walk camera orbit scale. Tune to match your asset / splat world units; camera distance scales ~`1/scale` so world orbit stays near the ref radius. */
const THIRD_PERSON_MODEL_SCALE = 0.8;

type WalkThirdPersonCharacterId = 'man' | 'robot';

interface WalkThirdPersonCharacterOption {
    readonly url: string;
    readonly modelScale: number;
}

const WALK_THIRD_PERSON_CHARACTERS: Record<WalkThirdPersonCharacterId, WalkThirdPersonCharacterOption> = {
    man: { url: WALK_CHARACTER_MODEL_URL_MAN, modelScale: THIRD_PERSON_MODEL_SCALE },
    robot: { url: WALK_CHARACTER_MODEL_URL_ROBOT, modelScale: THIRD_PERSON_MODEL_SCALE },
};

function resolveWalkThirdPersonCharacter(id: WalkThirdPersonCharacterId): WalkThirdPersonCharacterOption {
    return WALK_THIRD_PERSON_CHARACTERS[id];
}

/**
 * Keeps world-space look height and orbit radius stable when `THIRD_PERSON_MODEL_SCALE` changes:
 * `targetHeight * s ≈ const`, `thirdPersonDistance * s ≈ REF.cameraDistance * REF.modelScale`.
 * When `THIRD_PERSON_MODEL_SCALE === REF_THIRD_PERSON.modelScale`, returns exactly `(3.2, 1.25)` for distance/targetHeight.
 */
function thirdPersonCameraForModelScale(s: number): { distance: number; targetHeight: number } {
    const refS = REF_THIRD_PERSON.modelScale;
    const worldLookOffset = REF_THIRD_PERSON.targetHeight * refS;
    const worldOrbitRadius = REF_THIRD_PERSON.cameraDistance * refS;
    const targetHeight = worldLookOffset / Math.max(1e-6, s);
    const distance = worldOrbitRadius / Math.max(1e-6, s);
    return {
        distance: Math.max(0.8, Math.min(50_000, distance)),
        targetHeight: Math.max(0.4, Math.min(50_000, targetHeight)),
    };
}

/** `SplatRenderingStabilityChangedEvent` fires from the splatting pass, which only runs inside `viewer.render()`. */
const DENSE_SPLAT_STABILITY_PUMP_MAX_MS = 120_000;

/** Walk scene: splats or LOD stream on the shared preview {@link Viewer}. */
class WalkDemoScene {
    private readonly viewer: Viewer;
    private readonly scene: Scene3D;
    private readonly splatLayer = new Object3D();
    private readonly camera: PerspectiveCamera;
    private lodSplat: LodSplatInstance | null = null;
    private thirdPerson: WalkThirdPersonCharacter | null = null;
    private thirdPersonModelUrl = WALK_CHARACTER_MODEL_URL_MAN;
    private thirdPersonModelForwardOffset = 0;
    private thirdPersonModelScale = 0.3;
    private readonly splatPackType = SplatPackType.Compressed;
    private readonly maxSh = 3;
    private readonly maxStdDev = 5;

    constructor(viewer: Viewer) {
        this.viewer = viewer;
        this.scene = this.viewer.getScene() as Scene3D;
        this.applyViewerConfig();
        this.viewer.config.coordinateSystem.enabled.set(false);

        this.camera = new PerspectiveCamera(WALK_CAMERA.fov, WALK_CAMERA.aspect, WALK_CAMERA.near, WALK_CAMERA.far);
        this.camera.position.set(0, 0, 1);
        this.camera.rotation.set(0, 0, 0);
        this.camera.enableFrustumCulling = false;
        this.camera.enableDetailCulling = false;
        this.viewer.setCamera(this.camera);
        this.scene.add(this.splatLayer);

        const cul = this.viewer.defaultViewport.drivenCullingConfig;
        cul.frustumCullingEnabled = false;
        cul.occlusionCullingEnabled = false;
        cul.detailCullingEnabled = false;
        cul.layersCullingEnabled = false;
        cul.triCullingEnabled = false;

        this.viewer.on(SplatRenderingStabilityChangedEvent, () => {
            this.viewer.requestRender();
        });
    }

    applyViewerConfig(): void {
        setViewerConfig(this.viewer, {
            pipeline: {
                Background: {
                    background: {
                        active: BackgroundMode.BasicBackground,
                        basic: { color: new Color(0, 0, 0), alpha: 1 },
                    },
                    ground: { enabled: false },
                },
                Splatting: {
                    enabled: true,
                    preBlurAmount: 0.3,
                    blurAmount: 0,
                    focalAdjustment: 2,
                    maxStdDev: Math.sqrt(this.maxStdDev),
                    detailCullingThreshold: 0,
                    packHighPrecisionEnabled: true,
                },
                TAA: { enabled: false },
            },
        });
    }

    async loadSplatFiles(files: File[]): Promise<void> {
        if (files.length === 0) {
            return;
        }
        this.clearSplats();
        await this.addSplatFilesFromList(files);
    }

    /** Static splats layered under an active LOD stream (not cleared by {@link loadLodStream}). */
    async appendSplatFiles(files: File[]): Promise<void> {
        if (files.length === 0) {
            return;
        }
        await this.addSplatFilesFromList(files);
    }

    private async addSplatFilesFromList(files: File[]): Promise<void> {
        for (const file of files) {
            const buffer = await file.arrayBuffer();
            const u8 = new Uint8Array(buffer);
            const type = detectSplatFileType(file.name, u8);
            if (type === undefined) {
                throw new Error(`[walk] Unknown splat file type: ${file.name}`);
            }

            const splatData = await parseSplatData(type, file, this.splatPackType, {
                maxShDegree: this.maxSh,
                maxTextureSize: 8192,
            });
            const raw = splatData as unknown as Record<string, unknown>;
            if (raw?.magicCode === LOD_MAGIC_CODE && raw.type === 'lod-splat') {
                throw new Error('[walk] Use the LOD scene preset for lod-splat manifests.');
            }
            const splat = await createSplat(splatData);
            await this.pumpDenseSplatUntilStable(splat);
            this.splatLayer.add(splat);
        }

        this.thirdPerson?.reattachAfterSplat();
    }

    async loadLodStream(
        metaUrl: string,
        signal: AbortSignal,
        options: {
            loadResource: (url: string) => ReturnType<typeof parseSplatData>;
            bootstrapConfig: (meta: WalkLodMeta) => Record<string, unknown>;
            runtimeConfig: (meta: WalkLodMeta) => Record<string, unknown>;
            /** Rejects when a chunk load fails so initial schedule cannot hang (see splatting-lod-stream). */
            resourceError?: Promise<never>;
        },
    ): Promise<WalkLodMeta> {
        this.clearSplats();
        const meta = await loadWalkLodMeta(metaUrl, signal);

        const lodSplat = new LodSplat(
            meta,
            options.bootstrapConfig(meta),
            createViewerContext(this.viewer),
            options.loadResource,
        );
        this.scene.add(lodSplat.container);
        lodSplat.tick(this.camera);
        lodSplat.start();

        const scheduleDone = waitForWalkLodInitialSchedule(lodSplat, this.viewer, signal);
        if (options.resourceError) {
            await Promise.race([scheduleDone, options.resourceError]);
        } else {
            await scheduleDone;
        }
        throwIfAborted(signal);

        lodSplat.setConfig(options.runtimeConfig(meta));
        lodSplat.tick(this.camera);
        this.lodSplat = lodSplat;
        this.thirdPerson?.reattachAfterSplat();
        return meta;
    }

    hasLodSplat(): boolean {
        return this.lodSplat != null;
    }

    applyLodConfig(config: Record<string, unknown>): void {
        if (!this.lodSplat) {
            return;
        }
        this.lodSplat.setConfig(config);
        this.camera.updateMatrixWorld(true);
        this.lodSplat.tick(this.camera);
        this.viewer.forceNextFrameRender = true;
    }

    tickLod(): void {
        this.lodSplat?.tick(this.camera);
    }

    private clearSplats(): void {
        while (this.splatLayer.children.length > 0) {
            const child = this.splatLayer.children[0]!;
            this.splatLayer.remove(child);
            if ('freeGPU' in child && typeof child.freeGPU === 'function') {
                child.freeGPU();
            }
            if ('destroy' in child && typeof child.destroy === 'function') {
                child.destroy();
            }
        }
        if (this.lodSplat) {
            this.lodSplat.destroy();
            this.lodSplat = null;
        }
    }

    setThirdPersonModelUrl(url: string) {
        if (this.thirdPersonModelUrl === url) {
            return;
        }
        this.thirdPersonModelUrl = url;
        this.thirdPerson?.dispose();
        this.thirdPerson = null;
    }

    private ensureThirdPerson(): WalkThirdPersonCharacter {
        if (!this.thirdPerson) {
            this.thirdPerson = new WalkThirdPersonCharacter(this.scene, this.viewer, this.thirdPersonModelUrl);
            this.thirdPerson.setModelScale(this.thirdPersonModelScale);
            this.thirdPerson.setModelForwardOffset(this.thirdPersonModelForwardOffset);
        }
        return this.thirdPerson;
    }

    setThirdPersonEnabled(enabled: boolean): void {
        if (!enabled && !this.thirdPerson) {
            return;
        }
        this.ensureThirdPerson().setEnabled(enabled);
    }

    async waitForThirdPersonCharacter(signal: AbortSignal): Promise<void> {
        this.ensureThirdPerson();
        await this.thirdPerson!.waitUntilReady(signal);
    }

    setThirdPersonModelForwardOffset(radians: number): void {
        this.thirdPersonModelForwardOffset = radians;
        this.thirdPerson?.setModelForwardOffset(radians);
    }

    setThirdPersonModelScale(scale: number): void {
        this.thirdPersonModelScale = scale;
        this.thirdPerson?.setModelScale(scale);
    }

    updateThirdPersonCharacter(state: ViewerWalkCharacterState, dt: number): void {
        this.thirdPerson?.update(state, dt);
    }

    updateCamera(scale: number[], rotation: number[], position: number[]): void {
        // Walk mode encodes FP rotation as `Euler.set(pitch, yaw, 0, 'YXZ')`; `Euler.toArray()` appends `_order` at index 3.
        // `Euler.fromArray` does not apply that 4th element, so using `fromArray` alone leaves the
        // camera on default `XYZ` and completely misinterprets pitch/yaw → empty-looking view.
        this.camera.scale.set(scale[0]!, scale[1]!, scale[2]!);
        const ord = rotation[3];
        if (typeof ord === 'string') {
            this.camera.rotation.order = ord;
        }
        this.camera.rotation.set(rotation[0]!, rotation[1]!, rotation[2]!);
        this.camera.position.set(position[0]!, position[1]!, position[2]!);
        this.camera.updateMatrixWorld(true);
    }

    /**
     * gs-viewer keeps `requestAnimationFrame` running while `updateSplats` awaits stability; Aholo walk
     * used to block `start()` on `await stable` **before** any `render()`, so the splatting pass never ran
     * → deadlock. Pump `viewer.render()` here until the splat reports stable or we time out.
     */
    private async pumpDenseSplatUntilStable(splat: Splat): Promise<void> {
        const state = { ok: false };
        splat.once(SplatRenderingStabilityChangedEvent, (stable: boolean) => {
            if (stable) {
                state.ok = true;
            }
        });
        this.splatLayer.add(splat);
        const t0 = performance.now();
        let pumps = 0;
        while (!state.ok && performance.now() - t0 < DENSE_SPLAT_STABILITY_PUMP_MAX_MS) {
            this.viewer.forceNextFrameRender = true;
            this.viewer.render();
            pumps += 1;
            await new Promise<void>(r => requestAnimationFrame(() => r()));
        }
        if (!state.ok) {
            console.warn(
                `[walk] pumpDenseSplatUntilStable: no stable=true after ${pumps} frame(s) / ${Math.round(performance.now() - t0)}ms — continuing anyway`,
            );
        }
    }

    dispose(): void {
        this.thirdPerson?.dispose();
        this.thirdPerson = null;
        this.clearSplats();
        this.splatLayer.removeFromParent();
    }
}

type WalkViewMode = 'first' | 'third';
type WalkDemoSchemeId = 'indoor' | 'outdoor';

/** Capsule center + look (rad) for {@link WalkDemoApp}. */
interface WalkDemoInitialPose {
    px: number;
    py: number;
    pz: number;
    yaw: number;
    pitch: number;
    thirdPersonDistance?: number;
}

interface WalkDemoScheme {
    id: WalkDemoSchemeId;
    splatMode: 'files' | 'lod';
    splatCandidates?: readonly string[];
    /** Dense splats kept in splatLayer while LOD streams (e.g. environment.ply). */
    staticSplatUrls?: readonly string[];
    lodMetaUrl?: string;
    collisionGlb?: string;
    voxelJson?: string;
    voxelBin?: string;
    pose: WalkDemoInitialPose;
    thirdPersonFraming?: WalkThirdPersonFraming;
}

const WALK_DEMO_INDOOR_POSE: WalkDemoInitialPose = {
    px: -4.148223469209742,
    py: 1.0000000000000002,
    pz: 1.2315243027420304,
    yaw: -1.7860000000000005,
    pitch: 0.082,
    thirdPersonDistance: 3.3999999999999995,
};

const WALK_DEMO_OUTDOOR_POSE: WalkDemoInitialPose = {
    px: 20.398008,
    py: -0.15,
    pz: 62.773942,
    yaw: -0.384,
    pitch: -0.672,
    thirdPersonDistance: 3.6,
};

const WALK_DEMO_SCHEMES: Record<WalkDemoSchemeId, WalkDemoScheme> = {
    indoor: {
        id: 'indoor',
        splatMode: 'files',
        splatCandidates: [`${WALK_INDOOR_URL_PREFIX}scene.7c26e842.spz`],
        voxelJson: `${WALK_INDOOR_URL_PREFIX}voxel/10c88df3/collision.voxel-meta.json`,
        voxelBin: `${WALK_INDOOR_URL_PREFIX}voxel/10c88df3/collision.voxel.bin`,
        pose: WALK_DEMO_INDOOR_POSE,
        thirdPersonFraming: WALK_THIRD_PERSON_FRAMING_INDOOR,
    },
    outdoor: {
        id: 'outdoor',
        splatMode: 'lod',
        lodMetaUrl: `${WALK_OUTDOOR_URL_PREFIX}chunk-lod/0f9e3ae1/lod-meta.json`,
        staticSplatUrls: [`${WALK_OUTDOOR_URL_PREFIX}environment.d3e129aa.ply`],
        voxelJson: `${WALK_OUTDOOR_URL_PREFIX}voxel/309eccc1/collision.voxel-meta.json`,
        voxelBin: `${WALK_OUTDOOR_URL_PREFIX}voxel/309eccc1/collision.voxel.bin`,
        pose: WALK_DEMO_OUTDOOR_POSE,
        thirdPersonFraming: WALK_THIRD_PERSON_FRAMING_OUTDOOR,
    },
};

function defaultThirdPersonCharacterForScheme(schemeId: WalkDemoSchemeId): WalkThirdPersonCharacterId {
    return schemeId === 'outdoor' ? 'robot' : 'man';
}

const WALK_OUTDOOR_LOD_RESOURCE_CACHE_PREFIX = 'walk-demo-outdoor:compressed';
const WALK_OUTDOOR_LOD_RESOURCE_CACHE_VERSION = 1;
/** Outdoor juguo LOD stream cap (6M splats). */
const WALK_OUTDOOR_LOD_MAX_BUDGET = 6_000_000;

function walkOutdoorThirdPersonFraming(): WalkThirdPersonFraming {
    return {
        mode: 'lowerThird',
        pivotHeightFraction: WALK_THIRD_PERSON_FRAMING_OUTDOOR.pivotHeightFraction ?? 0.92,
        pivotLowerFrac: WALK_THIRD_PERSON_FRAMING_OUTDOOR.pivotLowerFrac ?? 0,
        baseElevation: WALK_THIRD_PERSON_FRAMING_OUTDOOR.baseElevation,
    };
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
}

async function fetchAllSplatFiles(urls: readonly string[], signal: AbortSignal): Promise<File[]> {
    if (urls.length === 0) {
        throw new Error('[walk] splatCandidates is empty.');
    }
    const files: File[] = [];
    for (const url of urls) {
        throwIfAborted(signal);
        const r = await fetch(url, { signal });
        if (!r.ok) {
            throw new Error(`[walk] Splat URL failed: ${url} → HTTP ${r.status}`);
        }
        throwIfAborted(signal);
        const name = url.split('/').pop() || 'scene.ply';
        files.push(await responseToFile(r, name));
    }
    return files;
}

async function responseToFile(response: Response, fileName: string): Promise<File> {
    const blob = await response.blob();
    return new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
}

function getWalkDemoUiStrings() {
    const lang = (typeof document !== 'undefined' && document.documentElement.getAttribute('lang')) || '';
    const zh = lang.toLowerCase().startsWith('zh');
    return {
        paneTitle: zh ? '行走模式' : 'Walk mode',
        schemeLabel: zh ? '场景' : 'Scene',
        schemeIndoor: zh ? '室内' : 'Indoor',
        schemeOutdoor: zh ? '室外' : 'Outdoor',
        viewLabel: zh ? '视角' : 'Camera',
        first: zh ? '第一人称' : 'First-person',
        third: zh ? '第三人称' : 'Third-person',
        characterLabel: zh ? '第三人称模型' : 'Third-person model',
        characterMan: zh ? '男性' : 'Man',
        characterRobot: zh ? '机器人' : 'Robot',
    };
}

async function loadWalkLodMeta(metaUrl: string, signal: AbortSignal): Promise<WalkLodMeta> {
    const response = await fetch(metaUrl, { signal });
    if (!response.ok) {
        throw new Error(`[walk] LOD metadata failed (${response.status} ${response.statusText}).`);
    }
    const content: unknown = await response.json();
    if (!isWalkLodMeta(content)) {
        throw new Error('[walk] LOD metadata is not a supported lod-splat manifest.');
    }
    return content;
}

function resolveWalkLodMetaBaseUrl(metaUrl: string): string {
    return new URL('.', new URL(metaUrl, typeof location !== 'undefined' ? location.href : 'http://localhost/')).href;
}

function getWalkOutdoorLodResourceCacheKey(resourceUrl: string): string {
    const stableUrl = new URL(resourceUrl);
    stableUrl.search = '';
    return `${WALK_OUTDOOR_LOD_RESOURCE_CACHE_PREFIX}:${stableUrl.toString()}`;
}

function getWalkOutdoorLodConfig(_meta: WalkLodMeta) {
    return {
        minLevel: 0,
        maxBudget: WALK_OUTDOOR_LOD_MAX_BUDGET,
        backgroundPenalty: 1,
        outsidePenalty: 1,
        behindPenalty: 1,
        behindTolerance: -0.2,
        behindDistanceTolerance: 2,
        hysteresisTicks: 4,
        schedulerParallelCounts: 4,
        schedulerExistingTaskLimit: 64,
        schedulerMinDuration: 160,
        debuggerEnabled: false,
        debuggerType: 0 as const,
    };
}

function createWalkOutdoorLodResourceLoader(
    indexedDB: RuntimeIndexedDBStorage,
    metaBaseUrl: string,
    signal: AbortSignal,
) {
    return async (url: string) => {
        throwIfAborted(signal);
        const resourceUrl = new URL(url, metaBaseUrl).toString();
        const cacheKey = getWalkOutdoorLodResourceCacheKey(resourceUrl);

        if (indexedDB.available) {
            const cached = await indexedDB.get<SerializedCompressedSplatData>(cacheKey, {
                version: WALK_OUTDOOR_LOD_RESOURCE_CACHE_VERSION,
            });
            throwIfAborted(signal);
            if (cached) {
                const splatData = new CompressedSplatData();
                splatData.deserialize(cached);
                return splatData;
            }
        }

        const fileType = detectSplatFileType(resourceUrl, new Uint8Array());
        if (fileType === undefined) {
            throw new Error(`[walk] Unsupported LOD resource: ${resourceUrl}`);
        }
        const response = await fetch(resourceUrl, { signal });
        if (!response.ok) {
            throw new Error(`[walk] LOD resource failed: ${resourceUrl} (${response.status})`);
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength === 0) {
            throw new Error(`[walk] LOD resource is empty: ${resourceUrl}`);
        }
        const splatData = await parseSplatData(fileType, new Uint8Array(buffer), SplatPackType.Compressed);
        throwIfAborted(signal);
        if (indexedDB.available) {
            await indexedDB.set(cacheKey, splatData.serialize(), {
                version: WALK_OUTDOOR_LOD_RESOURCE_CACHE_VERSION,
            });
        }
        return splatData;
    };
}

function wrapWalkOutdoorLodResourceLoader(
    loader: (url: string) => ReturnType<typeof parseSplatData>,
    onResourceError: (error: unknown) => void,
) {
    return async (url: string) => {
        try {
            return await loader(url);
        } catch (error) {
            onResourceError(error);
            throw error;
        }
    };
}

function createWalkOutdoorLodResourceErrorRace() {
    let rejectResourceError: (error: unknown) => void = () => {};
    const resourceError = new Promise<never>((_, reject) => {
        rejectResourceError = reject;
    });
    resourceError.catch(() => {});
    return { resourceError, rejectResourceError };
}

function waitForWalkLodInitialSchedule(lodSplat: LodSplatInstance, viewer: Viewer, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let frameId: number | undefined;

    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            if (frameId !== undefined) {
                window.cancelAnimationFrame(frameId);
                frameId = undefined;
            }
            signal.removeEventListener('abort', abort);
        };
        const abort = () => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const pump = () => {
            if (signal.aborted) {
                return;
            }
            lodSplat.tick(viewer.getCamera());
            viewer.getScene().notifySceneChange();
            viewer.forceNextFrameRender = true;
            viewer.render();
            frameId = window.requestAnimationFrame(pump);
        };

        signal.addEventListener('abort', abort, { once: true });
        frameId = window.requestAnimationFrame(pump);

        lodSplat.onFinishSchedule().then(
            () => {
                if (signal.aborted) {
                    return;
                }
                cleanup();
                resolve();
            },
            error => {
                cleanup();
                reject(error);
            },
        );
    });
}

function isReloadAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function isWalkLodMeta(value: unknown): value is WalkLodMeta {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const meta = value as Partial<WalkLodMeta>;
    return (
        meta.magicCode === LOD_MAGIC_CODE &&
        meta.type === 'lod-splat' &&
        typeof meta.counts === 'number' &&
        typeof meta.levels === 'number' &&
        meta.levels > 0 &&
        Array.isArray(meta.files) &&
        meta.files.every(file => typeof file === 'string')
    );
}

/** Wires splats/LOD, collision, and {@link ViewerWalkMode} on the render runtime. */
class WalkDemoApp {
    readonly #ctx: RenderRuntime;
    #params: { scheme: WalkDemoSchemeId; viewMode: WalkViewMode; thirdPersonCharacter: WalkThirdPersonCharacterId };
    #scene: WalkDemoScene | undefined;
    #walk: ViewerWalkMode | undefined;
    #running = false;
    #reloadGeneration = 0;
    #reloadAbort: AbortController | undefined;
    #reloadChain: Promise<void> = Promise.resolve();
    #hideLoadingOnFrame = false;
    #restoredCamera: ReturnType<Viewer['getCamera']> | undefined;
    #pane: ReturnType<RenderRuntime['configPanel']['createPane']> | undefined;
    #thirdPersonCharacterBinding: { refresh(): void } | undefined;

    constructor(ctx: RenderRuntime) {
        this.#ctx = ctx;
        this.#params = {
            scheme: 'indoor',
            viewMode: 'third',
            thirdPersonCharacter: 'man',
        };
    }

    async run(): Promise<void> {
        this.#mountConfigPanel();
        /** Same driver as other runtime runners: frame callback returns whether to render; adapter calls `viewer.render()` once. */
        this.#ctx.renderer.frame(({ delta }) => this.#onFrame(delta));
        await this.#queueReloadScene();
    }

    #mountConfigPanel(): void {
        if (!this.#ctx.configPanel.available) {
            return;
        }
        const ui = getWalkDemoUiStrings();
        this.#pane = this.#ctx.configPanel.createPane({ title: ui.paneTitle });
        this.#pane
            .addBinding(this.#params, 'scheme', {
                label: ui.schemeLabel,
                options: { [ui.schemeIndoor]: 'indoor', [ui.schemeOutdoor]: 'outdoor' },
            })
            .on('change', () => {
                this.#params.thirdPersonCharacter = defaultThirdPersonCharacterForScheme(this.#params.scheme);
                this.#thirdPersonCharacterBinding?.refresh();
                void this.#queueReloadScene();
            });
        this.#thirdPersonCharacterBinding = this.#pane
            .addBinding(this.#params, 'thirdPersonCharacter', {
                label: ui.characterLabel,
                options: { [ui.characterMan]: 'man', [ui.characterRobot]: 'robot' },
            })
            .on('change', () => {
                void this.#swapThirdPersonCharacter();
            });
        this.#pane
            .addBinding(this.#params, 'viewMode', {
                label: ui.viewLabel,
                options: { [ui.first]: 'first', [ui.third]: 'third' },
            })
            .on('change', () => {
                const walk = this.#walk;
                const scene = this.#scene;
                if (!walk || !scene) {
                    return;
                }
                this.#applyViewMode(walk, scene);
                if (this.#params.viewMode === 'third') {
                    void this.#swapThirdPersonCharacter();
                } else if (this.#params.scheme === 'outdoor') {
                    this.#applyOutdoorThirdPersonFraming();
                }
            });
    }

    #applyThirdPersonCharacterToWalk(walk: ViewerWalkMode, scene: WalkDemoScene, scheme: WalkDemoScheme): void {
        const character = resolveWalkThirdPersonCharacter(this.#params.thirdPersonCharacter);
        const tpCam = thirdPersonCameraForModelScale(character.modelScale);
        let tpDistance = tpCam.distance;
        if (this.#params.viewMode === 'third' && scheme.pose.thirdPersonDistance != null) {
            tpDistance = scheme.pose.thirdPersonDistance;
        }
        walk.setThirdPersonCamera(tpDistance, tpCam.targetHeight, 0.8, Math.max(4, tpDistance));
        walk.setThirdPersonModelScale(character.modelScale);
        scene.setThirdPersonModelScale(character.modelScale);
    }

    async #swapThirdPersonCharacter(): Promise<void> {
        const scene = this.#scene;
        if (!scene) {
            return;
        }

        const character = resolveWalkThirdPersonCharacter(this.#params.thirdPersonCharacter);
        const scheme = WALK_DEMO_SCHEMES[this.#params.scheme];
        scene.setThirdPersonModelUrl(character.url);
        const walk = this.#walk;
        if (walk) {
            this.#applyThirdPersonCharacterToWalk(walk, scene, scheme);
        }

        if (this.#params.viewMode !== 'third') {
            this.#ctx.renderer.render();
            return;
        }

        this.#ctx.loading.show();
        try {
            const signal = this.#reloadAbort?.signal ?? this.#ctx.signal;
            await scene.waitForThirdPersonCharacter(signal);
            if (walk) {
                this.#applyViewMode(walk, scene);
                if (this.#params.scheme === 'outdoor') {
                    this.#applyOutdoorThirdPersonFraming();
                }
            }
            this.#ctx.renderer.render();
        } catch (error) {
            if (!isReloadAbortError(error) && !(error instanceof DOMException && error.name === 'AbortError')) {
                console.error('[walk] Third-person character load failed:', error);
            }
        } finally {
            if (this.#running) {
                this.#ctx.loading.hide();
            }
        }
    }

    #resolveMoveSpeedMps(schemeId: WalkDemoSchemeId, viewMode: WalkViewMode): number {
        if (schemeId === 'outdoor') {
            return WALK_DEMO_LOCOMOTION.moveOutdoorMps;
        }
        return viewMode === 'third' ? WALK_DEMO_LOCOMOTION.moveThirdMps : WALK_DEMO_LOCOMOTION.moveFirstMps;
    }

    #applyOutdoorThirdPersonFraming(): void {
        const walk = this.#walk;
        if (!walk || this.#params.scheme !== 'outdoor' || this.#params.viewMode !== 'third') {
            return;
        }
        walk.setThirdPersonFraming(walkOutdoorThirdPersonFraming());
    }

    #applyViewMode(walk: ViewerWalkMode, scene: WalkDemoScene): void {
        const third = this.#params.viewMode === 'third';
        walk.setThirdPersonEnabled(third);
        walk.setMoveSpeed(this.#resolveMoveSpeedMps(this.#params.scheme, this.#params.viewMode));
        walk.setThirdPersonHideCursor(third && WALK_THIRD_PERSON_HIDE_CURSOR);
        scene.setThirdPersonEnabled(third);
    }

    #configureWalkFromScheme(
        walk: ViewerWalkMode,
        scene: WalkDemoScene,
        scheme: WalkDemoScheme,
        options: { enterPose?: boolean } = {},
    ): void {
        walk.setJumpVelocity(6);
        walk.setMouseLookDragOnly(true);
        scene.setThirdPersonModelForwardOffset(CHARACTER_MODEL_FORWARD_OFFSET_RAD);
        this.#applyThirdPersonCharacterToWalk(walk, scene, scheme);
        walk.setThirdPersonFraming(
            scheme.thirdPersonFraming ??
                (this.#params.scheme === 'outdoor'
                    ? walkOutdoorThirdPersonFraming()
                    : WALK_THIRD_PERSON_FRAMING_INDOOR),
        );
        this.#applyViewMode(walk, scene);
        if (options.enterPose !== false) {
            const p = scheme.pose;
            walk.enterFromPose(new Vector3(p.px, p.py, p.pz), p.yaw, p.pitch);
        }
    }

    #enterWalkFromSchemePose(walk: ViewerWalkMode, scheme: WalkDemoScheme): void {
        const p = scheme.pose;
        walk.enterFromPose(new Vector3(p.px, p.py, p.pz), p.yaw, p.pitch);
    }

    #queueReloadScene(): Promise<void> {
        this.#reloadChain = this.#reloadChain
            .then(() => this.#reloadScene())
            .catch(error => {
                if (!isReloadAbortError(error)) {
                    console.error('[walk] Scene reload failed:', error);
                }
            });
        return this.#reloadChain;
    }

    #onFrame(delta: number): boolean {
        if (!this.#running) {
            return false;
        }
        const sceneLoop = this.#scene;
        const walkLoop = this.#walk;
        if (!sceneLoop || !walkLoop) {
            return false;
        }
        const scheme = WALK_DEMO_SCHEMES[this.#params.scheme];
        walkLoop.update(delta);
        if (this.#params.viewMode === 'third') {
            sceneLoop.setThirdPersonEnabled(true);
            sceneLoop.updateThirdPersonCharacter(walkLoop.getCharacterState(), delta);
        } else {
            sceneLoop.setThirdPersonEnabled(false);
        }
        const cam = walkLoop.getCameraState();
        sceneLoop.updateCamera(cam.scale.toArray(), cam.rotation.toArray(), cam.position.toArray());
        if (scheme.splatMode === 'lod') {
            sceneLoop.tickLod();
        }
        this.#ctx.renderer.viewer.forceNextFrameRender = true;
        if (this.#hideLoadingOnFrame) {
            this.#hideLoadingOnFrame = false;
            this.#ctx.loading.hide();
        }
        return true;
    }

    async #reloadScene(): Promise<void> {
        this.#reloadAbort?.abort();
        this.#reloadAbort = new AbortController();
        const reloadSignal = this.#reloadAbort.signal;
        const generation = ++this.#reloadGeneration;
        const scheme = WALK_DEMO_SCHEMES[this.#params.scheme];

        this.#running = false;
        this.#walk?.disable();
        this.#walk = undefined;
        this.#scene?.dispose();
        this.#scene = undefined;

        throwIfAborted(this.#ctx.signal);
        throwIfAborted(reloadSignal);
        this.#ctx.control.setOptions({ enabled: false });
        this.#ctx.loading.show();

        const viewer = this.#ctx.renderer.viewer;
        if (!this.#restoredCamera) {
            this.#restoredCamera = viewer.getCamera();
        }

        const scene = new WalkDemoScene(viewer);
        scene.setThirdPersonModelUrl(resolveWalkThirdPersonCharacter(this.#params.thirdPersonCharacter).url);
        this.#scene = scene;
        this.#ctx.renderer.resize();

        try {
            if (scheme.splatMode === 'lod') {
                if (!scheme.lodMetaUrl) {
                    throw new Error('[walk] Outdoor scheme is missing lodMetaUrl.');
                }
                const metaUrl = scheme.lodMetaUrl;
                const metaBaseUrl = resolveWalkLodMetaBaseUrl(metaUrl);
                const { resourceError, rejectResourceError } = createWalkOutdoorLodResourceErrorRace();
                const reportOutdoorResourceError = (error: unknown) => {
                    if (reloadSignal.aborted || this.#ctx.signal.aborted) {
                        return;
                    }
                    const message = error instanceof Error ? error.message : 'LOD resource failed.';
                    this.#ctx.loading.show(message);
                    rejectResourceError(error);
                };
                const loadResource = wrapWalkOutdoorLodResourceLoader(
                    createWalkOutdoorLodResourceLoader(this.#ctx.indexedDB!, metaBaseUrl, reloadSignal),
                    reportOutdoorResourceError,
                );
                await scene.loadLodStream(metaUrl, reloadSignal, {
                    loadResource,
                    resourceError,
                    bootstrapConfig: lodMeta => ({
                        ...getWalkOutdoorLodConfig(lodMeta),
                        minLevel: Math.max(0, lodMeta.levels - 1),
                        schedulerParallelCounts: 99999,
                        schedulerExistingTaskLimit: 99999,
                        schedulerMinDuration: 0,
                    }),
                    runtimeConfig: lodMeta => getWalkOutdoorLodConfig(lodMeta),
                });
                if (generation !== this.#reloadGeneration) {
                    scene.dispose();
                    return;
                }
                const staticUrls = scheme.staticSplatUrls ?? [];
                if (staticUrls.length > 0) {
                    const staticFiles = await fetchAllSplatFiles(staticUrls, reloadSignal);
                    if (generation !== this.#reloadGeneration) {
                        scene.dispose();
                        return;
                    }
                    await scene.appendSplatFiles(staticFiles);
                }
            } else {
                const urls = scheme.splatCandidates ?? [];
                if (urls.length > 0) {
                    const splatFiles = await fetchAllSplatFiles(urls, reloadSignal);
                    await scene.loadSplatFiles(splatFiles);
                }
            }

            if (generation !== this.#reloadGeneration) {
                scene.dispose();
                return;
            }

            this.#ctx.renderer.render();
            throwIfAborted(reloadSignal);

            this.#walk = new ViewerWalkMode(viewer.canvasContainer);
            const walk = this.#walk;
            this.#configureWalkFromScheme(walk, scene, scheme, { enterPose: false });
            if (this.#params.viewMode === 'third') {
                throwIfAborted(reloadSignal);
                await scene.waitForThirdPersonCharacter(reloadSignal);
            }
            if (generation !== this.#reloadGeneration) {
                return;
            }
            this.#enterWalkFromSchemePose(walk, scheme);
            if (scheme.splatMode === 'lod') {
                const cam = walk.getCameraState();
                scene.updateCamera(cam.scale.toArray(), cam.rotation.toArray(), cam.position.toArray());
                scene.tickLod();
                this.#ctx.renderer.render();
            }

            throwIfAborted(reloadSignal);
            await this.#tryLoadCollision(walk, scheme, reloadSignal);

            if (generation !== this.#reloadGeneration) {
                return;
            }

            this.#ctx.renderer.resize();
            this.#running = true;
            this.#hideLoadingOnFrame = true;
            throwIfAborted(reloadSignal);
        } catch (error) {
            if (isReloadAbortError(error) || generation !== this.#reloadGeneration) {
                return;
            }
            if (scheme.splatMode === 'lod') {
                this.#scene?.dispose();
                this.#scene = undefined;
                console.error('[walk] Outdoor LOD reload failed:', error);
                return;
            }
            this.#ctx.loading.hide();
            throw error;
        }
    }

    async #tryLoadCollision(walk: ViewerWalkMode, scheme: WalkDemoScheme, signal: AbortSignal): Promise<void> {
        const glbUrl = scheme.collisionGlb;
        if (glbUrl) {
            try {
                throwIfAborted(signal);
                const glbRes = await fetch(glbUrl, { signal });
                if (glbRes.ok) {
                    throwIfAborted(signal);
                    await walk.loadCollisionMesh(glbUrl);
                    return;
                }
            } catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError') {
                    throw e;
                }
                /* fall through to voxel / no collision */
            }
        }

        const jsonUrl = scheme.voxelJson;
        const binUrl = scheme.voxelBin;
        if (jsonUrl && binUrl) {
            throwIfAborted(signal);
            const [jsonRes, binRes] = await Promise.all([fetch(jsonUrl, { signal }), fetch(binUrl, { signal })]);
            if (!jsonRes.ok || !binRes.ok) {
                console.warn(
                    `[walk] Voxel pair not OK (json ${jsonRes.status}, bin ${binRes.status}); walking without collision.`,
                );
                return;
            }
            throwIfAborted(signal);
            const metadata = JSON.parse(await jsonRes.text()) as VoxelMetadata;
            throwIfAborted(signal);
            const binBytes = new Uint8Array(await binRes.arrayBuffer());
            const allU32 = new Uint32Array(binBytes.buffer, binBytes.byteOffset, Math.floor(binBytes.byteLength / 4));
            const nodeCount = metadata.nodeCount >>> 0;
            const leafDataCount = metadata.leafDataCount >>> 0;
            if (nodeCount + leafDataCount > allU32.length) {
                console.warn('[walk] Voxel binary size mismatch; skipping voxel collision.');
                return;
            }
            const nodes = allU32.slice(0, nodeCount);
            const leafData = allU32.slice(nodeCount, nodeCount + leafDataCount);
            walk.loadVoxelCollision(metadata, nodes, leafData);
            return;
        }

        if (jsonUrl || binUrl) {
            console.warn('[walk] Voxel collision needs both voxelJson and voxelBin; walking without collision.');
            return;
        }

        if (!glbUrl) {
            console.warn(
                '[walk] No collision configured (set collisionGlb or voxelJson+voxelBin); walking without collision.',
            );
        } else {
            console.warn('[walk] GLB collision not available and no voxel pair; walking without collision.');
        }
    }

    dispose(): void {
        this.#reloadAbort?.abort();
        this.#reloadAbort = undefined;
        this.#reloadGeneration += 1;
        this.#running = false;
        this.#walk?.disable();
        this.#walk = undefined;
        this.#scene?.dispose();
        this.#scene = undefined;
        this.#ctx.configPanel.clear();
        this.#pane = undefined;
        const cam = this.#restoredCamera;
        this.#restoredCamera = undefined;
        if (cam) {
            this.#ctx.renderer.viewer.setCamera(cam);
        }
    }
}

export default async function runner(ctx: RenderRuntime): Promise<() => void> {
    const app = new WalkDemoApp(ctx);
    await app.run();
    return () => {
        app.dispose();
    };
}
