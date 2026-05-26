---
title: Playground
description: Usage guide for Playground.
order: 6
---

## Overview

[`Playground`](../../playground/) is a lightweight online editor for validating code with `@manycore/aholo-viewer` directly. The editor is built on [`monaco-editor`](https://github.com/microsoft/monaco-editor) and provides full `typescript` support with basic code completion.

![playground](../assets/playground/playground.en-US.jpeg)

## Usage

Basic code template:

```typescript
import { type Viewer } from '@manycore/aholo-viewer';
import type { RenderRuntime } from '../../client/render-runtime';

// typing of `RenderRuntime`
// interface RenderRuntime {
//     // core renderer
//     renderer: RuntimeRenderer;
//     // camera interaction controller
//     control: CameraControl;
//     // loading fame controller
//     loading: RuntimeLoadingController;
//     // a config panel component base on tweakpane
//     configPanel: RuntimeConfigPanel;
//     // indexed db cache storage
//     indexedDB: RuntimeIndexedDBStorage;
//     // abort signal dispatcher
//     signal: AbortSignal;
// }

export default async function runner({ renderer, control, loading, configPanel, indexedDB, signal }: RenderRuntime) {
    const const { scene, viewer } = renderer;
    // do work with scene & viewer
    // ....
    // use `throwIfAborted(signal)` to check whether abort requested
    // use `loading.show(info)` to update the loading to what ever you want to indicate which step is running

    // config frame call back, return a boolean to indicate whether anything updated
    renderer.frame(({ delta }) => {
        const cameraUpdated = control.update(delta);
        let animationUpdated = false;
        // update animation here...
        return cameraUpdated || animationUpdated;
    });

    // request next frame render
    renderer.render();
    // hide loading frame
    loading.hide();
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw new DOMException('The splatting basic sample load was aborted.', 'AbortError');
    }
}
```

In addition to the basic template, some [examples](../../examples/) can be opened from the button at the bottom of each example page or from the preset selector below `playground`. After editing, click **Run** to execute the code and view the result. Edited code can also be shared by copying the generated link directly.

## Notes

- `playground` currently does not support importing third-party libraries.
- To report issues related to `@manycore/aholo-viewer`, we recommend building a minimal reproduction in `playground` and submitting it with the [issue](https://github.com/manycoretech/aholo-viewer/issues).
