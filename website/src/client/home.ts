import { createRenderSession } from './render-runtime';

const HOME_INTERACTION_ENTER_EVENT = 'aholo:home-interaction-enter';

interface HomeStageConfig {
    code: string;
}

export function mountHomeStage(stage: HTMLElement, config: HomeStageConfig) {
    if (stage.dataset.mounted === 'true') {
        return;
    }

    const canvas = stage.querySelector<HTMLCanvasElement>('[data-home-preview]');
    const enterButton = stage.querySelector<HTMLButtonElement>('[data-home-enter]');
    const exitButton = stage.querySelector<HTMLButtonElement>('[data-home-exit]');

    if (!canvas) {
        return;
    }

    const previewCanvas = canvas;
    stage.dataset.mounted = 'true';

    let previewTiltX = 0;
    let previewTiltY = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragBaseX = 0;
    let dragBaseY = 0;
    let dragging = false;
    let renderSession: Awaited<ReturnType<typeof createRenderSession>> | undefined;
    let renderVersion = 0;
    let transitionTimer: number | undefined;
    let resizeFrame: number | undefined;
    let disposed = false;

    renderHomePreview();
    setHomeInteractive(false);

    enterButton?.addEventListener('click', handleEnter);
    exitButton?.addEventListener('click', handleExit);
    document.addEventListener('keydown', handleKeydown);
    previewCanvas.addEventListener('pointerdown', handlePointerDown);
    previewCanvas.addEventListener('pointermove', handlePointerMove);
    previewCanvas.addEventListener('pointerup', handlePointerUp);
    previewCanvas.addEventListener('pointercancel', handlePointerCancel);

    const themeObserver = new MutationObserver(() => {
        renderHomePreview();
    });
    themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    });

    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('resize', schedulePreviewResize);
    document.addEventListener('astro:before-swap', dispose, { once: true });

    async function renderHomePreview() {
        const version = renderVersion + 1;
        renderVersion = version;
        renderSession?.dispose();
        renderSession = undefined;

        try {
            const session = await createRenderSession(previewCanvas, config.code, readThemeAccent());

            if (disposed || version !== renderVersion) {
                session.dispose();
                return;
            }

            renderSession = session;
        } catch (error) {
            console.error(error);
        }
    }

    function handleEnter() {
        setHomeInteractive(true, { animate: true });
        document.dispatchEvent(new Event(HOME_INTERACTION_ENTER_EVENT));
    }

    function handleExit() {
        setHomeInteractive(false);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && stage.dataset.interactive === 'true') {
            setHomeInteractive(false);
        }
    }

    function handlePointerDown(event: PointerEvent) {
        if (stage.dataset.interactive !== 'true') {
            return;
        }

        dragging = true;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        dragBaseX = previewTiltX;
        dragBaseY = previewTiltY;
        previewCanvas.setPointerCapture(event.pointerId);
    }

    function handlePointerMove(event: PointerEvent) {
        if (!dragging) {
            return;
        }

        previewTiltY = clamp(dragBaseY + (event.clientX - dragStartX) * 0.04, -10, 10);
        previewTiltX = clamp(dragBaseX - (event.clientY - dragStartY) * 0.035, -7, 7);
        stage.style.setProperty('--home-tilt-x', `${previewTiltX}deg`);
        stage.style.setProperty('--home-tilt-y', `${previewTiltY}deg`);
    }

    function handlePointerUp(event: PointerEvent) {
        dragging = false;

        if (previewCanvas.hasPointerCapture(event.pointerId)) {
            previewCanvas.releasePointerCapture(event.pointerId);
        }
    }

    function handlePointerCancel() {
        dragging = false;
    }

    function handlePageShow(event: PageTransitionEvent) {
        if (event.persisted) {
            schedulePreviewResize();
        }
    }

    function schedulePreviewResize() {
        if (resizeFrame !== undefined) {
            window.cancelAnimationFrame(resizeFrame);
        }

        resizeFrame = window.requestAnimationFrame(() => {
            resizeFrame = undefined;
            renderSession?.resize();
        });
    }

    function dispose() {
        if (disposed) {
            return;
        }

        disposed = true;
        renderVersion += 1;
        window.clearTimeout(transitionTimer);

        if (resizeFrame !== undefined) {
            window.cancelAnimationFrame(resizeFrame);
            resizeFrame = undefined;
        }

        setHomeInteractive(false, { resize: false });
        enterButton?.removeEventListener('click', handleEnter);
        exitButton?.removeEventListener('click', handleExit);
        document.removeEventListener('keydown', handleKeydown);
        previewCanvas.removeEventListener('pointerdown', handlePointerDown);
        previewCanvas.removeEventListener('pointermove', handlePointerMove);
        previewCanvas.removeEventListener('pointerup', handlePointerUp);
        previewCanvas.removeEventListener('pointercancel', handlePointerCancel);
        window.removeEventListener('pageshow', handlePageShow);
        window.removeEventListener('resize', schedulePreviewResize);
        document.removeEventListener('astro:before-swap', dispose);
        themeObserver.disconnect();
        renderSession?.dispose();
        renderSession = undefined;
        delete stage.dataset.mounted;
    }

    function readThemeAccent() {
        return getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#0d9488';
    }

    function setHomeInteractive(interactive: boolean, options: { animate?: boolean; resize?: boolean } = {}) {
        window.clearTimeout(transitionTimer);

        if (interactive && options.animate) {
            stage.dataset.transition = 'enter';
            transitionTimer = window.setTimeout(() => {
                if (stage.dataset.transition === 'enter') {
                    delete stage.dataset.transition;
                }
            }, 860);
        } else {
            delete stage.dataset.transition;
        }

        stage.dataset.interactive = interactive ? 'true' : 'false';
        document.documentElement.classList.toggle('home-interactive', interactive);
        document.body.classList.toggle('home-interactive', interactive);
        enterButton?.setAttribute('aria-expanded', interactive ? 'true' : 'false');

        if (exitButton) {
            exitButton.hidden = !interactive;
        }

        if (options.resize !== false) {
            schedulePreviewResize();
        }
    }
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}
