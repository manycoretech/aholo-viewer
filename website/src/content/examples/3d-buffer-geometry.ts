import type { RenderRuntime } from '../../client/render-runtime';
import {
    AmbientLight,
    BufferAttribute,
    BufferGeometry,
    downloadTexture,
    Mesh,
    MeshPhongMaterial,
    PerspectiveCamera,
    Side,
    Vector3,
} from '@manycore/aholo-viewer';

const TEXTURE_BASE_URL = 'https://holo-cos.aholo3d.cn/aholo-opensource/page/texture/';
const TEXTURE_URLS = [`${TEXTURE_BASE_URL}grasslight-big.e8cc62ea.jpg`, `${TEXTURE_BASE_URL}lavatile.52fa1c03.jpg`];

export default async function runner({ renderer, loading, signal }: RenderRuntime) {
    const { scene, viewer } = renderer;
    const camera = viewer.getCamera() as PerspectiveCamera;
    camera.up.set(0, 0, 1);
    camera.position.set(10, 10, 10);
    camera.lookAt(new Vector3(0, 0, 0));
    scene.add(new AmbientLight(0xffffff, 1));

    loading.show('Loading textures');
    const textures = await Promise.all(TEXTURE_URLS.map(url => downloadTexture(url)));
    if (signal.aborted) {
        throw new DOMException('The 3D buffer geometry sample load was aborted.', 'AbortError');
    }

    const meshes = textures.map(
        texture => new Mesh(createGeometry(), new MeshPhongMaterial({ texture, side: Side.DoubleSide })),
    );
    scene.add(meshes);

    loading.hide();
    renderer.frame(({ time }) => {
        const elapsedSec = time * 0.001;
        meshes.forEach(mesh => {
            mesh.rotation.z = elapsedSec / 4;
        });
        return true;
    });

    return () => {
        scene.removeAllChildren();
        meshes.forEach(m => m.freeAllGpuResourceOwned());
    };
}

const TRIANGLE_COUNT = 4000;
const FIELD_SIZE = 10;
const TRIANGLE_SIZE = 0.4;
const randomOffset = (span: number) => (Math.random() - 0.5) * span;
function createGeometry() {
    const positions = new Float32Array(TRIANGLE_COUNT * 9);
    const normals = new Float32Array(TRIANGLE_COUNT * 9);
    const uvs = new Float32Array(TRIANGLE_COUNT * 6);
    for (let i = 0; i < TRIANGLE_COUNT; i++) {
        const cx = randomOffset(FIELD_SIZE);
        const cy = randomOffset(FIELD_SIZE);
        const cz = randomOffset(FIELD_SIZE);
        for (let j = 0; j < 3; j++) {
            const x = cx + randomOffset(TRIANGLE_SIZE);
            const y = cy + randomOffset(TRIANGLE_SIZE);
            const z = cz + randomOffset(TRIANGLE_SIZE);
            positions[i * 9 + j * 3 + 0] = x;
            positions[i * 9 + j * 3 + 1] = y;
            positions[i * 9 + j * 3 + 2] = z;
            normals[i * 9 + j * 3 + 0] = x;
            normals[i * 9 + j * 3 + 1] = y;
            normals[i * 9 + j * 3 + 2] = z;
        }

        uvs[i * 6 + 2] = 0.5;
        uvs[i * 6 + 3] = 1;
        uvs[i * 6 + 4] = 1;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    return geometry;
}
