import { S } from "./_state.js";
import { ensureBytes, intern, persist, urlForSync } from "./02c-blobs.js";
import { ANNOTATION_COLORS, annotateGallerySlot, normalizeMarks, rowSlots, slotOriginal } from "./02d-gallery.js";
import { findRowIndex } from "./03-sync.js";
import { slotPoster } from "./05-render.js";
import { galleryEdit } from "./05e-gallery-overlay.js";
import { showToast } from "./12-dirty-toast.js";
import { reviewMode } from "./13-hosted.js";

var COLOR_NAMES = ["Red", "Yellow", "Green", "Blue", "Black", "White"];
var SIZES = {
  pen: [0.004, 0.008, 0.016],
  highlight: [0.02, 0.035, 0.06],
  text: [0.03, 0.045, 0.07]
};
var HIGHLIGHT_ALPHA = 0.35;
var TEXT_LINE = 1.25;
var TEXT_OUTLINE = 0.12;
var MAX_TEXT = 500;
var MAX_POINTS = 2000;
var MAX_HISTORY = 200;
var STEP_PX = 1.5;
var ERASER_PX = 8;
var MOVE_PX = 4;
var ARM_MS = 2800;

var memory = { tool: "pen", color: {}, size: { pen: 1, highlight: 1, text: 1 } };

var ed = null;
var drawQueued = false;
var measureCtx = null;
var fontFamily = "";

function modal() { return document.getElementById("annotate-modal"); }
function frameEl() { return document.getElementById("annotate-frame"); }
function canvasEl() { return document.getElementById("annotate-canvas"); }
function imgEl() { return document.getElementById("annotate-img"); }
function textBoxEl() { return frameEl().querySelector(".annotate-textbox"); }

function copy(v) { return JSON.parse(JSON.stringify(v)); }
function round4(v) { return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000; }

export function annotatorOpen() { return !!ed; }

export function openAnnotator(rowId, at) {
  if (ed || reviewMode() || !S.state) return false;
  var idx = findRowIndex(rowId);
  if (idx === -1) return false;
  var slot = rowSlots(S.state.rows[idx])[at];
  if (!slot || !slot.ref || slotPoster(slot)) return false;
  var original = slotOriginal(slot);
  var marks = slot.annotation ? normalizeMarks(slot.annotation.marks) : [];
  ed = {
    rowId: rowId,
    at: at,
    sha: slot.ref.sha256,
    original: original,
    name: slot.name || "",
    start: JSON.stringify(marks),
    marks: copy(marks),
    undo: [],
    redo: [],
    gesture: null,
    text: null,
    ready: false,
    saving: false,
    committing: false,
    armed: false,
    armTimer: null,
    w: 0, h: 0,
    returnFocus: document.activeElement
  };
  var m = modal();
  m.hidden = false;
  document.getElementById("annotate-title").textContent = slot.annotation ? "Edit annotations" : "Annotate picture";
  var img = imgEl();
  img.alt = ed.name || "Picture " + (at + 1);
  img.removeAttribute("src");
  frameEl().style.visibility = "hidden";
  paintTools();
  setStatus("Loading the picture…");
  var tool = m.querySelector('[data-aact="tool"][aria-pressed="true"]');
  if (tool) tool.focus({ preventScroll: true });
  loadOriginal();
  return true;
}

function loadOriginal() {
  var sha = ed.original.sha256;
  var mine = ed;
  ensureBytes([sha]).then(function (missing) {
    if (ed !== mine) return;
    var url = missing.length ? null : urlForSync(sha);
    if (!url) {
      closeAnnotator();
      showToast("The original of this picture isn’t available here, so it can’t be annotated right now.", "warn");
      return;
    }
    var img = imgEl();
    img.onload = function () {
      img.onload = img.onerror = null;
      if (ed !== mine) return;
      ed.ready = true;
      frameEl().style.visibility = "";
      setStatus("");
      layout();
      paintTools();
      fontsReady().then(function () { if (ed === mine) redraw(); });
    };
    img.onerror = function () {
      img.onload = img.onerror = null;
      if (ed !== mine) return;
      closeAnnotator();
      showToast("This picture couldn’t be opened for annotating.", "warn");
    };
    img.src = url;
  });
}

export function closeAnnotator() {
  if (!ed) return;
  clearTimeout(ed.armTimer);
  var back = ed.returnFocus;
  ed = null;
  var box = textBoxEl();
  if (box) box.parentNode.removeChild(box);
  modal().hidden = true;
  disarmCancel();
  var img = imgEl();
  img.onload = img.onerror = null;
  img.removeAttribute("src");
  var g = document.getElementById("gallery-modal");
  var btn = g && !g.hidden ? g.querySelector('[data-gact="annotate"]') : null;
  if (!btn && g && !g.hidden) btn = g.querySelector(".scene-gallery-grid-tile.is-selected");
  var to = btn || (back && back.isConnected && back !== document.body ? back : null);
  if (to) to.focus({ preventScroll: true });
}

function locate() {
  var idx = findRowIndex(ed.rowId);
  if (idx === -1) return -1;
  var slots = rowSlots(S.state.rows[idx]);
  var s = slots[ed.at];
  if (s && s.ref && s.ref.sha256 === ed.sha && !slotPoster(s)) return ed.at;
  for (var i = 0; i < slots.length; i++) {
    if (slots[i].ref && slots[i].ref.sha256 === ed.sha && !slotPoster(slots[i])) { ed.at = i; return i; }
  }
  return -1;
}

export function refreshAnnotator() {
  if (!ed || ed.committing) return;
  if (locate() === -1) lost();
}

function lost() {
  closeAnnotator();
  showToast("This picture was changed or removed while you were drawing on it, so your marks weren’t saved.", "warn");
}

function layout() {
  if (!ed || !ed.ready) return;
  var img = imgEl();
  var nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return;
  var stage = document.getElementById("annotate-stage").getBoundingClientRect();
  var pad = stage.width <= 600 ? 8 : 24;
  var s = Math.min((stage.width - 2 * pad) / nw, (stage.height - 2 * pad) / nh);
  if (!(s > 0)) s = 1;
  ed.w = Math.max(1, Math.floor(nw * s));
  ed.h = Math.max(1, Math.floor(nh * s));
  var f = frameEl();
  f.style.width = ed.w + "px";
  f.style.height = ed.h + "px";
  var dpr = window.devicePixelRatio || 1;
  var c = canvasEl();
  c.width = Math.max(1, Math.round(ed.w * dpr));
  c.height = Math.max(1, Math.round(ed.h * dpr));
  redraw();
  placeTextBox();
}

function redraw() {
  drawQueued = false;
  if (!ed || !ed.ready) return;
  var c = canvasEl();
  var ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  var skip = ed.text ? ed.text.index : -1;
  var list = ed.marks.filter(function (m, i) { return i !== skip; });
  if (ed.gesture && ed.gesture.kind === "draw") list.push(ed.gesture.mark);
  drawMarks(ctx, list, c.width, c.height);
}

function queueRedraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(redraw);
}

function uiFont() {
  if (!fontFamily) {
    fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-body").trim() || "sans-serif";
  }
  return fontFamily;
}

function textFont(px) { return "700 " + px + "px " + uiFont(); }

function fontsReady() {
  var loaded = document.fonts && document.fonts.load ? document.fonts.load(textFont(32)).then(null, function () {}) : Promise.resolve();
  return Promise.race([loaded, new Promise(function (r) { setTimeout(r, 1500); })]);
}

function outlineFor(hex) {
  var n = parseInt(hex.slice(1), 16);
  var lin = function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  var lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.4 ? "#111111" : "#ffffff";
}

function drawMarks(ctx, marks, W, H) {
  marks.forEach(function (m) {
    if (m.kind === "text") drawText(ctx, m, W, H);
    else drawStroke(ctx, m, W, H);
  });
}

function drawStroke(ctx, m, W, H) {
  var p = m.points;
  var n = p.length / 2;
  if (!n) return;
  var lw = m.width * W;
  ctx.save();
  ctx.globalAlpha = m.kind === "highlight" ? HIGHLIGHT_ALPHA : 1;
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = lw;
  ctx.beginPath();
  if (n === 1) {
    ctx.arc(p[0] * W, p[1] * H, lw / 2, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.moveTo(p[0] * W, p[1] * H);
  for (var i = 1; i < n - 1; i++) {
    var x = p[2 * i] * W, y = p[2 * i + 1] * H;
    ctx.quadraticCurveTo(x, y, (x + p[2 * i + 2] * W) / 2, (y + p[2 * i + 3] * H) / 2);
  }
  ctx.lineTo(p[2 * n - 2] * W, p[2 * n - 1] * H);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx, m, W, H) {
  var px = m.size * W;
  var lh = px * TEXT_LINE;
  var lines = m.text.split("\n");
  var x = m.x * W, y = m.y * H;
  ctx.save();
  ctx.font = textFont(px);
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(1, px * TEXT_OUTLINE);
  ctx.strokeStyle = outlineFor(m.color);
  ctx.fillStyle = m.color;
  lines.forEach(function (line, k) { if (line) ctx.strokeText(line, x, y + lh * (k + 0.5)); });
  lines.forEach(function (line, k) { if (line) ctx.fillText(line, x, y + lh * (k + 0.5)); });
  ctx.restore();
}

function textBounds(m, W, H) {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  var px = m.size * W;
  measureCtx.font = textFont(px);
  var lines = m.text.split("\n");
  var w = px * 0.5;
  lines.forEach(function (line) { w = Math.max(w, measureCtx.measureText(line).width); });
  return { x: m.x * W, y: m.y * H, w: w, h: lines.length * px * TEXT_LINE };
}

function segmentDistance(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  var len = dx * dx + dy * dy;
  var t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  var cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

function hits(m, x, y, reach) {
  var W = ed.w, H = ed.h;
  if (m.kind === "text") {
    var b = textBounds(m, W, H);
    return x >= b.x - reach && x <= b.x + b.w + reach && y >= b.y - reach && y <= b.y + b.h + reach;
  }
  var p = m.points;
  var r = m.width * W / 2 + reach;
  if (p.length === 2) return segmentDistance(x, y, p[0] * W, p[1] * H, p[0] * W, p[1] * H) <= r;
  for (var i = 0; i + 3 < p.length; i += 2) {
    if (segmentDistance(x, y, p[i] * W, p[i + 1] * H, p[i + 2] * W, p[i + 3] * H) <= r) return true;
  }
  return false;
}

function textAt(x, y) {
  for (var i = ed.marks.length - 1; i >= 0; i--) {
    if (ed.marks[i].kind === "text" && hits(ed.marks[i], x, y, 4)) return i;
  }
  return -1;
}

function remember() {
  ed.undo.push(JSON.stringify(ed.marks));
  if (ed.undo.length > MAX_HISTORY) ed.undo.shift();
  ed.redo = [];
}

function undoMark() {
  commitText();
  if (!ed.undo.length) return;
  ed.redo.push(JSON.stringify(ed.marks));
  ed.marks = JSON.parse(ed.undo.pop());
  redraw();
  paintTools();
}

function redoMark() {
  commitText();
  if (!ed.redo.length) return;
  ed.undo.push(JSON.stringify(ed.marks));
  ed.marks = JSON.parse(ed.redo.pop());
  redraw();
  paintTools();
}

function clearAll() {
  commitText();
  if (!ed.marks.length) return;
  remember();
  ed.marks = [];
  redraw();
  paintTools();
}

function changed() {
  return JSON.stringify(normalizeMarks(ed.marks)) !== ed.start;
}

function pointOf(e) {
  var r = frameEl().getBoundingClientRect();
  var fx = r.width ? (e.clientX - r.left) / r.width : 0;
  var fy = r.height ? (e.clientY - r.top) / r.height : 0;
  fx = Math.min(1, Math.max(0, fx));
  fy = Math.min(1, Math.max(0, fy));
  return { fx: fx, fy: fy, x: fx * ed.w, y: fy * ed.h };
}

function onPointerDown(e) {
  if (!ed || !ed.ready || ed.saving) return;
  if (e.target && e.target.classList && e.target.classList.contains("annotate-textbox")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (ed.gesture) return;
  e.preventDefault();
  var p = pointOf(e);
  var tool = memory.tool;
  if (ed.text) {
    commitText();
    focusTool();
    if (tool === "text") return;
  }
  try { frameEl().setPointerCapture(e.pointerId); } catch (err) { }
  if (tool === "pen" || tool === "highlight") {
    ed.gesture = { kind: "draw", id: e.pointerId, last: p,
      mark: { kind: tool, color: memory.color[tool], width: SIZES[tool][memory.size[tool]], points: [round4(p.fx), round4(p.fy)] } };
    redraw();
  } else if (tool === "eraser") {
    ed.gesture = { kind: "erase", id: e.pointerId, last: p, removed: false };
    eraseAt(p.x, p.y);
  } else if (tool === "text") {
    var at = textAt(p.x, p.y);
    ed.gesture = at === -1
      ? { kind: "place", id: e.pointerId, at: p }
      : { kind: "text", id: e.pointerId, index: at, start: p, x: ed.marks[at].x, y: ed.marks[at].y, moved: false };
  }
}

function onPointerMove(e) {
  if (!ed || !ed.ready) return;
  var g = ed.gesture;
  if (!g) {
    if (memory.tool === "text" && !ed.text) {
      var p0 = pointOf(e);
      frameEl().classList.toggle("is-over-text", textAt(p0.x, p0.y) !== -1);
    }
    return;
  }
  if (e.pointerId !== g.id) return;
  var events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
  if (!events || !events.length) events = [e];
  if (g.kind === "draw") {
    events.forEach(function (ev) {
      var p = pointOf(ev);
      if (Math.hypot(p.x - g.last.x, p.y - g.last.y) < STEP_PX || g.mark.points.length >= MAX_POINTS * 2) return;
      g.mark.points.push(round4(p.fx), round4(p.fy));
      g.last = p;
    });
    queueRedraw();
  } else if (g.kind === "erase") {
    events.forEach(function (ev) {
      var p = pointOf(ev);
      var steps = Math.max(1, Math.ceil(Math.hypot(p.x - g.last.x, p.y - g.last.y) / 3));
      for (var k = 1; k <= steps; k++) {
        eraseAt(g.last.x + (p.x - g.last.x) * k / steps, g.last.y + (p.y - g.last.y) * k / steps);
      }
      g.last = p;
    });
  } else if (g.kind === "text") {
    var q = pointOf(e);
    var dx = q.x - g.start.x, dy = q.y - g.start.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < MOVE_PX) return;
    if (!g.moved) { g.moved = true; remember(); frameEl().classList.add("is-moving"); }
    var m = ed.marks[g.index];
    m.x = round4(g.x + dx / ed.w);
    m.y = round4(g.y + dy / ed.h);
    queueRedraw();
  }
}

function onPointerUp(e) {
  if (!ed) return;
  var g = ed.gesture;
  if (!g || e.pointerId !== g.id) return;
  ed.gesture = null;
  frameEl().classList.remove("is-moving");
  if (g.kind === "draw") {
    if (e.type === "pointerup") {
      var p = pointOf(e);
      if (Math.hypot(p.x - g.last.x, p.y - g.last.y) >= STEP_PX && g.mark.points.length < MAX_POINTS * 2) {
        g.mark.points.push(round4(p.fx), round4(p.fy));
      }
    }
    remember();
    ed.marks.push(g.mark);
  } else if (g.kind === "place") {
    startText(-1, g.at);
  } else if (g.kind === "text" && !g.moved) {
    startText(g.index);
  }
  redraw();
  paintTools();
}

function onPointerCancel(e) {
  if (!ed) return;
  var g = ed.gesture;
  if (!g || e.pointerId !== g.id) return;
  ed.gesture = null;
  frameEl().classList.remove("is-moving");
  if (g.kind === "text" && g.moved) {
    ed.marks = JSON.parse(ed.undo.pop());
  }
  redraw();
  paintTools();
}

function eraseAt(x, y) {
  var g = ed.gesture;
  var gone = false;
  for (var i = ed.marks.length - 1; i >= 0; i--) {
    if (!hits(ed.marks[i], x, y, ERASER_PX)) continue;
    if (!g.removed) { remember(); g.removed = true; }
    ed.marks.splice(i, 1);
    gone = true;
  }
  if (gone) { redraw(); paintTools(); }
}

function startText(index, at) {
  var m;
  if (index >= 0) {
    m = copy(ed.marks[index]);
  } else {
    var size = SIZES.text[memory.size.text];
    var half = size * ed.w * TEXT_LINE / 2;
    m = { kind: "text", color: memory.color.text, size: size,
      x: round4(at.fx), y: round4((at.y - half) / ed.h), text: "" };
  }
  ed.text = { index: index, mark: m };
  var box = document.createElement("textarea");
  box.className = "annotate-textbox";
  box.setAttribute("wrap", "off");
  box.setAttribute("rows", "1");
  box.setAttribute("maxlength", String(MAX_TEXT));
  box.setAttribute("spellcheck", "false");
  box.setAttribute("aria-label", "Text on the picture");
  box.value = m.text;
  box.addEventListener("input", placeTextBox);
  frameEl().appendChild(box);
  placeTextBox();
  redraw();
  paintTools();
  box.focus({ preventScroll: true });
  box.setSelectionRange(box.value.length, box.value.length);
}

function placeTextBox() {
  var box = textBoxEl();
  if (!ed || !ed.text || !box) return;
  var m = ed.text.mark;
  var px = m.size * ed.w;
  box.style.left = m.x * ed.w + "px";
  box.style.top = m.y * ed.h + "px";
  box.style.fontSize = px + "px";
  box.style.color = m.color;
  box.style.setProperty("--annotate-outline", outlineFor(m.color));
  box.style.setProperty("--annotate-outline-width", Math.max(1, px * TEXT_OUTLINE) + "px");
  box.style.width = "0px";
  box.style.height = "0px";
  box.style.width = box.scrollWidth + Math.ceil(px * 0.2) + "px";
  box.style.height = box.scrollHeight + "px";
}

function commitText() {
  if (!ed || !ed.text) return;
  var t = ed.text;
  var box = textBoxEl();
  var text = box ? box.value.replace(/\r\n?/g, "\n").slice(0, MAX_TEXT).replace(/\s+$/, "") : "";
  ed.text = null;
  if (box) box.parentNode.removeChild(box);
  var had = t.index >= 0 ? ed.marks[t.index] : null;
  if (!text.trim()) {
    if (had) { remember(); ed.marks.splice(t.index, 1); }
  } else {
    var m = copy(t.mark);
    m.text = text;
    if (!had || JSON.stringify(had) !== JSON.stringify(m)) {
      remember();
      if (had) ed.marks[t.index] = m; else ed.marks.push(m);
    }
  }
  redraw();
  paintTools();
}

function setTool(tool) {
  commitText();
  memory.tool = tool;
  frameEl().classList.remove("is-over-text");
  paintTools();
}

function setColor(color) {
  if (memory.tool === "eraser") return;
  memory.color[memory.tool] = color;
  if (ed.text) {
    ed.text.mark.color = color;
    placeTextBox();
  }
  paintTools();
  refocusText();
}

function setSize(i) {
  if (memory.tool === "eraser") return;
  memory.size[memory.tool] = i;
  if (ed.text) {
    ed.text.mark.size = SIZES.text[i];
    placeTextBox();
  }
  paintTools();
  refocusText();
}

function refocusText() {
  var box = textBoxEl();
  if (box) box.focus({ preventScroll: true });
}

function focusTool() {
  var b = modal().querySelector('[data-aact="tool"][aria-pressed="true"]');
  if (b) b.focus({ preventScroll: true });
}

var HINTS = {
  pen: "",
  highlight: "",
  text: "Click the picture to type. Click a text to change it, or drag it to move it.",
  eraser: "Drag over a mark to erase it."
};

function paintTools() {
  if (!ed) return;
  var m = modal();
  var tool = memory.tool;
  m.querySelectorAll('[data-aact="tool"]').forEach(function (b) {
    b.setAttribute("aria-pressed", b.getAttribute("data-tool") === tool ? "true" : "false");
  });
  frameEl().setAttribute("data-tool", tool);
  var eraser = tool === "eraser";
  var color = ed.text ? ed.text.mark.color : memory.color[tool];
  m.querySelectorAll('[data-aact="color"]').forEach(function (b) {
    b.disabled = eraser;
    b.setAttribute("aria-pressed", !eraser && b.getAttribute("data-color") === color ? "true" : "false");
  });
  var size = eraser ? -1 : memory.size[tool];
  m.querySelectorAll('[data-aact="size"]').forEach(function (b) {
    b.disabled = eraser;
    b.setAttribute("aria-pressed", Number(b.getAttribute("data-size")) === size ? "true" : "false");
  });
  document.getElementById("annotate-undo").disabled = !ed.undo.length && !ed.text;
  document.getElementById("annotate-redo").disabled = !ed.redo.length;
  document.getElementById("annotate-clear").disabled = !ed.marks.length && !ed.text;
  document.getElementById("annotate-done").disabled = !ed.ready || ed.saving;
  if (ed.ready && !ed.saving) setStatus(HINTS[tool] || "");
}

function setStatus(text) {
  var s = document.getElementById("annotate-status");
  if (s.textContent !== text) s.textContent = text;
  s.hidden = !text;
}

function cancel(fromKey) {
  commitText();
  if (!changed() || ed.armed) { closeAnnotator(); return; }
  var btn = document.getElementById("annotate-cancel");
  ed.armed = true;
  btn.textContent = "Discard changes?";
  btn.classList.add("armed");
  if (fromKey) btn.focus({ preventScroll: true });
  clearTimeout(ed.armTimer);
  ed.armTimer = setTimeout(function () {
    if (ed) ed.armed = false;
    disarmCancel();
  }, ARM_MS);
}

function disarmCancel() {
  var btn = document.getElementById("annotate-cancel");
  btn.textContent = "Cancel";
  btn.classList.remove("armed");
}

function done() {
  commitText();
  if (!ed.ready || ed.saving) return;
  if (reviewMode()) {
    closeAnnotator();
    showToast("This script can only be commented on now, so the annotations weren’t saved.", "warn");
    return;
  }
  var marks = normalizeMarks(ed.marks);
  if (JSON.stringify(marks) === ed.start) { closeAnnotator(); return; }
  if (locate() === -1) { lost(); return; }
  if (!marks.length) { save(null, marks); return; }
  var mine = ed;
  ed.saving = true;
  setStatus("Saving…");
  paintTools();
  flatten(marks).then(function (rec) {
    if (ed !== mine) return;
    ed.saving = false;
    paintTools();
    if (!rec) { showToast("Could not save the annotated picture — it may be too large for this browser.", "warn"); return; }
    save(rec, marks);
  });
}

function save(rec, marks) {
  var at = locate();
  if (at === -1) { lost(); return; }
  var original = ed.original;
  ed.committing = true;
  var ok = galleryEdit(ed.rowId, marks.length ? "Picture annotated" : "Annotations removed", function (row) {
    return annotateGallerySlot(row, at, rec, original, marks);
  });
  if (!ed) return;
  ed.committing = false;
  if (!ok) {
    showToast("Could not save the annotations to this picture.", "warn");
    return;
  }
  closeAnnotator();
}

function flatten(marks) {
  var img = imgEl();
  return fontsReady().then(function () {
    var w = img.naturalWidth, h = img.naturalHeight;
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    var ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    drawMarks(ctx, marks, w, h);
    var jpeg = ed && ed.original.mime === "image/jpeg";
    return new Promise(function (resolve) {
      try { c.toBlob(resolve, jpeg ? "image/jpeg" : "image/png", 0.9); } catch (e) { resolve(null); }
    });
  }).then(function (blob) {
    return blob ? blob.arrayBuffer() : null;
  }).then(function (buf) {
    var rec = buf ? intern(new Uint8Array(buf)) : null;
    if (rec) persist([rec.sha256]);
    return rec;
  }).then(null, function () { return null; });
}

function isUndoKey(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "z" || e.key === "Z");
}
function isRedoKey(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey &&
    (((e.key === "z" || e.key === "Z") && e.shiftKey) || ((e.key === "y" || e.key === "Y") && !e.shiftKey));
}

function onWindowKeydown(e) {
  if (!ed) return;
  var inText = !!(e.target && e.target.classList && e.target.classList.contains("annotate-textbox"));
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (ed.text) { commitText(); focusTool(); return; }
    cancel(true);
    return;
  }
  if (e.key === "Tab") { keepFocusIn(e); return; }
  if (inText) return;
  if (isRedoKey(e) || isUndoKey(e)) {
    e.preventDefault();
    e.stopPropagation();
    if (isRedoKey(e)) redoMark(); else undoMark();
    return;
  }
  var tool = toolForKey(e);
  if (tool && !ed.gesture) {
    e.preventDefault();
    e.stopPropagation();
    setTool(tool);
  }
}

var TOOL_KEYS = { p: "pen", h: "highlight", t: "text", e: "eraser" };

function toolForKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return "";
  return TOOL_KEYS[String(e.key || "").toLowerCase()] || "";
}

function keepFocusIn(e) {
  var list = Array.prototype.filter.call(modal().querySelectorAll("button, textarea"), function (el) {
    return !el.disabled && el.offsetParent !== null;
  });
  if (!list.length) return;
  var i = list.indexOf(document.activeElement);
  var to = null;
  if (e.shiftKey && i <= 0) to = list[list.length - 1];
  else if (!e.shiftKey && (i === -1 || i === list.length - 1)) to = list[0];
  if (!to) return;
  e.preventDefault();
  e.stopPropagation();
  to.focus({ preventScroll: true });
}

function onClick(e) {
  if (!ed) return;
  var b = e.target.closest && e.target.closest("[data-aact]");
  if (!b || b.disabled) return;
  var act = b.getAttribute("data-aact");
  if (act === "tool") setTool(b.getAttribute("data-tool"));
  else if (act === "color") setColor(b.getAttribute("data-color"));
  else if (act === "size") setSize(Number(b.getAttribute("data-size")));
  else if (act === "undo") undoMark();
  else if (act === "redo") redoMark();
  else if (act === "clear") clearAll();
  else if (act === "cancel") cancel(false);
  else if (act === "done") done();
}

function buildSwatches() {
  var host = document.getElementById("annotate-colors");
  ANNOTATION_COLORS.forEach(function (c, i) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "annotate-swatch";
    b.setAttribute("data-aact", "color");
    b.setAttribute("data-color", c);
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", COLOR_NAMES[i] || c);
    b.title = COLOR_NAMES[i] || c;
    b.style.setProperty("--swatch", c);
    host.appendChild(b);
  });
}

export function __init() {
  memory.color = { pen: ANNOTATION_COLORS[0], highlight: ANNOTATION_COLORS[1], text: ANNOTATION_COLORS[0] };
  var m = modal();
  if (!m) return;
  buildSwatches();
  m.addEventListener("click", onClick);
  var f = frameEl();
  f.addEventListener("pointerdown", onPointerDown);
  f.addEventListener("pointermove", onPointerMove);
  f.addEventListener("pointerup", onPointerUp);
  f.addEventListener("pointercancel", onPointerCancel);
  f.addEventListener("lostpointercapture", onPointerUp);
  window.addEventListener("keydown", onWindowKeydown, true);
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () { if (ed) layout(); }).observe(document.getElementById("annotate-stage"));
  } else {
    window.addEventListener("resize", function () { if (ed) layout(); });
  }
  window.__annotateTest = {
    state: function () {
      return ed ? { tool: memory.tool, marks: copy(ed.marks), undo: ed.undo.length, redo: ed.redo.length,
        text: ed.text ? copy(ed.text.mark) : null, ready: ed.ready, at: ed.at, w: ed.w, h: ed.h } : null;
    }
  };
}
