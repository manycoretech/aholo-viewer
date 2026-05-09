const GUIDE_SELECTOR = '[data-interaction-guide]';
const MIN_TRIGGER_DISTANCE = 88;
const MAX_TRIGGER_DISTANCE = 152;
const TRIGGER_HEIGHT_RATIO = 0.24;
const TOUCH_HIDE_DELAY = 1800;

export function mountInteractionGuides(root: ParentNode = document) {
    for (const guide of root.querySelectorAll<HTMLElement>(GUIDE_SELECTOR)) {
        mountInteractionGuide(guide);
    }
}

function mountInteractionGuide(guide: HTMLElement) {
    if (guide.dataset.mounted === 'true') {
        return;
    }

    const surface = guide.parentElement;

    if (!surface) {
        return;
    }

    const surfaceElement = surface;

    guide.dataset.mounted = 'true';

    let hideTimer: number | undefined;
    const stateObserver = new MutationObserver(() => {
        if (!isEnabled()) {
            hide();
        }
    });

    surfaceElement.addEventListener('pointermove', handlePointerMove);
    surfaceElement.addEventListener('pointerleave', hide);
    surfaceElement.addEventListener('pointercancel', hide);
    window.addEventListener('blur', hide);
    document.addEventListener('astro:before-swap', dispose, { once: true });

    if (guide.dataset.activeWhen === 'interactive') {
        stateObserver.observe(surfaceElement, {
            attributes: true,
            attributeFilter: ['data-interactive'],
        });
    }

    function handlePointerMove(event: PointerEvent) {
        window.clearTimeout(hideTimer);

        if (!isEnabled()) {
            hide();
            return;
        }

        const rect = surfaceElement.getBoundingClientRect();
        const triggerDistance = clamp(rect.height * TRIGGER_HEIGHT_RATIO, MIN_TRIGGER_DISTANCE, MAX_TRIGGER_DISTANCE);
        const insideHorizontal = event.clientX >= rect.left && event.clientX <= rect.right;
        const nearBottom =
            insideHorizontal && event.clientY >= rect.bottom - triggerDistance && event.clientY <= rect.bottom;

        if (nearBottom) {
            show();

            if (event.pointerType === 'touch') {
                hideTimer = window.setTimeout(hide, TOUCH_HIDE_DELAY);
            }
        } else {
            hide();
        }
    }

    function isEnabled() {
        return guide.dataset.activeWhen !== 'interactive' || surfaceElement.dataset.interactive === 'true';
    }

    function show() {
        guide.dataset.visible = 'true';
    }

    function hide() {
        window.clearTimeout(hideTimer);
        hideTimer = undefined;
        delete guide.dataset.visible;
    }

    function dispose() {
        hide();
        surfaceElement.removeEventListener('pointermove', handlePointerMove);
        surfaceElement.removeEventListener('pointerleave', hide);
        surfaceElement.removeEventListener('pointercancel', hide);
        window.removeEventListener('blur', hide);
        stateObserver.disconnect();
        delete guide.dataset.mounted;
    }
}

function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(Math.max(value, minimum), maximum);
}
