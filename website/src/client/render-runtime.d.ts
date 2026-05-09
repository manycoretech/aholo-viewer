import type { Scene3D, Viewer } from '@manycore/aholo-viewer';
import type { Pane } from 'tweakpane';
import type { CameraControl } from './camera-control';

export interface RuntimeRenderer {
    readonly viewer: Viewer;
    readonly scene: Scene3D;
    frame(callback: (state: { time: number; delta: number }) => boolean): void;
    render(): void;
    resize(): void;
}

export interface RuntimeLoadingController {
    show(label?: string): void;
    hide(): void;
}

interface RuntimeConfigPaneOptions {
    expanded?: boolean;
    title?: string;
}

export interface RuntimeConfigPanel {
    readonly available: boolean;
    readonly container: HTMLElement;
    createPane(options?: RuntimeConfigPaneOptions): Pane;
    clear(): void;
    hide(): void;
    show(): void;
}

interface RuntimeIndexedDBSetOptions {
    version?: number;
}

interface RuntimeIndexedDBGetOptions {
    version?: number;
}

export interface RuntimeIndexedDBStorage {
    readonly available: boolean;
    get<T>(key: string, options?: RuntimeIndexedDBGetOptions): Promise<T | undefined>;
    set<T>(key: string, value: T, options?: RuntimeIndexedDBSetOptions): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
}

export interface RenderRuntime {
    renderer: RuntimeRenderer;
    control: CameraControl;
    loading: RuntimeLoadingController;
    configPanel: RuntimeConfigPanel;
    indexedDB: RuntimeIndexedDBStorage;
    signal: AbortSignal;
}
