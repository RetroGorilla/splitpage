import { rowIndexOf } from "../../core/document/rows.ts";
import { slotPoster } from "../common/gallery.ts";
import { ANNOTATION_COLORS, annotateGallerySlot, normalizeMarks, rowSlots, slotOriginal } from "../../core/document/gallery.ts";
import { cappedLongText, codePointPrefix } from "../../core/document/text-policy.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

import type { GalleryMount, GalleryPorts } from "./ports.ts";
import type { Mark, Slot } from "../../core/document/gallery.ts";
import type { ImageRef } from "../../core/document/ports.ts";
import type { DocumentView } from "../../application/session/document-session.ts";

type AnnotatorDocument = Pick<DocumentView, "rows">;

interface AnnotatorPortUse extends Omit<GalleryPorts, "document"> {
  readonly document: {
    readonly current: (...args: Parameters<GalleryPorts["document"]["current"]>) => AnnotatorDocument | Extract<ReturnType<GalleryPorts["document"]["current"]>, null | undefined>;
    readonly read: GalleryPorts["document"]["read"];
  };
}

type DrawingTool = "pen" | "highlight" | "text";
type Tool = DrawingTool | "eraser";
type StrokeMark = Extract<Mark, { kind: "pen" | "highlight" }>;
type LabelMark = Extract<Mark, { kind: "text" }>;
type Point = { fx: number; fy: number; x: number; y: number };
type Gesture =
  | { kind: "draw"; id: number; last: Point; mark: StrokeMark }
  | { kind: "erase"; id: number; last: Point; removed: boolean }
  | { kind: "place"; id: number; at: Point }
  | { kind: "text"; id: number; index: number; start: Point; x: number; y: number; moved: boolean };
interface AnnotatorState {
  rowId: string;
  at: number;
  sha: string;
  original: ImageRef;
  name: string;
  start: string;
  marks: Mark[];
  undo: string[];
  redo: string[];
  gesture: Gesture | null;
  text: { index: number; mark: LabelMark } | null;
  ready: boolean;
  saving: boolean;
  committing: boolean;
  armed: boolean;
  armTimer: ReturnType<typeof setTimeout> | null;
  w: number;
  h: number;
  returnFocus: HTMLElement | SVGElement | null;
}

let ports: GalleryPorts | null = null;

const COLOR_NAMES = ["Red", "Yellow", "Green", "Blue", "Black", "White"];
const SIZES: Record<DrawingTool, [number, number, number]> = {
  pen: [0.004, 0.008, 0.016],
  highlight: [0.02, 0.035, 0.06],
  text: [0.03, 0.045, 0.07]
};
const HIGHLIGHT_ALPHA = 0.35;
const TEXT_LINE = 1.25;
const TEXT_OUTLINE = 0.12;
const MAX_TEXT = 500;
const MAX_POINTS = 2000;
const MAX_HISTORY = 200;
const STEP_PX = 1.5;
const ERASER_PX = 8;
const MOVE_PX = 4;
const ARM_MS = 2800;

const memory: { tool: Tool; color: Partial<Record<Tool, string>>; size: Record<DrawingTool, number> } = { tool: "pen", color: {}, size: { pen: 1, highlight: 1, text: 1 } };

let ed: AnnotatorState | null = null;
let drawQueued = false;
let drawFrame: number | null = null;
const fontTimers = new Set<ReturnType<typeof setTimeout>>();
let measureCtx: CanvasRenderingContext2D | null = null;
let fontFamily = "";

function modal() { return (document.getElementById("annotate-modal") as HTMLElement); }
function frameEl() { return (document.getElementById("annotate-frame") as HTMLElement); }
function canvasEl() { return document.getElementById("annotate-canvas") as HTMLCanvasElement; }
function imgEl() { return document.getElementById("annotate-img") as HTMLImageElement; }
function textBoxEl() { return frameEl().querySelector<HTMLTextAreaElement>(".annotate-textbox"); }

function copy<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function round4(v: number) { return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000; }

export function annotatorOpen() { return !!ed; }

export function openAnnotator(rowId: string, at: number) {
  if (ed || !(ports as AnnotatorPortUse).document.current()) return false;
  const idx = (ports as AnnotatorPortUse).document.read(function (doc) { return rowIndexOf(doc, rowId); });
  if (idx === -1) return false;
  const slot = rowSlots(((ports as AnnotatorPortUse).document.current() as AnnotatorDocument).rows[idx])[at];
  if (!slot || !slot.ref || slotPoster(slot)) return false;
  const original = slotOriginal(slot);
  const marks = slot.annotation ? normalizeMarks(slot.annotation.marks) : [];
  ed = {
    rowId: rowId,
    at: at,
    sha: slot.ref.sha256,
    original: (original as ImageRef),
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
    returnFocus: document.activeElement as HTMLElement | SVGElement | null
  };
  const m = modal();
  m.hidden = false;
  (document.getElementById("annotate-title") as HTMLElement).textContent = slot.annotation ? "Edit annotations" : "Annotate picture";
  const img = imgEl();
  img.alt = ed.name || "Picture " + (at + 1);
  img.removeAttribute("src");
  frameEl().style.visibility = "hidden";
  paintTools();
  setStatus("Loading the picture…");
  const tool = m.querySelector<HTMLButtonElement>('[data-aact="tool"][aria-pressed="true"]');
  if (tool) tool.focus({ preventScroll: true });
  loadOriginal();
  return true;
}

function loadOriginal() {
  const sha = (ed as AnnotatorState).original.sha256;
  const mine = ed;
  (ports as AnnotatorPortUse).pictures.ensureBytes([sha]).then(function (missing) {
    if (ed !== mine) return;
    const url = missing.length ? null : (ports as AnnotatorPortUse).pictures.urlFor(sha);
    if (!url) {
      closeAnnotator();
      (ports as AnnotatorPortUse).notices.show("The original of this picture isn’t available here, so it can’t be annotated right now.", "warn");
      return;
    }
    const img = imgEl();
    img.onload = function () {
      img.onload = img.onerror = null;
      if (ed !== mine) return;
      (ed as AnnotatorState).ready = true;
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
      (ports as AnnotatorPortUse).notices.show("This picture couldn’t be opened for annotating.", "warn");
    };
    img.src = url;
  });
}

export function closeAnnotator() {
  if (!ed) return;
  clearTimeout((ed.armTimer as ReturnType<typeof setTimeout>));
  const back = ed.returnFocus;
  ed = null;
  const box = textBoxEl();
  if (box) (box.parentNode as ParentNode).removeChild(box);
  modal().hidden = true;
  disarmCancel();
  const img = imgEl();
  img.onload = img.onerror = null;
  img.removeAttribute("src");
  const g = document.getElementById("gallery-modal");
  let btn = g && !g.hidden ? g.querySelector<HTMLElement>('[data-gact="annotate"]') : null;
  if (!btn && g && !g.hidden) btn = g.querySelector<HTMLElement>(".scene-gallery-grid-tile.is-selected");
  const to = btn || (back && back.isConnected && back !== document.body ? back : null);
  if (to) to.focus({ preventScroll: true });
}

function locate() {
  const idx = (ports as AnnotatorPortUse).document.read(function (doc) { return rowIndexOf(doc, (ed as AnnotatorState).rowId); });
  if (idx === -1) return -1;
  const slots = rowSlots(((ports as AnnotatorPortUse).document.current() as AnnotatorDocument).rows[idx]);
  const s = slots[(ed as AnnotatorState).at];
  if (s && s.ref && s.ref.sha256 === (ed as AnnotatorState).sha && !slotPoster(s)) return (ed as AnnotatorState).at;
  for (let i = 0; i < slots.length; i++) {
    if ((slots[i] as Slot).ref && ((slots[i] as Slot).ref as ImageRef).sha256 === (ed as AnnotatorState).sha && !slotPoster((slots[i] as Slot))) { (ed as AnnotatorState).at = i; return i; }
  }
  return -1;
}

export function refreshAnnotator() {
  if (!ed || ed.committing) return;
  if (locate() === -1) lost();
}

function lost() {
  closeAnnotator();
  (ports as AnnotatorPortUse).notices.show("This picture was changed or removed while you were drawing on it, so your marks weren’t saved.", "warn");
}

function layout() {
  if (!ed || !ed.ready) return;
  const img = imgEl();
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return;
  const stage = (document.getElementById("annotate-stage") as HTMLElement).getBoundingClientRect();
  const pad = stage.width <= 600 ? 8 : 24;
  let s = Math.min((stage.width - 2 * pad) / nw, (stage.height - 2 * pad) / nh);
  if (!(s > 0)) s = 1;
  ed.w = Math.max(1, Math.floor(nw * s));
  ed.h = Math.max(1, Math.floor(nh * s));
  const f = frameEl();
  f.style.width = ed.w + "px";
  f.style.height = ed.h + "px";
  const dpr = window.devicePixelRatio || 1;
  const c = canvasEl();
  c.width = Math.max(1, Math.round(ed.w * dpr));
  c.height = Math.max(1, Math.round(ed.h * dpr));
  redraw();
  placeTextBox();
}

function redraw() {
  if (drawFrame !== null) cancelAnimationFrame(drawFrame);
  drawQueued = false;
  drawFrame = null;
  if (!ed || !ed.ready) return;
  const c = canvasEl();
  const ctx = (c.getContext("2d") as CanvasRenderingContext2D);
  ctx.clearRect(0, 0, c.width, c.height);
  const skip = ed.text ? ed.text.index : -1;
  const list = ed.marks.filter(function (m, i) { return i !== skip; });
  if (ed.gesture && ed.gesture.kind === "draw") list.push(ed.gesture.mark);
  drawMarks(ctx, list, c.width, c.height);
}

function queueRedraw() {
  if (drawQueued) return;
  drawQueued = true;
  drawFrame = requestAnimationFrame(redraw);
}

function uiFont() {
  if (!fontFamily) {
    fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-body").trim() || "sans-serif";
  }
  return fontFamily;
}

function textFont(px: number) { return "700 " + px + "px " + uiFont(); }

function fontsReady() {
  const loaded = document.fonts && document.fonts.load ? document.fonts.load(textFont(32)).then(null, function () {}) : Promise.resolve();
  return Promise.race([loaded, new Promise<void>(function (r) {
    const timer = setTimeout(function () { fontTimers.delete(timer); r(); }, 1500);
    fontTimers.add(timer);
  })]);
}

function outlineFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lin = function (v: number) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.4 ? "#111111" : "#ffffff";
}

function drawMarks(ctx: CanvasRenderingContext2D, marks: Mark[], W: number, H: number) {
  marks.forEach(function (m) {
    if (m.kind === "text") drawText(ctx, m, W, H);
    else drawStroke(ctx, m, W, H);
  });
}

function drawStroke(ctx: CanvasRenderingContext2D, m: StrokeMark, W: number, H: number) {
  const p = m.points;
  const n = p.length / 2;
  if (!n) return;
  const lw = m.width * W;
  ctx.save();
  ctx.globalAlpha = m.kind === "highlight" ? HIGHLIGHT_ALPHA : 1;
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = lw;
  ctx.beginPath();
  if (n === 1) {
    ctx.arc((p[0] as number) * W, (p[1] as number) * H, lw / 2, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.moveTo((p[0] as number) * W, (p[1] as number) * H);
  for (let i = 1; i < n - 1; i++) {
    const x = (p[2 * i] as number) * W, y = (p[2 * i + 1] as number) * H;
    ctx.quadraticCurveTo(x, y, (x + (p[2 * i + 2] as number) * W) / 2, (y + (p[2 * i + 3] as number) * H) / 2);
  }
  ctx.lineTo((p[2 * n - 2] as number) * W, (p[2 * n - 1] as number) * H);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, m: LabelMark, W: number, H: number) {
  const px = m.size * W;
  const lh = px * TEXT_LINE;
  const lines = m.text.split("\n");
  const x = m.x * W, y = m.y * H;
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

function textBounds(m: LabelMark, W: number, H: number) {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  const px = m.size * W;
  (measureCtx as CanvasRenderingContext2D).font = textFont(px);
  const lines = m.text.split("\n");
  let w = px * 0.5;
  lines.forEach(function (line) { w = Math.max(w, (measureCtx as CanvasRenderingContext2D).measureText(line).width); });
  return { x: m.x * W, y: m.y * H, w: w, h: lines.length * px * TEXT_LINE };
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

function hits(m: Mark, x: number, y: number, reach: number) {
  const W = (ed as AnnotatorState).w, H = (ed as AnnotatorState).h;
  if (m.kind === "text") {
    const b = textBounds(m, W, H);
    return x >= b.x - reach && x <= b.x + b.w + reach && y >= b.y - reach && y <= b.y + b.h + reach;
  }
  const p = m.points;
  const r = m.width * W / 2 + reach;
  if (p.length === 2) return segmentDistance(x, y, (p[0] as number) * W, (p[1] as number) * H, (p[0] as number) * W, (p[1] as number) * H) <= r;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (segmentDistance(x, y, (p[i] as number) * W, (p[i + 1] as number) * H, (p[i + 2] as number) * W, (p[i + 3] as number) * H) <= r) return true;
  }
  return false;
}

function textAt(x: number, y: number) {
  for (let i = (ed as AnnotatorState).marks.length - 1; i >= 0; i--) {
    if (((ed as AnnotatorState).marks[i] as Mark).kind === "text" && hits(((ed as AnnotatorState).marks[i] as Mark), x, y, 4)) return i;
  }
  return -1;
}

function remember() {
  (ed as AnnotatorState).undo.push(JSON.stringify((ed as AnnotatorState).marks));
  if ((ed as AnnotatorState).undo.length > MAX_HISTORY) (ed as AnnotatorState).undo.shift();
  (ed as AnnotatorState).redo = [];
}

function undoMark() {
  commitText();
  if (!(ed as AnnotatorState).undo.length) return;
  (ed as AnnotatorState).redo.push(JSON.stringify((ed as AnnotatorState).marks));
  (ed as AnnotatorState).marks = JSON.parse(((ed as AnnotatorState).undo.pop() as string)) as Mark[];
  redraw();
  paintTools();
}

function redoMark() {
  commitText();
  if (!(ed as AnnotatorState).redo.length) return;
  (ed as AnnotatorState).undo.push(JSON.stringify((ed as AnnotatorState).marks));
  (ed as AnnotatorState).marks = JSON.parse(((ed as AnnotatorState).redo.pop() as string)) as Mark[];
  redraw();
  paintTools();
}

function clearAll() {
  commitText();
  if (!(ed as AnnotatorState).marks.length) return;
  remember();
  (ed as AnnotatorState).marks = [];
  redraw();
  paintTools();
}

function changed() {
  return JSON.stringify(normalizeMarks((ed as AnnotatorState).marks)) !== (ed as AnnotatorState).start;
}

function pointOf(e: MouseEvent) {
  const r = frameEl().getBoundingClientRect();
  let fx = r.width ? (e.clientX - r.left) / r.width : 0;
  let fy = r.height ? (e.clientY - r.top) / r.height : 0;
  fx = Math.min(1, Math.max(0, fx));
  fy = Math.min(1, Math.max(0, fy));
  return { fx: fx, fy: fy, x: fx * (ed as AnnotatorState).w, y: fy * (ed as AnnotatorState).h };
}

function onPointerDown(e: PointerEvent) {
  if (!ed || !ed.ready || ed.saving) return;
  if (e.target && (e.target as Element).classList && (e.target as Element).classList.contains("annotate-textbox")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (ed.gesture) return;
  e.preventDefault();
  const p = pointOf(e);
  const tool = memory.tool;
  if (ed.text) {
    commitText();
    focusTool();
    if (tool === "text") return;
  }
  try { frameEl().setPointerCapture(e.pointerId); } catch (err) { }
  if (tool === "pen" || tool === "highlight") {
    ed.gesture = { kind: "draw", id: e.pointerId, last: p,
      mark: { kind: tool, color: (memory.color[tool] as string), width: (SIZES[tool][memory.size[tool]] as number), points: [round4(p.fx), round4(p.fy)] } };
    redraw();
  } else if (tool === "eraser") {
    ed.gesture = { kind: "erase", id: e.pointerId, last: p, removed: false };
    eraseAt(p.x, p.y);
  } else if (tool === "text") {
    const at = textAt(p.x, p.y);
    ed.gesture = at === -1
      ? { kind: "place", id: e.pointerId, at: p }
      : { kind: "text", id: e.pointerId, index: at, start: p, x: (ed.marks[at] as LabelMark).x, y: (ed.marks[at] as LabelMark).y, moved: false };
  }
}

function onPointerMove(e: PointerEvent) {
  if (!ed || !ed.ready) return;
  const g = ed.gesture;
  if (!g) {
    if (memory.tool === "text" && !ed.text) {
      const p0 = pointOf(e);
      frameEl().classList.toggle("is-over-text", textAt(p0.x, p0.y) !== -1);
    }
    return;
  }
  if (e.pointerId !== g.id) return;
  let events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
  if (!events || !events.length) events = [e];
  if (g.kind === "draw") {
    events.forEach(function (ev) {
      const p = pointOf(ev);
      if (Math.hypot(p.x - g.last.x, p.y - g.last.y) < STEP_PX || g.mark.points.length >= MAX_POINTS * 2) return;
      g.mark.points.push(round4(p.fx), round4(p.fy));
      g.last = p;
    });
    queueRedraw();
  } else if (g.kind === "erase") {
    events.forEach(function (ev) {
      const p = pointOf(ev);
      const steps = Math.max(1, Math.ceil(Math.hypot(p.x - g.last.x, p.y - g.last.y) / 3));
      for (let k = 1; k <= steps; k++) {
        eraseAt(g.last.x + (p.x - g.last.x) * k / steps, g.last.y + (p.y - g.last.y) * k / steps);
      }
      g.last = p;
    });
  } else if (g.kind === "text") {
    const q = pointOf(e);
    const dx = q.x - g.start.x, dy = q.y - g.start.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < MOVE_PX) return;
    if (!g.moved) { g.moved = true; remember(); frameEl().classList.add("is-moving"); }
    const m = ed.marks[g.index] as LabelMark;
    m.x = round4(g.x + dx / ed.w);
    m.y = round4(g.y + dy / ed.h);
    queueRedraw();
  }
}

function onPointerUp(e: PointerEvent) {
  if (!ed) return;
  const g = ed.gesture;
  if (!g || e.pointerId !== g.id) return;
  ed.gesture = null;
  frameEl().classList.remove("is-moving");
  if (g.kind === "draw") {
    if (e.type === "pointerup") {
      const p = pointOf(e);
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

function onPointerCancel(e: PointerEvent) {
  if (!ed) return;
  const g = ed.gesture;
  if (!g || e.pointerId !== g.id) return;
  ed.gesture = null;
  frameEl().classList.remove("is-moving");
  if (g.kind === "text" && g.moved) {
    ed.marks = JSON.parse((ed.undo.pop() as string)) as Mark[];
  }
  redraw();
  paintTools();
}

function eraseAt(x: number, y: number) {
  const g = (ed as AnnotatorState).gesture as Extract<Gesture, { kind: "erase" }>;
  let gone = false;
  for (let i = (ed as AnnotatorState).marks.length - 1; i >= 0; i--) {
    if (!hits(((ed as AnnotatorState).marks[i] as Mark), x, y, ERASER_PX)) continue;
    if (!g.removed) { remember(); g.removed = true; }
    (ed as AnnotatorState).marks.splice(i, 1);
    gone = true;
  }
  if (gone) { redraw(); paintTools(); }
}

function startText(index: number, at?: Point) {
  let m: LabelMark;
  if (index >= 0) {
    m = copy((ed as AnnotatorState).marks[index] as LabelMark);
  } else {
    const size = (SIZES.text[memory.size.text] as number);
    const half = size * (ed as AnnotatorState).w * TEXT_LINE / 2;
    m = { kind: "text", color: (memory.color.text as string), size: size,
      x: round4((at as Point).fx), y: round4(((at as Point).y - half) / (ed as AnnotatorState).h), text: "" };
  }
  (ed as AnnotatorState).text = { index: index, mark: m };
  const box = document.createElement("textarea");
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
  const box = textBoxEl();
  if (!ed || !ed.text || !box) return;
  const m = ed.text.mark;
  const px = m.size * ed.w;
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
  const t = ed.text;
  const box = textBoxEl();
  const raw = box ? box.value.replace(/\r\n?/g, "\n") : "";
  const cut = cappedLongText(raw, MAX_TEXT);
  const text = (cut.trim() ? cut : codePointPrefix(raw, MAX_TEXT)).replace(/\s+$/, "");
  ed.text = null;
  if (box) (box.parentNode as ParentNode).removeChild(box);
  const had = t.index >= 0 ? ed.marks[t.index] : null;
  if (!text.trim()) {
    if (had) { remember(); ed.marks.splice(t.index, 1); }
  } else {
    const m = copy(t.mark);
    m.text = text;
    if (!had || JSON.stringify(had) !== JSON.stringify(m)) {
      remember();
      if (had) ed.marks[t.index] = m; else ed.marks.push(m);
    }
  }
  redraw();
  paintTools();
}

function setTool(tool: Tool) {
  commitText();
  memory.tool = tool;
  frameEl().classList.remove("is-over-text");
  paintTools();
}

function setColor(color: string) {
  if (memory.tool === "eraser") return;
  memory.color[memory.tool] = color;
  if ((ed as AnnotatorState).text) {
    ((ed as AnnotatorState).text as NonNullable<AnnotatorState["text"]>).mark.color = color;
    placeTextBox();
  }
  paintTools();
  refocusText();
}

function setSize(i: number) {
  if (memory.tool === "eraser") return;
  memory.size[memory.tool] = i;
  if ((ed as AnnotatorState).text) {
    ((ed as AnnotatorState).text as NonNullable<AnnotatorState["text"]>).mark.size = (SIZES.text[i] as number);
    placeTextBox();
  }
  paintTools();
  refocusText();
}

function refocusText() {
  const box = textBoxEl();
  if (box) box.focus({ preventScroll: true });
}

function focusTool() {
  const b = modal().querySelector<HTMLButtonElement>('[data-aact="tool"][aria-pressed="true"]');
  if (b) b.focus({ preventScroll: true });
}

const HINTS: Record<Tool, string> = {
  pen: "",
  highlight: "",
  text: "Click the picture to type. Click a text to change it, or drag it to move it.",
  eraser: "Drag over a mark to erase it."
};

function paintTools() {
  if (!ed) return;
  const m = modal();
  const tool = memory.tool;
  m.querySelectorAll<HTMLButtonElement>('[data-aact="tool"]').forEach(function (b) {
    b.setAttribute("aria-pressed", b.getAttribute("data-tool") === tool ? "true" : "false");
  });
  frameEl().setAttribute("data-tool", tool);
  const eraser = tool === "eraser";
  const color = ed.text ? ed.text.mark.color : memory.color[tool];
  m.querySelectorAll<HTMLButtonElement>('[data-aact="color"]').forEach(function (b) {
    b.disabled = eraser;
    b.setAttribute("aria-pressed", !eraser && b.getAttribute("data-color") === color ? "true" : "false");
  });
  const size = eraser ? -1 : memory.size[tool as DrawingTool];
  m.querySelectorAll<HTMLButtonElement>('[data-aact="size"]').forEach(function (b) {
    b.disabled = eraser;
    b.setAttribute("aria-pressed", Number(b.getAttribute("data-size")) === size ? "true" : "false");
  });
  (document.getElementById("annotate-undo") as HTMLButtonElement).disabled = !ed.undo.length && !ed.text;
  (document.getElementById("annotate-redo") as HTMLButtonElement).disabled = !ed.redo.length;
  (document.getElementById("annotate-clear") as HTMLButtonElement).disabled = !ed.marks.length && !ed.text;
  (document.getElementById("annotate-done") as HTMLButtonElement).disabled = !ed.ready || ed.saving;
  if (ed.ready && !ed.saving) setStatus(HINTS[tool] || "");
}

function setStatus(text: string) {
  const s = (document.getElementById("annotate-status") as HTMLElement);
  if (s.textContent !== text) s.textContent = text;
  s.hidden = !text;
}

function cancel(fromKey: boolean) {
  commitText();
  if (!changed() || (ed as AnnotatorState).armed) { closeAnnotator(); return; }
  const btn = (document.getElementById("annotate-cancel") as HTMLElement);
  (ed as AnnotatorState).armed = true;
  btn.textContent = "Discard changes?";
  btn.classList.add("armed");
  if (fromKey) btn.focus({ preventScroll: true });
  clearTimeout(((ed as AnnotatorState).armTimer as ReturnType<typeof setTimeout>));
  (ed as AnnotatorState).armTimer = setTimeout(function () {
    if (ed) ed.armed = false;
    disarmCancel();
  }, ARM_MS);
}

function disarmCancel() {
  const btn = (document.getElementById("annotate-cancel") as HTMLElement);
  btn.textContent = "Cancel";
  btn.classList.remove("armed");
}

function done() {
  commitText();
  if (!(ed as AnnotatorState).ready || (ed as AnnotatorState).saving) return;
  const marks = normalizeMarks((ed as AnnotatorState).marks);
  if (JSON.stringify(marks) === (ed as AnnotatorState).start) { closeAnnotator(); return; }
  if (locate() === -1) { lost(); return; }
  if (!marks.length) { save(null, marks); return; }
  const mine = ed;
  const ctx = (ports as AnnotatorPortUse).ownership.capture();
  (ed as AnnotatorState).saving = true;
  setStatus("Saving…");
  paintTools();
  flatten(marks).then(function (rec) {
    if (ed !== mine) return;
    (ed as AnnotatorState).saving = false;
    if (!(ports as AnnotatorPortUse).ownership.stillOwns(ctx)) {
      closeAnnotator();
      (ports as AnnotatorPortUse).notices.show("The annotations were not saved because the script changed.", "warn");
      return;
    }
    paintTools();
    if (!rec) { (ports as AnnotatorPortUse).notices.show("Could not save the annotated picture — it may be too large for this browser.", "warn"); return; }
    save(rec, marks);
  });
}

function save(rec: ImageRef | null, marks: Mark[]) {
  const at = locate();
  if (at === -1) { lost(); return; }
  const original = (ed as AnnotatorState).original;
  (ed as AnnotatorState).committing = true;
  const ok = (ports as AnnotatorPortUse).cells.editGallery((ed as AnnotatorState).rowId, marks.length ? "Picture annotated" : "Annotations removed", function (row) {
    return annotateGallerySlot(row, at, rec, original, marks);
  });
  if (!ed) return;
  ed.committing = false;
  if (!ok) {
    (ports as AnnotatorPortUse).notices.show("Could not save the annotations to this picture.", "warn");
    return;
  }
  closeAnnotator();
}

function flatten(marks: Mark[]): Promise<ImageRef | null> {
  const img = imgEl();
  const pictures = (ports as AnnotatorPortUse).pictures;
  return fontsReady().then(function () {
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    drawMarks(ctx, marks, w, h);
    const jpeg = ed && ed.original.mime === "image/jpeg";
    return new Promise<Blob | null>(function (resolve) {
      try { c.toBlob(resolve, jpeg ? "image/jpeg" : "image/png", 0.9); } catch (e) { resolve(null); }
    });
  }).then(function (blob) {
    return blob ? blob.arrayBuffer() : null;
  }).then(function (buf) {
    const rec = buf ? pictures.intern(new Uint8Array(buf)) : null;
    if (rec) pictures.persist([rec.sha256]);
    return rec;
  }).then(null, function () { return null; });
}

function isUndoKey(e: KeyboardEvent) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "z" || e.key === "Z");
}
function isRedoKey(e: KeyboardEvent) {
  return (e.ctrlKey || e.metaKey) && !e.altKey &&
    (((e.key === "z" || e.key === "Z") && e.shiftKey) || ((e.key === "y" || e.key === "Y") && !e.shiftKey));
}

function onWindowKeydown(e: KeyboardEvent) {
  if (!ed) return;
  const inText = !!(e.target && (e.target as Element).classList && (e.target as Element).classList.contains("annotate-textbox"));
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
  const tool = toolForKey(e);
  if (tool && !ed.gesture) {
    e.preventDefault();
    e.stopPropagation();
    setTool(tool);
  }
}

const TOOL_KEYS: Record<string, Tool> = { p: "pen", h: "highlight", t: "text", e: "eraser" };

function toolForKey(e: KeyboardEvent): Tool | "" {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return "";
  return TOOL_KEYS[String(e.key || "").toLowerCase()] || "";
}

function keepFocusIn(e: KeyboardEvent) {
  const list = Array.prototype.filter.call(modal().querySelectorAll("button, textarea"), function (el: HTMLButtonElement | HTMLTextAreaElement) {
    return !el.disabled && el.offsetParent !== null;
  }) as (HTMLButtonElement | HTMLTextAreaElement)[];
  if (!list.length) return;
  const i = list.indexOf(document.activeElement as HTMLButtonElement | HTMLTextAreaElement);
  let to: HTMLButtonElement | HTMLTextAreaElement | null | undefined = null;
  if (e.shiftKey && i <= 0) to = list[list.length - 1];
  else if (!e.shiftKey && (i === -1 || i === list.length - 1)) to = list[0];
  if (!to) return;
  e.preventDefault();
  e.stopPropagation();
  to.focus({ preventScroll: true });
}

function onClick(e: MouseEvent) {
  if (!ed) return;
  const b = (e.target as Element).closest && (e.target as Element).closest<HTMLButtonElement>("[data-aact]");
  if (!b || b.disabled) return;
  const act = b.getAttribute("data-aact");
  if (act === "tool") setTool(b.getAttribute("data-tool") as Tool);
  else if (act === "color") setColor((b.getAttribute("data-color") as string));
  else if (act === "size") setSize(Number(b.getAttribute("data-size")));
  else if (act === "undo") undoMark();
  else if (act === "redo") redoMark();
  else if (act === "clear") clearAll();
  else if (act === "cancel") cancel(false);
  else if (act === "done") done();
}

function buildSwatches() {
  const host = (document.getElementById("annotate-colors") as HTMLElement);
  ANNOTATION_COLORS.forEach(function (c, i) {
    const b = document.createElement("button");
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

export function startAnnotate(given: GalleryPorts): GalleryMount {
  ports = given;
  memory.color = { pen: (ANNOTATION_COLORS[0] as string), highlight: (ANNOTATION_COLORS[1] as string), text: (ANNOTATION_COLORS[0] as string) };
  const m = modal();
  const f = frameEl();
  let observer: ResizeObserver | null = null;
  const resize = function () { if (ed) layout(); };
  let withdrawHook: (() => void) | null = null;
  let swatches: Element[] = [];
  if (m) {
    buildSwatches();
    swatches = Array.from((document.getElementById("annotate-colors") as HTMLElement).children);
    m.addEventListener("click", onClick);
    f.addEventListener("pointerdown", onPointerDown);
    f.addEventListener("pointermove", onPointerMove);
    f.addEventListener("pointerup", onPointerUp);
    f.addEventListener("pointercancel", onPointerCancel);
    f.addEventListener("lostpointercapture", onPointerUp);
    window.addEventListener("keydown", onWindowKeydown, true);
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(resize);
      observer.observe((document.getElementById("annotate-stage") as HTMLElement));
    } else {
      window.addEventListener("resize", resize);
    }
  }
  if (m) exposeTestHook("__annotateTest", function () { return {
    state: function () {
      return ed ? { tool: memory.tool, marks: copy(ed.marks), undo: ed.undo.length, redo: ed.redo.length,
        text: ed.text ? copy(ed.text.mark) : null, ready: ed.ready, at: ed.at, w: ed.w, h: ed.h } : null;
    }
  }; }, function (withdraw) { withdrawHook = withdraw; });
  let disposed = false;
  return {
    openAnnotator: openAnnotator,
    refreshAnnotator: refreshAnnotator,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      closeAnnotator();
      if (m) {
        m.removeEventListener("click", onClick);
        f.removeEventListener("pointerdown", onPointerDown);
        f.removeEventListener("pointermove", onPointerMove);
        f.removeEventListener("pointerup", onPointerUp);
        f.removeEventListener("pointercancel", onPointerCancel);
        f.removeEventListener("lostpointercapture", onPointerUp);
        window.removeEventListener("keydown", onWindowKeydown, true);
        if (observer) observer.disconnect();
        else window.removeEventListener("resize", resize);
      }
      swatches.forEach(function (swatch) { swatch.remove(); });
      if (drawFrame !== null) cancelAnimationFrame(drawFrame);
      drawFrame = null;
      drawQueued = false;
      fontTimers.forEach(function (timer) { clearTimeout(timer); });
      fontTimers.clear();
      measureCtx = null;
      fontFamily = "";
      if (withdrawHook) withdrawHook();
      ports = null;
    }
  };
}
