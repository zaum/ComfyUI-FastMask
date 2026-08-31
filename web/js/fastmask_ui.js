// ============================================================================
//  FastMask - very fast mask editor for ComfyUI
//  ---------------------------------------------------------------------------
//  Performance architecture:
//   * The mask lives on an offscreen 2D canvas at PREVIEW resolution; painting
//     uses GPU-accelerated canvas strokes (no per-stroke object allocation).
//   * The FULL-resolution mask (Uint8Array) is only built once, on the OK
//     button (a single drawImage + getImageData call).
//   * Every frame redraws only the affected DIRTY RECTANGLES - a brush stroke
//     never re-renders the whole image.
//   * A single requestAnimationFrame loop runs, and only draws when something
//     actually changed.
//   * Zoom / pan is a pure CSS transform -> zero-cost navigation.
//   * Undo/Redo does not copy whole images: it stores lazy 256x256 TILE
//     snapshots of only the tiles that were actually touched.
//
//  Not implemented (design only): fast SAM segmentation - see README.md,
//  "SAM segmentation - planned extension" chapter.
// ============================================================================

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TILE = 256;          // undo/redo tile size (preview px)
const MAX_PREVIEW = 2048;  // max preview resolution (the result is full-res)
const MAX_UNDO = 40;
const FM_VERSION = "1.7.4";
const BTN_LABEL = "\uD83D\uDD8C FastMask Editor v" + FM_VERSION;

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = isMac ? "\u2318" : "Ctrl";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let ui = null; // DOM elements (filled by buildUI)
let st = null; // editor state (filled by openEditor)

/* --------------------------------- CSS --------------------------------- */
const CSS = `
.fm-overlay{position:fixed;inset:0;z-index:99999;background:#101010;display:flex;flex-direction:column;color:#ddd;font:13px/1.4 system-ui,Segoe UI,sans-serif;user-select:none;-webkit-user-select:none}
.fm-topbar{display:flex;align-items:center;gap:14px;padding:8px 12px;background:#1b1b1b;border-bottom:1px solid #333;flex-wrap:wrap}
.fm-group{display:flex;align-items:center;gap:6px}
.fm-spacer{flex:1}
.fm-btn{position:relative;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;white-space:nowrap}
.fm-btn.icon{padding:5px 9px;font-size:17px;line-height:1}
.fm-btn.icon svg{display:block}
/* labeled mode toggle: "Paint"/"Erase" are both 5 chars, so min-width keeps
   the button width constant when toggling; auto height -> nothing is clipped */
.fm-btn.fm-mode{min-width:104px;padding:5px 12px;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.fm-btn.fm-mode svg{flex:none}
.fm-modelabel{font-size:13px;line-height:1}
/* oval Paint/Erase toggle: labels on both sides, sliding knob in the middle */
.fm-mode-toggle{display:inline-flex;align-items:center;gap:10px;user-select:none}
.fm-toggle-label{font-size:13px;color:#888;cursor:pointer;user-select:none;transition:color .15s}
.fm-toggle-label.active{color:#fff;font-weight:600}
.fm-toggle-track{position:relative;width:48px;height:26px;border-radius:13px;background:#3d6ea5;border:1px solid #5a8fc4;cursor:pointer;transition:background .15s,border-color .15s;flex:none}
.fm-toggle-track:hover{border-color:#7aa8d8}
.fm-toggle-track.active{background:#3d6ea5;border-color:#5a8fc4}
.fm-toggle-knob{position:absolute;top:2px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:left .15s}
.fm-toggle-track.active .fm-toggle-knob{left:25px}
/* live brush size badge in the middle of the canvas */
.fm-brushbadge{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;border:2px solid rgba(255,255,255,.95);outline:1px solid rgba(0,0,0,.75);border-radius:50%;background:rgba(255,255,255,.08);pointer-events:none}
.fm-brushbadge-inner{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:2px dashed rgba(255,255,255,.95);border-radius:50%;background:transparent;pointer-events:none}
.fm-gap{width:12px}
.fm-btn:hover{background:#3a3a3a;border-color:#666}
.fm-btn.active{background:#3d6ea5;border-color:#5a8fc4;color:#fff}
.fm-btn.ok{background:#2e7d32;border-color:#388e3c}
.fm-btn.ok:hover{background:#388e3c}
.fm-btn:disabled{opacity:.4;cursor:default}
.fm-btn::after{content:attr(data-tip);position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#000;color:#fff;border:1px solid #555;padding:5px 9px;border-radius:5px;white-space:nowrap;font-size:12px;opacity:0;pointer-events:none;transition:opacity .1s;z-index:100000}
.fm-btn:hover::after{opacity:1}
/* thin, flat slider track */
.fm-slider{-webkit-appearance:none;appearance:none;width:170px;height:3px;background:#444;border-radius:2px;outline:none;cursor:pointer}
.fm-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#4a90d9;border:none;cursor:pointer}
.fm-slider::-moz-range-track{height:3px;background:#444;border-radius:2px}
.fm-slider::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#4a90d9;border:none;cursor:pointer}
/* blur slider - narrower than the brush slider (blue thumb, inherited) */
.fm-slider.fm-blur-slider{width:100px}
.fm-brushlabel{color:#aaa}
.fm-brushval{margin-left:2px;min-width:42px;text-align:right;font-variant-numeric:tabular-nums;color:#8cf}
.fm-blurval{margin-left:2px;min-width:36px;text-align:right;font-variant-numeric:tabular-nums;color:#da6}
.fm-swatch{display:inline-block;width:18px;height:18px;border-radius:50%;border:1px solid #777;vertical-align:-4px}
.fm-viewport{position:relative;flex:1;overflow:hidden;cursor:none;touch-action:none}
.fm-viewport.fm-outside{cursor:default}
.fm-viewport.fm-pan{cursor:grab}
.fm-viewport.fm-panning{cursor:grabbing}
.fm-node-bw{position:absolute;inset:0;background:#000;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5}
.fm-wrap{position:absolute;left:0;top:0;transform-origin:0 0}
/* screen-resolution overlay for the brush cursor: stays crisp even when the
   preview canvas itself is low-res and heavily upscaled by the zoom */
.fm-cursorlayer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2}
/* screen-resolution overlay for the hatch pattern: like the cursor ring, it
   stays crisp on small images where the preview canvas is heavily upscaled */
.fm-hatchlayer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1}
.fm-wrap canvas{display:block}
.fm-wrap canvas.fm-bw{outline:1px solid rgba(255,255,255,.28);outline-offset:-1px}
.fm-statusbar{display:flex;gap:28px;padding:5px 12px;background:#1b1b1b;border-top:1px solid #333;font-size:12px;color:#aaa;flex-wrap:wrap}
.fm-statusbar b{color:#8cf;font-weight:600}
.fm-statusbar kbd{display:inline-block;padding:1px 4px;margin:0;font:600 11px/1.4 system-ui,Segoe UI,sans-serif;color:#8cf;background:#1e2a3a;border:1px solid #3a4a5a;border-radius:3px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 1px 0 rgba(0,0,0,.4)}
.fm-hint{margin-left:auto;display:flex;gap:0;flex-wrap:wrap;align-items:center}
.fm-hint span{white-space:nowrap}
.fm-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:16px;color:#aaa;background:#101010;z-index:2}
.fm-hidden{display:none!important}
.fm-colinput{position:absolute;width:0;height:0;opacity:0}
`;

function injectCSS() {
  if (document.getElementById("fastmask-css")) return;
  const el = document.createElement("style");
  el.id = "fastmask-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

function btn(id, html, tip, cls) {
  const b = document.createElement("button");
  b.id = id;
  b.className = "fm-btn" + (cls ? " " + cls : "");
  b.innerHTML = html;
  b.dataset.tip = tip;
  b.addEventListener("click", () => b.blur());
  return b;
}

/* --- toolbar SVG icons (module scope: also used by updateToolbar) --- */
function svgIcon(paths, viewBox) {
  return '<svg width="18" height="18" viewBox="' + (viewBox || "0 0 24 24") +
    '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
}
function iconUndo() {
  return svgIcon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v0a6 6 0 0 1-6 6h-3"/>');
}
function iconRedo() {
  return svgIcon('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v0a6 6 0 0 0 6 6h3"/>');
}
function iconTrash() {
  return svgIcon('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>');
}
function iconFill() {
  // a circle filled with a diagonal hatch pattern: auto-fill the interior of
  // a closed shape
  return svgIcon(
    '<defs><pattern id="fmFillHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
    '<line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" stroke-width="1.3"/></pattern></defs>' +
    '<circle cx="12" cy="12" r="9" fill="url(#fmFillHatch)" stroke="currentColor" stroke-width="2"/>'
  );
}
function iconShowMask() {
  // wider rectangle with a SOLID filled circle inside (mask indicator)
  return svgIcon('<rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="currentColor" stroke-width="1.4"/>');
}
function iconPaint() {
  // B/W paint brush
  return svgIcon('<path d="m15 5 4 4"/><path d="M13 7 4.5 15.5a2.1 2.1 0 0 0 3 3L16 10"/><path d="m13 7 4 4"/>');
}
function iconErase() {
  // B/W eraser
  return svgIcon('<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a2 2 0 0 1 2.8 0l5.2 5.2a2 2 0 0 1 0 2.8L13 21"/><path d="M22 21H7"/><path d="m5 12 7 7"/>');
}
function iconFit() {
  return svgIcon('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>');
}

/* ------------------------------ DOM construction ------------------------------ */
function buildUI() {
  if (ui) return;
  injectCSS();

  const overlay = document.createElement("div");
  overlay.className = "fm-overlay fm-hidden";

  const topbar = document.createElement("div");
  topbar.className = "fm-topbar";

  // THREE toolbar blocks: left (undo, redo, clear all) / centered (fit,
  // brush size, fill, show mask, hatch color, mode toggle) / right (cancel, OK).
  const gLeft = document.createElement("div");
  gLeft.className = "fm-group";
  const undoBtn = btn("fmUndo", iconUndo(), "Undo (" + MOD + "+Z)", "icon");
  const redoBtn = btn("fmRedo", iconRedo(), "Redo (" + MOD + "+Y / " + MOD + "+Shift+Z)", "icon");
  const clearAll = btn("fmClear", iconTrash(), "Clear all (" + MOD + "+Del)", "icon");
  gLeft.append(undoBtn, redoBtn, clearAll);

  const spL = document.createElement("div");
  spL.className = "fm-spacer";
  const gMid = document.createElement("div");
  gMid.className = "fm-group";
  gMid.style.gap = "16px";
  // brush size: label BEFORE the slider, no pixel value next to it (the live
  // size is shown in the middle of the canvas while changing)
  const brushLabel = document.createElement("span");
  brushLabel.className = "fm-brushlabel";
  brushLabel.textContent = "Brush size";
  const brushSlider = document.createElement("input");
  brushSlider.type = "range";
  brushSlider.id = "fmBrush";
  brushSlider.className = "fm-slider";
  brushSlider.min = "1";
  brushSlider.max = "1000";
  brushSlider.value = "60";
  brushSlider.dataset.tip = "Brush size (" + MOD + "+left-drag, " + MOD + "+wheel, [ / ])";
  const fillToggle = btn("fmFill", iconFill(), "Auto-fill interior of closed shapes (F)", "icon");
  const showMask = btn("fmShow", iconShowMask(), "B/W mask - hover for preview, click to lock and edit (M)", "icon");
  const spR = document.createElement("div");
  spR.className = "fm-spacer";

  const gRight = document.createElement("div");
  gRight.className = "fm-group";
  const fitBtn = btn("fmFit", iconFit(), "Fit image to window (" + MOD + "+0)", "icon");
  const hatchBtn = btn("fmHatch", "", "Hatch line color (C)", "icon");
  const swatch = document.createElement("span");
  swatch.className = "fm-swatch";
  hatchBtn.append(swatch);
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "fm-colinput";
  colorInput.value = "#ff3fd8";
  // oval Paint/Erase toggle: labels on both sides, sliding knob
  const modeToggle = document.createElement("div");
  modeToggle.className = "fm-mode-toggle";
  modeToggle.id = "fmModeToggle";
  const paintLabel = document.createElement("span");
  paintLabel.className = "fm-toggle-label";
  paintLabel.textContent = "Paint";
  const modeBtn = document.createElement("button");
  modeBtn.id = "fmMode";
  modeBtn.className = "fm-toggle-track";
  modeBtn.dataset.tip = "Toggle Paint / Erase (X) - right button always erases";
  const knob = document.createElement("span");
  knob.className = "fm-toggle-knob";
  modeBtn.appendChild(knob);
  const eraseLabel = document.createElement("span");
  eraseLabel.className = "fm-toggle-label";
  eraseLabel.textContent = "Erase";
  modeToggle.append(paintLabel, modeBtn, eraseLabel);
  const cancelBtn = btn("fmCancel", "Cancel", "Cancel (Esc)");
  const okBtn = btn("fmOk", "OK", "Save and close (Enter)", "ok");
  gRight.append(cancelBtn, okBtn);

  // middle block (centered): fit-to-page FIRST, then brush size, blur, fill,
  // hatch color, oval Paint/Erase toggle, and the B/W mask button LAST (rightmost)
  const blurLabel = document.createElement("span");
  blurLabel.className = "fm-brushlabel";
  blurLabel.textContent = "Blur";
  const blurSlider = document.createElement("input");
  blurSlider.type = "range";
  blurSlider.id = "fmBlur";
  blurSlider.className = "fm-slider fm-blur-slider";
  blurSlider.min = "0";
  blurSlider.max = "100";
  blurSlider.value = "0";
  blurSlider.dataset.tip = "Mask blur (drag horizontally with " + MOD + " held)";
  gMid.append(fitBtn, brushLabel, brushSlider, blurLabel, blurSlider, fillToggle, hatchBtn, colorInput, modeToggle, showMask);

  topbar.append(gLeft, spL, gMid, spR, gRight);

  const viewport = document.createElement("div");
  viewport.className = "fm-viewport";
  const loading = document.createElement("div");
  loading.className = "fm-loading";
  loading.textContent = "Loading image...";
  const wrap = document.createElement("div");
  wrap.className = "fm-wrap fm-hidden";
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  // live brush size badge (center of the canvas, shown while changing)
  const brushBadge = document.createElement("div");
  brushBadge.className = "fm-brushbadge fm-hidden";
  // inner dashed circle visualizes the current mask blur amount
  const brushBadgeInner = document.createElement("div");
  brushBadgeInner.className = "fm-brushbadge-inner";
  brushBadge.appendChild(brushBadgeInner);
  // screen-resolution brush cursor overlay (crisp at any zoom / image size)
  const cursorLayer = document.createElement("canvas");
  cursorLayer.className = "fm-cursorlayer";
  const hatchLayer = document.createElement("canvas");
  hatchLayer.className = "fm-hatchlayer";
  viewport.append(loading, wrap, hatchLayer, cursorLayer, brushBadge);

  const statusbar = document.createElement("div");
  statusbar.className = "fm-statusbar";
  statusbar.innerHTML =
    '<span>Brush: <b id="fmStBrush"></b></span>' +
    '<span>Blur: <b id="fmStBlur"></b></span>' +
    '<span>Zoom: <b id="fmStZoom"></b></span>' +
    '<span>Image: <b id="fmStSize"></b></span>' +
    '<span class="fm-hint">' +
       '<kbd>' + MOD + '</kbd>+<kbd>up/down-drag</kbd>: brush size' +
       '<kbd>' + MOD + '</kbd>+<kbd>left/right-drag</kbd>: blur' +
       '<kbd>' + MOD + '</kbd>+<kbd>wheel</kbd>: brush' +
       '<kbd>wheel</kbd>: zoom' +
       '<kbd>Space</kbd>/<kbd>middle button</kbd>: pan' +
       '<kbd>right button</kbd>: erase' +
       '<kbd>double right button</kbd>: clear all' +
       '<kbd>X</kbd>: mode' +
       '<kbd>' + MOD + '</kbd>+<kbd>Z</kbd>/<kbd>' + MOD + '</kbd>+<kbd>Y</kbd>: undo/redo</span>';

  overlay.append(topbar, viewport, statusbar);
  document.body.appendChild(overlay);

  // keep the OK button exactly as wide as the Cancel button (regardless of
  // label length / font metrics); min-width so it can still grow if needed.
  // Measured AFTER the overlay becomes visible (openEditor removes fm-hidden) -
  // while hidden, offsetWidth is 0 and the sync would silently do nothing.
  const syncOkWidth = () => {
    try {
      const w = cancelBtn.offsetWidth;
      if (w > 0) okBtn.style.minWidth = w + "px";
    } catch (e) {}
  };
  requestAnimationFrame(syncOkWidth);
  setTimeout(syncOkWidth, 60);
  setTimeout(syncOkWidth, 300);

  ui = {
    overlay, topbar, viewport, wrap, canvas, loading, brushBadge, brushBadgeInner,
    modeBtn, modeToggle, paintLabel, eraseLabel, clearAll, undoBtn, redoBtn, brushSlider, blurSlider,
    hatchBtn, swatch, colorInput, fillToggle, showMask,
    fitBtn, cancelBtn, okBtn, cursorLayer, hatchLayer,
    stBrush: statusbar.querySelector("#fmStBrush"),
    stBlur: statusbar.querySelector("#fmStBlur"),
    stZoom: statusbar.querySelector("#fmStZoom"),
    stSize: statusbar.querySelector("#fmStSize"),
  };

  wireUI();
}

/* ------------------------------ state / init ------------------------------ */
async function openEditor(node) {
  buildUI();
  if (st) return; // already open

  const src = getSourceImage(node);
  if (!src) {
    toast("FastMask", "No image found on the node inputs! Run the workflow first.", "error");
    return;
  }

  ui.overlay.classList.remove("fm-hidden");
  ui.loading.classList.remove("fm-hidden");
  ui.wrap.classList.add("fm-hidden");

  // window resizes change the viewport size -> cursor overlay must rescale
  if (!openEditor._resizeWired) {
    openEditor._resizeWired = true;
    window.addEventListener("resize", () => { if (st) st.cursorDirty = true; });
  }

  // OK button width sync must run while the overlay is VISIBLE (hidden
  // elements measure 0), so re-sync right after showing the editor
  const syncW = () => {
    try {
      const w = ui.cancelBtn.offsetWidth;
      if (w > 0) ui.okBtn.style.minWidth = w + "px";
    } catch (e) {}
  };
  requestAnimationFrame(syncW);
  setTimeout(syncW, 100);

  let img;
  try {
    img = await loadImage(api.apiURL("/view?" + new URLSearchParams({
      filename: src.filename,
      subfolder: src.subfolder || "",
      type: src.type || "output",
    })));
  } catch (err) {
    console.error("[FastMask] image load failed:", src, err);
    ui.loading.textContent = "FastMask: failed to load image (" + (src.filename || "?") + ")";
    toast("FastMask", "Failed to load image: " + err, "error");
    return;
  }

  try {

  const fullW = img.naturalWidth;
  const fullH = img.naturalHeight;
  const f = Math.min(1, MAX_PREVIEW / Math.max(fullW, fullH));
  const pw = Math.max(1, Math.round(fullW * f));
  const ph = Math.max(1, Math.round(fullH * f));

  // base image (preview resolution, drawn once)
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = pw; baseCanvas.height = ph;
  baseCanvas.getContext("2d").drawImage(img, 0, 0, pw, ph);

  // mask (preview resolution; the full-res version is only built on OK)
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = pw; maskCanvas.height = ph;
  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });

  // tinted mask (hatch / white) - updated per dirty rect
  const tintCanvas = document.createElement("canvas");
  tintCanvas.width = pw; tintCanvas.height = ph;
  const tctx = tintCanvas.getContext("2d");

  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = pw; tempCanvas.height = ph;
  const tempCtx = tempCanvas.getContext("2d");

  ui.canvas.width = pw; ui.canvas.height = ph;
  const vctx = ui.canvas.getContext("2d");

  st = {
    node, fullW, fullH, pw, ph, previewScale: pw / fullW,
    baseCanvas, maskCanvas, mctx, tintCanvas, tctx, tempCanvas, tempCtx, vctx,
    cursorCtx: ui.cursorLayer.getContext("2d"),
    hatchCtx: ui.hatchLayer.getContext("2d"),
    hatchDirty: true,
    // screen-space blurred mask buffer for the hatch overlay (perf)
    msC: null, msCtx: null, msScale: 0, msBlur: -1, msW: 0, msH: 0, msRects: null,
    img,
    view: { scale: 1, x: 0, y: 0 },
    fitScale: 1,
    brushFull: Math.round(Math.min(fullW, fullH) * 0.06),
    blurPct: 0,             // 0..100 mask blur, 0 = sharp
    mode: "paint",          // 'paint' | 'erase'
    autoFill: true,
    hatchColor: "#ff3fd8",
    hatchPattern: null,
    maskLocked: false,      // locked via the Show mask button
    bwHover: false,         // B/W preview while hovering Show mask
    dirty: [],
    cursor: { x: 0, y: 0, inside: false },
    prevCursor: null,
    cursorDirty: false,
    undoStack: [], redoStack: [],
    strokeTiles: null,
    drawing: null,          // { mode }
    panning: null, sizing: null, spaceDown: false,
    suppressFollow: false,  // keep brush center fixed right after a ctrl-resize
    last: null,
    ptsX: new Float32Array(256), ptsY: new Float32Array(256), ptsN: 0,
    strokeBBox: null,
    raf: 0,
  };

  const maxBrush = Math.min(fullW, fullH);
  ui.brushSlider.max = String(maxBrush);
  ui.brushSlider.value = String(st.brushFull);
  ui.blurSlider.value = "0";
  ui.colorInput.value = st.hatchColor;
  ui.swatch.style.background = st.hatchColor;
  ui.fillToggle.classList.toggle("active", st.autoFill);
  ui.stSize.textContent = fullW + " \u00D7 " + fullH + (f < 1 ? "  (preview " + pw + "\u00D7" + ph + ")" : "");

  // restore a previously painted mask from mask_path (if any)
  (async () => {
    const mw = (node.widgets || []).find((w) => w.name === "mask_path");
    if (!mw || !mw.value) return;
    try {
      const seg = String(mw.value).split("/");
      const mf = seg.pop();
      // cache-bust: the mask file is overwritten in-place on every OK, so the
      // browser would otherwise serve the stale /view result from cache and the
      // editor would restore the OLD mask instead of the latest one.
      const mimg = await loadImage(api.apiURL("/view?" + new URLSearchParams({
        filename: mf,
        subfolder: seg.join("/"),
        type: "input",
        _t: Date.now(),
      })));
      if (!st) return; // editor was closed meanwhile
      mctx.clearRect(0, 0, pw, ph);
      mctx.drawImage(mimg, 0, 0, pw, ph);
      st.dirty.push({ x: 0, y: 0, w: pw, h: ph });
    } catch (e) { /* no saved mask, start empty */ }
  })();

  makeHatch();
  fitView();
  updateToolbar();

  ui.loading.classList.add("fm-hidden");
  ui.wrap.classList.remove("fm-hidden");

  // IMPORTANT: full initial render, otherwise the image would only appear
  // under the brush strokes (dirty-rect-only painting)
  renderAll();

  // first full render, then dirty rects only
  st.raf = requestAnimationFrame(frame);
  } catch (err) {
    // Any init error must surface here - otherwise the UI would stay on
    // "Loading image..." forever with no visible cause.
    console.error("[FastMask] editor init failed:", err);
    if (ui) {
      ui.loading.textContent =
        "FastMask init error: " + (err && err.message ? err.message : err);
      ui.loading.classList.remove("fm-hidden");
    }
    toast("FastMask", "Editor init failed: " + (err && err.message ? err.message : err), "error");
  }
}

function closeEditor() {
  if (!st) return;
  cancelAnimationFrame(st.raf);
  st = null;
  ui.overlay.classList.add("fm-hidden");
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("load error"));
    img.src = url;
  });
}

function getSourceImage(node) {
  try {
    // 1. connected IMAGE input (optional "image" input) - overrides the dropdown
    for (const inp of node.inputs || []) {
      if (inp.type !== "IMAGE" || !inp.link) continue;
      const link = app.graph.links[inp.link];
      if (!link) continue;
      const out = app.nodeOutputs[link.origin_id];
      if (out && out.images && out.images.length) {
        return out.images.find((i) => i.type === "output") || out.images[0];
      }
    }
    // 2. the node's own image combo widget (file-loader mode, like LoadImage)
    const w = (node.widgets || []).find((w) => w.name === "image");
    if (w && w.value && typeof w.value === "string") {
      // the value may contain a subfolder ("folder/file.png")
      const seg = w.value.split("/");
      return { filename: seg.pop(), subfolder: seg.join("/"), type: "input" };
    }
    // 3. the preview shown on the node (after upload)
    if (node.images && node.images.length) return node.images[0];
  } catch (e) { /* ignore */ }
  return null;
}

function toast(title, detail, severity) {
  const m = app.extensionManager;
  if (m && m.toast && m.toast.add) m.toast.add({ severity: severity || "info", summary: title, detail, life: 5000 });
  else console.warn("[FastMask]", title, detail);
}

/* ------------------------------ view: zoom / pan ------------------------------ */
function applyTransform() {
  ui.wrap.style.transform = "translate(" + st.view.x + "px," + st.view.y + "px) scale(" + st.view.scale + ")";
  ui.stZoom.textContent = Math.round(st.view.scale * 100) + "%";
  // the cursor overlay is drawn in screen coords -> reposition on any view change
  st.cursorDirty = true;
}

function fitView() {
  const r = ui.viewport.getBoundingClientRect();
  const s = Math.min(r.width / st.pw, r.height / st.ph) * 0.98;
  st.view.scale = s;
  st.fitScale = s;
  st.view.x = (r.width - st.pw * s) / 2;
  st.view.y = (r.height - st.ph * s) / 2;
  applyTransform();
}

function zoomAt(clientX, clientY, factor) {
  const r = ui.viewport.getBoundingClientRect();
  const mx = clientX - r.left, my = clientY - r.top;
  const s0 = st.view.scale;
  const s1 = clamp(s0 * factor, 0.05, 40);
  if (s1 === s0) return;
  st.view.x = mx - (mx - st.view.x) * (s1 / s0);
  st.view.y = my - (my - st.view.y) * (s1 / s0);
  st.view.scale = s1;
  st.cursorDirty = true;
  st.hatchDirty = true;
  applyTransform();
}

function toCanvas(e) {
  const r = ui.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (st.pw / r.width),
    y: (e.clientY - r.top) * (st.ph / r.height),
  };
}

/* ------------------------------ render (dirty rect) ------------------------------ */
function bwMode() { return st.maskLocked || st.bwHover; }

function makeHatch() {
  const c = document.createElement("canvas");
  c.width = 18; c.height = 18; // 18px tile -> sparser hatch spacing
  const g = c.getContext("2d");
  g.strokeStyle = st.hatchColor;
  g.lineWidth = 2;
  g.lineCap = "square";
  g.beginPath();
  g.moveTo(-4, 22); g.lineTo(22, -4);
  g.moveTo(-4, 4);  g.lineTo(4, -4);
  g.moveTo(14, 22); g.lineTo(22, 14);
  g.stroke();
  st.hatchPattern = st.hatchCtx.createPattern(c, "repeat");
}

function addDirty(x, y, w, h) {
  const x0 = Math.max(0, Math.floor(x) - 1);
  const y0 = Math.max(0, Math.floor(y) - 1);
  const x1 = Math.min(st.pw, Math.ceil(x + w) + 1);
  const y1 = Math.min(st.ph, Math.ceil(y + h) + 1);
  if (x1 > x0 && y1 > y0) st.dirty.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

function renderAll() { st.dirty.push({ x: 0, y: 0, w: st.pw, h: st.ph }); }

// Redraw one dirty rect: base image + (in B/W mode) white drawing limited to
// the mask. In paint mode the hatch lives on its own screen-resolution
// overlay (drawHatchLayer), so the preview canvas only carries the image -
// this also keeps the hatch crisp on small, heavily upscaled images.
function renderRect(r) {
  const v = st.vctx, t = st.tctx;
  const bw = bwMode();
  v.save();
  v.beginPath(); v.rect(r.x, r.y, r.w, r.h); v.clip();
  if (bw) {
    v.fillStyle = "#000";
    v.fillRect(r.x, r.y, r.w, r.h);
    // tint the mask inside the rect only
    t.save();
    t.beginPath(); t.rect(r.x, r.y, r.w, r.h); t.clip();
    t.clearRect(r.x, r.y, r.w, r.h);
    t.fillStyle = "#ffffff";
    t.fillRect(r.x, r.y, r.w, r.h);
    t.globalCompositeOperation = "destination-in";
    // real-time mask blur: sample the mask with a margin around the dirty rect
    // so the Gaussian kernel near the rect edges sees the correct pixels
    const bp = st.blurPct > 0 ? blurRadiusPx() : 0;
    const sx = bp ? Math.max(0, Math.floor(r.x - bp)) : r.x;
    const sy = bp ? Math.max(0, Math.floor(r.y - bp)) : r.y;
    const sxx = sx, syy = sy;
    const sww = bp ? Math.min(st.pw, Math.ceil(r.x + r.w + bp)) - sx : r.w;
    const shh = bp ? Math.min(st.ph, Math.ceil(r.y + r.h + bp)) - sy : r.h;
    if (bp > 0) t.filter = "blur(" + bp + "px)";
    t.drawImage(st.maskCanvas, sx, sy, sww, shh, sxx, syy, sww, shh);
    t.filter = "none";
    t.restore();
    v.drawImage(st.tintCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  } else {
    v.drawImage(st.baseCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }
  v.restore();
}

function brushRadiusCanvas() {
  return (st.brushFull * st.previewScale) / 2;
}

function cursorRect(c) {
  // Integer coordinates: fractional clip rects caused faint square seams
  // along the redrawn area edges (very visible in B/W mode). Extended with the
  // blur halo so the soft edge also refreshes while the cursor passes by.
  const rad = brushRadiusCanvas() + 2 + (st.blurPct > 0 ? blurRadiusPx() : 0);
  const x = Math.max(0, Math.floor(c.x - rad));
  const y = Math.max(0, Math.floor(c.y - rad));
  const w = Math.min(st.pw - x, Math.ceil(rad * 2) + 2);
  const h = Math.min(st.ph - y, Math.ceil(rad * 2) + 2);
  return { x, y, w, h };
}

// Brush cursor ring + (when blur > 0) inner dashed circle, drawn on a
// SCREEN-RESOLUTION overlay canvas (devicePixelRatio-aware) instead of the
// preview canvas. The preview canvas is only pw x ph and gets upscaled by the
// zoom transform, which made the circle blurry/jagged on small images - the
// overlay stays perfectly crisp at any zoom level.
function sizeCursorLayer() {
  const lay = ui.cursorLayer;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(ui.viewport.clientWidth * dpr));
  const h = Math.max(1, Math.round(ui.viewport.clientHeight * dpr));
  if (lay.width !== w || lay.height !== h) { lay.width = w; lay.height = h; }
}

function clearCursorLayer() {
  const g = st && st.cursorCtx;
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
}

function drawCursor() {
  const g = st.cursorCtx;
  if (!g) return;
  sizeCursorLayer();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const s = st.view.scale, c = st.cursor;
  // canvas coords -> viewport px -> device px
  const sx = (st.view.x + c.x * s) * dpr;
  const sy = (st.view.y + c.y * s) * dpr;
  const rs = Math.max(1, brushRadiusCanvas() * s * dpr);
  const lw = Math.max(1, 1.25 * dpr);
  g.save();
  g.lineWidth = lw;
  g.strokeStyle = "rgba(255,255,255,.95)";
  g.shadowColor = "rgba(0,0,0,.9)";
  g.shadowBlur = 2 * dpr;
  g.beginPath(); g.arc(sx, sy, rs, 0, Math.PI * 2); g.stroke();
  if (st.blurPct > 0) {
    // inner concentric dashed circle grows with the blur amount
    const irs = rs * (st.blurPct / 100);
    if (irs > lw * 2) {
      const dash = Math.max(2, 4 * dpr);
      g.strokeStyle = "rgba(255,255,255,.7)";
      g.setLineDash([dash, dash]);
      g.beginPath(); g.arc(sx, sy, irs, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
  }
  g.restore();
}

// Hatch overlay: the vivid diagonal pattern drawn at SCREEN resolution,
// masked by the (optionally blurred) mask. Like the cursor layer, this stays
// crisp when the preview canvas is small and upscaled by the zoom transform.
function sizeHatchLayer() {
  const lay = ui.hatchLayer;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(ui.viewport.clientWidth * dpr));
  const h = Math.max(1, Math.round(ui.viewport.clientHeight * dpr));
  if (lay.width !== w || lay.height !== h) { lay.width = w; lay.height = h; }
}

function drawHatchLayer() {
  const g = st.hatchCtx;
  if (!g) return;
  sizeHatchLayer();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  if (bwMode()) { st.hatchDirty = false; return; } // B/W view paints its own white mask
  const s = st.view.scale;
  const vw = g.canvas.width, vh = g.canvas.height; // device px
  const bp = st.blurPct > 0 ? blurRadiusPx() : 0;  // canvas px
  // ---- keep a SCREEN-RES blurred copy of the mask (st.msC) ----
  // Rebuilt fully on zoom / resize / blur-change; while painting only the
  // dirty rects are re-blurred, so strokes never re-blur the whole screen.
  if (!st.msC || st.msW !== vw || st.msH !== vh ||
      Math.abs(st.msScale - s * dpr) > 1e-4 || Math.abs(st.msBlur - bp) > 0.5) {
    if (!st.msC) { st.msC = document.createElement("canvas"); st.msCtx = st.msC.getContext("2d"); }
    st.msC.width = vw; st.msC.height = vh;
    st.msW = vw; st.msH = vh;
    const m = st.msCtx;
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (bp > 0) m.filter = "blur(" + (bp * s).toFixed(2) + "px)";
    m.drawImage(st.maskCanvas, st.view.x, st.view.y, st.pw * s, st.ph * s);
    m.filter = "none";
    st.msScale = s * dpr; st.msBlur = bp; st.msRects = null;
  } else if (st.msRects && st.msRects.length) {
    const m = st.msCtx;
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m2 = Math.ceil(bp * s * 2) + 6; // screen-px margin for the blur halo
    for (const r of st.msRects) {
      const dx = st.view.x + r.x * s, dy = st.view.y + r.y * s;
      const dw = r.w * s, dh = r.h * s;
      const ex = Math.max(0, dx - m2), ey = Math.max(0, dy - m2);
      const ex2 = Math.min(vw / dpr, dx + dw + m2), ey2 = Math.min(vh / dpr, dy + dh + m2);
      if (ex2 <= ex || ey2 <= ey) continue;
      // clear + redraw an expanded region: blur near the borders stays correct
      m.clearRect(ex, ey, ex2 - ex, ey2 - ey);
      const sx0 = Math.max(0, Math.floor((ex - st.view.x) / s));
      const sy0 = Math.max(0, Math.floor((ey - st.view.y) / s));
      const sx1 = Math.min(st.pw, Math.ceil((ex2 - st.view.x) / s));
      const sy1 = Math.min(st.ph, Math.ceil((ey2 - st.view.y) / s));
      if (sx1 > sx0 && sy1 > sy0) {
        if (bp > 0) m.filter = "blur(" + (bp * s).toFixed(2) + "px)";
        m.drawImage(st.maskCanvas, sx0, sy0, sx1 - sx0, sy1 - sy0,
                    st.view.x + sx0 * s, st.view.y + sy0 * s, (sx1 - sx0) * s, (sy1 - sy0) * s);
        m.filter = "none";
      }
    }
    st.msRects = null;
  }
  // ---- composite: mask buffer + hatch pattern (two cheap GPU ops) ----
  g.drawImage(st.msC, 0, 0);
  g.globalCompositeOperation = "source-in";
  const pat = st.hatchPattern;
  if (pat) {
    // anchor the pattern to the image so panning does not make it swim
    // (user space here is device px, hence the dpr factor)
    try { pat.setTransform(new DOMMatrix([1, 0, 0, 1, st.view.x * dpr, st.view.y * dpr])); } catch (e) {}
    g.fillStyle = pat;
    g.fillRect(0, 0, vw, vh);
  }
  g.globalCompositeOperation = "source-over";
  st.hatchDirty = false;
}

// Single rAF loop: dirty rects + cursor, otherwise nothing to do.
function frame() {
  if (!st) return;
  const bw = bwMode();
  // faint outline around the image frame in B/W mode (CSS outline, zero cost)
  if (st._lastBw === undefined) st._lastBw = bw;
  else if (bw !== st._lastBw) { st._lastBw = bw; st.hatchDirty = true; }
  ui.canvas.classList.toggle("fm-bw", bw);
  if (st.dirty.length) {
    let list = st.dirty;
    st.dirty = [];
    if (list.length > 64) list = [{ x: 0, y: 0, w: st.pw, h: st.ph }];
    for (const r of list) renderRect(r);
    // the hatch overlay updates the same regions incrementally (no full-screen
    // re-blur while painting - see drawHatchLayer)
    st.msRects = list;
    st.hatchDirty = true;
    st.cursorDirty = true;
  }
  if (st.cursorDirty) {
    // the cursor lives on its own screen-resolution overlay now - no need to
    // repaint image rects to erase it, just clear + redraw the overlay
    const c = st.cursor;
    const inside = c.inside && !st.panning && !st.sizing;
    clearCursorLayer();
    if (inside) drawCursor();
    st.prevCursor = null;
    st.cursorDirty = false;
  }
  if (st.hatchDirty) drawHatchLayer();
  st.raf = requestAnimationFrame(frame);
}

/* ------------------------------ painting ------------------------------ */
function lineRadiusCanvas() {
  return (st.brushFull * st.previewScale) / 2;
}

function segBBox(x0, y0, x1, y1) {
  // the blur halo extends beyond the hard brush edge, so the dirty rects and
  // the undo tiles must cover it too or the soft edge won't refresh in place
  const rad = lineRadiusCanvas() + 5 + (st.blurPct > 0 ? blurRadiusPx() : 0);
  const x = Math.min(x0, x1) - rad, y = Math.min(y0, y1) - rad;
  return { x, y, w: Math.abs(x0 - x1) + rad * 2, h: Math.abs(y0 - y1) + rad * 2 };
}

function pushPoint(x, y) {
  if (st.ptsN >= st.ptsX.length) {
    const nx = new Float32Array(st.ptsX.length * 2);
    const ny = new Float32Array(st.ptsY.length * 2);
    nx.set(st.ptsX); ny.set(st.ptsY);
    st.ptsX = nx; st.ptsY = ny;
  }
  st.ptsX[st.ptsN] = x;
  st.ptsY[st.ptsN] = y;
  st.ptsN++;
}

function startStroke(p, mode) {
  st.drawing = { mode };
  st.strokeTiles = new Map();
  st.ptsN = 0;
  pushPoint(p.x, p.y);
  st.last = p;
  st.strokeBBox = segBBox(p.x, p.y, p.x + 0.01, p.y);
  captureTiles(st.strokeBBox);
  const m = st.mctx;
  m.save();
  m.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
  m.fillStyle = "#fff";
  m.strokeStyle = "#fff";
  m.lineCap = "round";
  m.lineJoin = "round";
  m.lineWidth = st.brushFull * st.previewScale;
  m.beginPath();
  m.arc(p.x, p.y, m.lineWidth / 2, 0, Math.PI * 2);
  m.fill();
  m.beginPath();
  m.moveTo(p.x, p.y);
  addDirty(st.strokeBBox.x, st.strokeBBox.y, st.strokeBBox.w, st.strokeBBox.h);
}

function strokeTo(p) {
  if (!st.drawing) return;
  const m = st.mctx;
  const bb = segBBox(st.last.x, st.last.y, p.x, p.y);
  captureTiles(bb);
  m.lineTo(p.x, p.y);
  m.stroke();
  m.beginPath();
  m.moveTo(p.x, p.y);
  addDirty(bb.x, bb.y, bb.w, bb.h);
  // grow the stroke bbox
  const sb = st.strokeBBox;
  const x0 = Math.min(sb.x, bb.x), y0 = Math.min(sb.y, bb.y);
  const x1 = Math.max(sb.x + sb.w, bb.x + bb.w), y1 = Math.max(sb.y + sb.h, bb.y + bb.h);
  st.strokeBBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  pushPoint(p.x, p.y);
  st.last = p;
}

function endStroke() {
  if (!st.drawing) return;
  const m = st.mctx;
  m.stroke();
  m.restore(); // restore gco
  if (st.autoFill && st.ptsN >= 6 && closedEnough()) fillClosedShape();
  pushUndo({ tiles: st.strokeTiles });
  st.strokeTiles = null;
  st.drawing = null;
  st.strokeBBox = null;
}

function closedEnough() {
  const dx = st.ptsX[st.ptsN - 1] - st.ptsX[0];
  const dy = st.ptsY[st.ptsN - 1] - st.ptsY[0];
  const d = Math.hypot(dx, dy);
  return d <= Math.max(st.brushFull * st.previewScale * 0.75, 10);
}

// Fill the interior of a closed shape (evenodd scanline) using a temp canvas,
// then a single drawImage onto the mask.
function fillClosedShape() {
  const bb = st.strokeBBox;
  captureTiles(bb);
  const t = st.tempCtx;
  t.save();
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.clearRect(0, 0, st.pw, st.ph);
  t.fillStyle = "#fff";
  t.beginPath();
  t.moveTo(st.ptsX[0], st.ptsY[0]);
  for (let i = 1; i < st.ptsN; i++) t.lineTo(st.ptsX[i], st.ptsY[i]);
  t.closePath();
  t.fill("evenodd");
  t.restore();
  const m = st.mctx;
  m.save();
  m.globalCompositeOperation = st.drawing.mode === "erase" ? "destination-out" : "source-over";
  m.drawImage(st.tempCanvas, 0, 0);
  m.restore();
  addDirty(bb.x, bb.y, bb.w, bb.h);
}

/* ------------------- undo / redo (lazy tile snapshot) ------------------- */
function tileCols() { return Math.ceil(st.pw / TILE); }

// Save the tiles touched by the rect (once per stroke) BEFORE modifying them.
// This way undo only stores the area that actually changed.
function captureTiles(bb) {
  if (!st.strokeTiles || !bb) return;
  const cols = tileCols();
  const maxTy = Math.ceil(st.ph / TILE) - 1;
  const tx0 = clamp(Math.floor(bb.x / TILE), 0, cols - 1);
  const ty0 = clamp(Math.floor(bb.y / TILE), 0, maxTy);
  const tx1 = clamp(Math.floor((bb.x + bb.w - 1) / TILE), 0, cols - 1);
  const ty1 = clamp(Math.floor((bb.y + bb.h - 1) / TILE), 0, maxTy);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const idx = ty * cols + tx;
      if (st.strokeTiles.has(idx)) continue;
      const x = tx * TILE, y = ty * TILE;
      const w = Math.min(TILE, st.pw - x), h = Math.min(TILE, st.ph - y);
      st.strokeTiles.set(idx, st.mctx.getImageData(x, y, w, h));
    }
  }
}

function pushUndo(entry) {
  if (!entry.tiles || entry.tiles.size === 0) return;
  st.undoStack.push(entry);
  if (st.undoStack.length > MAX_UNDO) st.undoStack.shift();
  st.redoStack.length = 0;
  updateToolbar();
}

function undo() {
  const now = Date.now();
  if (now - (undo._last || 0) < 200) return;
  undo._last = now;
  const entry = st.undoStack.pop();
  if (!entry) return;
  const cols = tileCols();
  const redoEntry = { tiles: new Map() };
  for (const [idx, img] of entry.tiles) {
    const x = (idx % cols) * TILE, y = Math.floor(idx / cols) * TILE;
    redoEntry.tiles.set(idx, st.mctx.getImageData(x, y, img.width, img.height));
    st.mctx.putImageData(img, x, y);
  }
  renderAll();
  requestAnimationFrame(() => { if (st) renderAll(); });
  st.redoStack.push(redoEntry);
  updateToolbar();
}

function redo() {
  const now = Date.now();
  if (now - (redo._last || 0) < 200) return;
  redo._last = now;
  const entry = st.redoStack.pop();
  if (!entry) return;
  const cols = tileCols();
  const undoEntry = { tiles: new Map() };
  for (const [idx, img] of entry.tiles) {
    const x = (idx % cols) * TILE, y = Math.floor(idx / cols) * TILE;
    undoEntry.tiles.set(idx, st.mctx.getImageData(x, y, img.width, img.height));
    st.mctx.putImageData(img, x, y);
  }
  renderAll();
  requestAnimationFrame(() => { if (st) renderAll(); });
  st.undoStack.push(undoEntry);
  updateToolbar();
}

function clearAll() {
  if (!st) return;
  const entry = { tiles: new Map() };
  const cols = tileCols();
  const rows = Math.ceil(st.ph / TILE);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x = tx * TILE, y = ty * TILE;
      const w = Math.min(TILE, st.pw - x), h = Math.min(TILE, st.ph - y);
      const d = st.mctx.getImageData(x, y, w, h).data;
      let has = false;
      for (let i = 3; i < d.length; i += 4) { if (d[i] !== 0) { has = true; break; } }
      if (has) {
        entry.tiles.set(ty * cols + tx, st.mctx.getImageData(x, y, w, h));
        st.mctx.clearRect(x, y, w, h);
      }
    }
  }
  renderAll();
  requestAnimationFrame(() => { if (st) renderAll(); });
  pushUndo(entry);
}

/* ------------------------------ toolbar / state ------------------------------ */
function setMode(mode) { st.mode = mode; updateToolbar(); }
function toggleMode() { setMode(st.mode === "paint" ? "erase" : "paint"); }

function setBrush(sizeFull, fromKeyboard) {
  st.brushFull = clamp(Math.round(sizeFull), 1, Math.min(st.fullW, st.fullH));
  ui.brushSlider.value = String(st.brushFull);
  if (!fromKeyboard) showBrushBadge();
  st.cursorDirty = true;
  updateToolbar();
}

// Mask blur (0..100 percent). blurPx = the Gaussian radius used on the
// preview canvas for the real-time B/W preview, based on the image size.
function blurRadiusPx() {
  return (st.blurPct / 100) * (Math.min(st.pw, st.ph) / 8);
}

// Coalesce full repaints while the blur is being dragged: at most one per
// animation frame, so the mask blurs in real time without extra cost.
function queueBlurRender() {
  if (!st || st._blurRender) return;
  st._blurRender = true;
  requestAnimationFrame(() => {
    if (!st) return;
    st._blurRender = false;
    renderAll();
  });
}

function setBlur(pct, fromSizing) {
  const v = clamp(Math.round(pct), 0, 100);
  if (v === st.blurPct) { ui.blurSlider.value = String(v); return; }
  st.blurPct = v;
  ui.blurSlider.value = String(v);
  ui.stBlur.textContent = v + "%";
  // the whole mask display changes whenever blur changes -> repaint everything
  queueBlurRender();
  st.cursorDirty = true;
}

// Live brush preview in the middle of the canvas: an actual circle with the
// current brush diameter (screen pixels) instead of a number; the inner dashed
// circle grows/shrinks with the mask blur amount. Auto-hides shortly after the
// value stops changing.
let brushBadgeTimer = 0;
let lastRightClickMs = 0;
function showBrushBadge() {
  if (!ui || !st) return;
  const d = Math.max(12, Math.round(st.brushFull * st.previewScale * st.view.scale));
  ui.brushBadge.style.width = d + "px";
  ui.brushBadge.style.height = d + "px";
  if (st.blurPct > 0) {
    const innerD = Math.max(6, Math.round(d * st.blurPct / 100));
    ui.brushBadgeInner.style.width = innerD + "px";
    ui.brushBadgeInner.style.height = innerD + "px";
    ui.brushBadgeInner.style.display = "block";
  } else {
    ui.brushBadgeInner.style.display = "none";
  }
  ui.brushBadge.classList.remove("fm-hidden");
  clearTimeout(brushBadgeTimer);
  brushBadgeTimer = setTimeout(() => ui.brushBadge.classList.add("fm-hidden"), 800);
}

// Immediately hide the centered brush badge (used when a toolbar slider is
// released - the 800ms auto-hide of showBrushBadge would otherwise keep the
// preview visible briefly after the interaction finished).
function hideBrushBadge() {
  if (brushBadgeTimer) { clearTimeout(brushBadgeTimer); brushBadgeTimer = 0; }
  if (ui && ui.brushBadge) ui.brushBadge.classList.add("fm-hidden");
}

function toggleFill() { st.autoFill = !st.autoFill; updateToolbar(); }

// After a toolbar slider interaction ends the whole canvas is repainted a few
// times (immediately + next frame + shortly after). Dirty-rect / GPU tiling
// can leave thin stale seams that otherwise only disappear when the cursor
// happens to repaint the tile - the same pattern as the resize-drag cleanup.
function refreshCanvas() {
  if (!st) return;
  renderAll();
  requestAnimationFrame(() => { if (st) renderAll(); });
  setTimeout(() => { if (st) renderAll(); }, 120);
}

function toggleShowMask() {
  st.maskLocked = !st.maskLocked;
  renderAll();
  updateToolbar();
}

function updateToolbar() {
  if (!st || !ui) return;
  const isErase = st.mode === "erase";
  ui.modeBtn.classList.toggle("active", isErase);
  ui.paintLabel.classList.toggle("active", !isErase);
  ui.eraseLabel.classList.toggle("active", isErase);
  ui.fillToggle.classList.toggle("active", st.autoFill);
  ui.showMask.classList.toggle("active", st.maskLocked);
  ui.stBrush.textContent = st.brushFull + " px";
  ui.stBlur.textContent = st.blurPct + "%";
  ui.stZoom.textContent = Math.round(st.view.scale * 100) + "%";
}

/* ------------------------------ UI events ------------------------------ */
function wireUI() {
  const v = ui.viewport;

  ui.modeBtn.addEventListener("click", () => { if (st) toggleMode(); });
  ui.paintLabel.addEventListener("click", () => { if (st && st.mode !== "paint") setMode("paint"); });
  ui.eraseLabel.addEventListener("click", () => { if (st && st.mode !== "erase") setMode("erase"); });
  ui.clearAll.addEventListener("click", () => clearAll());
  ui.undoBtn.addEventListener("click", () => undo());
  ui.redoBtn.addEventListener("click", () => redo());
  ui.brushSlider.addEventListener("input", (e) => { if (st) setBrush(+e.target.value); e.target.blur(); });
  ui.blurSlider.addEventListener("input", (e) => { if (st) { setBlur(+e.target.value); showBrushBadge(); } e.target.blur(); });
  // once the slider drag/step is committed, wipe any leftover tiling artifacts
  // and drop the centered brush preview immediately
  ui.brushSlider.addEventListener("change", () => { refreshCanvas(); hideBrushBadge(); });
  ui.blurSlider.addEventListener("change", () => { refreshCanvas(); hideBrushBadge(); });
  ui.hatchBtn.addEventListener("click", () => ui.colorInput.click());
  ui.colorInput.addEventListener("input", (e) => {
    if (!st) return;
    st.hatchColor = e.target.value;
    ui.swatch.style.background = st.hatchColor;
    makeHatch();
    renderAll();
  });
  ui.fillToggle.addEventListener("click", () => toggleFill());
  ui.showMask.addEventListener("mouseenter", () => {
    if (st && !st.maskLocked) { st.bwHover = true; renderAll(); }
  });
  ui.showMask.addEventListener("mouseleave", () => {
    if (st && st.bwHover) { st.bwHover = false; renderAll(); }
  });
  ui.showMask.addEventListener("click", () => toggleShowMask());
  ui.fitBtn.addEventListener("click", () => fitView());
  ui.cancelBtn.addEventListener("click", () => closeEditor());
  ui.okBtn.addEventListener("click", () => saveAndClose());
  ui.overlay.addEventListener("contextmenu", (e) => e.preventDefault());
  v.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  // right-button double click: clear the whole mask (dblclick is unreliable for
  // right button in some browsers, so we also detect it manually on pointerdown)
  v.addEventListener("dblclick", (e) => {
    if (e.button === 2 && st) { e.preventDefault(); clearAll(); }
  });

  v.addEventListener("pointerdown", (e) => {
    if (!st) return;
    e.preventDefault();
    v.setPointerCapture(e.pointerId);
    if (st.sizing || st.panning) return;
    st.suppressFollow = false; // any new press resumes normal cursor-follow
    const p = toCanvas(e);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.button === 0) {
      const p = toCanvas(e);
      // anchor the brush center where the resize starts; it stays fixed while
      // the diameter changes (the circle grows/shrinks from its center).
      // Vertical drag changes the brush size, horizontal drag changes the blur,
      // with a deadzone / axis lock so a slightly tilted drag only affects ONE.
      st.cursor.x = p.x; st.cursor.y = p.y; st.cursor.inside = true; st.cursorDirty = true;
      st.sizing = { x: e.clientX, y: e.clientY, size: st.brushFull, blur: st.blurPct, axis: null };
      st.suppressFollow = true; // don't let the brush follow the mouse until next click
      return;
    }
    if (e.button === 1 || (st.spaceDown && e.button === 0)) {
      if (st.drawing) return;
      st.panning = { x: e.clientX, y: e.clientY, vx: st.view.x, vy: st.view.y };
      v.classList.add("fm-panning");
      return;
    }
    if (st.drawing) return;
    if (e.button === 0) { startStroke(p, st.mode); return; }
    if (e.button === 2) {
      const now = Date.now();
      if (now - lastRightClickMs < 350) {
        lastRightClickMs = 0;
        clearAll();
        return;
      }
      lastRightClickMs = now;
      startStroke(p, "erase"); return;
    }
  });

  v.addEventListener("pointermove", (e) => {
    if (!st) return;
    if (st.sizing) {
      const s = st.sizing;
      const dx = e.clientX - s.x, dy = s.y - e.clientY; // dy > 0 = upward
      const ax = Math.abs(dx), ay = Math.abs(dy);
      const DEADZONE = 20, SWITCH = 90; // px
      if (!s.axis) {
        // ignore small initial jitter, then lock to the dominant direction
        if (Math.max(ax, ay) < DEADZONE) return;
        s.axis = ay >= ax ? "size" : "blur";
      } else if (s.axis === "size" && ax > ay + SWITCH) {
        // clearly switched to horizontal: re-anchor and continue on the blur axis
        s.axis = "blur";
        s.blur = st.blurPct; s.x = e.clientX; s.y = e.clientY; s.size = st.brushFull;
      } else if (s.axis === "blur" && ay > ax + SWITCH) {
        // clearly switched to vertical: re-anchor and continue on the size axis
        s.axis = "size";
        s.size = st.brushFull; s.x = e.clientX; s.y = e.clientY; s.blur = st.blurPct;
      }
      if (s.axis === "size") {
        // horizontal jitter is ignored -> only the vertical component matters
        setBrush(s.size + (s.y - e.clientY) * Math.max(1, st.fullH / 400), true);
      } else if (s.axis === "blur") {
        // vertical jitter is ignored -> only the horizontal component matters
        setBlur(s.blur + (e.clientX - s.x) * Math.max(1, st.fullH / 1600), true);
      }
      // throttle a full repaint while sizing — dirty-rect-only updates can leave
      // thin GPU seams that otherwise only disappear when the brush repaints.
      if (!st._sizingRefresh) {
        st._sizingRefresh = setTimeout(() => { if (st) { renderAll(); st._sizingRefresh = null; } }, 350);
      }
      return;
    }
    const p = toCanvas(e);
    const c = st.cursor;
    const isInside = p.x >= 0 && p.x < st.pw && p.y >= 0 && p.y < st.ph;
    if (!st.suppressFollow) {
      if (c.inside !== isInside || c.x !== p.x || c.y !== p.y) {
        c.x = p.x; c.y = p.y; c.inside = isInside;
        st.cursorDirty = true;
        ui.viewport.classList.toggle("fm-outside", !isInside);
      }
    } else if (c.inside !== isInside) {
      c.inside = isInside;
      st.cursorDirty = true;
      ui.viewport.classList.toggle("fm-outside", !isInside);
    }
    if (st.panning) {
      st.view.x = st.panning.vx + (e.clientX - st.panning.x);
      st.view.y = st.panning.vy + (e.clientY - st.panning.y);
      applyTransform();
      return;
    }
    if (st.drawing) strokeTo(p);
  });

  v.addEventListener("pointerup", (e) => {
    if (!st) return;
    if (st.sizing) {
      st.sizing = null;
      if (st._sizingRefresh) { clearTimeout(st._sizingRefresh); st._sizingRefresh = null; }
      // resume normal cursor-follow and place the brush at the pointer so it
      // reappears immediately (it was anchored/frozen during the resize)
      const p = toCanvas(e);
      if (p) { st.cursor.x = p.x; st.cursor.y = p.y; st.cursor.inside = true; }
      st.suppressFollow = false;
      st.cursorDirty = true;
      // GPU tiling can leave thin stale seams after a sizing drag; force a
      // full repaint now and once more on the next frame to clear it. Without
      // this the artifact stays until the cursor happens to repaint the tile.
      renderAll();
      requestAnimationFrame(() => { if (st) renderAll(); });
      setTimeout(() => { if (st) renderAll(); }, 120);
      return;
    }
    if (st.panning) { st.panning = null; v.classList.remove("fm-panning"); return; }
    if (st.drawing) endStroke();
  });

  v.addEventListener("pointerleave", () => {
    if (!st) return;
    st.cursor.inside = false;
    st.cursorDirty = true;
    ui.viewport.classList.add("fm-outside");
  });
  v.addEventListener("pointerenter", (e) => {
    if (!st) return;
    const p = toCanvas(e);
    const isInside = p.x >= 0 && p.x < st.pw && p.y >= 0 && p.y < st.ph;
    st.cursor.inside = isInside;
    st.cursorDirty = true;
    ui.viewport.classList.toggle("fm-outside", !isInside);
  });

  v.addEventListener("wheel", (e) => {
    if (!st) return;
    e.preventDefault();
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      setBrush(st.brushFull * (e.deltaY < 0 ? 1.08 : 1 / 1.08), true);
      return;
    }
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  window.addEventListener("keydown", (e) => onKey(e, true), true);
  window.addEventListener("keyup", (e) => onKey(e, false), true);
}

/* ------------------------------ keyboard ------------------------------ */
let lastUndoMs = 0;
function onKey(e, down) {
  if (!st) return;
  if (e.repeat) return;
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;

  if (down && k === "Enter") { e.preventDefault(); saveAndClose(); return; }
  if (down && k === "Escape") { e.preventDefault(); closeEditor(); return; }

  if (mod && (k === "z" || k === "Z")) {
    e.preventDefault();
    if (!st.drawing) {
      const now = Date.now();
      if (now - lastUndoMs < 250) return;
      lastUndoMs = now;
      if (e.shiftKey) redo(); else undo();
    }
    return;
  }
  if (mod && (k === "y" || k === "Y")) {
    e.preventDefault();
    if (!st.drawing) {
      const now = Date.now();
      if (now - lastUndoMs < 250) return;
      lastUndoMs = now;
      redo();
    }
    return;
  }
  if (mod && k === "0") { e.preventDefault(); fitView(); return; }
  if (mod && (k === "Delete")) { e.preventDefault(); if (!st.drawing) clearAll(); return; }

  if (e.code === "Space") {
    e.preventDefault();
    st.spaceDown = down;
    ui.viewport.classList.toggle("fm-pan", down);
    return;
  }

  if (!down) {
    if (k === "m" || k === "M") {
      if (st.bwHover) { st.bwHover = false; renderAll(); }
    }
    return;
  }
  if (e.repeat) return;

  switch (k.toLowerCase()) {
    case "x":
    case "b":
    case "e":
      toggleMode();
      break;
    case "m":
      if (!st.bwHover && !st.maskLocked) { st.bwHover = true; renderAll(); }
      break;
    case "f":
      toggleFill();
      break;
    case "c":
      ui.colorInput.click();
      break;
    case "[":
      setBrush(st.brushFull * 0.9, true);
      break;
    case "]":
      setBrush(st.brushFull * 1.1, true);
      break;
    case "+":
    case "=":
      zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2);
      break;
    case "-":
      zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2);
      break;
  }
}

/* --------------------- save: full-resolution export --------------------- */
// From the preview-resolution mask canvas a single drawImage builds the
// full-res Uint8Array/ImageData (RGB = white, A = mask), uploaded as PNG via
// the ComfyUI /upload/image API (subfolder: fastmask).
async function buildFullResMask() {
  const full = document.createElement("canvas");
  full.width = st.fullW; full.height = st.fullH;
  const fctx = full.getContext("2d");
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = "high";
  // the blur set in the editor is applied to the exported full-res mask too
  const blurFull = st.blurPct > 0 ? (st.blurPct / 100) * (Math.min(st.fullW, st.fullH) / 8) : 0;
  // GPU-composited white mask: fill white, then punch the (blurred) mask into
  // the alpha channel. Same result as the old per-pixel ImageData loop, but
  // fully GPU-accelerated - no 67MB getImageData/putImageData round-trip on
  // large images, so the OK save is several times faster.
  fctx.fillStyle = "#fff";
  fctx.fillRect(0, 0, st.fullW, st.fullH);
  fctx.globalCompositeOperation = "destination-in";
  if (blurFull > 0) fctx.filter = "blur(" + blurFull + "px)";
  fctx.drawImage(st.maskCanvas, 0, 0, st.fullW, st.fullH);
  fctx.filter = "none";
  fctx.globalCompositeOperation = "source-over";
  return full;
}

async function saveAndClose() {
  if (!st) return;
  ui.okBtn.disabled = true;
  ui.okBtn.textContent = "Saving...";
  try {
    const full = await buildFullResMask();
    const blob = await new Promise((res) => full.toBlob(res, "image/png"));
    const name = "fastmask_node" + st.node.id + ".png";
    const fd = new FormData();
    fd.append("image", blob, name);
    fd.append("overwrite", "true");
    fd.append("type", "input");
    fd.append("subfolder", "fastmask");
    const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error("upload failed: " + r.status);
    const j = await r.json();
    // ComfyUI's /upload/image responds with `name` (not `filename`), and
    // `subfolder` may be null when at the root. Build the mask_path robustly.
    const fname = j.name || j.filename;
    if (!fname) throw new Error("upload response missing filename");
    const sub = j.subfolder || "";
    const path = sub ? sub + "/" + fname : fname;
    // Composite preview for the node display: color image + vivid mask in the
    // hatch color, generated ONCE here as a small JPEG (max 1024px). The node
    // only ever displays this ready-made file - it never composites/renders
    // the mask itself, so there is zero continuous generation cost.
    try {
      const maxC = 1024;
      const cs = Math.min(1, maxC / Math.max(st.fullW, st.fullH));
      const cw = Math.max(1, Math.round(st.fullW * cs));
      const chh = Math.max(1, Math.round(st.fullH * cs));
      const cc = document.createElement("canvas");
      cc.width = cw; cc.height = chh;
      const cctx = cc.getContext("2d");
      cctx.drawImage(st.img, 0, 0, cw, chh);
      // mask (already blurred, full-res) becomes the alpha of the hatch color
      const tc = document.createElement("canvas");
      tc.width = cw; tc.height = chh;
      const tctx = tc.getContext("2d");
      tctx.fillStyle = st.hatchColor || "#ff3fd8";
      tctx.fillRect(0, 0, cw, chh);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(full, 0, 0, cw, chh);
      cctx.globalAlpha = 0.75;
      cctx.drawImage(tc, 0, 0);
      cctx.globalAlpha = 1;
      const compBlob = await new Promise((res) => cc.toBlob(res, "image/jpeg", 0.85));
      if (compBlob) {
        const cfd = new FormData();
        cfd.append("image", compBlob, "fastmask_node" + st.node.id + "_composite.jpg");
        cfd.append("overwrite", "true");
        cfd.append("type", "input");
        cfd.append("subfolder", "fastmask");
        const cr = await api.fetchApi("/upload/image", { method: "POST", body: cfd });
        if (!cr.ok) throw new Error("composite upload failed: " + cr.status);
      }
      // tell the node to load the fresh composite immediately (no polling)
      try { if (window.__fmCompSync && window.__fmCompSync[st.node.id]) window.__fmCompSync[st.node.id](); } catch (e) {}
    } catch (e) { /* composite is best-effort; mask saving already succeeded */ }
    const w = (st.node.widgets || []).find((w) => w.name === "mask_path");
    if (w) {
      // keep BOTH the widget value AND the serialized widgets_values in sync:
      // only setting `.value` silently drops the mask path on graph save/reload
      // and the editor then restores the original (empty) mask.
      w.value = path;
      const idx = (st.node.widgets || []).indexOf(w);
      if (idx >= 0 && st.node.widgets_values) st.node.widgets_values[idx] = path;
      // ComfyUI's high-level setter also marks the graph dirty / triggers the
      // widget callback so the node picks the new mask path up on next run.
      try { if (typeof st.node.setWidgetValue === "function") st.node.setWidgetValue("mask_path", path); } catch (e) {}
      if (w.callback) w.callback(path);
    }
    app.graph.setDirtyCanvas(true, false);
    closeEditor();
  } catch (err) {
    toast("FastMask", "Save failed: " + err, "error");
  } finally {
    if (ui) {
      ui.okBtn.disabled = false;
      ui.okBtn.textContent = "OK";
    }
  }
}

/* --------------------------- ComfyUI extension --------------------------- */
function fmLog(...args) {
  try { console.log("%c[FastMask]", "color:#4a90d9;font-weight:bold", ...args); } catch (e) {}
}
window.__fastmaskDebug = fmLog;

function fmEditorClick(node) {
  try {
    Promise.resolve(openEditor(node)).catch((err) => {
      console.error("[FastMask] editor open error:", err);
      try { toast("FastMask", "Editor error: " + err.message, "error"); } catch (e2) {}
    });
  } catch (err) {
    console.error("[FastMask] editor open error:", err);
    try { alert("[FastMask] error: " + err.message); } catch (e2) {}
  }
}

function wireImageMaskReset(node) {
  // when the source image changes, drop the previously painted mask - it no
  // longer corresponds to the new image (otherwise the old mask reappears)
  try {
    const imgW = (node.widgets || []).find((w) => w.name === "image");
    if (!imgW || imgW._fmClear) return;
    imgW._fmClear = true;
    const orig = imgW.callback;
    imgW.callback = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;
      const cur = imgW.value;
      // a pasted/uploaded file is not in the combo list computed at startup -
      // add it so the frontend combo validation does not reject the value
      if (imgW.options && Array.isArray(imgW.options.values) && !imgW.options.values.includes(cur)) {
        imgW.options.values.push(cur);
      }
      if (imgW._fmLast === undefined) { imgW._fmLast = cur; return r; }
      if (imgW._fmLast !== cur) {
        const mp = (node.widgets || []).find((w) => w.name === "mask_path");
        if (mp) {
          mp.value = "";
          if (typeof mp.callback === "function") { try { mp.callback.call(mp, mp.value); } catch (e) {} }
        }
      }
      imgW._fmLast = cur;
      return r;
    };
  } catch (e) { /* no-op */ }
}

function makeOpenButtonEl(node) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = "Edit Mask v" + FM_VERSION;
  el.setAttribute("data-fastmask-open", "1"); // never let hideNativeMaskButtons() hide our own button
  el.style.cssText =
    "display:block;width:100%;height:32px;min-height:32px;max-height:32px;box-sizing:border-box;flex:none;" +
    "background:#2563eb;color:#fff;border:1px solid #1d4ed8;border-radius:6px;" +
    "cursor:pointer;font-size:13px;font-weight:600;padding:0 10px;font-family:inherit;line-height:30px;text-align:center;pointer-events:auto";
  el.addEventListener("mouseenter", () => { el.style.background = "#1d4ed8"; });
  el.addEventListener("mouseleave", () => { el.style.background = "#2563eb"; });
  el.addEventListener("pointerdown", (e) => e.stopPropagation()); // do not drag the node
  el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fmEditorClick(node); });
  return el;
}

function makeVersionEl() {
  const el = document.createElement("div");
  el.textContent = "FastMask v" + FM_VERSION;
  el.style.cssText =
    "text-align:center;color:#8cf;font:600 11px/1.3 system-ui,Segoe UI,sans-serif;" +
    "padding:2px 0 1px;box-sizing:border-box;pointer-events:none;user-select:none";
  return el;
}

// Strip any stale FastMask widget from a node: old canvas buttons that render
// as a static "FastMask" oval, old DOM widgets, etc. We always re-add exactly
// ONE fresh button afterwards, so removing everything stale first is safe.
// Our own widget (fm_open) is preserved; fm_version is now removed (version
// is shown inside the Edit Mask button).
function stripStaleWidgets(node) {
  const widgets = node.widgets || [];
  for (let i = widgets.length - 1; i >= 0; i--) {
    const w = widgets[i];
    if (!w) continue;
    if (w.name === "fm_open") continue; // keep our own button
    const nm = String(w.name || "").toLowerCase();
    const lb = String(w.label || w.name || "").toLowerCase();
    const elText = (w.element && w.element.textContent) ? w.element.textContent.toLowerCase() : "";
    const safe = /upload|refresh|browse|choose|load|folder|preview|image/i.test(nm + " " + lb);
    const isFastmask =
      nm.indexOf("fastmask") !== -1 || nm.indexOf("mask editor") !== -1 || nm.indexOf("edit mask") !== -1 ||
      lb.indexOf("fastmask") !== -1 || lb.indexOf("edit mask") !== -1 ||
      elText.indexOf("fastmask") !== -1 || elText.indexOf("edit mask") !== -1;
    // a stale canvas "button" / DOM widget renders as an oval snapshot on the
    // canvas (the old FastMask button). Remove any such widget that is NOT a
    // built-in upload/refresh/preview control.
    const isStaleButton = (w.type === "button" || w.type === "DOM" || w.type === "custom") && !safe;
    if (isFastmask || isStaleButton) {
      widgets.splice(i, 1);
      fmLog("previous FastMask widget removed:", w.name || w.label || "(unnamed)");
    }
  }
}

function alignPreviewTop(node) {
  try {
    const wOpen = node.widgets && node.widgets.find((x) => x.name === "fm_open");
    const nodeEl = wOpen && wOpen.element ? (wOpen.element.closest("[data-node-id]") || document.querySelector(`[data-node-id="${node.id}"]`)) : document.querySelector(`[data-node-id="${node.id}"]`);
    if (!nodeEl) return;
    // (no display/flex changes here - forcing display:flex on ComfyUI's node
    // containers collapses the preview img inside it and hides the image)
    const preview = findNodePreview(nodeEl);
    if (!preview) {
      // preview not yet rendered — the gap is the collapsed button's slot (34px)
      // pull the node content up by shrinking the node; the next call after
      // preview appears will fine-tune.
      try { if (node.size) { node.size[1] = Math.max(320, node.size[1] - 8); if (node.setDirtyCanvas) node.setDirtyCanvas(true,true); } } catch(e){}
      return;
    }
    const pbox = preview.closest(".comfy-widget") || preview.parentElement;
    if (pbox) {
      pbox.style.setProperty("margin-top", "6px", "important");
      pbox.style.setProperty("padding-top", "0", "important");
      pbox.style.setProperty("top", "auto", "important");
      // flex-only: align the preview to the top if any container is a flex column
      pbox.style.setProperty("align-self", "flex-start", "important");
    }
    // the image fills the FULL WIDTH of the node; height follows automatically
    // so the aspect ratio is always preserved (no distortion)
    if (preview.tagName === "IMG") {
      preview.style.setProperty("width", "100%", "important");
      preview.style.setProperty("height", "auto", "important");
      preview.style.setProperty("object-fit", "contain", "important");
    }
    // top-align every widget container WITHOUT touching display/flex of children.
    // These properties are no-ops on static blocks and only take effect in the
    // (already-flex) node containers, where they stop the vertical centering
    // that leaves a large empty gap at the top when the node is resized bigger.
    const containers = nodeEl.querySelectorAll(".comfy-node-content, .comfy-node-widgets, .comfy-widgets, .node-content, .node-widgets");
    for (const c of containers) {
      c.style.setProperty("justify-content", "flex-start", "important");
      c.style.setProperty("align-content", "flex-start", "important");
    }
    // also collapse any empty widget row that LiteGraph left for the now-absolute button
    try {
      const widgetsEl = nodeEl.querySelector(".comfy-widgets, .node-widgets");
      if (widgetsEl) widgetsEl.style.setProperty("gap", "0", "important");
    } catch(e){}
  } catch (e) { /* no-op */ }
}

function positionBottom(node) {
  try {
    const wOpen = node.widgets && node.widgets.find((x) => x.name === "fm_open");
    // The button is a NORMAL in-flow DOM widget: ComfyUI positions the widget
    // wrapper itself, so the button ALWAYS moves / zooms / resizes together
    // with the node and the other elements - with zero JS syncing.
    // (The previous approach pinned it with position:absolute + a top computed
    // from screen rects; that value went stale as soon as the node was moved,
    // leaving the button fixed on the screen while the node drifted away.)
    try {
      if (wOpen) {
        // give the widget its natural 34px slot back in the widget flow
        wOpen.computeSize = () => [-1, 34];
        const el = wOpen.element;
        if (el) {
          const box = el.closest(".comfy-widget") || el.parentElement;
          if (box) {
            // undo every override from the old absolute-pin layout
            box.style.removeProperty("top");
            box.style.removeProperty("left");
            box.style.removeProperty("right");
            box.style.removeProperty("bottom");
            box.style.setProperty("position", "static", "important");
            box.style.setProperty("width", "100%", "important");
            box.style.setProperty("height", "34px", "important");
            box.style.setProperty("z-index", "auto", "important");
            box.style.setProperty("margin-top", "8px", "important");
          }
        }
      }
    } catch (e) {}
    // remove the extra bottom padding that was only needed by the old
    // absolute layout, so no empty stripe stays at the bottom of the node
    try {
      if (node._fmBottomPad) {
        node.size[1] = Math.max(220, (node.size[1] || 300) - node._fmBottomPad);
        node._fmBottomPad = 0;
        if (node.onResize) try { node.onResize(node.size); } catch (e) {}
        if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
      }
    } catch (e) {}
    // sane minimum height
    try {
      const minH = 240;
      if (node.size && node.size[1] < minH) {
        node.size[1] = minH;
        if (node.onResize) try { node.onResize(node.size); } catch (e) {}
        if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
      }
    } catch (e) {}
    alignPreviewTop(node);
    // hide any stale version label or grey pill
    const nodeEl = wOpen && wOpen.element ? (wOpen.element.closest("[data-node-id]") || document.querySelector(`[data-node-id="${node.id}"]`) || wOpen.element.parentElement) : document.querySelector(`[data-node-id="${node.id}"]`);
    if (nodeEl) {
      nodeEl.querySelectorAll("*").forEach((el) => {
        if (el.id === "fm_open" || (el.closest && el.closest("#fm_open"))) return;
        const t = (el.textContent || "").trim();
        if ((t === "FastMask" || t.indexOf("FastMask v") === 0) && el.offsetWidth > 0 && el.offsetWidth < 180 && el.offsetHeight > 0 && el.offsetHeight < 32) {
          // keep the button itself, hide only the old separate label/pill
          if (el.id !== "fm_open") el.style.setProperty("display", "none", "important");
        }
      });
    }
  } catch (e) { /* no-op */ }
}
function findNodePreview(nodeEl) {
  if (!nodeEl) return null;
  // ComfyUI preview is usually an <img> with /view? or a <canvas>; the node's
  // own preview area is the largest image/canvas inside the node.
  const candidates = nodeEl.querySelectorAll("img, canvas");
  let best = null, bestArea = 0;
  for (const el of candidates) {
    if (el.id === "fm_open" || (el.closest && el.closest("#fm_open"))) continue;
    // NEVER treat our own composite overlay as the preview - findNodePreview
    // returning the overlay made the overlay logic target itself (the mask
    // then silently disappeared after any frontend re-render)
    if (el.classList && el.classList.contains("fm-node-tint")) continue;
    // preview images have a /view? src or are sizable
    const isPreview = (el.tagName === "IMG" && el.src && el.src.includes("/view")) || el.tagName === "CANVAS";
    if (!isPreview && el.tagName === "IMG") {
      // fallback: any reasonably large image inside the node
      if (el.naturalWidth < 32 && el.naturalHeight < 32) continue;
    }
    const area = (el.offsetWidth || 100) * (el.offsetHeight || 100);
    if (area > bestArea) { bestArea = area; best = el; }
  }
  return best;
}

// Composite display on the node: the editor's OK button uploads a ready-made
// composite JPEG (color image + vivid mask, max 1024px) to
// fastmask/fastmask_node<id>_composite.jpg. The node only ever DISPLAYS that
// file as an <img> - no per-frame generation, no pixel loops, no timers.
// Repositioning on resize is layout-only (no re-fetch); a fresh composite is
// loaded only after the editor's OK button notifies us via __fmCompSync.
function enableNodeMaskOverlay(node) {
  try {
    const w = node.widgets && node.widgets.find((x) => x.name === "fm_open");
    if (!w || !w.element) return;
    const wrapper = w.element.closest(".comfy-widget") || w.element;
    const nodeEl = wrapper.closest("[data-node-id]") || document.querySelector(`[data-node-id="${node.id}"]`) || wrapper.parentElement;
    if (!nodeEl) return;
    const preview = findNodePreview(nodeEl);
    if (!preview) { setTimeout(() => enableNodeMaskOverlay(node), 900); return; }
    const box = preview.parentElement;
    if (!box) return;
    if (box._fmCompWired) return;
    box._fmCompWired = true;

    const compName = "fastmask_node" + node.id + "_composite.jpg";
    let lastPath = null;

    const reposition = () => {
      const ov = box._fmCompOv;
      if (!ov) return;
      // offset chain = layout px, invariant under the workspace zoom transform
      let left = 0, top = 0, nOff = preview;
      while (nOff && nOff !== box) { left += nOff.offsetLeft; top += nOff.offsetTop; nOff = nOff.offsetParent; }
      // The composite has the SAME aspect ratio as the source image, so it must
      // be placed on the image's ACTUAL rendered area (object-fit: contain /
      // cover / fill of the source image inside the preview box) - never
      // stretched over the whole preview rect, which would distort it.
      const pw = preview.offsetWidth, ph = preview.offsetHeight;
      const sw = preview.naturalWidth || preview.width || 0;
      const sh = preview.naturalHeight || preview.height || 0;
      let rw = pw, rh = ph;
      if (sw > 0 && sh > 0 && pw > 0 && ph > 0) {
        let fit = "fill";
        try { fit = getComputedStyle(preview).objectFit || "fill"; } catch (e) {}
        if (fit === "contain" || fit === "cover" || fit === "none" || fit === "scale-down") {
          const s = fit === "cover" ? Math.max(pw / sw, ph / sh) : Math.min(pw / sw, ph / sh);
          rw = Math.min(pw, sw * s);
          rh = Math.min(ph, sh * s);
          left += (pw - rw) / 2;
          top += (ph - rh) / 2;
        }
      }
      ov.style.left = left + "px";
      ov.style.top = top + "px";
      ov.style.width = rw + "px";
      ov.style.height = rh + "px";
      // overlay rect == image aspect exactly, so "fill" here keeps 1:1 scale
      ov.style.objectFit = "fill";
    };
    const refresh = (force) => {
      const mp = (node.widgets || []).find((x) => x.name === "mask_path");
      const cur = mp && mp.value ? String(mp.value) : null;
      if (!cur) {
        lastPath = null;
        if (box._fmCompOv) box._fmCompOv.style.display = "none";
        return;
      }
      if (!box._fmCompOv) {
        const ov = document.createElement("img");
        ov.className = "fm-node-tint";
        ov.style.cssText = "position:absolute;pointer-events:none;z-index:10;object-fit:fill;";
        ov.onerror = () => { ov.style.display = "none"; ov._fmFailed = lastPath; }; // no composite saved yet
        box.style.position = "relative";
        box.appendChild(ov);
        box._fmCompOv = ov;
      }
      const ov = box._fmCompOv;
      // self-heal: if the frontend re-rendered the node and dropped our
      // overlay from the DOM, re-attach it instead of staying invisible
      if (!ov.isConnected) box.appendChild(ov);
      ov.style.display = "block";
      // composite file not saved yet (pre-1.5.0 masks): stay hidden, do not
      // churn the network every tick; a forced refresh (OK) retries once
      if (ov._fmFailed === cur) {
        if (!force) { reposition(); return; }
        ov._fmFailed = null;
      }
      reposition();
      // new timestamped src ONLY when the mask path changed or OK notified us
      if (cur !== lastPath || force || !ov.src) {
        lastPath = cur;
        ov.src = api.apiURL("/view?" + new URLSearchParams({ filename: compName, subfolder: "fastmask", type: "input", _t: Date.now() }));
      }
    };
    // ultra-cheap self-heal tick: only ensures the overlay exists, is attached
    // and is positioned (NO image re-fetch unless mask_path changed). This
    // recovers the mask after any ComfyUI DOM re-render that removed it.
    // ALSO: when the source image (image widget) changes, the previously
    // painted mask no longer matches the new image - clear mask_path and hide
    // the stale composite so the old mask does NOT reappear on a new image.
    if (!box._fmCompTimer) {
      box._fmCompTimer = setInterval(() => {
        try {
          const mp = (node.widgets || []).find((x) => x.name === "mask_path");
          const imgW = (node.widgets || []).find((x) => x.name === "image");
          const imgVal = imgW ? String(imgW.value == null ? "" : imgW.value) : "";
          if (box._fmLastImgVal === undefined) {
            box._fmLastImgVal = imgVal; // first tick: just remember, do not clear
          } else if (imgVal !== box._fmLastImgVal) {
            box._fmLastImgVal = imgVal;
            // keep the combo list in sync with pasted/uploaded files so the
            // frontend validation accepts the new value
            if (imgW && imgW.options && Array.isArray(imgW.options.values) && !imgW.options.values.includes(imgVal)) {
              imgW.options.values.push(imgVal);
            }
            if (mp && mp.value) {
              mp.value = "";
              const idx = (node.widgets || []).indexOf(mp);
              if (idx >= 0 && node.widgets_values) node.widgets_values[idx] = "";
              if (typeof node.setWidgetValue === "function") { try { node.setWidgetValue("mask_path", ""); } catch (e) {} }
              if (typeof mp.callback === "function") { try { mp.callback.call(mp, mp.value); } catch (e) {} }
            }
            if (box._fmCompOv) box._fmCompOv.style.display = "none";
            lastPath = null;
          }
          if (!(mp && mp.value)) return;
          refresh(false);
        } catch (e) {}
      }, 2000);
    }
    // the editor's saveAndClose calls this right after uploading the composite
    window.__fmCompSync = window.__fmCompSync || {};
    window.__fmCompSync[node.id] = () => refresh(true);
    // cheap layout-only reposition on node resize - no image re-fetch
    if (!box._fmCompRO && typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(reposition);
      ro.observe(preview);
      box._fmCompRO = ro;
    }
    // the fit-rect needs naturalWidth/naturalHeight, which only exist AFTER the
    // preview image has loaded - re-measure then (aspect-correct placement)
    if (preview.tagName === "IMG" && !preview._fmCompLoadHook) {
      preview._fmCompLoadHook = true;
      preview.addEventListener("load", reposition);
    }
    // re-wire when the preview element itself is replaced (new image loaded).
    // Mutations caused by our own overlay (fm-node-tint img) are ignored.
    if (!box._fmCompObs) {
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type !== "childList") continue;
          for (const an of m.addedNodes) if (an && an.classList && an.classList.contains("fm-node-tint")) return;
          for (const rn of m.removedNodes) if (rn && rn.classList && rn.classList.contains("fm-node-tint")) return;
        }
        const np = findNodePreview(nodeEl);
        if (np && np !== preview) {
          box._fmCompWired = false;
          if (box._fmCompRO) { try { box._fmCompRO.disconnect(); } catch (e) {} box._fmCompRO = null; }
          enableNodeMaskOverlay(node);
        }
      });
      mo.observe(box, { childList: true, subtree: true });
      box._fmCompObs = mo;
    }
    refresh(false);
  } catch (e) { /* no-op */ }
}
function addOpenButton(node) {
  if (!node) return;
  stripStaleWidgets(node);
  // our own paste handlers (Ctrl+V and the right-click "Paste Image" menu
  // action both route through node.pasteFile / node.pasteFiles)
  installFastMaskPaste(node);

  // re-clean on the next frames too: some extensions (e.g. the built-in image
  // upload preview) add their widgets only AFTER the node is configured, so a
  // stale oval button can appear a tick later. Our own fm_open/fm_version are
  // preserved by stripStaleWidgets.
  try {
    requestAnimationFrame(() => { stripStaleWidgets(node); positionBottom(node); enableNodeMaskOverlay(node); });
    setTimeout(() => { stripStaleWidgets(node); positionBottom(node); enableNodeMaskOverlay(node); }, 0);
    setTimeout(() => { stripStaleWidgets(node); positionBottom(node); enableNodeMaskOverlay(node); }, 300);
    setTimeout(() => { positionBottom(node); enableNodeMaskOverlay(node); }, 900);
    setTimeout(() => { positionBottom(node); }, 1800);
  } catch (e) { /* no-op */ }

  // PROVEN PATTERN - exactly how one-node-flux-2-klein builds its working
  // buttons: a DOM widget whose body is a REAL <button> HTMLElement, passed
  // as the third argument of addDOMWidget. Canvas button widgets and
  // wrongly-typed DOM widgets rendered as static, non-interactive snapshots
  // in this frontend version; a real element always receives pointer events.
  if (typeof node.addDOMWidget === "function") {
    try {
      const el = makeOpenButtonEl(node);
      const w = node.addDOMWidget("fm_open", "div", el, {
        getValue() { return null; },
        setValue() {},
        serialize: false,
        // no height in the widget flow — we pin it absolute at the bottom, so
        // it must not reserve the 34px gap between mask_path and the image preview
        computeSize() { return [-1, 0]; },
      });
      if (w) {
        w.name = "fm_open";
        if ("serialize" in w) w.serialize = false;
        if (w.serializeValue) w.serializeValue = () => undefined;
        // collapse the widget slot height — otherwise LiteGraph leaves a blank
        // stripe above the preview where the button used to sit
        try { w.computeSize = () => [-1, 0]; if (w.element && w.element.parentElement) w.element.parentElement.style.height = "0px"; } catch (e) {}
        fmLog("DOM open button added:", node.id, node.comfyClass || node.type);
        // version is now shown inside the Edit Mask button text; no separate label
        // pin to bottom below the image preview with a small gap above
        try { positionBottom(node); setTimeout(() => positionBottom(node), 50); setTimeout(() => positionBottom(node), 280); } catch (e) {}
        return;
      }
    } catch (e) {
      console.warn("[FastMask] DOM open button failed:", e);
    }
  }
  fmLog("could not add open button:", node.id);
}

/* ----------------- image paste (Ctrl+V / right-click menu) ---------------- */
// Applies a freshly uploaded image to the node: selects it in the image combo,
// syncs the serialized widgets_values and clears the previous mask (a new
// image means the old mask no longer applies). Self-contained so it works
// even when the built-in upload-widget machinery skips its own steps.
function fmApplyNewImageToNode(node, value) {
  const setW = (name, v) => {
    const w = (node.widgets || []).find((x) => x.name === name);
    if (!w) return;
    if (name === "image") {
      // make sure the combo accepts the freshly uploaded file name
      if (!w.options) w.options = {};
      if (!Array.isArray(w.options.values)) w.options.values = [];
      if (!w.options.values.includes(v)) w.options.values.push(v);
    }
    w.value = v;
    const idx = (node.widgets || []).indexOf(w);
    if (idx >= 0 && node.widgets_values) node.widgets_values[idx] = v;
    if (typeof w.callback === "function") { try { w.callback.call(w, v); } catch (e) {} }
  };
  setW("image", value);
  setW("mask_path", ""); // new image -> old mask no longer applies
  // hide a stale composite overlay right away (the 2s self-heal tick cleans up too)
  try {
    const w = (node.widgets || []).find((x) => x.name === "fm_open");
    const host = w && w.element && (w.element.closest(".comfy-widget") || w.element);
    const box = host && host.parentElement;
    if (box && box._fmCompOv) box._fmCompOv.style.display = "none";
  } catch (e) {}
  try { app.graph.setDirtyCanvas(true, false); } catch (e) {}
}

// Uploads a pasted/dropped image file and applies it to the node. Returns
// false when no image file was in the list (callers can fall back).
async function fmHandlePastedFiles(node, files) {
  const imgs = Array.from(files || []).filter(
    (f) => f && typeof f.type === "string" && f.type.startsWith("image/")
  );
  if (!imgs.length) return false;
  const f = imgs[0];
  try {
    const fd = new FormData();
    fd.append("image", f, f.name || "pasted-image.png");
    fd.append("overwrite", "true");
    fd.append("type", "input");
    fd.append("subfolder", "pasted");
    const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error("upload failed: " + r.status);
    const j = await r.json();
    const fname = j.name || j.filename;
    if (!fname) throw new Error("upload response missing filename");
    const value = j.subfolder ? j.subfolder + "/" + fname : fname;
    fmApplyNewImageToNode(node, value);
  } catch (err) {
    toast("FastMask", "Paste failed: " + err, "error");
  }
  return true;
}

// Install our own paste handlers on the node. The core right-click
// "Paste Image" action (pasteClipboardImageToNode) calls node.pasteFile /
// node.pasteFiles after reading the clipboard - by defining BOTH ourselves
// the whole flow runs through our code with visible feedback, independent
// of the built-in upload widget's internals.
function installFastMaskPaste(node) {
  try {
    const prevFiles = node.pasteFiles;
    node.pasteFile = function (file) {
      return fmHandlePastedFiles(node, [file]);
    };
    node.pasteFiles = function (files) {
      const imgs = Array.from(files || []).filter(
        (f) => f && typeof f.type === "string" && f.type.startsWith("image/")
      );
      if (imgs.length) return fmHandlePastedFiles(node, imgs);
      // no image files -> let the previous handler (if any) deal with it
      return prevFiles ? prevFiles.call(node, files) : false;
    };
    // the frontend gates image-related menu items on this flag
    try { node.previewMediaType = "image"; } catch (e) {}
  } catch (e) { /* no-op */ }
}

function isFastMaskNode(node) {
  if (!node) return false;
  return node.comfyClass === "FastMaskEditor" ||
    node.constructor?.name === "FastMaskEditor" ||
    (String(node.type || "").indexOf("FastMaskEditor") !== -1) ||
    (node.getTitle ? String(node.getTitle()).indexOf("FastMask") !== -1 : false);
}

function scanExistingNodes() {
  try {
    const nodes = (app.graph && app.graph._nodes) || [];
    let n = 0;
    for (const node of nodes) {
      if (isFastMaskNode(node)) { addOpenButton(node); n++; }
    }
    if (n) fmLog("existing FastMask nodes updated:", n);
  } catch (e) {
    console.warn("[FastMask] graph scan failed:", e);
  }
}

/* Hide the built-in "Edit or mask image" pencil button that the default
   frontend overlays on image previews (we provide our own editor). */
function hideNativeMaskButtons() {
  const RX = /mask ?editor|edit or mask|open in mask|fastmask/i;
  const check = (el) => {
    if (el.getAttribute && el.getAttribute("data-fastmask-open") === "1") return; // never hide our own open button
    const t = (el.getAttribute?.("aria-label") || "") + " " + (el.getAttribute?.("title") || "");
    const txt = (el.textContent || "").trim().toLowerCase();
    if (RX.test(t) || txt.indexOf("fastmask") !== -1 || txt.indexOf("edit mask") !== -1) {
      el.style.setProperty("display", "none", "important");
    }
  };
  const scan = (root) => {
    if (root.nodeType !== 1) return;
    if (root.tagName === "BUTTON") check(root);
    if (root.querySelectorAll) root.querySelectorAll("button[aria-label],button[title]").forEach(check);
  };
  try {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) scan(n);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll("button[aria-label],button[title]").forEach(check);
  } catch (e) { /* never break the app over cosmetics */ }
}

app.registerExtension({
  name: "FastMask.Editor",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== "FastMaskEditor") return;
    fmLog("node registered to the frontend:", nodeData.name);

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      addOpenButton(this);
      wireImageMaskReset(this);
      return r;
    };

    // re-clean stale widgets (e.g. the old oval FastMask button) after the node
    // is (re)configured from a saved graph - the upload/preview widgets may be
    // (re)added during configure, so we strip leftovers again here.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      addOpenButton(this);
      return r;
    };

    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_, options) {
      const r = getExtraMenuOptions ? getExtraMenuOptions.apply(this, arguments) : undefined;
      options.unshift({
        content: "Edit Mask",
        callback: () => openEditor(this),
      });
      return r;
    };
  },
  // second safety net: inspect every created node (in case the wrapper above
  // was overridden by another extension)
  nodeCreated(node) {
    if (isFastMaskNode(node)) addOpenButton(node);
  },
  // third safety net: re-inspect nodes already in the graph after workflow
  // load / graph switch
  setup() {
    fmLog("extension loaded, scanning nodes...");
    hideNativeMaskButtons();
    scanExistingNodes();
    // also run after workflow loads (setup only runs once)
    const origConfigure = app.configureGraph ? app.configureGraph.bind(app) : null;
    if (origConfigure) {
      app.configureGraph = function () {
        const r = origConfigure.apply(null, arguments);
        scanExistingNodes();
        return r;
      };
    }
  },
});
fmLog("script loaded, version v" + FM_VERSION);
