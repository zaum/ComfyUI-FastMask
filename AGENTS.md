# AGENTS.md — agent / coding guidelines for the FastMask repository

## Project

FastMask is a fast custom mask editor node for ComfyUI (custom node, Python backend
in `nodes.py` / `__init__.py`, frontend extension in `web/js/fastmask_ui.js`).

## All user-facing text and code comments must be in English

- Every string shown in the UI (button labels, tooltips, status bar, toasts, errors)
  MUST be written in English.
- Every comment in the source code (JS, Python, Markdown) MUST be written in English.
- Never mix Hungarian (or any other language) text into the code or the UI.
- Console log messages are diagnostics, but keep them in English too.

## Serving the frontend extension (cache-safe pattern — do not regress)

The ComfyUI Desktop (Electron) app aggressively caches extension JS files. The
following pattern was required to make updates actually reach the browser and
MUST be kept:

1. **Absolute import paths.** The extension lives under
   `/extensions/ComfyUI-FastMask/js/`, so imports must be absolute:

   ```js
   import { app } from "/scripts/app.js";
   import { api } from "/scripts/api.js";
   ```

   Relative paths like `../../scripts/app.js` resolve to
   `/extensions/scripts/...` (404) and the module fails to load silently.
2. **`no-store` middleware.** `__init__.py` installs an aiohttp middleware that
   adds `Cache-Control: no-store, must-revalidate` to every response under
   `/extensions/ComfyUI-FastMask`, so the browser never caches the JS.
3. **Version marker in the UI.** `FM_VERSION` in `fastmask_ui.js` is rendered on
   the node's open button (e.g. `FastMask Editor v1.1.1`), so the actually
   running frontend version is visible at a glance.
4. **The open button must be a DOM widget with a REAL element body.** The only
   button mechanism proven to work in this frontend (frontend v1.49.6) is the
   same one the working `one-node-flux-2-klein` node uses: pass an actual
   `HTMLElement` as the **third argument** of `addDOMWidget`:

   ```js
   const el = makeOpenButtonEl(node); // a real <button> with click listeners
   node.addDOMWidget("fm_open", "div", el, {
     getValue() { return null; },
     setValue() {},
     serialize: false,
     computeSize() { return [-1, 34]; },
   });
   ```

   Pitfalls that do NOT work here (all tested):

   - `node.addWidget("button", ...)` canvas widget → click never fires.
   - `addDOMWidget(name, "button", callback, ...)` → WRONG signature: the
     third argument is the element, not a callback; the frontend then draws a
     static, non-clickable oval snapshot on the canvas.
5. **Deployment for local testing** — the live ComfyUI Desktop instance loads
   the node from ONE location only (a plain copy, not a junction):

   - `C:\Users\peter\Documents\ComfyUI\custom_nodes\ComfyUI-FastMask`

   Verified 2026-09-04: the `ComfyUI-Installs\...\custom_nodes` folder holds
   only stock files (no user nodes), while `Documents\ComfyUI\custom_nodes`
   holds all ~60 custom nodes; `extra_model_paths.yaml` maps `custom_nodes`
   to the Documents folder; and the Desktop `app.log` loads FastMask from
   `Documents\ComfyUI\custom_nodes\ComfyUI-FastMask`. A stale second copy
   under `ComfyUI-Installs\...\custom_nodes\ComfyUI-FastMask` was deleted —
   do NOT re-create it (a duplicate copy risks double registration).

   **MANDATORY: after EVERY fix/change** copy the repo to the live folder so
   the running instance actually uses the new code. From the project root run:

   ```powershell
   robocopy "I:\APPLICATIONS\Comfy Mask Editor\fastmask" "C:\Users\peter\Documents\ComfyUI\custom_nodes\ComfyUI-FastMask" /MIR /XD .git __pycache__ /XF *.pyc
   ```

   (Robocopy exit codes 0–7 are SUCCESS; 8+ means real errors. Only `__pycache__`
   exclusion matters for stale pyc files.)

   Then reload the ComfyUI frontend (F5) so the cache-safe `no-store` middleware
   serves the updated `fastmask_ui.js`.

   **IMPORTANT — Python (`nodes.py` / `__init__.py`) changes need a SERVER
   RESTART (or "Refresh Custom Nodes" in the UI).** Pressing F5 only reloads the
   frontend JS; it does NOT reload the Python backend. If a `nodes.py` fix "does
   not take effect", the old Python is still running — restart ComfyUI.

## Manual verification workflow (run after every change)

After copying + restarting, verify the node end-to-end. Manually (or with a
ComfyUI MCP / API if available):

1. **New workflow** — open a fresh, empty workflow in ComfyUI (Menu → New).
2. **Refresh** — click "Refresh" (or restart) so the FastMaskEditor node is
   registered.
3. **Build the test graph**:
   - Add a **FastMaskEditor** node (it has the "Edit Mask" button + version
     label at the bottom, below the image preview).
   - Add an **Preview Image** node and connect FastMaskEditor `image` →
     Preview Image `images`.
   - Add a **Preview Mask** node and connect FastMaskEditor `mask` →
     Preview Mask `mask`.
4. **Smoke test the editor**:
   - Click **Edit Mask** → the full-screen editor opens.
   - Paint with left-drag, erase with right-drag, toggle Paint/Erase (X),
     double right-click = clear all, Fit-to-page in the middle block.
   - Click **OK** (or Enter) → mask is uploaded and `mask_path` is set.
5. **Run the workflow** (Queue Prompt) and confirm:
   - The FastMaskEditor node still shows the ORIGINAL image (it must NOT
     disappear / go blank).
   - Preview Image shows the source image.
   - Preview Mask shows the painted mask (not an empty black image).
   - There is NO leftover oval "FastMask" button anywhere on the node.

If the image disappears after Queue Prompt, the Python change did not load →
restart ComfyUI and retry.

## Extension version history / pitfalls found

- Cached old JS silently shadowed all fixes → filename was changed once to
  `fastmask_ui.js` (new URL = fresh load) and `no-store` was added.
- `beforeRegisterNodeDef` + `nodeCreated` + `setup` (graph scan) are all used to
  attach the open button; all three must stay.
- **Python changes require a ComfyUI restart** (F5 alone is not enough) — this
  was the cause of the "image deleted after run" symptom persisting across
  fixes.
- **Pasted images MUST go to the input ROOT with `overwrite=false`** (v1.9.12).
  The frontend's "Missing Inputs" panel (`scanNodeMediaCandidates` in the
  bundled frontend JS) marks a combo widget red whenever the widget value is
  NOT in the server's combo list, and `INPUT_TYPES` (FastMask AND LoadImage)
  lists root files only. The native paste flow uploads to the root, letting
  the server dedupe the name (`pasted-image (17).png`), so the value survives
  F5 and node-def reloads. Uploading into `subfolder: "pasted"` produced a
  value (`pasted/pasted-image.png`) that is never in the combo list → the node
  went red at Queue time even though the file existed on disk.
- **Do NOT call `app.refreshComboInNodes()` in the paste flow** (v1.9.13): it
  reloads every node definition from the server and takes seconds, which made
  pasting feel slow. The native flow only pushes the value into the widget's
  combo options locally (`addToComboValues`); a root upload makes the file
  appear in the server combo list at the next refresh anyway.
- **Nodes 1 (LiteGraph canvas) compatibility** (v1.9.15): the DOM overlay
  (`enableNodeMaskOverlay`) only works in the Nodes 2 (Vue) frontend — Nodes 1
  draws the preview from `node.imgs` straight on the canvas. There:
  - `addOpenButton` MUST early-return when an `fm_open` widget with an element
    already exists (onNodeCreated + nodeCreated + onConfigure + graph scan all
    call it; in Nodes 1 that added the Edit Mask button twice), and
    `stripStaleWidgets` keeps only the FIRST `fm_open`.
  - the mask is shown via `fmSetNodePreviewComposite` (swaps `node.imgs[0]` to
    the composite JPEG) — called from `saveAndClose` and from an
    `api.addEventListener("executed", ...)` hook (300 ms delay: LiteGraph loads
    the original preview asynchronously and would overwrite `node.imgs`).
  - `enablePreviewPasteButton` retry loops are capped at 10 attempts (Nodes 1
    has no DOM preview, the old code would retry every 900 ms forever).
- **Nodes 1 button placement** (v1.9.16): in the canvas UI the preview is drawn
  from `node.imgs` in the free space at the bottom of the node, so an in-flow
  DOM widget ALWAYS lands ABOVE the image. Fix: `node._fmLegacy` is decided
  once (500 ms after node creation: legacy = no `[data-node-id]` anywhere in
  the document); then `setupLegacyButtonPin` gives the widget a 0-height slot,
  replaces `node.imgs` with a padded copy (image + 36 px dark strip,
  `fmPadLegacyImage` / `fmSetLegacyNodePreview`), and shifts the button element
  into that strip every canvas frame from an `onDrawForeground` hook (re-applied
  on every move/zoom/resize, so it cannot go stale like the old absolute pin).
  `positionBottom` early-returns for legacy nodes; Nodes 2 keeps the DOM flow.
- **Nodes 2 button below preview** (v1.9.17): the Vue frontend renders the
  widget flow BEFORE the image preview, so the in-flow Edit Mask button sat
  ABOVE the image. Fix: `moveButtonBelowPreview` moves the `fm_open` wrapper
  AFTER the preview box in DOM order (widget array untouched) from
  `positionBottom`, with a per-node MutationObserver that re-applies the order
  after frontend re-renders. Nodes 1 keeps the canvas strip pin.


Please make sure it is compatible with both versions of Nodes (1 and 2): Nodes 2.0 is now available in the Comfy Desktop, portable, and stable releases. This update transitions the Nodes system from LiteGraph.js Canvas rendering to a Vue-based architecture. If this would create a bottleneck or require a compromise, please indicate version 1.
