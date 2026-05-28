export {
    type Viewer,
    type Viewport,
    type IViewerContext,
    createViewerContext,
    Object3D,
    Scene3D,
    Camera as Camera3D,
    PerspectiveCamera,
    OrthographicCamera,
    type Light,
    AmbientLight,
    DirectionalLight,
    PointLight,
    SpotLight,
    BufferAttribute,
    InstancedBufferAttribute,
    BufferGeometry,
    FatLineBufferGeometry,
    type Material,
    PointsMaterial,
    LineBasicMaterial as LineMaterial,
    FatLineMaterial,
    Splat,
    Mesh,
    Sprite,
    Points,
    Line,
    LineSegments,
    FatLineSegments,
    InstanceMesh,
    WebGLDrawMode as DrawMode,
    WebGLTextureWrap as SamplerWrap,
    WebGLTextureFilter as SamplerFilter,
    Side,
    DepthModes,
    Blending,
    WebGLBlendingEquation as BlendingEquation,
    WebGLBlendingDst as BlendingFactor,
    WebGLStencilOp as StencilOp,
    WebGLStencilFunc as StencilFunc,
    Layers,
    type Intersection,
    Raycaster,
    TypeAssert,
    DrawableRenderMode,
    ToneMapping,
    FilterTarget,
    SplatState,
    BackgroundMode,

    // Math
    Box3,
    Color,
    type ReadonlyColor,
    Euler,
    Frustum,
    Matrix3,
    type ReadonlyMatrix3,
    Matrix4,
    type ReadonlyMatrix4,
    Plane,
    Quaternion,
    Ray,
    Sphere,
    Vector2,
    type ReadonlyVector2,
    Vector3,
    type ReadonlyVector3,
    Vector4,
    type ReadonlyVector4,
} from '@qunhe/egs';

export * as Events from './events.js';
export * as Animation from './animation.js';

export * as SplatLoader from './splat-loader.js';
export * as DracoLoader from './draco-loader.js';
export * as GLTFLoader from './gltf-loader.js';

export * as SplatUtils from './splat-utils.js';

import {
    Application,
    BackgroundMode,
    EngineInitializeConfig,
    Viewer,
    Viewport,
    Texture,
    ToneMapping,
    Vector3,
    Color,
    Vector4,
    setViewerConfig as originSetViewerConfig,
    MeshBasicMaterial as BaseMeshBasicMaterial,
    MeshPhongMaterial as BaseMeshPhongMaterial,
    SpriteMaterial as BaseSpriteMaterial,
    SourceTexture,
    TextureDimension,
    TextureViewDimension,
    TextureFormat,
    __INTERNAL__,
} from '@qunhe/egs';

import InstancedBufferGeometry = __INTERNAL__.InstancedBufferGeometry;
import CompressedSplat = __INTERNAL__.CompressedSplat;
import SuperCompressedSplat = __INTERNAL__.SuperCompressedSplat;
import SogSplat = __INTERNAL__.SogSplat;

export const MeshBasicMaterial = BaseMeshBasicMaterial<SourceTexture>;
export const MeshPhongMaterial = BaseMeshPhongMaterial<SourceTexture>;
export const SpriteMaterial = BaseSpriteMaterial<SourceTexture>;

export interface IBasicBackgroundConfig {
    color?: Color;
    alpha?: number;
    texture?: Texture | null;
}

export interface IEnvMapBackgroundConfig {
    texture?: Texture;
    luma?: number;
    verticalRotation?: number;
    horizonRotation?: number;
    reverseVertical?: boolean;
    reverseHorizon?: boolean;
}

export interface IGradientBackgroundConfig {
    skyColor?: Color;
    groundColor?: Color;
}

export interface ISkyBackgroundConfig {
    enablePreSkyMap?: boolean;
    luminance?: number;
    turbidity?: number;
    rayleigh?: number;
    mieCoefficient?: number;
    mieDirectionalG?: number;
}

export interface IBackgroundPluginConfig {
    /**
     * @default `true`
     */
    enabled?: boolean;
    /**
     * up for background rendering, will effect ground and background
     * @default `Vector3(0.0, 0.0, 1.0)`
     */
    up?: Vector3;
    ground?: {
        /**
         * enable ground grid
         * @default `true`
         */
        enabled?: boolean;
        /**
         * default ground grid size
         * @default `1000000`
         */
        gridSize?: number;
        /**
         * grid A gap
         * @default `500`
         */
        gridGapSizeA?: number;
        /**
         * grid A color
         * @default `Color(1.0, 1.0, 1.0)`
         */
        colorA?: Color;
        /**
         * grid A line width
         * @default `1`
         */
        lineWidthA?: number;
        /**
         * grid B gap
         * @default `5000`
         */
        gridGapSizeB?: number;
        /**
         * grid B color
         * @default `Color(1.0, 1.0, 1.0)`
         */
        colorB?: Color;
        /**
         * grid B line width
         * @default `1`
         */
        lineWidthB?: number;
        /**
         * enable ground color shading, by default will only render noise for ground.
         * @default `false`
         */
        isGroundColorEnabled?: boolean;
        /**
         * ground color
         * @default `Color(0.7, 0.7, 0.7)`
         */
        groundColor?: Color;
    };
    background?: {
        /**
         * @default `BackgroundMode.BasicBackground`
         */
        active?: BackgroundMode;
        /**
         * basic color and texture
         * active by `BackgroundMode.BasicBackground`
         */
        basic?: IBasicBackgroundConfig;
        /**
         * sphere envmap
         * active by `BackgroundMode.EnvMapBackground`
         */
        envmap?: IEnvMapBackgroundConfig;
        /**
         * sphere gradient
         * active by `BackgroundMode.GradientBackground`
         */
        gradient?: IGradientBackgroundConfig;
        /**
         * sky box
         * active by `BackgroundMode.SkyBackground`
         */
        sky?: ISkyBackgroundConfig;
    };
}

export interface ICompositePluginConfig {
    enabled?: boolean;
    multiSamplingEnabled?: boolean;
    staticFrameCacheEnabled?: boolean;
}

export interface ISplattingPluginConfig {
    enabled?: boolean;
    precalculateEnabled?: boolean;
    repackEnabled?: boolean;
    packHighPrecisionEnabled?: boolean;
    preBlurAmount?: number;
    blurAmount?: number;
    focalAdjustment?: number;
    maxStdDev?: number;
    maxPixelRadius?: number;
    detailCullingThreshold?: number;
    normalizedFalloff?: boolean;
    selectedColor?: Vector4;
    /**
     * gaussian sorting
     */
    sort?: {
        sortRadial?: boolean;
        sortMinDuration?: number;
        sortSplatDistance?: number;
        sortSplatCoorient?: number;
        sortCameraDistance?: number;
        sortCameraCoorient?: number;
    };
    /**
     * composite before output
     */
    composite?: {
        enabled?: boolean;
        highPrecisionAttachEnabled?: boolean;
    };
    /**
     * tone mapping functions
     */
    toneMapping?: {
        enabled?: boolean;
        toneMapping?: ToneMapping;
        exposure?: number;
    };
    /**
     * gaussian center highlight
     */
    highlightKernel?: {
        enabled?: boolean;
        size?: number;
        color?: number;
    };
}

export interface ITaaPluginConfig {
    /**
     * enabled static TAA
     * @default `true`
     */
    enabled?: boolean;
}

export interface IPipelineConfig {
    /**
     * background and ground
     */
    Background?: IBackgroundPluginConfig;
    /**
     * output Composite, used to optimize multi viewport rendering
     */
    Composite?: ICompositePluginConfig;
    /**
     * gaussian splatting
     */
    Splatting?: ISplattingPluginConfig;
    /**
     * static TAA
     */
    TAA?: ITaaPluginConfig;
}

export interface IViewerConfig {
    /**
     * pixel ratio used for rendering
     * @default `1.0`
     * @remarks
     * default the renderer will use physical pixel in rendering.
     * if `devicePixelRatio` is large on some device, will cause performance issue, could set it to `1 / devicePixelRatio`
     */
    pixelRatio?: number;
    /**
     * render pipeline config
     */
    pipeline?: IPipelineConfig;
}

async function loadImage(url: string, { crossOrigin = '' } = {}) {
    const image = document.createElement('img');
    if (!url.startsWith('data:')) {
        if (crossOrigin !== undefined) {
            image.crossOrigin = crossOrigin;
        }
    }
    image.src = url;
    await image.decode();

    return image;
}

export async function downloadTexture(url: string) {
    const image = await loadImage(url);
    return new SourceTexture(
        TextureDimension.D2,
        TextureViewDimension.D2,
        TextureFormat.Rgba8Unorm,
        image.width,
        image.height,
        1,
        true,
        true,
    ).setLevelLayerData(image, 0, 0);
}

export function createViewer(name: string, container: HTMLElement, config: EngineInitializeConfig) {
    return Application.getInstance().createViewer(name, container, config);
}

export function setViewerConfig(ctx: Viewer | Viewport, config: IViewerConfig) {
    const viewerConfig: import('@qunhe/egs/src/engine/EngineConfig').ConfigCellImpl<
        import('@qunhe/egs/src/engine/EngineConfig').ViewerConfig
    > = {};
    if (config.pixelRatio) {
        viewerConfig.canvas = {
            renderPixelRatio: config.pixelRatio,
        };
    }
    if (config.pipeline) {
        viewerConfig.effects = {
            __INTERNAL__: config.pipeline,
        };
    }
    originSetViewerConfig(viewerConfig, ctx.config);
}

export {
    TextureDimension,
    TextureViewDimension,
    TextureFormat,
    SourceTexture,
    InstancedBufferGeometry,
    CompressedSplat,
    SuperCompressedSplat,
    SogSplat,
};
