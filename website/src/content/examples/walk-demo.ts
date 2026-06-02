/**
 * @file Walk demo: splats + collision + ViewerWalkMode.
 *
 * Derived from SuperSplat Viewer (MIT) and adapted for Aholo Viewer, voxel collision, and the website runtime.
 *
 * Reading order for code display:
 * 1. Voxel collision data and queries.
 * 2. Capsule push-out and walk controller.
 * 3. Character presentation.
 * 4. Demo scene wiring, presets, and resource loading.
 *
 * Scene presets and spawn poses are defined near the bottom of the file.
 */
import type { RenderRuntime, RuntimeIndexedDBStorage } from '../../client/render-runtime';
import {
    AmbientLight,
    Animation,
    BackgroundMode,
    DirectionalLight,
    createViewerContext,
    downloadTexture,
    SplatLoader,
    GLTFLoader,
    Object3D,
    PerspectiveCamera,
    setViewerConfig,
    SplatUtils,
    Vector3,
    Euler,
    Box3,
    Color,
} from '@manycore/aholo-viewer';
import type { Scene3D, Viewer } from '@manycore/aholo-viewer';

const AnimationPlugin = Animation.AnimationPlugin;
const AnimationMixer = Animation.AnimationMixer;
const Skeleton = Animation.Skeleton;

const { CompressedSplatData, parseSplatData, detectSplatFileType, SplatPackType } = SplatLoader;
type SerializedCompressedSplatData = Parameters<InstanceType<typeof CompressedSplatData>['deserialize']>[0];
const { createSplat, LodSplat } = SplatUtils;
const { loadGLTF } = GLTFLoader;

type AnimationClip = Animation.AnimationClip;

// -----------------------------------------------------------------------------
// Voxel collision data and queries
// -----------------------------------------------------------------------------

const SOLID_LEAF_MARKER = 0xff000000 >>> 0;
const PENETRATION_EPSILON = 1e-4;
const MAX_RESOLVE_ITERATIONS = 4;

/**
 * Sparse voxel collision field. The walk controller only needs point occupancy, raycast, and capsule push-out.
 */
export class VoxelCollision {
    private gridMinX: number;
    private gridMinY: number;
    private gridMinZ: number;
    private voxelCountX: number;
    private voxelCountY: number;
    private voxelCountZ: number;
    private voxelSize: number;
    private leafSize: number;
    private treeDepth: number;
    private nodes: Uint32Array;
    private leafData: Uint32Array;
    private scratchPush: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
    private contactNormals: { x: number; y: number; z: number }[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
    ];

    constructor(
        metadata: {
            gridBounds: { min: number[]; max: number[] };
            voxelResolution: number;
            leafSize: number;
            treeDepth: number;
        },
        nodes: Uint32Array,
        leafData: Uint32Array,
    ) {
        this.gridMinX = metadata.gridBounds.min[0];
        this.gridMinY = metadata.gridBounds.min[1];
        this.gridMinZ = metadata.gridBounds.min[2];
        const voxelSize = metadata.voxelResolution;
        this.voxelCountX = Math.round((metadata.gridBounds.max[0] - metadata.gridBounds.min[0]) / voxelSize);
        this.voxelCountY = Math.round((metadata.gridBounds.max[1] - metadata.gridBounds.min[1]) / voxelSize);
        this.voxelCountZ = Math.round((metadata.gridBounds.max[2] - metadata.gridBounds.min[2]) / voxelSize);
        this.voxelSize = voxelSize;
        this.leafSize = metadata.leafSize;
        this.treeDepth = metadata.treeDepth;
        this.nodes = nodes;
        this.leafData = leafData;
    }

    /** Fast point occupancy lookup. */
    isVoxelSolid(ix: number, iy: number, iz: number): boolean {
        if (
            this.nodes.length === 0 ||
            ix < 0 ||
            iy < 0 ||
            iz < 0 ||
            ix >= this.voxelCountX ||
            iy >= this.voxelCountY ||
            iz >= this.voxelCountZ
        ) {
            return false;
        }
        const blockX = Math.floor(ix / this.leafSize);
        const blockY = Math.floor(iy / this.leafSize);
        const blockZ = Math.floor(iz / this.leafSize);
        let nodeIndex = 0;
        for (let level = this.treeDepth - 1; level >= 0; level--) {
            const node = this.nodes[nodeIndex] >>> 0;
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
        const node = this.nodes[nodeIndex] >>> 0;
        if (node === SOLID_LEAF_MARKER) {
            return true;
        }
        return this.checkLeafByIndex(node, ix, iy, iz);
    }

    /** Raycast through voxels for ground snaps and camera blocking checks. */
    queryRay(
        ox: number,
        oy: number,
        oz: number,
        dx: number,
        dy: number,
        dz: number,
        maxDist: number,
    ): { x: number; y: number; z: number } | null {
        if (this.nodes.length === 0) {
            return null;
        }
        const voxelSize = this.voxelSize;
        const gMinX = this.gridMinX;
        const gMinY = this.gridMinY;
        const gMinZ = this.gridMinZ;
        const gMaxX = gMinX + this.voxelCountX * voxelSize;
        const gMaxY = gMinY + this.voxelCountY * voxelSize;
        const gMaxZ = gMinZ + this.voxelCountZ * voxelSize;
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
        let ix = Math.max(0, Math.min(Math.floor((entryX - gMinX) / voxelSize), this.voxelCountX - 1));
        let iy = Math.max(0, Math.min(Math.floor((entryY - gMinY) / voxelSize), this.voxelCountY - 1));
        let iz = Math.max(0, Math.min(Math.floor((entryZ - gMinZ) / voxelSize), this.voxelCountZ - 1));

        const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
        const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
        const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
        const invDx = Math.abs(dx) > EPS ? 1 / dx : 0;
        const invDy = Math.abs(dy) > EPS ? 1 / dy : 0;
        const invDz = Math.abs(dz) > EPS ? 1 / dz : 0;
        let tMaxX = Math.abs(dx) > EPS ? (gMinX + (ix + (dx > 0 ? 1 : 0)) * voxelSize - ox) * invDx : Infinity;
        let tMaxY = Math.abs(dy) > EPS ? (gMinY + (iy + (dy > 0 ? 1 : 0)) * voxelSize - oy) * invDy : Infinity;
        let tMaxZ = Math.abs(dz) > EPS ? (gMinZ + (iz + (dz > 0 ? 1 : 0)) * voxelSize - oz) * invDz : Infinity;
        const tDeltaX = Math.abs(dx) > EPS ? voxelSize * Math.abs(invDx) : Infinity;
        const tDeltaY = Math.abs(dy) > EPS ? voxelSize * Math.abs(invDy) : Infinity;
        const tDeltaZ = Math.abs(dz) > EPS ? voxelSize * Math.abs(invDz) : Infinity;
        let currentT = tNear;

        const maxSteps = this.voxelCountX + this.voxelCountY + this.voxelCountZ;
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
                ix >= this.voxelCountX ||
                iy >= this.voxelCountY ||
                iz >= this.voxelCountZ ||
                currentT > maxDist
            ) {
                return null;
            }
        }
        return null;
    }

    /** Resolve a vertical capsule out of solid voxels. */
    queryCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: { x: number; y: number; z: number },
    ): boolean {
        return this.resolveIterative(
            cx,
            cy,
            cz,
            (rx, ry, rz, push) => this.resolveDeepestPenetrationCapsule(rx, ry, rz, halfHeight, radius, push),
            out,
        );
    }

    /** Read one packed leaf bit. */
    private checkLeafByIndex(node: number, ix: number, iy: number, iz: number) {
        const leafDataIndex = node & 0x00ffffff;
        const vx = ix & 3;
        const vy = iy & 3;
        const vz = iz & 3;
        const bitIndex = vz * 16 + vy * 4 + vx;
        if (bitIndex < 32) {
            const lo = this.leafData[leafDataIndex * 2] >>> 0;
            return ((lo >>> bitIndex) & 1) === 1;
        }
        const hi = this.leafData[leafDataIndex * 2 + 1] >>> 0;
        return ((hi >>> (bitIndex - 32)) & 1) === 1;
    }

    /** Find the strongest push needed to move a capsule out of nearby solid voxels. */
    private resolveDeepestPenetrationCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: { x: number; y: number; z: number },
    ): boolean {
        const voxelSize = this.voxelSize;
        const radiusSq = radius * radius;
        const segBottomY = cy - halfHeight;
        const segTopY = cy + halfHeight;
        const ixMin = Math.floor((cx - radius - this.gridMinX) / voxelSize);
        const iyMin = Math.floor((segBottomY - radius - this.gridMinY) / voxelSize);
        const izMin = Math.floor((cz - radius - this.gridMinZ) / voxelSize);
        const ixMax = Math.floor((cx + radius - this.gridMinX) / voxelSize);
        const iyMax = Math.floor((segTopY + radius - this.gridMinY) / voxelSize);
        const izMax = Math.floor((cz + radius - this.gridMinZ) / voxelSize);
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
                    const vMinX = this.gridMinX + ix * voxelSize;
                    const vMinY = this.gridMinY + iy * voxelSize;
                    const vMinZ = this.gridMinZ + iz * voxelSize;
                    const vMaxX = vMinX + voxelSize;
                    const vMaxY = vMinY + voxelSize;
                    const vMaxZ = vMinZ + voxelSize;
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

    /** Apply a few push-out passes so corner collisions do not trap the capsule. */
    private resolveIterative(
        cx: number,
        cy: number,
        cz: number,
        findPenetration: (x: number, y: number, z: number, out: { x: number; y: number; z: number }) => boolean,
        out: { x: number; y: number; z: number },
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
            if (!findPenetration(resolvedX, resolvedY, resolvedZ, this.scratchPush)) {
                break;
            }
            hadCollision = true;
            let px = this.scratchPush.x;
            let py = this.scratchPush.y;
            let pz = this.scratchPush.z;

            for (let i = 0; i < numNormals; i++) {
                const n = this.contactNormals[i];
                const dot = px * n.x + py * n.y + pz * n.z;
                if (dot < 0) {
                    px -= dot * n.x;
                    py -= dot * n.y;
                    pz -= dot * n.z;
                }
            }

            const len = Math.sqrt(
                this.scratchPush.x * this.scratchPush.x +
                    this.scratchPush.y * this.scratchPush.y +
                    this.scratchPush.z * this.scratchPush.z,
            );
            if (len > PENETRATION_EPSILON && numNormals < 3) {
                const invLen = 1 / len;
                const n = this.contactNormals[numNormals];
                n.x = this.scratchPush.x * invLen;
                n.y = this.scratchPush.y * invLen;
                n.z = this.scratchPush.z * invLen;
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

const popcount = (n: number) => {
    n >>>= 0;
    n -= (n >>> 1) & 0x55555555;
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

// -----------------------------------------------------------------------------
// Capsule collision and walk controller
// -----------------------------------------------------------------------------

const WALK_SIMULATION_STEP_SECONDS = 1 / 60;
const MAX_SUBSTEPS = 10;
const WALK_CAPSULE_HEIGHT = 1.5;
const WALK_CAPSULE_RADIUS = 0.12;
const WALK_HOVER_HEIGHT = 0.2;
const WALK_EYE_HEIGHT = WALK_CAPSULE_HEIGHT - 0.1 - WALK_HOVER_HEIGHT;
const WALK_GRAVITY = 9.8;
const THIRD_PERSON_MODEL_SCALE = 0.8;

export interface ViewerWalkCharacterState {
    position: InstanceType<typeof Vector3>;
    yaw: number;
    speed: number;
    walkSpeed: number;
    verticalVelocity: number;
    grounded: boolean;
}

/** Walk controller: voxel collision in, camera and character state out. */
export class ViewerWalkMode {
    private collision: {
        queryRay: (...args: number[]) => { x: number; y: number; z: number } | null;
        queryCapsule: (
            cx: number,
            cy: number,
            cz: number,
            halfHeight: number,
            radius: number,
            out: { x: number; y: number; z: number },
        ) => boolean;
    } | null = null;

    private enabled = false;
    private keys: Record<string, boolean> = {};
    private mouseLookDragging = false;

    private yaw = 0;
    private pitch = 0;
    private position = new Vector3();
    private velocity = new Vector3();
    private grounded = false;
    private groundYFiltered: number | null = null;
    private horizontalSpeed = 0;

    private cameraPosition = new Vector3();
    private cameraRotation = new Euler(0, 0, 0, 'YXZ');
    private cameraScale = new Vector3(1, 1, 1);
    private characterPosition = new Vector3();
    private cameraTarget = new Vector3();
    private cameraIdealPosition = new Vector3();
    private cameraCollisionPosition = new Vector3();
    private cameraRay = new Vector3();

    private accumulator = 0;
    moveSpeed = 7;

    thirdPersonEnabled = false;
    private thirdPersonDistance = 3.2;
    private thirdPersonDistanceTarget = 3.2;
    private thirdPersonDistanceMin = 0.8;
    private thirdPersonDistanceMax = 4;
    private thirdPersonBounceOffset = 0;
    private thirdPersonBounceVelocity = 0;
    private thirdPersonTargetHeight = 1.25;
    private characterYaw = 0;
    private thirdPersonCollisionDistance = -1;
    private thirdPersonOcclusionReleaseTimer = 0;
    thirdPersonCameraPreset: 'indoor' | 'outdoor' = 'indoor';

    constructor(private container: HTMLElement) {
        document.addEventListener('keydown', this.onKeyDown);
        document.addEventListener('keyup', this.onKeyUp);
        document.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mouseup', this.onMouseUp);
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('wheel', this.onWheel, { passive: false });
        // Prevent "stuck key" drift when keyup is lost (UI panel focus, pointer-lock, tab blur).
        document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
        document.addEventListener('focusin', this.onDocumentFocusIn, true);
        window.addEventListener('blur', this.onWindowBlur);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    /** Attach voxel collision data used by ground checks and capsule push-out. */
    loadVoxelCollision(
        metadata: {
            gridBounds: { min: number[]; max: number[] };
            voxelResolution: number;
            leafSize: number;
            treeDepth: number;
        },
        nodes: Uint32Array,
        leafData: Uint32Array,
    ) {
        this.collision = new VoxelCollision(metadata, nodes, leafData);
    }

    /** Place the walker at a known position and camera angle. */
    startAtPose(position: InstanceType<typeof Vector3>, yaw: number, pitch: number) {
        this.position.copy(position);
        this.velocity.set(0, 0, 0);
        this.yaw = yaw;
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
        this.activateAtCurrentPose();
    }

    /** Reset runtime state, resolve spawn collision, and snap to the ground if one is below. */
    private activateAtCurrentPose() {
        this.enabled = true;
        this.keys = {};
        this.accumulator = 0;
        this.grounded = false;
        this.horizontalSpeed = 0;
        this.characterYaw = this.yaw;
        this.thirdPersonDistanceTarget = this.thirdPersonDistance;
        this.thirdPersonCollisionDistance = -1;
        this.thirdPersonOcclusionReleaseTimer = 0;
        this.groundYFiltered = null;
        this.resolveSpawnCollision();
        const gy = this.probeGround(this.position);
        if (gy !== null) {
            this.grounded = true;
            this.velocity.y = 0;
            this.position.y = gy + WALK_HOVER_HEIGHT + WALK_EYE_HEIGHT;
            this.groundYFiltered = gy;
        }
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
    }

    /** Stop walk mode and clear held input. */
    disable() {
        this.enabled = false;
        this.clearInputState();
    }

    /** Set third-person orbit distance and look height. */
    setThirdPersonCamera(distance: number, targetHeight: number, minDistance = 0.8, maxDistance = 4) {
        this.thirdPersonDistanceMin = Math.max(0.2, Math.min(4, minDistance));
        const maxCap = 1_000_000;
        this.thirdPersonDistanceMax = Math.max(this.thirdPersonDistanceMin + 0.1, Math.min(maxCap, maxDistance));
        const clampedDistance = Math.max(this.thirdPersonDistanceMin, Math.min(this.thirdPersonDistanceMax, distance));
        this.thirdPersonDistance = clampedDistance;
        this.thirdPersonDistanceTarget = clampedDistance;
        this.thirdPersonTargetHeight = Math.max(0.4, Math.min(maxCap, targetHeight));
    }
    /** Called once per frame; runs fixed physics steps and then updates the camera state. */
    update(dt: number) {
        if (!this.enabled) {
            return;
        }
        const dtClamped = Math.min(Math.max(0, dt), 1 / 20);
        this.accumulator = Math.min(this.accumulator + dtClamped, MAX_SUBSTEPS * WALK_SIMULATION_STEP_SECONDS);
        while (this.accumulator >= WALK_SIMULATION_STEP_SECONDS) {
            this.step(WALK_SIMULATION_STEP_SECONDS);
            this.accumulator -= WALK_SIMULATION_STEP_SECONDS;
        }
        this.updateCharacterPosition();
        if (this.thirdPersonEnabled) {
            this.updateThirdPersonCamera(dtClamped);
        } else {
            this.cameraPosition.set(this.position.x, this.position.y, this.position.z);
            this.cameraRotation.set(this.pitch, this.yaw, 0, 'YXZ');
        }
    }

    /** Current camera transform for the render scene. */
    getCameraState() {
        return { position: this.cameraPosition, rotation: this.cameraRotation, scale: this.cameraScale };
    }

    /** Current avatar state for the third-person model. */
    getCharacterState(): ViewerWalkCharacterState {
        return {
            position: this.characterPosition,
            yaw: this.characterYaw,
            speed: this.horizontalSpeed,
            walkSpeed: this.moveSpeed,
            verticalVelocity: this.velocity.y,
            grounded: this.grounded,
        };
    }

    /** One fixed physics step: ground probe, gravity, horizontal movement, and voxel push-out. */
    private step(dt: number) {
        const rawGroundY = this.probeGround(this.position);
        const hasGround = rawGroundY !== null;

        if (hasGround && rawGroundY !== null) {
            if (this.groundYFiltered === null) {
                this.groundYFiltered = rawGroundY;
            } else {
                const a = 1 - Math.exp(-20 * dt);
                this.groundYFiltered += (rawGroundY - this.groundYFiltered) * a;
            }
        } else if (!hasGround) {
            this.groundYFiltered = null;
        }

        const groundYStick = hasGround && this.groundYFiltered !== null ? this.groundYFiltered : rawGroundY;

        if (hasGround) {
            const groundYValue = groundYStick as number;
            const targetY = groundYValue + WALK_HOVER_HEIGHT + WALK_EYE_HEIGHT;
            const displacement = this.position.y - targetY;
            if (displacement > 0.1) {
                this.velocity.y -= WALK_GRAVITY * dt;
                const nextY = this.position.y + this.velocity.y * dt;
                if (nextY <= targetY) {
                    this.position.y = targetY;
                    this.velocity.y = 0;
                }
                this.grounded = false;
            } else {
                const spring = -800 * displacement - 57 * this.velocity.y;
                this.velocity.y += spring * dt;
                this.grounded = true;
            }
        } else {
            this.velocity.y -= WALK_GRAVITY * dt;
            this.grounded = false;
        }

        const forwardInput = (this.keys.KeyW ? 1 : 0) - (this.keys.KeyS ? 1 : 0);
        const strafeInput = (this.keys.KeyD ? 1 : 0) - (this.keys.KeyA ? 1 : 0);
        const move = new Vector3();
        const hasMoveInput = forwardInput !== 0 || strafeInput !== 0;
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
        const accel = this.grounded ? 24 : 6;
        const blend = Math.min(1, accel * dt);
        this.velocity.x = this.velocity.x + (move.x - this.velocity.x) * blend;
        this.velocity.z = this.velocity.z + (move.z - this.velocity.z) * blend;
        const dampFactor = this.grounded ? 0.99 : 0.998;
        const alpha = this.damp(dampFactor, dt);
        this.velocity.x = this.lerp(this.velocity.x, 0, alpha * 0.35);
        this.velocity.z = this.lerp(this.velocity.z, 0, alpha * 0.35);
        this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);

        this.position.addScaledVector(this.velocity, dt);
        this.resolveCollision();
    }

    /** Build a third-person camera from avatar position, pitch, zoom, and collision. */
    private updateThirdPersonCamera(dt: number) {
        this.updateThirdPersonDistance(dt);
        const cameraScale = THIRD_PERSON_MODEL_SCALE;
        const meshWorldH = CHARACTER_HEIGHT_METERS * cameraScale;
        const { pivotY, baseElevation } = this.computeThirdPersonCameraTarget(meshWorldH, cameraScale);

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
        this.cameraCollisionPosition.y = Math.max(this.cameraCollisionPosition.y, this.characterPosition.y + 0.12);

        this.cameraPosition.copy(this.cameraCollisionPosition);
        this.cameraRotation.set(-elevation, this.yaw, 0, 'YXZ');
    }

    /** Pick the vertical target point for indoor and outdoor third-person views. */
    private computeThirdPersonCameraTarget(meshWorldHeight: number, cameraScale: number) {
        if (this.thirdPersonCameraPreset === 'outdoor') {
            return {
                pivotY: this.characterPosition.y + meshWorldHeight * 0.92,
                baseElevation: 0.4,
            };
        }

        const pivotY =
            this.position.y -
            WALK_EYE_HEIGHT +
            WALK_HOVER_HEIGHT +
            this.thirdPersonTargetHeight * cameraScale -
            0.22 * meshWorldHeight;

        return {
            pivotY: Math.max(this.characterPosition.y + meshWorldHeight * 0.06, pivotY),
            baseElevation: 0.35,
        };
    }

    /** Smooth zoom changes and the small zoom bounce. */
    private updateThirdPersonDistance(dt: number) {
        const alpha = Math.min(1, Math.max(0, 12 * dt));
        this.thirdPersonDistance = this.lerp(this.thirdPersonDistance, this.thirdPersonDistanceTarget, alpha);
        const spring = -this.thirdPersonBounceOffset * 70;
        const damping = -this.thirdPersonBounceVelocity * 12;
        this.thirdPersonBounceVelocity += (spring + damping) * dt;
        this.thirdPersonBounceVelocity = Math.max(-6, Math.min(6, this.thirdPersonBounceVelocity));
        this.thirdPersonBounceOffset += this.thirdPersonBounceVelocity * dt;
        this.thirdPersonBounceOffset = Math.max(-0.5, Math.min(0.5, this.thirdPersonBounceOffset));
        if (Math.abs(this.thirdPersonBounceOffset) < 5e-4 && Math.abs(this.thirdPersonBounceVelocity) < 0.005) {
            this.thirdPersonBounceOffset = 0;
            this.thirdPersonBounceVelocity = 0;
        }
    }

    /** Pull the third-person camera forward when voxels block the view. */
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
                blockedDistance = Math.max(0.1, this.cameraTarget.distanceTo(new Vector3(hit.x, hit.y, hit.z)) - 0.18);
                blocked = true;
                this.thirdPersonOcclusionReleaseTimer = 0.1;
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
            const rate = desiredDistance < this.thirdPersonCollisionDistance ? 14 : 7;
            const alpha = 1 - Math.exp(-Math.max(0, dt) * rate);
            this.thirdPersonCollisionDistance = this.lerp(this.thirdPersonCollisionDistance, desiredDistance, alpha);
        }
        this.thirdPersonCollisionDistance = Math.max(0.1, Math.min(maxDistance, this.thirdPersonCollisionDistance));
        this.cameraCollisionPosition
            .copy(this.cameraTarget)
            .addScaledVector(this.cameraRay, this.thirdPersonCollisionDistance);
    }

    /** Place the avatar feet on the current ground height. */
    private updateCharacterPosition() {
        const groundY =
            this.grounded && this.groundYFiltered !== null
                ? this.groundYFiltered
                : this.grounded
                  ? this.probeGround(this.position)
                  : null;
        const footY = groundY !== null ? groundY : this.position.y - WALK_HOVER_HEIGHT - WALK_EYE_HEIGHT;
        this.characterPosition.set(this.position.x, footY, this.position.z);
    }

    /** Raycast below the capsule and return a stable ground height. */
    private probeGround(pos: InstanceType<typeof Vector3>): number | null {
        if (!this.collision) {
            return null;
        }
        const oy = pos.y - WALK_EYE_HEIGHT;
        const r = WALK_CAPSULE_RADIUS;
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
            const hit = this.collision.queryRay(pos.x + ox, oy, pos.z + oz, 0, -1, 0, 1.0);
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

    /** Push the moving capsule out of solid voxels. */
    private resolveCollision() {
        if (!this.collision) {
            return;
        }
        const centerY = this.position.y - WALK_EYE_HEIGHT + WALK_CAPSULE_HEIGHT * 0.5;
        const half = WALK_CAPSULE_HEIGHT * 0.5 - WALK_CAPSULE_RADIUS;
        const push = { x: 0, y: 0, z: 0 };
        if (this.collision.queryCapsule(this.position.x, centerY, this.position.z, half, WALK_CAPSULE_RADIUS, push)) {
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

    /** Lift the start pose until the capsule is outside solid voxels. */
    private resolveSpawnCollision() {
        if (!this.collision) {
            return;
        }
        const half = WALK_CAPSULE_HEIGHT * 0.5 - WALK_CAPSULE_RADIUS;
        const minStep = WALK_CAPSULE_RADIUS;
        const push = { x: 0, y: 0, z: 0 };
        for (let i = 0; i < 100; i++) {
            const center = this.position.y - WALK_EYE_HEIGHT + WALK_CAPSULE_HEIGHT * 0.5;
            if (
                !this.collision.queryCapsule(this.position.x, center, this.position.z, half, WALK_CAPSULE_RADIUS, push)
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

    private onKeyDown = (e: KeyboardEvent) => {
        if (!this.enabled) {
            return;
        }
        this.keys[e.code] = true;
        if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') {
            e.preventDefault();
        }
    };

    private onKeyUp = (e: KeyboardEvent) => {
        if (!this.enabled) {
            return;
        }
        this.keys[e.code] = false;
    };

    // Clear held keys when the user leaves the walk area or the page loses focus.
    private onDocumentPointerDown = (e: PointerEvent) => {
        this.clearInputWhenTargetLeavesContainer(e.target);
    };

    private onDocumentFocusIn = (e: FocusEvent) => {
        this.clearInputWhenTargetLeavesContainer(e.target);
    };

    private clearInputWhenTargetLeavesContainer(target: EventTarget | null) {
        if (!this.enabled) {
            return;
        }
        if (target instanceof Node && !this.container.contains(target)) {
            this.clearInputState();
        }
    }

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
        this.mouseLookDragging = false;
    }

    private onMouseDown = (e: MouseEvent) => {
        if (!this.enabled) {
            return;
        }
        if (e.target instanceof Node && !this.container.contains(e.target)) {
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
        if (!this.mouseLookDragging || (e.buttons & 1) === 0) {
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
        let next = this.thirdPersonDistanceTarget + e.deltaY * 0.002;
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

// -----------------------------------------------------------------------------
// Demo assets and character presentation
// -----------------------------------------------------------------------------

/** Aholo OSS walk assets (`oss-res` -> `node uploader/index.mjs gs:aholo`); indoor `gs_file/room/`, outdoor `gs_file/juguo/`. */
const AHOLO_OSS_GS_FILE_BASE = 'https://holo-cos.aholo3d.cn/aholo-opensource/gs_file';
const WALK_INDOOR_URL_PREFIX = `${AHOLO_OSS_GS_FILE_BASE}/room/`;
const WALK_OUTDOOR_URL_PREFIX = `${AHOLO_OSS_GS_FILE_BASE}/juguo/`;

/** Third-person GLB assets; tune with `scripts/tune-character-glb-to-walk.mjs`. */
const WALK_CHARACTER_MODEL_URL_MAN = `${AHOLO_OSS_GS_FILE_BASE}/misc/man-final.755ce8ea.glb`;
const WALK_CHARACTER_MODEL_URL_ROBOT = `${AHOLO_OSS_GS_FILE_BASE}/misc/robot.0765006a.glb`;

/** Normalized third-person GLB height. */
const CHARACTER_HEIGHT_METERS = 1.75;

const FADE_SECONDS = 0.18;
/** Idle/walk speed thresholds. */
const CHARACTER_LOCOMOTION_IDLE_ENTER_SPEED = 0.05;
const CHARACTER_LOCOMOTION_WALK_ENTER_SPEED = 0.12;
const CHARACTER_STAIR_FALL_VERTICAL_SPEED = -0.85;
type CharacterActionName = 'Idle' | 'Walk' | 'Fall';

interface ActionFade {
    action: InstanceType<typeof Animation.AnimationAction>;
    from: number;
    to: number;
    elapsed: number;
    duration: number;
    deactivateOnComplete: boolean;
}

/** Third-person avatar rendered in the same scene as the splats. */
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
    private locomotionAnim: 'Idle' | 'Walk' = 'Idle';
    private actionFades: ActionFade[] = [];

    private enabled = false;
    private loaded = false;
    private loadError = false;
    private loadPromise: Promise<void> | undefined;
    /** Guards async character loading after disposal. */
    private readonly lifetime = new AbortController();

    private smoothedYaw = 0;

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
        this.characterRoot.scale.setScalar(THIRD_PERSON_MODEL_SCALE);
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

    /** Show the avatar and start loading it when needed. */
    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        this.characterRoot.visible = enabled && this.loaded && !this.loadError;
        this.lights.visible = enabled && this.loaded && !this.loadError;
        if (enabled) {
            this.ensureLoaded();
        }
    }

    /** Add avatar objects to the active scene. */
    private attachToScene(): void {
        if (this.lights.parent !== this.scene) {
            this.scene.add(this.lights);
        }
        if (this.characterRoot.parent !== this.scene) {
            this.scene.add(this.characterRoot);
        }
        this.scene.notifySceneChange();
    }

    /** Match the GLB position, yaw, and animation to walk state. */
    update(state: ViewerWalkCharacterState, _dt: number) {
        if (!this.enabled || !this.loaded || this.loadError) {
            return;
        }
        const p = state.position;
        this.tmpPos.set(p.x, p.y, p.z);
        this.characterRoot.position.copy(this.tmpPos);
        this.smoothCharacterYaw(state.yaw, _dt);
        this.characterRoot.rotation.y = this.smoothedYaw + Math.PI;
        this.characterRoot.updateMatrixWorld(true);

        if (this.mixer) {
            this.playAction(this.resolveActionName(state), state);
            this.updateActionFades(_dt);
        }
    }

    /** Start the GLB load once. */
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

    /** Load the GLB, bind animation, fit its size, and attach it to the scene. */
    private async loadCharacter() {
        const { signal } = this.lifetime;
        try {
            const response = await fetch(this.modelUrl, { signal });
            throwIfAborted(signal);
            const buffer = await response.arrayBuffer();
            throwIfAborted(signal);
            const result = await loadGLTF(buffer, {
                textureLoader: (url: string) => downloadTexture(url),
            } as any);
            throwIfAborted(signal);

            // GLTF loader typings differ; scene graph objects are runtime-compatible with our Scene3D.
            const model = result.scene as any;
            this.characterRoot.removeAllChildren();
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
            // After `bindSkinned` -> `SkinnedMesh.bind`, `worldBoundingBox` uses bone matrices (not raw POSITION AABB).
            this.normalizeModel(model);
            this.characterRoot.add(model);
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

    /** Meshes used to fit character height and foot origin. */
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

    /** Bounds used to fit the character model. */
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

    /** Scale to CHARACTER_HEIGHT_METERS and move the feet to the origin. */
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

    /** Pick idle, walk, and fall clips from the GLB animation list. */
    private setupActions(clips: AnimationClip[]) {
        if (!this.mixer) {
            return;
        }
        const findClip = (name: string) => {
            const normalized = name.toLowerCase();
            return clips.find(c => c.name.toLowerCase().indexOf(normalized) >= 0) || null;
        };
        this.actions = {};
        const map: Partial<Record<CharacterActionName, AnimationClip | null>> = {
            Idle: findClip('idle'),
            Walk: findClip('walk') || findClip('run') || findClip('mixamo.com'),
            Fall: findClip('fall') || findClip('jump'),
        };

        (Object.keys(map) as CharacterActionName[]).forEach(name => {
            const clip = map[name];
            if (!clip) {
                return;
            }
            const action = this.mixer!.clipAction(clip);
            action.active = false;
            action.weight = 0;
            this.actions[name] = action;
        });

        const idle = this.actions.Idle || Object.values(this.actions)[0] || null;
        this.activateAction(idle, 0, 'Idle');
    }

    /** Choose the avatar animation from ground and speed state. */
    private resolveActionName(state: ViewerWalkCharacterState): CharacterActionName {
        if (!state.grounded) {
            // Small steps can briefly set grounded=false; keep idle/walk unless actually falling.
            if (state.speed >= CHARACTER_LOCOMOTION_WALK_ENTER_SPEED) {
                return this.resolveLocomotionAction(state);
            }
            if (state.verticalVelocity > CHARACTER_STAIR_FALL_VERTICAL_SPEED) {
                return this.resolveLocomotionAction(state);
            }
            return 'Fall';
        }
        return this.resolveLocomotionAction(state);
    }

    /** Switch between idle and walk with a small speed gap. */
    private resolveLocomotionAction(state: ViewerWalkCharacterState): 'Idle' | 'Walk' {
        if (this.locomotionAnim === 'Walk') {
            if (state.speed < CHARACTER_LOCOMOTION_IDLE_ENTER_SPEED) {
                this.locomotionAnim = 'Idle';
            }
        } else if (state.speed > CHARACTER_LOCOMOTION_WALK_ENTER_SPEED) {
            this.locomotionAnim = 'Walk';
        }
        return this.locomotionAnim;
    }

    /** Update speed and fade to the requested animation. */
    private playAction(name: CharacterActionName, state: ViewerWalkCharacterState) {
        const next = this.actions[name] || this.actions.Idle || null;
        this.updateActionSpeed(name, next, state);
        this.activateAction(next, FADE_SECONDS, name);
    }

    /** Fade from the current animation to the next one. */
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
            prevName !== null &&
            (prevName === 'Idle' || prevName === 'Walk') &&
            (nextName === 'Idle' || nextName === 'Walk');
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

    /** Queue a weight fade for one animation action. */
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

    /** Advance queued animation fades. */
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

    /** Match walk animation speed to movement speed. */
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
        } else {
            action.speed = 1;
        }
    }

    /** Smooth avatar turning so direction changes are not sharp. */
    private smoothCharacterYaw(targetYaw: number, dt: number) {
        const wrapped = Math.atan2(Math.sin(targetYaw - this.smoothedYaw), Math.cos(targetYaw - this.smoothedYaw));
        const alpha = 1 - Math.exp(-Math.max(0, dt) * 14);
        this.smoothedYaw += wrapped * alpha;
    }

    /** Remove avatar objects and stop animation resources. */
    dispose(): void {
        this.lifetime.abort();
        this.loadPromise = undefined;
        try {
            (this.viewer as any).unregisterPlugin(this.animationPlugin as never);
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

// -----------------------------------------------------------------------------
// Demo scene resources and wiring
// -----------------------------------------------------------------------------

const WALK_CAMERA = {
    fov: 60,
    aspect: 1,
    near: 0.1,
    /** Large scans use world units much greater than 1e3; keep a generous perspective far plane. */
    far: 1_000_000,
} as const;

const LOD_MAGIC_CODE = 2500660;
const WALK_SPLAT_PACK_TYPE = SplatPackType.Compressed;
const WALK_MAX_SH_DEGREE = 3;
const WALK_MAX_STD_DEV = 5;

type WalkLodMeta = SplatUtils.LodMeta;
type LodSplatInstance = InstanceType<typeof LodSplat>;

/** Reference third-person camera tuning. */
const REF_THIRD_PERSON = {
    modelScale: 0.3,
    cameraDistance: 3.2,
    targetHeight: 1.25,
} as const;

const THIRD_PERSON_CAMERA = {
    distance: (REF_THIRD_PERSON.cameraDistance * REF_THIRD_PERSON.modelScale) / THIRD_PERSON_MODEL_SCALE,
    targetHeight: (REF_THIRD_PERSON.targetHeight * REF_THIRD_PERSON.modelScale) / THIRD_PERSON_MODEL_SCALE,
} as const;

type WalkThirdPersonCharacterId = 'man' | 'robot';

const WALK_THIRD_PERSON_CHARACTER_URLS: Record<WalkThirdPersonCharacterId, string> = {
    man: WALK_CHARACTER_MODEL_URL_MAN,
    robot: WALK_CHARACTER_MODEL_URL_ROBOT,
};

/** Walk scene: splats or LOD stream on the shared preview viewer. */
class WalkDemoScene {
    private readonly viewer: Viewer;
    private readonly scene: Scene3D;
    private readonly splatLayer = new Object3D();
    private readonly camera: PerspectiveCamera;
    private lodSplat: LodSplatInstance | null = null;
    private thirdPerson: WalkThirdPersonCharacter | null = null;
    private thirdPersonModelUrl = WALK_CHARACTER_MODEL_URL_MAN;

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

        const cul = (this.viewer as any).defaultViewport.drivenCullingConfig;
        cul.frustumCullingEnabled = false;
        cul.occlusionCullingEnabled = false;
        cul.detailCullingEnabled = false;
        cul.layersCullingEnabled = false;
        cul.triCullingEnabled = false;
    }

    /** Apply viewer settings needed by this demo. */
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
                    maxStdDev: Math.sqrt(WALK_MAX_STD_DEV),
                    detailCullingThreshold: 0,
                    packHighPrecisionEnabled: true,
                },
                TAA: { enabled: false },
            },
        });
    }

    /** Replace current splats with static splat files. */
    async loadSplatUrls(urls: readonly string[], signal: AbortSignal): Promise<void> {
        if (urls.length === 0) {
            return;
        }
        this.clearSplats();
        await this.addSplatUrls(urls, signal);
    }

    /** Add static splats without clearing the active LOD stream. */
    async appendSplatUrls(urls: readonly string[], signal: AbortSignal): Promise<void> {
        if (urls.length === 0) {
            return;
        }
        await this.addSplatUrls(urls, signal);
    }

    /** Fetch, parse, and add static splat files. */
    private async addSplatUrls(urls: readonly string[], signal: AbortSignal): Promise<void> {
        for (const url of urls) {
            const response = await fetch(url, { signal });
            if (!response.ok) {
                throw new Error(`[walk] Splat URL failed: ${url} -> HTTP ${response.status}`);
            }
            const buffer = await response.arrayBuffer();
            throwIfAborted(signal);
            const u8 = new Uint8Array(buffer);
            const type = detectSplatFileType(url, u8);
            if (type === undefined) {
                throw new Error(`[walk] Unknown splat file type: ${url}`);
            }

            const splatData = await parseSplatData(type, u8, WALK_SPLAT_PACK_TYPE, {
                maxShDegree: WALK_MAX_SH_DEGREE,
                maxTextureSize: 8192,
            });
            throwIfAborted(signal);
            const splat = await createSplat(splatData);
            throwIfAborted(signal);
            this.splatLayer.add(splat);
        }
    }

    /** Load the outdoor LOD stream and wait for the first chunk pass. */
    async loadLodStream(
        metaUrl: string,
        signal: AbortSignal,
        loadResource: (url: string) => ReturnType<typeof parseSplatData>,
    ): Promise<void> {
        this.clearSplats();
        const meta = await loadWalkLodMeta(metaUrl, signal);

        const lodSplat = new LodSplat(
            meta,
            {
                ...WALK_OUTDOOR_LOD_CONFIG,
                minLevel: Math.max(0, meta.levels - 1),
                schedulerParallelCounts: 99999,
                schedulerExistingTaskLimit: 99999,
                schedulerMinDuration: 0,
            },
            createViewerContext(this.viewer),
            loadResource,
        );
        this.scene.add(lodSplat.container);
        lodSplat.tick(this.camera);
        lodSplat.start();
        await lodSplat.onFinishSchedule();
        throwIfAborted(signal);

        lodSplat.setConfig(WALK_OUTDOOR_LOD_CONFIG);
        lodSplat.tick(this.camera);
        this.lodSplat = lodSplat;
    }

    /** Update LOD selection for the current camera. */
    tickLod(): void {
        this.lodSplat?.tick(this.camera);
    }

    /** Remove static splats and any active LOD stream. */
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

    /** Change the avatar GLB URL and reset the loaded avatar. */
    setThirdPersonModelUrl(url: string) {
        if (this.thirdPersonModelUrl === url) {
            return;
        }
        this.thirdPersonModelUrl = url;
        this.thirdPerson?.dispose();
        this.thirdPerson = null;
    }

    /** Create the avatar object when the view first needs it. */
    private ensureThirdPerson(): WalkThirdPersonCharacter {
        if (!this.thirdPerson) {
            this.thirdPerson = new WalkThirdPersonCharacter(this.scene, this.viewer, this.thirdPersonModelUrl);
        }
        return this.thirdPerson;
    }

    /** Show or hide the third-person avatar. */
    setThirdPersonEnabled(enabled: boolean): void {
        if (!enabled && !this.thirdPerson) {
            return;
        }
        this.ensureThirdPerson().setEnabled(enabled);
    }

    /** Wait until the avatar GLB is ready. */
    async waitForThirdPersonCharacter(signal: AbortSignal): Promise<void> {
        this.ensureThirdPerson();
        await this.thirdPerson!.waitUntilReady(signal);
    }

    /** Update avatar pose and animation. */
    updateThirdPersonCharacter(state: ViewerWalkCharacterState, dt: number): void {
        this.thirdPerson?.update(state, dt);
    }

    /** Copy walk camera state to the viewer camera. */
    updateCamera(state: ReturnType<ViewerWalkMode['getCameraState']>): void {
        this.camera.scale.copy(state.scale);
        this.camera.rotation.copy(state.rotation);
        this.camera.position.copy(state.position);
        this.camera.updateMatrixWorld(true);
        // Splat sorting depends on the viewer seeing this manual camera move as a real frame update.
        (this.viewer as any).forceNextFrameRender = true;
    }

    /** Remove demo scene objects. */
    dispose(): void {
        this.thirdPerson?.dispose();
        this.thirdPerson = null;
        this.clearSplats();
        this.splatLayer.removeFromParent();
    }
}

// -----------------------------------------------------------------------------
// Demo presets and loading helpers
// -----------------------------------------------------------------------------

type WalkViewMode = 'first' | 'third';
type WalkDemoSchemeId = 'indoor' | 'outdoor';

/** Initial capsule center and camera angles. */
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
    staticSplatUrls?: readonly string[];
    lodMetaUrl?: string;
    voxelJson?: string;
    voxelBin?: string;
    pose: WalkDemoInitialPose;
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
    },
    outdoor: {
        id: 'outdoor',
        splatMode: 'lod',
        lodMetaUrl: `${WALK_OUTDOOR_URL_PREFIX}chunk-lod/0f9e3ae1/lod-meta.json`,
        staticSplatUrls: [`${WALK_OUTDOOR_URL_PREFIX}environment.d3e129aa.ply`],
        voxelJson: `${WALK_OUTDOOR_URL_PREFIX}voxel/309eccc1/collision.voxel-meta.json`,
        voxelBin: `${WALK_OUTDOOR_URL_PREFIX}voxel/309eccc1/collision.voxel.bin`,
        pose: WALK_DEMO_OUTDOOR_POSE,
    },
};

/** Outdoor juguo LOD stream cap (6M splats). */
const WALK_OUTDOOR_LOD_MAX_BUDGET = 6_000_000;

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
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

const WALK_OUTDOOR_LOD_CONFIG = {
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

function createWalkOutdoorLodResourceLoader(
    indexedDB: RuntimeIndexedDBStorage,
    metaBaseUrl: string,
    signal: AbortSignal,
) {
    return async (url: string) => {
        throwIfAborted(signal);
        const resourceUrl = new URL(url, metaBaseUrl).toString();
        const cached = await indexedDB.get<SerializedCompressedSplatData>(resourceUrl, { version: 0 });
        throwIfAborted(signal);
        if (cached) {
            const splatData = new CompressedSplatData();
            splatData.deserialize(cached);
            return splatData;
        }

        const fileType = detectSplatFileType(resourceUrl, new Uint8Array());
        if (fileType === undefined) {
            throw new Error(`[walk] Unsupported LOD resource: ${resourceUrl}`);
        }
        const splatData = await parseSplatData(fileType, resourceUrl, SplatPackType.Compressed);
        throwIfAborted(signal);
        await indexedDB.set(resourceUrl, splatData.serialize(), { version: 0 });
        return splatData;
    };
}

function isReloadAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function isWalkLodMeta(value: unknown): value is WalkLodMeta {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const meta = value as Partial<WalkLodMeta>;
    return meta.magicCode === LOD_MAGIC_CODE && meta.type === 'lod-splat';
}

// -----------------------------------------------------------------------------
// Render runtime entry and demo shell
// -----------------------------------------------------------------------------

export default async function runner(ctx: RenderRuntime): Promise<() => void> {
    const app = new WalkDemoApp(ctx);
    await app.run();
    return () => {
        app.dispose();
    };
}

/** Wires splats/LOD, collision, and walk mode on the render runtime. */
class WalkDemoApp {
    private readonly ctx: RenderRuntime;
    private params: {
        scheme: WalkDemoSchemeId;
        viewMode: WalkViewMode;
        thirdPersonCharacter: WalkThirdPersonCharacterId;
    };
    private scene: WalkDemoScene | undefined;
    private walk: ViewerWalkMode | undefined;
    private running = false;
    private reloadGeneration = 0;
    private reloadAbort: AbortController | undefined;
    private reloadChain: Promise<void> = Promise.resolve();
    private hideLoadingOnFrame = false;
    private restoredCamera: ReturnType<Viewer['getCamera']> | undefined;
    private thirdPersonCharacterBinding: { refresh(): void } | undefined;

    constructor(ctx: RenderRuntime) {
        this.ctx = ctx;
        this.params = {
            scheme: 'indoor',
            viewMode: 'third',
            thirdPersonCharacter: 'man',
        };
    }

    /** Mount UI, start the frame loop, and load the first scene. */
    async run(): Promise<void> {
        this.mountConfigPanel();
        /** Frame callback returns whether the runtime should render. */
        this.ctx.renderer.frame(({ delta }) => this.onFrame(delta));
        await this.queueReloadScene();
    }

    /** Build the small runtime control panel. */
    private mountConfigPanel(): void {
        if (!this.ctx.configPanel.available) {
            return;
        }
        const ui = getWalkDemoUiStrings();
        const pane = this.ctx.configPanel.createPane({ title: ui.paneTitle });
        pane.addBinding(this.params, 'scheme', {
            label: ui.schemeLabel,
            options: { [ui.schemeIndoor]: 'indoor', [ui.schemeOutdoor]: 'outdoor' },
        }).on('change', () => {
            this.params.thirdPersonCharacter = this.params.scheme === 'outdoor' ? 'robot' : 'man';
            this.thirdPersonCharacterBinding?.refresh();
            void this.queueReloadScene();
        });
        this.thirdPersonCharacterBinding = pane
            .addBinding(this.params, 'thirdPersonCharacter', {
                label: ui.characterLabel,
                options: { [ui.characterMan]: 'man', [ui.characterRobot]: 'robot' },
            })
            .on('change', () => {
                void this.swapThirdPersonCharacter();
            });
        pane.addBinding(this.params, 'viewMode', {
            label: ui.viewLabel,
            options: { [ui.first]: 'first', [ui.third]: 'third' },
        }).on('change', () => {
            const walk = this.walk;
            const scene = this.scene;
            if (!walk || !scene) {
                return;
            }
            this.applyViewMode(walk, scene);
            if (this.params.viewMode === 'third') {
                void this.swapThirdPersonCharacter();
            }
        });
    }

    /** Apply third-person camera distance for the current scene. */
    private applyThirdPersonCameraToWalk(walk: ViewerWalkMode, scheme: WalkDemoScheme): void {
        let tpDistance = THIRD_PERSON_CAMERA.distance;
        if (this.params.viewMode === 'third' && scheme.pose.thirdPersonDistance != null) {
            tpDistance = scheme.pose.thirdPersonDistance;
        }
        walk.setThirdPersonCamera(tpDistance, THIRD_PERSON_CAMERA.targetHeight, 0.8, Math.max(4, tpDistance));
    }

    /** Swap the avatar GLB without reloading splats or collision. */
    private async swapThirdPersonCharacter(): Promise<void> {
        const scene = this.scene;
        if (!scene) {
            return;
        }

        const scheme = WALK_DEMO_SCHEMES[this.params.scheme];
        scene.setThirdPersonModelUrl(WALK_THIRD_PERSON_CHARACTER_URLS[this.params.thirdPersonCharacter]);
        const walk = this.walk;
        if (walk) {
            this.applyThirdPersonCameraToWalk(walk, scheme);
        }

        if (this.params.viewMode !== 'third') {
            this.ctx.renderer.render();
            return;
        }

        this.ctx.loading.show();
        try {
            const signal = this.reloadAbort?.signal ?? this.ctx.signal;
            await scene.waitForThirdPersonCharacter(signal);
            if (walk) {
                this.applyViewMode(walk, scene);
            }
            this.ctx.renderer.render();
        } catch (error) {
            if (!isReloadAbortError(error) && !(error instanceof DOMException && error.name === 'AbortError')) {
                console.error('[walk] Third-person character load failed:', error);
            }
        } finally {
            if (this.running) {
                this.ctx.loading.hide();
            }
        }
    }

    /** Apply first-person or third-person mode to walk and scene state. */
    private applyViewMode(walk: ViewerWalkMode, scene: WalkDemoScene): void {
        const third = this.params.viewMode === 'third';
        walk.thirdPersonEnabled = third;
        walk.thirdPersonCameraPreset = this.params.scheme === 'outdoor' ? 'outdoor' : 'indoor';
        const indoorSpeed = third ? 1.35 : 2.7;
        walk.moveSpeed = this.params.scheme === 'outdoor' ? 2.15 : indoorSpeed;
        scene.setThirdPersonEnabled(third);
    }

    /** Serialize scene reloads so rapid UI changes do not overlap. */
    private queueReloadScene(): Promise<void> {
        this.reloadChain = this.reloadChain
            .then(() => this.reloadScene())
            .catch(error => {
                if (!isReloadAbortError(error)) {
                    console.error('[walk] Scene reload failed:', error);
                }
            });
        return this.reloadChain;
    }

    /** Update walk, avatar, camera, and LOD once per frame. */
    private onFrame(delta: number): boolean {
        if (!this.running) {
            return false;
        }
        const sceneLoop = this.scene;
        const walkLoop = this.walk;
        if (!sceneLoop || !walkLoop) {
            return false;
        }
        const scheme = WALK_DEMO_SCHEMES[this.params.scheme];
        walkLoop.update(delta);
        if (this.params.viewMode === 'third') {
            sceneLoop.updateThirdPersonCharacter(walkLoop.getCharacterState(), delta);
        }
        sceneLoop.updateCamera(walkLoop.getCameraState());
        if (scheme.splatMode === 'lod') {
            sceneLoop.tickLod();
        }

        if (this.hideLoadingOnFrame) {
            this.hideLoadingOnFrame = false;
            this.ctx.loading.hide();
        }
        return true;
    }

    /** Reload splats or LOD, avatar, walk mode, and voxel collision. */
    private async reloadScene(): Promise<void> {
        this.reloadAbort?.abort();
        this.reloadAbort = new AbortController();
        const reloadSignal = this.reloadAbort.signal;
        const generation = ++this.reloadGeneration;
        const scheme = WALK_DEMO_SCHEMES[this.params.scheme];

        this.running = false;
        this.walk?.disable();
        this.walk = undefined;
        this.scene?.dispose();
        this.scene = undefined;

        throwIfAborted(this.ctx.signal);
        throwIfAborted(reloadSignal);
        this.ctx.control.setOptions({ enabled: false });
        this.ctx.loading.show();

        const viewer = this.ctx.renderer.viewer;
        if (!this.restoredCamera) {
            this.restoredCamera = viewer.getCamera();
        }

        const scene = new WalkDemoScene(viewer);
        scene.setThirdPersonModelUrl(WALK_THIRD_PERSON_CHARACTER_URLS[this.params.thirdPersonCharacter]);
        this.scene = scene;
        this.ctx.renderer.resize();

        try {
            if (scheme.splatMode === 'lod') {
                if (!scheme.lodMetaUrl) {
                    throw new Error('[walk] Outdoor scheme is missing lodMetaUrl.');
                }
                const metaUrl = scheme.lodMetaUrl;
                const metaBaseUrl = new URL(
                    '.',
                    new URL(metaUrl, typeof location !== 'undefined' ? location.href : 'http://localhost/'),
                ).href;
                await scene.loadLodStream(
                    metaUrl,
                    reloadSignal,
                    createWalkOutdoorLodResourceLoader(this.ctx.indexedDB!, metaBaseUrl, reloadSignal),
                );
                if (generation !== this.reloadGeneration) {
                    scene.dispose();
                    return;
                }
                await scene.appendSplatUrls(scheme.staticSplatUrls ?? [], reloadSignal);
                if (generation !== this.reloadGeneration) {
                    scene.dispose();
                    return;
                }
            } else {
                await scene.loadSplatUrls(scheme.splatCandidates ?? [], reloadSignal);
            }

            if (generation !== this.reloadGeneration) {
                scene.dispose();
                return;
            }

            this.ctx.renderer.render();

            this.walk = new ViewerWalkMode(viewer.canvasContainer);
            const walk = this.walk;
            this.applyThirdPersonCameraToWalk(walk, scheme);
            this.applyViewMode(walk, scene);
            if (this.params.viewMode === 'third') {
                await scene.waitForThirdPersonCharacter(reloadSignal);
            }
            if (generation !== this.reloadGeneration) {
                return;
            }
            const p = scheme.pose;
            walk.startAtPose(new Vector3(p.px, p.py, p.pz), p.yaw, p.pitch);
            if (scheme.splatMode === 'lod') {
                scene.updateCamera(walk.getCameraState());
                scene.tickLod();
                this.ctx.renderer.render();
            }

            await this.tryLoadCollision(walk, scheme, reloadSignal);

            if (generation !== this.reloadGeneration) {
                return;
            }

            this.ctx.renderer.resize();
            this.running = true;
            this.hideLoadingOnFrame = true;
            throwIfAborted(reloadSignal);
        } catch (error) {
            if (isReloadAbortError(error) || generation !== this.reloadGeneration) {
                return;
            }
            if (scheme.splatMode === 'lod') {
                this.scene?.dispose();
                this.scene = undefined;
                console.error('[walk] Outdoor LOD reload failed:', error);
                return;
            }
            this.ctx.loading.hide();
            throw error;
        }
    }

    /** Load voxel collision data if the scene provides it. */
    private async tryLoadCollision(walk: ViewerWalkMode, scheme: WalkDemoScheme, signal: AbortSignal): Promise<void> {
        const jsonUrl = scheme.voxelJson;
        const binUrl = scheme.voxelBin;
        if (jsonUrl && binUrl) {
            const [jsonRes, binRes] = await Promise.all([fetch(jsonUrl, { signal }), fetch(binUrl, { signal })]);
            if (!jsonRes.ok || !binRes.ok) {
                console.warn(
                    `[walk] Voxel pair not OK (json ${jsonRes.status}, bin ${binRes.status}); walking without collision.`,
                );
                return;
            }
            throwIfAborted(signal);
            const metadataText = await jsonRes.text();
            throwIfAborted(signal);
            const metadata = JSON.parse(metadataText) as {
                gridBounds: { min: number[]; max: number[] };
                voxelResolution: number;
                leafSize: number;
                treeDepth: number;
                nodeCount: number;
                leafDataCount: number;
            };
            const binBuffer = await binRes.arrayBuffer();
            throwIfAborted(signal);
            const binBytes = new Uint8Array(binBuffer);
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

        console.warn('[walk] No voxel collision configured (set voxelJson+voxelBin); walking without collision.');
    }

    /** Stop walk mode and restore the original runtime camera. */
    dispose(): void {
        this.reloadAbort?.abort();
        this.reloadAbort = undefined;
        this.reloadGeneration += 1;
        this.running = false;
        this.walk?.disable();
        this.walk = undefined;
        this.scene?.dispose();
        this.scene = undefined;
        this.ctx.configPanel.clear();
        const cam = this.restoredCamera;
        this.restoredCamera = undefined;
        if (cam) {
            this.ctx.renderer.viewer.setCamera(cam);
        }
    }
}
