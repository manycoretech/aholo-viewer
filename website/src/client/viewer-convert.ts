import { SplatLoader, SplatUtils } from '@manycore/aholo-viewer';
import { fileSources, inspectSplatSource, SPLAT_EXTENSIONS, extension, type AssetSource } from './viewer-assets.js';
import type { ViewerLabels } from './viewer-labels.js';

export async function convertSplatSources(
    sources: AssetSource[],
    target: 'ply' | 'spz' | 'splat',
    signal: AbortSignal,
) {
    if (!sources.length) {
        throw new Error('No source files selected.');
    }
    const parsed: SplatLoader.SplatData[] = [];
    for (const source of sources) {
        signal.throwIfAborted();
        if (!SPLAT_EXTENSIONS.includes(extension(source.name))) {
            throw new Error(`Unsupported conversion input: ${source.name}`);
        }
        const input = await inspectSplatSource(source, signal);
        if ('lod' in input) {
            throw new Error('LOD manifests cannot be converted as a single file.');
        }
        parsed.push(
            await SplatLoader.parseSplatData(input.type, input.input, SplatLoader.SplatPackType.Raw, { signal }),
        );
    }
    signal.throwIfAborted();
    const data = parsed.length === 1 ? parsed[0] : SplatUtils.combineSplatData(parsed);
    const types = {
        ply: SplatLoader.SplatFileType.PLY,
        spz: SplatLoader.SplatFileType.SPZ,
        splat: SplatLoader.SplatFileType.SPLAT,
    };
    return SplatUtils.transformSplatFile(data, types[target]);
}

export function mountViewerConversion(root: HTMLElement, labels: ViewerLabels) {
    const input = root.querySelector<HTMLInputElement>('[data-convert-input]')!;
    const fileLabel = root.querySelector<HTMLElement>('[data-convert-files]')!;
    const target = root.querySelector<HTMLSelectElement>('[data-convert-target]')!;
    const button = root.querySelector<HTMLButtonElement>('[data-convert-save]')!;
    const cancel = root.querySelector<HTMLButtonElement>('[data-convert-cancel]')!;
    const status = root.querySelector<HTMLElement>('[data-convert-status]')!;
    let sources: AssetSource[] = [];
    let active: AbortController | undefined;
    let disposed = false;

    input.addEventListener('change', () => {
        sources = fileSources(Array.from(input.files ?? [], file => ({ file, path: file.name })));
        fileLabel.textContent =
            sources.length > 1
                ? labels.convertSelected.replace('{count}', String(sources.length))
                : sources[0]?.name || labels.chooseConvert;
        input.title = sources.map(source => source.name).join('\n') || labels.chooseConvert;
        button.disabled = !sources.length;
        status.textContent = '';
        input.value = '';
    });
    cancel.addEventListener('click', () => active?.abort());
    button.addEventListener('click', () => {
        void convert();
    });

    async function convert() {
        if (active) {
            return;
        }
        const controller = new AbortController();
        active = controller;
        const format = target.value as 'ply' | 'spz' | 'splat';
        button.disabled = true;
        input.disabled = true;
        target.disabled = true;
        cancel.hidden = false;
        status.dataset.state = 'loading';
        status.textContent = labels.converting;
        try {
            const stream = await convertSplatSources(sources, format, controller.signal);
            const chunks = new TransformStream<Uint8Array, Uint8Array>();
            const blob = new Response(chunks.readable).blob();
            const [, output] = await Promise.all([stream.pipeTo(chunks.writable, { signal: controller.signal }), blob]);
            controller.signal.throwIfAborted();
            if (disposed) {
                return;
            }
            const name = sources.length === 1 ? sources[0].name.replace(/\.[^.]+$/u, '') : 'merged';
            const url = URL.createObjectURL(output);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${name}.${format}`;
            link.click();
            // Keep the URL alive until the browser has accepted the download.
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            status.dataset.state = 'ready';
            status.textContent = labels.converted;
        } catch (error) {
            if (!disposed) {
                status.dataset.state = controller.signal.aborted ? 'ready' : 'error';
                if (controller.signal.aborted) {
                    status.textContent = '';
                } else {
                    status.textContent = error instanceof Error ? error.message : String(error);
                }
            }
        } finally {
            active = undefined;
            if (!disposed) {
                button.disabled = !sources.length;
                input.disabled = false;
                target.disabled = false;
                cancel.hidden = true;
            }
        }
    }

    return {
        dispose() {
            disposed = true;
            active?.abort();
        },
    };
}
