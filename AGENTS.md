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

4. **DOM widget buttons must opt out of canvas-only mode.** ComfyUI frontend
   renders DOM widgets as static canvas snapshots unless `canvasOnly: false`
   is passed. Buttons added via `node.addDOMWidget(...)` must therefore use:

   ```js
   node.addDOMWidget("fastmask_open", "", el, { serialize: false, canvasOnly: false });
   ```

   Otherwise the button appears as a non-clickable, oval canvas drawing.

5. **Deployment for local testing** — the live instance loads the node from
   `C:\Users\peter\ComfyUI-Installs\ComfyUI (v0.25.0)\ComfyUI\custom_nodes\ComfyUI-FastMask`
   (a plain copy, not a junction). After editing, copy the whole repo content
   (except `.git`, `__pycache__`) there and reload the frontend.

## Extension version history / pitfalls found

- Cached old JS silently shadowed all fixes → filename was changed once to
  `fastmask_ui.js` (new URL = fresh load) and `no-store` was added.
- `beforeRegisterNodeDef` + `nodeCreated` + `setup` (graph scan) are all used to
  attach the open button; all three must stay.
