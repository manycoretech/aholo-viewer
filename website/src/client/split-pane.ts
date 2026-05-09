interface SplitPaneController {
    dispose(): void;
    getCollapsed(): boolean;
    getSize(): number;
    setCollapsed(collapsed: boolean, options?: SplitPaneUpdateOptions): void;
    setSize(value: number, options?: SplitPaneUpdateOptions): void;
}

interface SplitPaneUpdateOptions {
    persist?: boolean;
}

interface SplitPaneOptions {
    container: HTMLElement;
    splitter: HTMLElement;
    collapsedDatasetKey: string;
    cssProperty: string;
    defaultValue: number;
    valueUnit: 'px' | '%';
    keyboardStep: number;
    clampValue(value: number, rect: DOMRect): number;
    shouldCollapse(value: number, rect: DOMRect): boolean;
    expandKey?: 'ArrowLeft' | 'ArrowRight';
    getAriaValue?: (value: number, rect: DOMRect) => number;
    getInitialCollapsed?: () => boolean;
    isDisabled?: () => boolean;
    onChange?: () => void;
    onCollapsedChange?: (collapsed: boolean, options: Required<SplitPaneUpdateOptions>) => void;
    onValueChange?: (value: number, options: Required<SplitPaneUpdateOptions>) => void;
    pointerToValue?: (event: PointerEvent, rect: DOMRect) => number;
    toggleWhenDisabled?: boolean;
}

const DEFAULT_UPDATE_OPTIONS: Required<SplitPaneUpdateOptions> = {
    persist: true,
};

export function mountSplitPane(options: SplitPaneOptions): SplitPaneController {
    const {
        container,
        splitter,
        collapsedDatasetKey,
        cssProperty,
        defaultValue,
        valueUnit,
        keyboardStep,
        clampValue,
        shouldCollapse,
        expandKey = 'ArrowRight',
        getAriaValue = value => value,
        getInitialCollapsed = () => false,
        isDisabled = () => false,
        onChange,
        onCollapsedChange,
        onValueChange,
        pointerToValue = (event, rect) => event.clientX - rect.left,
        toggleWhenDisabled = false,
    } = options;
    const collapseKey = expandKey === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
    const resizeLabel = splitter.dataset.resizeLabel ?? splitter.getAttribute('aria-label') ?? 'Resize panes';
    const expandLabel = splitter.dataset.expandLabel ?? 'Expand pane';

    let activePointerId: number | undefined;
    let didDrag = false;
    let pointerStartX = 0;
    let collapsed = getInitialCollapsed();
    let value = defaultValue;

    setSize(value, { persist: false });
    setCollapsed(collapsed, { persist: false });

    splitter.addEventListener('pointerdown', handlePointerDown);
    splitter.addEventListener('pointermove', handlePointerMove);
    splitter.addEventListener('pointerup', endPointerResize);
    splitter.addEventListener('pointercancel', endPointerResize);
    splitter.addEventListener('click', handleClick);
    splitter.addEventListener('keydown', handleKeydown);

    return {
        dispose() {
            splitter.removeEventListener('pointerdown', handlePointerDown);
            splitter.removeEventListener('pointermove', handlePointerMove);
            splitter.removeEventListener('pointerup', endPointerResize);
            splitter.removeEventListener('pointercancel', endPointerResize);
            splitter.removeEventListener('click', handleClick);
            splitter.removeEventListener('keydown', handleKeydown);

            if (activePointerId !== undefined && splitter.hasPointerCapture(activePointerId)) {
                splitter.releasePointerCapture(activePointerId);
            }

            activePointerId = undefined;
            delete container.dataset.resizing;
        },
        getCollapsed() {
            return collapsed;
        },
        getSize() {
            return value;
        },
        setCollapsed,
        setSize,
    };

    function handlePointerDown(event: PointerEvent) {
        if (isDisabled()) {
            return;
        }

        activePointerId = event.pointerId;
        pointerStartX = event.clientX;
        didDrag = false;
        splitter.setPointerCapture(event.pointerId);
        container.dataset.resizing = 'true';
        updateFromPointer(event);
    }

    function handlePointerMove(event: PointerEvent) {
        if (activePointerId !== event.pointerId) {
            return;
        }

        didDrag = didDrag || Math.abs(event.clientX - pointerStartX) > 4;
        updateFromPointer(event);
    }

    function endPointerResize(event: PointerEvent) {
        if (activePointerId !== event.pointerId) {
            return;
        }

        if (splitter.hasPointerCapture(event.pointerId)) {
            splitter.releasePointerCapture(event.pointerId);
        }

        activePointerId = undefined;
        delete container.dataset.resizing;
    }

    function handleClick() {
        if (didDrag) {
            didDrag = false;
            return;
        }

        if (isDisabled()) {
            if (toggleWhenDisabled) {
                setCollapsed(!collapsed);
            }
            return;
        }

        if (collapsed) {
            setCollapsed(false);
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        if (isDisabled() || (event.key !== collapseKey && event.key !== expandKey)) {
            return;
        }

        event.preventDefault();

        if (collapsed) {
            if (event.key === expandKey) {
                setCollapsed(false);
            }
            return;
        }

        const direction = event.key === collapseKey ? -1 : 1;
        const nextValue = value + direction * keyboardStep;
        const rect = container.getBoundingClientRect();

        if (event.key === collapseKey && shouldCollapse(nextValue, rect)) {
            setCollapsed(true);
            return;
        }

        setSize(nextValue);
    }

    function updateFromPointer(event: PointerEvent) {
        const rect = container.getBoundingClientRect();
        const nextValue = pointerToValue(event, rect);

        if (shouldCollapse(nextValue, rect)) {
            setCollapsed(true);
            return;
        }

        setSize(nextValue);
    }

    function setCollapsed(nextCollapsed: boolean, updateOptions: SplitPaneUpdateOptions = {}) {
        const resolvedOptions = {
            ...DEFAULT_UPDATE_OPTIONS,
            ...updateOptions,
        };

        collapsed = nextCollapsed;

        if (!nextCollapsed) {
            applyValue(value);
        }

        syncSplitter();
        onCollapsedChange?.(nextCollapsed, resolvedOptions);
        onChange?.();
    }

    function setSize(nextValue: number, updateOptions: SplitPaneUpdateOptions = {}) {
        const resolvedOptions = {
            ...DEFAULT_UPDATE_OPTIONS,
            ...updateOptions,
        };
        const rect = container.getBoundingClientRect();

        value = clampValue(nextValue, rect);
        collapsed = false;
        applyValue(value);
        syncSplitter();
        onValueChange?.(value, resolvedOptions);
        onCollapsedChange?.(false, resolvedOptions);
        onChange?.();
    }

    function applyValue(nextValue: number) {
        container.style.setProperty(cssProperty, `${nextValue}${valueUnit}`);
    }

    function syncSplitter() {
        container.dataset[collapsedDatasetKey] = String(collapsed);
        splitter.setAttribute('aria-expanded', String(!collapsed));
        splitter.setAttribute('aria-label', collapsed ? expandLabel : resizeLabel);

        const ariaValue = collapsed ? 0 : Math.round(getAriaValue(value, container.getBoundingClientRect()));
        splitter.setAttribute('aria-valuenow', String(ariaValue));
    }
}
