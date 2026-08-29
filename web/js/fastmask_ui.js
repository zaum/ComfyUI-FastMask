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
const FM_VERSION = "1.1.0";
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
.fm-btn:hover{background:#3a3a3a;border-color:#666}
.fm-btn.active{background:#3d6ea5;border-color:#5a8fc4;color:#fff}
.fm-btn.ok{background:#2e7d32;border-color:#388e3c}
.fm-btn.ok:hover{background:#388e3c}
.fm-btn:disabled{opacity:.4;cursor:default}
.fm-btn::after{content:attr(data-tip);position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#000;color:#fff;border:1px solid #555;padding:5px 9px;border-radius:5px;white-space:nowrap;font-size:12px;opacity:0;pointer-events:none;transition:opacity .1s;z-index:100000}
.fm-btn:hover::after{opacity:1}
.fm-slider{width:170px;accent-color:#4a90d9}
.fm-brushval{min-width:60px;text-align:right;font-variant-numeric:tabular-nums;color:#8cf}
.fm-swatch{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid #777;vertical-align:-2px;margin-right:5px}
.fm-viewport{position:relative;flex:1;overflow:hidden;cursor:none;touch-action:none}
.fm-viewport.fm-pan{cursor:grab}
.fm-viewport.fm-panning{cursor:grabbing}
.fm-wrap{position:absolute;left:0;top:0;transform-origin:0 0}
.fm-wrap canvas{display:block}
.fm-wrap canvas.fm-bw{outline:1px solid rgba(255,255,255,.28);outline-offset:-1px}
.fm-statusbar{display:flex;gap:18px;padding:5px 12px;background:#1b1b1b;border-top:1px solid #333;font-size:12px;color:#aaa;flex-wrap:wrap}
.fm-statusbar b{color:#8cf;font-weight:600}
.fm-hint{margin-left:auto}
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

/* ------------------------------ DOM construction ------------------------------ */
function buildUI() {
  if (ui) return;
  injectCSS();

  const overlay = document.createElement("div");
  overlay.className = "fm-overlay fm-hidden";

  const topbar = document.createElement("div");
  topbar.className = "fm-topbar";

  const g1 = document.createElement("div");
  g1.className = "fm-group";
  // two-state paint/erase toggle (X toggles, right button always erases)
  const modeBtn = btn("fmMode", "\uD83D\uDD8C Paint", "Toggle Paint / Erase (X) - right button always erases");
  const clearAll = btn("fmClear", "\uD83D\uDDD1 Clear all", "Clear all (" + MOD + "+Del)");
  const undoBtn = btn("fmUndo", "&#8617; Undo", "Undo (" + MOD + "+Z)");
  const redoBtn = btn("fmRedo", "&#8618; Redo", "Redo (" + MOD + "+Y / " + MOD + "+Shift+Z)");
  g1.append(modeBtn, clearAll, undoBtn, redoBtn);

  const g2 = document.createElement("div");
  g2.className = "fm-group";
  const brushLabel = document.createElement("span");
  brushLabel.textContent = "Brush";
  const brushSlider = document.createElement("input");
  brushSlider.type = "range";
  brushSlider.id = "fmBrush";
  brushSlider.className = "fm-slider";
  brushSlider.min = "1";
  brushSlider.max = "1000";
  brushSlider.value = "60";
  brushSlider.dataset.tip = "Brush size (" + MOD + "+left-drag, " + MOD + "+wheel, [ / ])";
  const brushVal = document.createElement("span");
  brushVal.className = "fm-brushval";
  g2.append(brushLabel, brushSlider, brushVal);

  const g3 = document.createElement("div");
  g3.className = "fm-group";
  const hatchBtn = btn("fmHatch", "\u25A8 Hatch", "Hatch line color (C)");
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "fm-colinput";
  colorInput.value = "#ff3fd8";
  const swatch = document.createElement("span");
  swatch.className = "fm-swatch";
  hatchBtn.prepend(swatch);
  const fillToggle = btn("fmFill", "Auto-fill", "Auto-fill interior of closed shapes (F)");
  const showMask = btn("fmShow", "\uD83D\uDC41 Show mask", "B/W mask - hover for preview, click to lock and edit (M)");
  g3.append(hatchBtn, colorInput, fillToggle, showMask);

  const spacer = document.createElement("div");
  spacer.className = "fm-spacer";

  const g4 = document.createElement("div");
  g4.className = "fm-group";
  const fitBtn = btn("fmFit", "\u26F6 Fit", "Fit image to window (" + MOD + "+0)");
  const cancelBtn = btn("fmCancel", "\u2715 Cancel", "Cancel (Esc)");
  const okBtn = btn("fmOk", "\u2714 OK", "Save and close (Enter)", "ok");
  g4.append(fitBtn, cancelBtn, okBtn);

  topbar.append(g1, g2, g3, spacer, g4);

  const viewport = document.createElement("div");
  viewport.className = "fm-viewport";
  const loading = document.createElement("div");
  loading.className = "fm-loading";
  loading.textContent = "Loading image...";
  const wrap = document.createElement("div");
  wrap.className = "fm-wrap fm-hidden";
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  viewport.append(loading, wrap);

  const statusbar = document.createElement("div");
  statusbar.className = "fm-statusbar";
  statusbar.innerHTML =
    '<span>Mode: <b id="fmStMode">Paint</b></span>' +
    '<span>Brush: <b id="fmStBrush"></b></span>' +
    '<span>Zoom: <b id="fmStZoom"></b></span>' +
    '<span>Image: <b id="fmStSize"></b></span>' +
    '<span class="fm-hint">' + MOD + '+left-drag: brush size &bull; ' + MOD + '+wheel: brush &bull; wheel: zoom &bull; Space / middle button: pan &bull; right button: erase &bull; X: mode &bull; ' + MOD + '+Z / ' + MOD + '+Y: undo/redo</span>';

  overlay.append(topbar, viewport, statusbar);
  document.body.appendChild(overlay);

  ui = {
    overlay, topbar, viewport, wrap, canvas, loading,
    modeBtn, clearAll, undoBtn, redoBtn, brushSlider, brushVal,
    hatchBtn, swatch, colorInput, fillToggle, showMask,
    fitBtn, cancelBtn, okBtn,
    stMode: statusbar.querySelector("#fmStMode"),
    stBrush: statusbar.querySelector("#fmStBrush"),
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

  let img;
  try {
    img = await loadImage(api.apiURL("/view?" + new URLSearchParams({
      filename: src.filename,
      subfolder: src.subfolder || "",
      type: src.type || "output",
    })));
  } catch (err) {
    ui.overlay.classList.add("fm-hidden");
    toast("FastMask", "Failed to load image: " + err, "error");
    return;
  }

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
    img,
    view: { scale: 1, x: 0, y: 0 },
    fitScale: 1,
    brushFull: Math.round(Math.min(fullW, fullH) * 0.06),
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
    last: null,
    ptsX: new Float32Array(256), ptsY: new Float32Array(256), ptsN: 0,
    strokeBBox: null,
    raf: 0,
  };

  const maxBrush = Math.min(fullW, fullH);
  ui.brushSlider.max = String(maxBrush);
  ui.brushSlider.value = String(st.brushFull);
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
      const mimg = await loadImage(api.apiURL("/view?" + new URLSearchParams({
        filename: mf,
        subfolder: seg.join("/"),
        type: "input",
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
    // 1. connected IMAGE input (image_opt) - overrides the dropdown
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
  c.width = 12; c.height = 12;
  const g = c.getContext("2d");
  g.strokeStyle = st.hatchColor;
  g.lineWidth = 2;
  g.lineCap = "square";
  g.beginPath();
  g.moveTo(-3, 15); g.lineTo(15, -3);
  g.moveTo(-3, 3);  g.lineTo(3, -3);
  g.moveTo(9, 15);  g.lineTo(15, 9);
  g.stroke();
  st.hatchPattern = st.tctx.createPattern(c, "repeat");
}

function addDirty(x, y, w, h) {
  const x0 = Math.max(0, Math.floor(x) - 1);
  const y0 = Math.max(0, Math.floor(y) - 1);
  const x1 = Math.min(st.pw, Math.ceil(x + w) + 1);
  const y1 = Math.min(st.ph, Math.ceil(y + h) + 1);
  if (x1 > x0 && y1 > y0) st.dirty.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

function renderAll() { st.dirty.push({ x: 0, y: 0, w: st.pw, h: st.ph }); }

// Redraw one dirty rect: base image + hatch/white drawing limited to the mask.
function renderRect(r) {
  const v = st.vctx, t = st.tctx;
  const bw = bwMode();
  v.save();
  v.beginPath(); v.rect(r.x, r.y, r.w, r.h); v.clip();
  if (bw) {
    v.fillStyle = "#000";
    v.fillRect(r.x, r.y, r.w, r.h);
  } else {
    v.drawImage(st.baseCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }
  // tint the mask inside the rect only
  t.save();
  t.beginPath(); t.rect(r.x, r.y, r.w, r.h); t.clip();
  t.clearRect(r.x, r.y, r.w, r.h);
  t.fillStyle = bw ? "#ffffff" : st.hatchPattern;
  t.fillRect(r.x, r.y, r.w, r.h);
  t.globalCompositeOperation = "destination-in";
  t.drawImage(st.maskCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  t.restore();
  v.drawImage(st.tintCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  v.restore();
}

function brushRadiusCanvas() {
  return (st.brushFull * st.previewScale) / 2;
}

function cursorRect(c) {
  const rad = brushRadiusCanvas() + 2;
  return { x: Math.max(0, c.x - rad), y: Math.max(0, c.y - rad), w: rad * 2, h: rad * 2 };
}

// Thin (screen-space ~1px) brush outline + center crosshair. Both are drawn in
// the SAME canvas frame, so the crosshair can never lag behind the circle.
function drawCursor() {
  const v = st.vctx, c = st.cursor;
  const rad = brushRadiusCanvas();
  const lw = 1 / st.view.scale;
  v.save();
  v.lineWidth = lw;
  v.strokeStyle = "rgba(255,255,255,.95)";
  v.shadowColor = "rgba(0,0,0,.9)";
  v.shadowBlur = 2 / st.view.scale;
  v.beginPath(); v.arc(c.x, c.y, rad, 0, Math.PI * 2); v.stroke();
  // crosshair: four lines from the center outwards, small gap in the middle
  v.shadowBlur = 0;
  const g = Math.max(rad * 0.16, 3 / st.view.scale);
  v.beginPath();
  v.moveTo(c.x - rad, c.y); v.lineTo(c.x - g, c.y);
  v.moveTo(c.x + g, c.y);   v.lineTo(c.x + rad, c.y);
  v.moveTo(c.x, c.y - rad); v.lineTo(c.x, c.y - g);
  v.moveTo(c.x, c.y + g);   v.lineTo(c.x, c.y + rad);
  v.stroke();
  v.restore();
}

// Single rAF loop: dirty rects + cursor, otherwise nothing to do.
function frame() {
  if (!st) return;
  const bw = bwMode();
  // faint outline around the image frame in B/W mode (CSS outline, zero cost)
  ui.canvas.classList.toggle("fm-bw", bw);
  if (st.dirty.length) {
    let list = st.dirty;
    st.dirty = [];
    if (list.length > 64) list = [{ x: 0, y: 0, w: st.pw, h: st.ph }];
    for (const r of list) renderRect(r);
    st.cursorDirty = true;
  }
  if (st.cursorDirty) {
    if (st.prevCursor) renderRect(st.prevCursor);
    st.prevCursor = null;
    const c = st.cursor;
    if (c.inside && !st.panning) {
      const r = cursorRect(c);
      renderRect(r);
      st.prevCursor = r;
      drawCursor();
    }
    st.cursorDirty = false;
  }
  st.raf = requestAnimationFrame(frame);
}

/* ------------------------------ painting ------------------------------ */
function lineRadiusCanvas() {
  return (st.brushFull * st.previewScale) / 2;
}

function segBBox(x0, y0, x1, y1) {
  const rad = lineRadiusCanvas() / 2 + 3;
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
  const entry = st.undoStack.pop();
  if (!entry) return;
  const cols = tileCols();
  const redoEntry = { tiles: new Map() };
  for (const [idx, img] of entry.tiles) {
    const x = (idx % cols) * TILE, y = Math.floor(idx / cols) * TILE;
    redoEntry.tiles.set(idx, st.mctx.getImageData(x, y, img.width, img.height));
    st.mctx.putImageData(img, x, y);
    addDirty(x, y, img.width, img.height);
  }
  st.redoStack.push(redoEntry);
  updateToolbar();
}

function redo() {
  const entry = st.redoStack.pop();
  if (!entry) return;
  const cols = tileCols();
  const undoEntry = { tiles: new Map() };
  for (const [idx, img] of entry.tiles) {
    const x = (idx % cols) * TILE, y = Math.floor(idx / cols) * TILE;
    undoEntry.tiles.set(idx, st.mctx.getImageData(x, y, img.width, img.height));
    st.mctx.putImageData(img, x, y);
    addDirty(x, y, img.width, img.height);
  }
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
        addDirty(x, y, w, h);
      }
    }
  }
  pushUndo(entry);
}

/* ------------------------------ toolbar / state ------------------------------ */
function setMode(mode) { st.mode = mode; updateToolbar(); }
function toggleMode() { setMode(st.mode === "paint" ? "erase" : "paint"); }

function setBrush(sizeFull) {
  st.brushFull = clamp(Math.round(sizeFull), 1, Math.min(st.fullW, st.fullH));
  ui.brushSlider.value = String(st.brushFull);
  st.cursorDirty = true;
  updateToolbar();
}

function toggleFill() { st.autoFill = !st.autoFill; updateToolbar(); }

function toggleShowMask() {
  st.maskLocked = !st.maskLocked;
  renderAll();
  updateToolbar();
}

function updateToolbar() {
  if (!st || !ui) return;
  ui.modeBtn.textContent = st.mode === "paint" ? "\uD83D\uDD8C Paint" : "\uD83E\uDDFD Erase";
  ui.modeBtn.classList.toggle("active", st.mode === "erase");
  ui.modeBtn.dataset.tip = "Toggle Paint / Erase (X) - right button always erases";
  ui.fillToggle.classList.toggle("active", st.autoFill);
  ui.showMask.classList.toggle("active", st.maskLocked);
  ui.brushVal.textContent = st.brushFull + " px";
  ui.stMode.textContent = st.mode === "paint" ? "Paint" : "Erase";
  ui.stBrush.textContent = st.brushFull + " px";
  ui.stZoom.textContent = Math.round(st.view.scale * 100) + "%";
}

/* ------------------------------ UI events ------------------------------ */
function wireUI() {
  const v = ui.viewport;

  ui.modeBtn.addEventListener("click", () => { if (st) toggleMode(); });
  ui.clearAll.addEventListener("click", () => clearAll());
  ui.undoBtn.addEventListener("click", () => undo());
  ui.redoBtn.addEventListener("click", () => redo());
  ui.brushSlider.addEventListener("input", (e) => { if (st) setBrush(+e.target.value); e.target.blur(); });
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

  v.addEventListener("pointerdown", (e) => {
    if (!st) return;
    e.preventDefault();
    v.setPointerCapture(e.pointerId);
    if (st.sizing || st.panning) return;
    const p = toCanvas(e);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.button === 0) {
      st.sizing = { y: e.clientY, size: st.brushFull };
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
    if (e.button === 2) { startStroke(p, "erase"); return; }
  });

  v.addEventListener("pointermove", (e) => {
    if (!st) return;
    const p = toCanvas(e);
    const c = st.cursor;
    if (c.x !== p.x || c.y !== p.y || !c.inside) {
      c.x = p.x; c.y = p.y; c.inside = true;
      st.cursorDirty = true;
    }
    if (st.sizing) {
      setBrush(st.sizing.size + (st.sizing.y - e.clientY) * Math.max(1, st.fullH / 400));
      return;
    }
    if (st.panning) {
      st.view.x = st.panning.vx + (e.clientX - st.panning.x);
      st.view.y = st.panning.vy + (e.clientY - st.panning.y);
      applyTransform();
      return;
    }
    if (st.drawing) strokeTo(p);
  });

  v.addEventListener("pointerup", () => {
    if (!st) return;
    if (st.sizing) { st.sizing = null; return; }
    if (st.panning) { st.panning = null; v.classList.remove("fm-panning"); return; }
    if (st.drawing) endStroke();
  });

  v.addEventListener("pointerleave", () => {
    if (!st) return;
    st.cursor.inside = false;
    st.cursorDirty = true;
  });

  v.addEventListener("wheel", (e) => {
    if (!st) return;
    e.preventDefault();
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      setBrush(st.brushFull * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
      return;
    }
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  window.addEventListener("keydown", (e) => onKey(e, true), true);
  window.addEventListener("keyup", (e) => onKey(e, false), true);
}

/* ------------------------------ keyboard ------------------------------ */
function onKey(e, down) {
  if (!st) return;
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;

  if (down && k === "Enter") { e.preventDefault(); saveAndClose(); return; }
  if (down && k === "Escape") { e.preventDefault(); closeEditor(); return; }

  if (mod && (k === "z" || k === "Z")) {
    e.preventDefault();
    if (!st.drawing) { if (e.shiftKey) redo(); else undo(); }
    return;
  }
  if (mod && (k === "y" || k === "Y")) { e.preventDefault(); if (!st.drawing) redo(); return; }
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
      setBrush(st.brushFull * 0.9);
      break;
    case "]":
      setBrush(st.brushFull * 1.1);
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
  const fctx = full.getContext("2d", { willReadFrequently: true });
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = "high";
  fctx.drawImage(st.maskCanvas, 0, 0, st.fullW, st.fullH);
  const data = fctx.getImageData(0, 0, st.fullW, st.fullH);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; // white, alpha carries the mask
  }
  fctx.putImageData(data, 0, 0);
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
    const path = j.subfolder ? j.subfolder + "/" + j.filename : j.filename;
    const w = (st.node.widgets || []).find((w) => w.name === "mask_path");
    if (w) {
      w.value = path;
      if (w.callback) w.callback(path);
    }
    app.graph.setDirtyCanvas(true, false);
    closeEditor();
  } catch (err) {
    toast("FastMask", "Save failed: " + err, "error");
  } finally {
    if (ui) {
      ui.okBtn.disabled = false;
      ui.okBtn.textContent = "\u2714 OK";
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

function makeOpenButtonEl(node) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = "\uD83D\uDD8C FastMask Editor v" + FM_VERSION;
  el.style.cssText =
    "display:block;width:100%;height:100%;box-sizing:border-box;" +
    "background:#2a2a2a;color:#eee;border:1px solid #555;border-radius:6px;" +
    "cursor:pointer;font-size:13px;padding:4px 10px;font-family:inherit;text-align:center;pointer-events:auto";
  el.addEventListener("mouseenter", () => { el.style.background = "#3a3a3a"; el.style.borderColor = "#777"; });
  el.addEventListener("mouseleave", () => { el.style.background = "#2a2a2a"; el.style.borderColor = "#555"; });
  el.addEventListener("pointerdown", (e) => e.stopPropagation()); // do not drag the node
  el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fmEditorClick(node); });
  return el;
}

function addOpenButton(node) {
  // idempotent: never add two buttons
  if (!node) return;
  const widgets = node.widgets || [];

  // CLEANUP: remove every stale FastMask widget (old canvas button, widgets
  // left over from cached JS under any name containing "fastmask" that is not
  // our current DOM button)
  for (let i = widgets.length - 1; i >= 0; i--) {
    const w = widgets[i];
    if (!w) continue;
    const nameMatch = String(w.name || "").toLowerCase().indexOf("fastmask") !== -1;
    const labelMatch = String(w.label || w.name || "").toLowerCase().indexOf("fastmask") !== -1;
    const isOurs = w.name === "fastmask_open" && w.element && w.element.tagName === "BUTTON";
    if ((nameMatch || labelMatch) && !isOurs) {
      widgets.splice(i, 1);
      fmLog("stale FastMask widget removed:", w.name || w.label || "(unnamed)");
    }
  }

  // PRIMARY: a real HTML button as a DOM widget. canvasOnly MUST be false,
  // otherwise the new frontend renders it as a static, non-interactive
  // canvas snapshot (that was the "oval button" bug).
  if (typeof node.addDOMWidget === "function") {
    try {
      const el = makeOpenButtonEl(node);
      const w = node.addDOMWidget("fastmask_open", "", el, { serialize: false, canvasOnly: false });
      if (w) {
        w.label = "";
        if (w.options) w.options.canvasOnly = false;
        try { w.computeSize = () => [0, 32]; } catch (e) {}
        if (w.serializeValue) w.serializeValue = () => undefined;
        if ("serialize" in w) w.serialize = false;
        fmLog("DOM button added:", node.id, node.comfyClass || node.type);
        return;
      }
    } catch (e) {
      console.warn("[FastMask] DOM widget failed, falling back to canvas button:", e);
    }
  }

  // FALLBACK: litegraph canvas button (if addDOMWidget is unavailable)
  if (!node.addWidget) return;
  const w = node.addWidget("button", BTN_LABEL, null, () => fmEditorClick(node));
  if (w) {
    w.name = "fastmask_open";
    try { w.label = BTN_LABEL; } catch (e) {}
    if (w.serializeValue) w.serializeValue = () => undefined;
    if ("serialize" in w) w.serialize = false;
    fmLog("canvas button added:", node.id, node.comfyClass || node.type);
  }
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
  const RX = /mask ?editor|edit or mask|open in mask/i;
  const check = (el) => {
    const t = (el.getAttribute?.("aria-label") || "") + " " + (el.getAttribute?.("title") || "");
    if (RX.test(t)) el.style.setProperty("display", "none", "important");
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
      return r;
    };

    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_, options) {
      const r = getExtraMenuOptions ? getExtraMenuOptions.apply(this, arguments) : undefined;
      options.unshift({
        content: "\uD83D\uDD8C Open in FastMask Editor",
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
