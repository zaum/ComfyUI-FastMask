// ============================================================================
//  FastMask - nagyon gyors maszk editor a ComfyUI-hoz
//  ---------------------------------------------------------------------------
//  Teljesitmeny-architektura:
//   * A maszk egy offscreen 2D canvason el PREVIEW felbontasban, a festes
//     GPU-gyorsitott canvas stroke-okkal tortenik (nincs objektum-allokacio
//     ecsetvonasonkent).
//   * a TELJES felbontasu maszk (Uint8Array) csak egyszer, az OK gombra keszul
//     el (egyetlen drawImage + getImageData hivassal).
//   * Minden frame csak a DIRTY RECTANGLE-oket rajzolja ujra - egy ecsetvonas
//     soha nem rendereli ujra a teljes kepet.
//   * Egyetlen requestAnimationFrame loop fut, es csak akkor rajzol, ha
//     valtozott valami.
//   * Zoom / pan tiszta CSS transform -> nulla koltsegu navigacio.
//   * Undo/Redo nem masol teljes kepeket: 256x256-os LAZY TILE snapshotokat
//     tarol, csak a tenylegesen erintett csempekbol.
//
//  Nem implementalt (csak terv): gyors SAM szegmentacio - lasd README.md,
//  "SAM szegmentacio - tervezett kiterjesztes" fejezet.
// ============================================================================

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TILE = 256;          // undo/redo csempe meret (preview px)
const MAX_PREVIEW = 2048;  // max preview felbontas (a vegeredmeny full-res)
const MAX_UNDO = 40;
const FM_VERSION = "1.0.3"; // console-ban ellenoriheto: [FastMask] script betoltve v1.0.3
const BTN_LABEL = "\uD83D\uDD8C FastMask Editor v" + FM_VERSION; // verzio a gombon - diagnosztika

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = isMac ? "\u2318" : "Ctrl";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let ui = null; // DOM elemek (buildUI tolti fel)
let st = null; // editor allapot (openEditor tolti fel)

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
.fm-viewport{position:relative;flex:1;overflow:hidden;cursor:crosshair;touch-action:none}
.fm-viewport.fm-pan{cursor:grab}
.fm-viewport.fm-panning{cursor:grabbing}
.fm-wrap{position:absolute;left:0;top:0;transform-origin:0 0}
.fm-wrap canvas{display:block}
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

/* ------------------------------ DOM felepites ------------------------------ */
function buildUI() {
  if (ui) return;
  injectCSS();

  const overlay = document.createElement("div");
  overlay.className = "fm-overlay fm-hidden";

  const topbar = document.createElement("div");
  topbar.className = "fm-topbar";

  const g1 = document.createElement("div");
  g1.className = "fm-group";
  const modeMask = btn("fmModeMask", "\uD83D\uDD8C Maszk", "Festes / maszkolas (X)");
  const modeErase = btn("fmModeErase", "\uD83E\uDDFD Torles", "Torles (X)");
  const clearAll = btn("fmClear", "\uD83D\uDDD1 Clear all", "Osszes torlese (" + MOD + "+Del)");
  const undoBtn = btn("fmUndo", "&#8617; Undo", "Visszavonas (" + MOD + "+Z)");
  const redoBtn = btn("fmRedo", "&#8618; Redo", "Megis (" + MOD + "+Y / " + MOD + "+Shift+Z)");
  g1.append(modeMask, modeErase, clearAll, undoBtn, redoBtn);

  const g2 = document.createElement("div");
  g2.className = "fm-group";
  const brushLabel = document.createElement("span");
  brushLabel.textContent = "Ecset";
  const brushSlider = document.createElement("input");
  brushSlider.type = "range";
  brushSlider.id = "fmBrush";
  brushSlider.className = "fm-slider";
  brushSlider.min = "1";
  brushSlider.max = "1000";
  brushSlider.value = "60";
  brushSlider.dataset.tip = "Ecset merete (" + MOD + "+bal eger huzas, " + MOD + "+gorgo, [ / ])";
  const brushVal = document.createElement("span");
  brushVal.className = "fm-brushval";
  g2.append(brushLabel, brushSlider, brushVal);

  const g3 = document.createElement("div");
  g3.className = "fm-group";
  const hatchBtn = btn("fmHatch", "\u25A8 Halo", "Halo vonalak szine (C)");
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "fm-colinput";
  colorInput.value = "#ff3fd8";
  const swatch = document.createElement("span");
  swatch.className = "fm-swatch";
  hatchBtn.prepend(swatch);
  const fillToggle = btn("fmFill", "Zart alakzat kitoltese", "Zart korvonal belso reszenek automatikus kitoltese (F)");
  const showMask = btn("fmShow", "\uD83D\uDC41 Show mask", "Fekete-feher maszk: fole tartva elonezet, kattintva rogzitve marheto szerkeszteni (M)");
  g3.append(hatchBtn, colorInput, fillToggle, showMask);

  const spacer = document.createElement("div");
  spacer.className = "fm-spacer";

  const g4 = document.createElement("div");
  g4.className = "fm-group";
  const fitBtn = btn("fmFit", "\u26F6 Fit", "Teljes kep ablakra (" + MOD + "+0)");
  const cancelBtn = btn("fmCancel", "\u2715 Cancel", "Megse (Esc)");
  const okBtn = btn("fmOk", "\u2714 OK", "Mentes es bezaras (Enter)", "ok");
  g4.append(fitBtn, cancelBtn, okBtn);

  topbar.append(g1, g2, g3, spacer, g4);

  const viewport = document.createElement("div");
  viewport.className = "fm-viewport";
  const loading = document.createElement("div");
  loading.className = "fm-loading";
  loading.textContent = "Kep betoltese...";
  const wrap = document.createElement("div");
  wrap.className = "fm-wrap fm-hidden";
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  viewport.append(loading, wrap);

  const statusbar = document.createElement("div");
  statusbar.className = "fm-statusbar";
  statusbar.innerHTML =
    '<span>Mod: <b id="fmStMode">Maszk</b></span>' +
    '<span>Ecset: <b id="fmStBrush"></b></span>' +
    '<span>Zoom: <b id="fmStZoom"></b></span>' +
    '<span>Kep: <b id="fmStSize"></b></span>' +
    '<span class="fm-hint">Ctrl+bal gomb: ecset meret &bull; Ctrl+gorgo: ecset &bull; gorgo: zoom &bull; Space / kozepso gomb: pan &bull; jobb gomb: torles &bull; X: mod &bull; ' + MOD + '+Z / ' + MOD + '+Y: undo/redo</span>';

  overlay.append(topbar, viewport, statusbar);
  document.body.appendChild(overlay);

  ui = {
    overlay, topbar, viewport, wrap, canvas, loading,
    modeMask, modeErase, clearAll, undoBtn, redoBtn, brushSlider, brushVal,
    hatchBtn, swatch, colorInput, fillToggle, showMask,
    fitBtn, cancelBtn, okBtn,
    stMode: statusbar.querySelector("#fmStMode"),
    stBrush: statusbar.querySelector("#fmStBrush"),
    stZoom: statusbar.querySelector("#fmStZoom"),
    stSize: statusbar.querySelector("#fmStSize"),
  };

  wireUI();
}

/* ------------------------------ allapot / init ------------------------------ */
async function openEditor(node) {
  buildUI();
  if (st) return; // mar nyitva

  const src = getSourceImage(node);
  if (!src) {
    toast("FastMask", "Nincs betoltott kep a node bemeneten! Futtasd le a workflow-t elobb.", "error");
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
    toast("FastMask", "A kep betoltese sikertelen: " + err, "error");
    return;
  }

  const fullW = img.naturalWidth;
  const fullH = img.naturalHeight;
  const f = Math.min(1, MAX_PREVIEW / Math.max(fullW, fullH));
  const pw = Math.max(1, Math.round(fullW * f));
  const ph = Math.max(1, Math.round(fullH * f));

  // alap kep (preview felbontasban, egyszer rajzolva)
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = pw; baseCanvas.height = ph;
  baseCanvas.getContext("2d").drawImage(img, 0, 0, pw, ph);

  // maszk (preview felbontasban; a full-res csak az OK-nal keszul)
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = pw; maskCanvas.height = ph;
  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });

  // szinezett maszk (halo / feher) - dirty rect-enkent frissitve
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
    maskLocked: false,      // Show mask gombbal rogzitve
    bwHover: false,         // Show mask folott hover-elonezet
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

  // korabban festett maszk visszaallitasa a mask_path-rol (ha van)
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
      if (!st) return; // kozben bezartak az editort
      mctx.clearRect(0, 0, pw, ph);
      mctx.drawImage(mimg, 0, 0, pw, ph);
      st.dirty.push({ x: 0, y: 0, w: pw, h: ph });
    } catch (e) { /* nincs mentett maszk, megyunk uresen */ }
  })();

  makeHatch();
  fitView();
  updateToolbar();

  ui.loading.classList.add("fm-hidden");
  ui.wrap.classList.remove("fm-hidden");

  // elso teljes render, aztan csak dirty rect-ek
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
    // 1. bekotott IMAGE bemenet (image_opt) -> ez felulirja a dropdown-t
    for (const inp of node.inputs || []) {
      if (inp.type !== "IMAGE" || !inp.link) continue;
      const link = app.graph.links[inp.link];
      if (!link) continue;
      const out = app.nodeOutputs[link.origin_id];
      if (out && out.images && out.images.length) {
        return out.images.find((i) => i.type === "output") || out.images[0];
      }
    }
    // 2. a node sajat image combo widgetje (file-loader mod, mint a LoadImage)
    const w = (node.widgets || []).find((w) => w.name === "image");
    if (w && w.value && typeof w.value === "string") {
      // az ertek tartalmazhat subfoldert is ("mappa/fajl.png")
      const seg = w.value.split("/");
      return { filename: seg.pop(), subfolder: seg.join("/"), type: "input" };
    }
    // 3. a node-on megjelenitett preview (feltoltes utan)
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

// Egy dirty rect ujrarajzolasa: alap kep + a maszkra limitalt halo/feher rajz.
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
  // maszk szinezese csak a rect-en belul
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

function drawCursor() {
  const v = st.vctx, c = st.cursor;
  const rad = brushRadiusCanvas();
  const lw = 1.5 / st.view.scale;
  v.save();
  v.lineWidth = lw;
  v.strokeStyle = "rgba(0,0,0,.85)";
  v.beginPath(); v.arc(c.x, c.y, rad, 0, Math.PI * 2); v.stroke();
  v.lineWidth = lw;
  v.strokeStyle = "rgba(255,255,255,.9)";
  v.beginPath(); v.arc(c.x, c.y, rad - lw, 0, Math.PI * 2); v.stroke();
  v.restore();
}

// Egyetlen rAF loop: dirty rect-ek + kurzor, egyebkent tenni-valo sincs.
function frame() {
  if (!st) return;
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
    if (c.inside) {
      const r = cursorRect(c);
      renderRect(r);
      st.prevCursor = r;
      drawCursor();
    }
    st.cursorDirty = false;
  }
  st.raf = requestAnimationFrame(frame);
}

/* ------------------------------ festes ------------------------------ */
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
  // stroke bbox novelese
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
  m.restore(); // gco vissza
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

// Zart alakzat belso reszenek kitoltese (evenodd scanline) - egy temp canvas
// segitsegevel, ami utan egyetlen drawImage kerul a maszkra.
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

// A rect altal erintett csempek elmentese (egyszer vonasonkent), MIELOTT
// modositjuk oket. Igy az undo csak a tenylegesen valtozott teruletet tarolja.
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

/* ------------------------------ toolbar / allapot ------------------------------ */
function setMode(mode) { st.mode = mode; updateToolbar(); }

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
  ui.modeMask.classList.toggle("active", st.mode === "paint");
  ui.modeErase.classList.toggle("active", st.mode === "erase");
  ui.fillToggle.classList.toggle("active", st.autoFill);
  ui.showMask.classList.toggle("active", st.maskLocked);
  ui.brushVal.textContent = st.brushFull + " px";
  ui.stMode.textContent = st.mode === "paint" ? "Maszk" : "Torles";
  ui.stBrush.textContent = st.brushFull + " px";
  ui.stZoom.textContent = Math.round(st.view.scale * 100) + "%";
}

/* ------------------------------ UI esemenyek ------------------------------ */
function wireUI() {
  const v = ui.viewport;

  ui.modeMask.addEventListener("click", () => setMode("paint"));
  ui.modeErase.addEventListener("click", () => setMode("erase"));
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

/* ------------------------------ billentyuzet ------------------------------ */
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
      setMode(st.mode === "paint" ? "erase" : "paint");
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

/* --------------------- mentes: full-resolution export --------------------- */
// A preview-felbontasu maszk canvasbol egyetlen drawImage-gel full-res
// Uint8Array/ImageData keszul (RGB = feher, A = maszk), es PNG-kent megy fel
// a ComfyUI /upload/image API-jan (subfolder: fastmask).
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
    d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; // feher, az alfa a maszk
  }
  fctx.putImageData(data, 0, 0);
  return full;
}

async function saveAndClose() {
  if (!st) return;
  ui.okBtn.disabled = true;
  ui.okBtn.textContent = "Mentes...";
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
    toast("FastMask", "Mentes sikertelen: " + err, "error");
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
      console.error("[FastMask] editor megnyitas hiba:", err);
      try { toast("FastMask", "Editor hiba: " + err.message, "error"); } catch (e2) {}
    });
  } catch (err) {
    console.error("[FastMask] editor megnyitas hiba:", err);
    try { alert("[FastMask] hiba: " + err.message); } catch (e2) {}
  }
}

function makeOpenButtonEl(node) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = "\uD83D\uDD8C FastMask Editor v" + FM_VERSION;
  el.style.cssText =
    "display:block;width:100%;height:100%;box-sizing:border-box;" +
    "background:#2a2a2a;color:#eee;border:1px solid #555;border-radius:6px;" +
    "cursor:pointer;font-size:13px;padding:4px 10px;font-family:inherit;text-align:center";
  el.addEventListener("mouseenter", () => { el.style.background = "#3a3a3a"; el.style.borderColor = "#777"; });
  el.addEventListener("mouseleave", () => { el.style.background = "#2a2a2a"; el.style.borderColor = "#555"; });
  el.addEventListener("pointerdown", (e) => e.stopPropagation()); // ne huzza a node-ot
  el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fmEditorClick(node); });
  return el;
}

function addOpenButton(node) {
  // idempotens: ne keruljon fel ketto gomb
  if (!node) return;
  const widgets = node.widgets || [];
  const existing = widgets.find((w) => w.name === "fastmask_open");
  if (existing) {
    // Ha mar letezik gomb, de az regi canvas-button (DOM element nelkul,
    // egyes frontend verziokon nem kattintható), csere valodi HTML gombra.
    if (!existing.element && typeof node.addDOMWidget === "function") {
      try {
        const idx = widgets.indexOf(existing);
        if (idx !== -1) widgets.splice(idx, 1);
        fmLog("regi canvas gomb eltavositva, DOM gomb kerul helyette:", node.id);
      } catch (e) {}
    } else {
      // cimke frissitese az aktualis verzióra, hogy latszodjon, melyik JS fut
      try {
        if (existing.element && existing.element.tagName === "BUTTON") {
          existing.element.textContent = "\uD83D\uDD8C FastMask Editor v" + FM_VERSION;
        } else {
          existing.label = BTN_LABEL;
        }
      } catch (e) {}
      return;
    }
  }

  // ELSODLEGES: valodi HTML button DOM widgetkent - ez mindig latszik es
  // kattinthat, fuggetlenul a litegraph canvas widget-rajzolastol
  if (typeof node.addDOMWidget === "function") {
    try {
      const el = makeOpenButtonEl(node);
      const w = node.addDOMWidget("fastmask_open", "", el, { serialize: false });
      if (w) {
        w.label = "";
        try { w.computeSize = () => [0, 32]; } catch (e) {}
        if (w.serializeValue) w.serializeValue = () => undefined;
        if ("serialize" in w) w.serialize = false;
        fmLog("DOM gomb hozzaadva:", node.id, node.comfyClass || node.type);
        return;
      }
    } catch (e) {
      console.warn("[FastMask] DOM widget sikertelen, canvas button-re esik vissza:", e);
    }
  }

  // TARTALEK: litegraph canvas button (ha addDOMWidget nem elerheto)
  if (!node.addWidget) return;
  const w = node.addWidget("button", BTN_LABEL, null, () => fmEditorClick(node));
  if (w) {
    w.name = "fastmask_open";
    try { w.label = BTN_LABEL; } catch (e) {}
    if (w.serializeValue) w.serializeValue = () => undefined;
    if ("serialize" in w) w.serialize = false;
    fmLog("canvas gomb hozzaadva:", node.id, node.comfyClass || node.type);
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
    if (n) fmLog("meglvo FastMask node-ok frissitve:", n);
  } catch (e) {
    console.warn("[FastMask] graph scan failed:", e);
  }
}

app.registerExtension({
  name: "FastMask.Editor",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== "FastMaskEditor") return;
    fmLog("node regisztralva a frontend fele:", nodeData.name);

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
  // masodik biztositek: minden letrehozott node-ra ranezunk (ha a fenti
  // wrapper masik extension altal felulirasra kerult, itt is hozzaadodik)
  nodeCreated(node) {
    if (isFastMaskNode(node)) addOpenButton(node);
  },
  // harmadik biztositek: workflow betoltes / grafikonvaltas utan is ranezunk
  // a grafikonban mar meglevo node-okra
  setup() {
    fmLog("extension betoltve, node-ok atvizsgalasa...");
    scanExistingNodes();
    // workflow-betoltes utan is fusson le (a setup egyszer fut csak)
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
fmLog("script betoltve, verzió: v" + FM_VERSION);
