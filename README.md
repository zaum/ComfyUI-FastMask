# ComfyUI-FastMask

A very fast, custom-built mask editor for ComfyUI – an alternative to the built-in MaskEditor, with a completely new, performance-focused architecture.

![status](https://img.shields.io/badge/version-1.6.4-blue) ![status](https://img.shields.io/badge/status-beta-orange)

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/zaum/ComfyUI-FastMask
```

After restarting ComfyUI, look for the **`FastMask Editor`** node in the `mask` category.

## Usage

The node is also an **image loader** (just like the built-in LoadImage):

1. Select an image from the ComfyUI input folder in the node's `image` dropdown, or upload an image directly onto the node (using the built-in **upload** button). Alternatively, you can connect an image to the **`image_opt`** input (e.g. from a LoadImage output) – a connected image overrides the dropdown selection.
2. Open the full-screen editor with the **Edit Mask** button on the node.
3. Paint, then press **OK** – the mask is saved at full resolution into the `ComfyUI/input/fastmask/` folder; when you reopen the editor, the previous mask is **restored** and you can keep editing it.
4. In addition to the mask, the OK button also generates and uploads a **composite preview image** (image + vivid mask, max. 1024 px, JPEG). This is displayed **permanently** on the node preview – no need to hover the mouse, and it refreshes automatically after every OK.
5. The node has two outputs: `IMAGE` (the loaded image) and `MASK` (1.0 = masked area).

## Features

| Feature | Command |
|---|---|
| Painting (round brush) | Hold the **left mouse button** |
| Erasing | Hold the **right mouse button** |
| Brush size | **Ctrl + drag up/down**, **Ctrl + mouse wheel**, `[` / `]`, or the slider |
| Mask blur | **Ctrl + drag left/right** or the **Blur** slider – the mask edge softens in real time in the black-and-white view. Default: 0% (no blur) |
| Ctrl + drag direction selection | After a 20 px deadzone the drag locks to the dominant axis: **vertical = size**, **horizontal = blur** – values never "jump" when switching |
| Brush visual indicator | With blur > 0 a dashed, concentric inner circle shows the blur amount (at 0% only the outer circle is visible); while moving the sliders, the brush preview appears at the center of the canvas |
| Paint/Erase mode switch | `X` or the Paint/Erase toggle (blue in both states) |
| Zoom | **Mouse wheel** (anchored to the cursor) |
| Pan | **Middle button drag** or hold **Space** |
| Closed-shape auto-fill | On by default – the interior of a closed outline fills in automatically; toggle: `F` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z` (mac: `⌘`) |
| Clear all | `Ctrl+Delete` or button |
| Show mask (black & white) | **Hovering** the button already shows a preview; **clicking** pins the view – editing still works while pinned |
| Hatch color | `C` or the button → color picker |
| Fit / whole image | `Ctrl+0` |
| OK / Cancel | `Enter` / `Esc` (both buttons have the same width) |

Every button **shows its own keyboard shortcut on hover**. On mac, `⌘` is displayed instead of `Ctrl`. After releasing a slider, the canvas is automatically fully repainted (no stale artifacts), and the brush preview disappears immediately.

## Why is it faster than the built-in MaskEditor?

The built-in editor re-renders a large area on every mouse move, stores full-image snapshots for undo, and copies mask data in JS arrays. FastMask uses a completely different architecture:

- **Offscreen 2D canvas for the mask** – painting is done with native, GPU-accelerated canvas strokes; a single brush stroke does not create any JS objects.
- **Dirty-rectangle rendering** – every frame redraws only the affected rectangles, never the whole image. The "halo" of a blurred brush is accounted for in both the dirty rect and the undo tiles, so soft edges always refresh instantly.
- **A single `requestAnimationFrame` loop** that only draws when something changed (no continuous redrawing).
- **Preview resolution + full-res export** – on large images, editing happens on a 2048 px preview; the final mask is produced at the **full original resolution** (at OK: a single `drawImage` + `getImageData` with scaling, as a `Uint8Array`/`ImageData`).
- **Zoom/pan = pure CSS transform** – zero-cost navigation, even at 32× magnification.
- **Tile-based undo/redo** – instead of copying whole images, it only snapshots the 256×256 tiles actually touched by the stroke (lazy snapshots, max. 40 steps).
- **Closed-shape filling** – a closed outline detected from the stroke endpoints is filled with a single `evenodd` scanline fill via a temp canvas.
- **Real-time mask blur** – the **Blur** slider (0–100%) softens the mask edges with a Gaussian blur, tracked live in the black-and-white view while editing, and preserved in the full-res export as well.
- **Cheap node preview** – the node's composite (image + mask) is a small, pre-generated JPEG; the frontend only **displays** it (no runtime pixel manipulation, no timer-based re-rendering), it scales with the workspace zoom without distortion, always preserving the aspect ratio.

## SAM segmentation – planned extension (not implemented)

The plan is to add fast, simple SAM segmentation later:

- **Model:** MobileSAM or FastSAM (in ONNX form) running in the browser via **onnxruntime-web with a WebGPU backend** (WASM fallback if WebGPU is unavailable). This avoids occupying a server-side GPU and adds no extra ComfyUI dependency.
- **Operation:** from the cursor position over the object (box + point prompt), the model returns an embedding-based mask in ~50–100 ms; the live preview would appear on the same overlay channel as the hatch.
- **Activation:** hold `Shift` (occasional use), **Caps Lock** (continuous mode), or a UI toggle. You would accept the offered mask with a click / `Enter`, and it would be composited into the mask layer immediately.
- **Speed:** the image embedding would be computed only once per image/zoom change (cached), point prompts only run the lightweight mask decoder – that's what makes it interactive.

This feature is currently **not part** of the package; the above is the planned architecture.

## Compatibility

- ComfyUI frontend (latest), Windows / Linux / macOS
- Saving uses the standard ComfyUI `/upload/image` API – no extra server-side component is required.

## License

MIT
