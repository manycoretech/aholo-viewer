import {
    BufferAttribute,
    BufferGeometry,
    DirectionalLight,
    downloadTexture,
    Mesh,
    MeshBasicMaterial,
    MeshPhongMaterial,
    PerspectiveCamera,
    PointLight,
    Vector3,
} from '@manycore/aholo-viewer';
import type { RenderRuntime } from '../../client/render-runtime';

const FLOOR_TEXTURE_URL = 'https://holo-cos.aholo3d.cn/aholo-opensource/page/texture/disturb.76f1cbca.jpg';

export default async function runner({ renderer, control, loading, signal }: RenderRuntime) {
    const { scene, viewer } = renderer;
    const camera = viewer.getCamera() as PerspectiveCamera;
    camera.near = 100;
    camera.far = 1_000_000;
    camera.updateProjectionMatrix();

    loading.show('Loading floor texture');
    const floorTexture = await downloadTexture(FLOOR_TEXTURE_URL);
    throwIfAborted(signal);

    const directionalLight = new DirectionalLight(0xffffff, 0.2);
    const floorGeometry = createPlaneGeometry(FLOOR_SIZE);
    const floorMaterial = new MeshPhongMaterial({
        specular: 0xffffff,
        shininess: 500,
        texture: floorTexture as never,
    });

    const floor = new Mesh(floorGeometry, floorMaterial);
    floor.position.set(0, 0, -2000);

    const bulbGeometry = createSphereGeometry(300);
    const bulbMaterials = LIGHT_COLORS.map(color => new MeshBasicMaterial({ color }));
    const pointLights = LIGHT_COLORS.map((color, i) => {
        const light = new PointLight(color, 2.5, 30000, 1);
        light.add(new Mesh(bulbGeometry, bulbMaterials[i]!));
        return light;
    });

    const geometry = createTorusGeometry(500, 150);
    const material = new MeshPhongMaterial({ specular: 0xffffff, shininess: 100 });
    const meshList = Array.from({ length: OBJECT_COUNT }, () => {
        const mesh = new Mesh(geometry, material);
        mesh.position.set(randSigned(100000), randSigned(100000), rand(2000, 20000));
        mesh.rotation.set(rand(0, Math.PI), rand(0, Math.PI), 0);
        return mesh;
    });

    const sceneObjects = [directionalLight, floor, ...pointLights, ...meshList];
    scene.add(sceneObjects);

    camera.up.set(0, 0, 1);
    camera.position.set(0, 0, 100000);
    camera.lookAt(new Vector3(20000, 20000, 0));
    camera.updateMatrixWorld(true);
    control.setOptions({ enabled: false });

    loading.hide();

    /** Same driver as other previews: frame callback returns whether to render; adapter calls `viewer.render()` once. */
    renderer.frame(({ time }) => {
        const elapsedSec = time * 0.001;
        pointLights.forEach((light, i) => {
            const phase = (i / pointLights.length) * Math.PI;
            const radius = Math.sin(elapsedSec * 0.2 + phase) * 80000;
            light.position.set(Math.cos(phase) * radius, Math.sin(phase) * radius, 0);
        });
        return true;
    });

    renderer.render();

    return () => {
        scene.removeObjects(sceneObjects);
        pointLights.flatMap(light => light.removeAllChildren()).forEach(child => child.destroy());

        for (const object of sceneObjects) object.destroy();
        for (const resource of [
            floorGeometry,
            floorMaterial,
            bulbGeometry,
            ...bulbMaterials,
            geometry,
            material,
            floorTexture,
        ]) {
            resource.destroy();
        }
    };
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw new DOMException('The 3D point light sample load was aborted.', 'AbortError');
    }
}

const TAU = Math.PI * 2;
const FLOOR_SIZE = 200000;
const OBJECT_COUNT = 3000;
const LIGHT_COLORS = [0xff0040, 0x0040ff, 0x80ff80, 0xffaa00, 0x00ffaa, 0xff1100];

function rand(min: number, max: number) {
    return min + Math.random() * (max - min);
}

const randSigned = (limit: number) => rand(-limit, limit);

function createSurfaceGeometry(
    widthSegments: number,
    heightSegments: number,
    sample: (u: number, v: number) => [number, number, number, number, number, number],
): BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let y = 0; y <= heightSegments; y++) {
        for (let x = 0; x <= widthSegments; x++) {
            const u = x / widthSegments;
            const v = y / heightSegments;
            const [px, py, pz, nx, ny, nz] = sample(u, v);
            positions.push(px, py, pz);
            normals.push(nx, ny, nz);
            uvs.push(u, 1 - v);
        }
    }

    const row = widthSegments + 1;
    for (let y = 0; y < heightSegments; y++) {
        for (let x = 0; x < widthSegments; x++) {
            const a = x + row * y;
            const b = a + row;
            indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
    }

    const geometry = new BufferGeometry();
    geometry.setIndex(indices);
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geometry.computeBoundingSphere();
    return geometry;
}

function createPlaneGeometry(size: number) {
    return createSurfaceGeometry(1, 1, (u, v) => [(u - 0.5) * size, (0.5 - v) * size, 0, 0, 0, 1]);
}

function createSphereGeometry(radius: number, segments = 18) {
    return createSurfaceGeometry(segments, segments, (u, v) => {
        const phi = u * TAU;
        const theta = v * Math.PI;
        const sinTheta = Math.sin(theta);
        const x = -Math.cos(phi) * sinTheta;
        const y = Math.cos(theta);
        const z = Math.sin(phi) * sinTheta;
        return [x * radius, y * radius, z * radius, x, y, z];
    });
}

function createTorusGeometry(radius: number, tube: number, segments = 18) {
    return createSurfaceGeometry(segments, segments, (u, v) => {
        const phi = u * TAU;
        const theta = -v * TAU;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);
        const cosTheta = Math.cos(theta);
        const sinTheta = Math.sin(theta);
        const nx = cosTheta * cosPhi;
        const ny = cosTheta * sinPhi;
        return [
            (radius + tube * cosTheta) * cosPhi,
            (radius + tube * cosTheta) * sinPhi,
            tube * sinTheta,
            nx,
            ny,
            sinTheta,
        ];
    });
}
