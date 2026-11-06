import { ROW_STATUSES, rowStatus } from "../../core/production/looks.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { contentMemo } from "../../core/document/memo.ts";
import { escapeHtml, unitSafePrefix } from "../../core/document/text-policy.ts";
import { formatDuration, rowSeconds } from "../../core/production/timing.ts";
import { toPlainText } from "../../core/text/projections.ts";
import { brollCountIn } from "../../core/production/broll.ts";
import { cssAttr } from "../common/dom.ts";
import { exposeTestHook } from "../common/test-hooks.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { RundownControls } from "./actions.ts";
import { lensIndexAt, lensIndexFit, lensIndexMap } from "./lens-index.ts";
import type { IndexRef } from "./lens-index.ts";
import type { RundownPorts } from "./ports.ts";

type TimerHandle = ReturnType<typeof setTimeout>;
type BeatRow = DocumentView["rows"][number];
type StatusLook = NonNullable<ReturnType<typeof rowStatus>>;
type RundownBeat = { readonly seconds?: number | null | undefined; readonly status?: unknown };
type RundownBlock = {
  index: number;
  start: number;
  seconds: number;
  left: number;
  width: number;
  showNumber: boolean;
  showLength: boolean;
};
type TimeMap = (seconds: number) => number;
type RestLayout = {
  pxPerSecond: number;
  spanSeconds: number;
  totalSeconds: number;
  width: number;
  blocks: RundownBlock[];
  knots: number[];
  x: TimeMap;
};
type LayoutView = Pick<RestLayout, "pxPerSecond" | "spanSeconds" | "totalSeconds" | "width" | "x">;
type PaintListener = (layout: LayoutView) => void;
type Tick = { seconds: number; x: number; major: boolean; label: string };
type TickStep = readonly [number, number];
type LengthPlace = { width: number; left: number | null; fit: number; pinned: boolean };
type LensOpts = { readonly minWidth?: number; readonly reach?: number };
type KeepLabels = { number: boolean; length: boolean };
type KnotBlock = { left: number; width: number };
type LensSource = "pointer" | "drag" | "focus";
type StripBase = {
  blocks: RundownBlock[];
  X: number[] | null;
  n: number;
  W: number;
  pps: number;
  els: HTMLElement[];
  lefts: number[];
  widths: number[];
  keep: string[];
  shot: boolean[];
  current: number;
};
type LengthAt = { left: number | null; width: number; fit: number; pinned?: boolean };
type LensState = {
  on: boolean;
  src: LensSource | null;
  ref: IndexRef | null;
  p: number;
  a: number;
  x: number | null;
  t: number;
  Z: number[] | null;
  raf: number;
  last: number;
  hold: boolean;
  holdAt: number;
  holdTimer: TimerHandle | 0;
  easeAt: number;
  easeNext: boolean;
};
type DropState = { x: number | null; gap: number };
type DropEls = { marker: HTMLElement; label: HTMLElement };
type LensDebug = {
  on: boolean;
  src: LensSource | null;
  p: number;
  a: number;
  hold: boolean;
  holdAt: number;
  Z: number[] | null;
  X: number[] | null;
  starts: number[];
  dropGap: number;
  minimized: boolean;
  W: number;
  length: { left: number | null; width: number; fit: number; pinned: boolean };
};
type RundownTestHooks = {
  lens: () => LensDebug;
  setMinimized: (on: boolean, persist?: boolean) => void;
  x: (seconds: number) => number;
};
type RundownOwner = RundownControls & {
  readonly mounted: () => boolean;
  readonly dispose: () => void;
};

let ports: RundownPorts;

export const RUNDOWN_TAIL_SECONDS = 10;
const BLOCK_GAP_PX = 2;
const BLOCK_MIN_PX = 2;
const LABEL_NUMBER_PX = 28;
const LABEL_LENGTH_PX = 66;
const LABEL_LENGTH_SHOT_PX = 80;

export function rundownSpan(totalSeconds: number | null | undefined, extraSeconds: number | null | undefined): number {
  return Math.max(totalSeconds || 0, extraSeconds || 0, 0) + RUNDOWN_TAIL_SECONDS;
}

export function rundownScale(totalSeconds: number | null | undefined, extraSeconds: number | null | undefined, widthPx: number): number {
  return widthPx > 0 ? widthPx / rundownSpan(totalSeconds, extraSeconds) : 0;
}

function tenth(v: number): number { return Math.round(v * 10) / 10; }

export function rundownBlocks(beats: readonly RundownBeat[], pxPerSecond: number): RundownBlock[] {
  let t = 0;
  return beats.map(function (sc, i) {
    const secs = Math.max(0, sc.seconds || 0);
    const width = Math.max(BLOCK_MIN_PX, tenth(secs * pxPerSecond - BLOCK_GAP_PX));
    const shot = sc.status === "shot";
    const block = {
      index: i,
      start: t,
      seconds: secs,
      left: tenth(t * pxPerSecond),
      width: width,
      showNumber: width >= LABEL_NUMBER_PX,
      showLength: width >= (shot ? LABEL_LENGTH_SHOT_PX : LABEL_LENGTH_PX)
    };
    t += secs;
    return block;
  });
}

export const REST_MIN_PX = 5;
const REST_FLOOR_SHARE = 0.8;

export function rundownRestLayout(
  beats: readonly (RundownBeat | null | undefined)[] | null | undefined,
  totalSeconds: number | null | undefined,
  extraSeconds: number | null | undefined,
  widthPx: number,
  floorPx?: number | null
): RestLayout {
  beats = beats || [];
  const n = beats.length;
  const secs = beats.map(function (sc) { return Math.max(0, (sc && sc.seconds) || 0); });
  let total = Number(totalSeconds);
  if (!(total >= 0)) total = secs.reduce(function (a, b) { return a + b; }, 0);
  const W = widthPx > 0 ? widthPx : 0;
  const pps = rundownScale(total, extraSeconds, W);
  const beatW = total * pps;
  const floor = floorPx == null ? REST_MIN_PX : Number(floorPx) || 0;
  const slotFloor = floor > BLOCK_MIN_PX && n && beatW > 0 ? Math.min(floor + BLOCK_GAP_PX, beatW / n * REST_FLOOR_SHARE) : 0;
  const raw = secs.map(function (s) { return s * pps; });
  const w = raw.slice();
  if (slotFloor > 0) {
    const held = raw.map(function () { return false; });
    for (let it = 0; it <= n; it++) {
      let heldW = 0, freeRaw = 0, i;
      for (i = 0; i < n; i++) { if (held[i]) heldW += slotFloor; else freeRaw += raw[i] as number; }
      const f = freeRaw > 0 ? (beatW - heldW) / freeRaw : 0;
      let changed = false;
      for (i = 0; i < n; i++) {
        if (held[i]) { w[i] = slotFloor; continue; }
        w[i] = (raw[i] as number) * f;
        if ((w[i] as number) < slotFloor) { held[i] = true; changed = true; }
      }
      if (!changed) break;
    }
  }
  const X = [0];
  const blocks: RundownBlock[] = [];
  let t = 0;
  for (let j = 0; j < n; j++) {
    const width = Math.max(BLOCK_MIN_PX, tenth((w[j] as number) - BLOCK_GAP_PX));
    const shot = beats[j] && (beats[j] as RundownBeat).status === "shot";
    blocks.push({
      index: j,
      start: t,
      seconds: secs[j] as number,
      left: tenth(X[j] as number),
      width: width,
      showNumber: width >= LABEL_NUMBER_PX,
      showLength: width >= (shot ? LABEL_LENGTH_SHOT_PX : LABEL_LENGTH_PX)
    });
    t += secs[j] as number;
    X.push((X[j] as number) + (w[j] as number));
  }
  X[n] = Math.min(beatW, W);
  X.push(W);
  return {
    pxPerSecond: pps,
    spanSeconds: rundownSpan(total, extraSeconds),
    totalSeconds: total,
    width: W,
    blocks: blocks,
    knots: X,
    x: function (seconds) {
      const s = Number(seconds) || 0;
      if (s <= 0) return s * pps;
      if (s >= total) return (X[n] as number) + (s - total) * pps;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((blocks[mid] as RundownBlock).start <= s) lo = mid; else hi = mid - 1;
      }
      const b = blocks[lo] as RundownBlock;
      return b.seconds > 0 ? (X[lo] as number) + (s - b.start) / b.seconds * ((X[lo + 1] as number) - (X[lo] as number)) : X[lo + 1] as number;
    }
  };
}

const TICK_STEPS: readonly TickStep[] = [[5, 15], [10, 30], [15, 60], [30, 120], [60, 300], [120, 600], [300, 1800], [600, 3600]];
const LABEL_MIN_GAP_PX = 56;
const TICK_MIN_GAP_PX = 6;
const LABEL_ROOM_PX = 34;

export function rundownTicks(spanSeconds: number, pxPerSecond: number, widthPx: number, timeX?: TimeMap | null): Tick[] {
  if (!(pxPerSecond > 0)) return [];
  let step = TICK_STEPS[TICK_STEPS.length - 1] as TickStep;
  for (let i = 0; i < TICK_STEPS.length; i++) {
    if ((TICK_STEPS[i] as TickStep)[1] * pxPerSecond >= LABEL_MIN_GAP_PX && (TICK_STEPS[i] as TickStep)[0] * pxPerSecond >= TICK_MIN_GAP_PX) {
      step = TICK_STEPS[i] as TickStep;
      break;
    }
  }
  const out: Tick[] = [];
  let lastLabel = -Infinity;
  for (let s = 0; s <= spanSeconds; s += step[0]) {
    const x = typeof timeX === "function" ? tenth(timeX(s)) : Math.round(s * pxPerSecond);
    const major = s % step[1] === 0;
    const label = major && x + LABEL_ROOM_PX <= widthPx && x - lastLabel >= LABEL_MIN_GAP_PX ? formatDuration(s) : "";
    if (label) lastLabel = x;
    out.push({ seconds: s, x: x, major: major, label: label });
  }
  return out;
}

export const LENGTH_GAP_PX = 6;
const LENGTH_MAX_SHARE = 0.25;

export function rundownLengthPlace(
  totalSeconds: number | null | undefined,
  extraSeconds: number | null | undefined,
  widthPx: number,
  widths: readonly number[] | null | undefined
): LengthPlace {
  const none = { width: widthPx, left: null, fit: -1, pinned: false };
  if (!(widthPx > 0) || !widths || !widths.length) return none;
  const end = tenth((totalSeconds || 0) * rundownScale(totalSeconds, extraSeconds, widthPx));
  for (let i = 0; i < widths.length; i++) {
    if (end + LENGTH_GAP_PX + (widths[i] as number) <= widthPx) return { width: widthPx, left: end + LENGTH_GAP_PX, fit: i, pinned: false };
    if ((widths[i] as number) + LENGTH_GAP_PX <= LENGTH_MAX_SHARE * widthPx) {
      return { width: tenth(widthPx - (widths[i] as number) - LENGTH_GAP_PX), left: tenth(widthPx - (widths[i] as number)), fit: i, pinned: true };
    }
  }
  return none;
}

export const LENS_MIN_PX = 96;
export const LENS_REACH_BEATS = 3;
const LENS_GLIDE_MS = 60;
const LENS_EASE_MS = 90;
const LENS_EASE_FLOOR = 0.08;

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

export function rundownLensIndex(slots: readonly number[], index: number, anchor: number | null | undefined, opts?: LensOpts | null): number[] {
  const m = slots.length - 1;
  if (!((slots[m] as number) > 0) || m < 2) return slots.slice();
  const q = clamp(Number(index) || 0, 0, m - 1);
  const jp = Math.min(m - 2, Math.floor(q));
  return lensAround(slots, jp, q - jp, anchor, slots[jp] as number, opts);
}

function lensAround(slots: readonly number[], jp: number, phi: number, anchor: number | null | undefined, fallback: number, opts?: LensOpts | null): number[] {
  opts = opts || {};
  const minW = (opts.minWidth as number) > 0 ? opts.minWidth as number : LENS_MIN_PX;
  const R = (opts.reach as number) >= 0 ? opts.reach as number : LENS_REACH_BEATS;
  const m = slots.length - 1;
  const W = slots[m] as number;
  const q = jp + phi;
  const L = [0];
  const nw: number[] = [];
  for (let j = 0; j < m; j++) {
    let w = (slots[j + 1] as number) - (slots[j] as number);
    if (j < m - 1) {
      const d = Math.abs(j + 0.5 - q);
      if (d < R + 0.5) w = Math.max(w, minW * 0.5 * (1 + Math.cos(Math.PI * d / (R + 0.5))));
    }
    nw.push(w);
    L.push((L[j] as number) + w);
  }
  let a = Number(anchor);
  if (!isFinite(a)) a = fallback;
  const o =clamp(a - ((L[jp] as number) + phi * (nw[jp] as number)), W - (L[m] as number), 0);
  return L.map(function (v) { return v + o; });
}

export function knotMap(from: readonly number[], to: readonly number[], x: number): number {
  const n = from.length - 1;
  if (!(n >= 1)) return x;
  if (x <= (from[0] as number)) return to[0] as number;
  if (x >= (from[n] as number)) return to[n] as number;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((from[mid] as number) <= x) lo = mid; else hi = mid;
  }
  const w = (from[lo + 1] as number) - (from[lo] as number);
  return w > 0 ? (to[lo] as number) + (x - (from[lo] as number)) / w * ((to[lo + 1] as number) - (to[lo] as number)) : to[lo] as number;
}

const KEEP_NUMBER_PX = 18;
const KEEP_NUMBER_3_PX = 25;
const KEEP_LENGTH_PX = 56;
const KEEP_LENGTH_SHOT_PX = 70;

export function rundownKeepLabels(rest: Pick<RundownBlock, "index" | "showNumber" | "showLength">, width: number, shot: boolean | undefined): KeepLabels {
  const numberPx = rest.index + 1 >= 100 ? KEEP_NUMBER_3_PX : KEEP_NUMBER_PX;
  return {
    number: !!rest.showNumber && width >= numberPx,
    length: !!rest.showLength && width >= (shot ? KEEP_LENGTH_SHOT_PX : KEEP_LENGTH_PX)
  };
}

export function knotBlocks(knots: readonly number[]): KnotBlock[] {
  const out: KnotBlock[] = [];
  for (let i = 0; i < knots.length - 2; i++) {
    out.push({ left: tenth(knots[i] as number), width: Math.max(BLOCK_MIN_PX, tenth((knots[i + 1] as number) - (knots[i] as number) - BLOCK_GAP_PX)) });
  }
  return out;
}

export function rundownDropGap(knots: readonly number[], x: number, from: number, hitPx: number): number {
  const n = knots.length - 2;
  if (n < 1) return -1;
  let best = -1, bestD = Infinity;
  for (let g = 0; g <= n; g++) {
    const gx = g === 0 ? knots[0] as number : (knots[g] as number) - BLOCK_GAP_PX / 2;
    const d = Math.abs(x - gx);
    if (d < bestD) { bestD = d; best = g; }
  }
  if (bestD > hitPx) return -1;
  if (best === from || best === from + 1) return -1;
  return best;
}

function gapX(knots: readonly number[], g: number): number {
  return g === 0 ? knots[0] as number : (knots[g] as number) - BLOCK_GAP_PX / 2;
}

interface RundownState {
  extraSeconds: number;
  currentRowId: string | null;
  lastBlocksHtml: string;
  lastBlocksShape: string;
  lastRulerHtml: string;
  lastRulerShape: string;
  lastScenesHtml: string;
  lastScenesShape: string;
  sceneLabels: { el: HTMLElement; start: number; end: number }[];
  lastLayout: LayoutView;
  lastKnotsKey: string;
  minimized: boolean;
  readonly base: StripBase;
  snippetOf: ((html: string | null | undefined) => string) | null;
  lengthAt: LengthAt;
  readonly lens: LensState;
  noHover: boolean;
  readonly drop: DropState;
}

function freshState(): RundownState {
  return {
    extraSeconds: 0,
    currentRowId: null,
    lastBlocksHtml: "",
    lastBlocksShape: "",
    lastRulerHtml: "",
    lastRulerShape: "",
    lastScenesHtml: "",
    lastScenesShape: "",
    sceneLabels: [],
    lastLayout: { pxPerSecond: 0, spanSeconds: 0, totalSeconds: 0, width: 0, x: function () { return 0; } },
    lastKnotsKey: "",
    minimized: false,
    base: { blocks: [], X: null, n: 0, W: 0, pps: 0, els: [], lefts: [], widths: [], keep: [], shot: [], current: -1 },
    snippetOf: null,
    lengthAt: { left: null, width: 0, fit: -1 },
    lens: {
      on: false,
      src: null,
      ref: null,
      p: 0,
      a: 0,
      x: null,
      t: 0,
      Z: null,
      raf: 0,
      last: 0,
      hold: false,
      holdAt: -1,
      holdTimer: 0,
      easeAt: -1,
      easeNext: false
    },
    noHover: false,
    drop: { x: null, gap: -1 }
  };
}

const state = freshState();

const paintListeners: PaintListener[] = [];

export function setRundownExtraSeconds(seconds: number | null | undefined): void {
  const next = Math.max(0, Number(seconds) || 0);
  if (next === state.extraSeconds) return;
  state.extraSeconds = next;
  renderRundown();
}

function rundownX(seconds: number): number {
  const px = state.lastLayout.x(seconds || 0);
  if (state.lens.Z && state.base.X && state.lens.Z.length === state.base.X.length) return tenth(knotMap(state.base.X, state.lens.Z, px));
  return tenth(px);
}

export function onRundownPaint(fn: PaintListener): () => void {
  if (typeof fn !== "function") return function () {};
  paintListeners.push(fn);
  return function () {
    const at = paintListeners.indexOf(fn);
    if (at >= 0) paintListeners.splice(at, 1);
  };
}

export function rundownLayout(): LayoutView {
  return {
    pxPerSecond: state.lastLayout.pxPerSecond,
    spanSeconds: state.lastLayout.spanSeconds,
    totalSeconds: state.lastLayout.totalSeconds,
    width: state.lastLayout.width,
    x: state.lastLayout.x
  };
}

const GEOMETRY_STYLE = / style="left:[^"]*"/g;

const CHECK_SVG ='<svg class="rd-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function beatSnippet(row: BeatRow): string {
  if (!state.snippetOf) {
    state.snippetOf = contentMemo(function (html) {
      const text = toPlainText(ports.text.cellOf(html)).replace(/\s+/g, " ").trim();
      return unitSafePrefix(text, 90);
    }, ports.text.cacheSeal);
  }
  return state.snippetOf(row.audioText || "") || state.snippetOf(row.visualText || "");
}

function brollTicksHtml(row: BeatRow): string {
  const n = brollCountIn(row, ports.text.productionReaders);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += '<span class="rd-broll" style="left:calc(' + tenth((i + 1) / (n + 1) * 100) + '% - 1px)"></span>';
  }
  return out;
}

function blockHtml(row: BeatRow, b: RundownBlock, isCurrent: boolean, focusable: boolean): string {
  const st = rowStatus(row.status) || ROW_STATUSES[0] as StatusLook;
  const num = ports.document.numbering().beats[row.id]?.full ?? "";
  const len = formatDuration(b.seconds);
  const label = "Beat " + num + ", " + len + ", " + st.label.toLowerCase() + (isCurrent ? " — current beat" : "");
  const snip = beatSnippet(row);
  return '<button type="button" class="rd-block is-' + escapeHtml(st.id) + (isCurrent ? ' is-current' : '') +
    '" data-row="' + escapeHtml(row.id) + '" data-i="' + b.index + '" tabindex="' + (focusable ? '0' : '-1') + '"' +
    (isCurrent ? ' aria-current="true"' : '') +
    ' style="left:' + b.left + 'px;width:' + b.width + 'px" aria-label="' + escapeHtml(label) +
    '" title="Beat ' + num + ' · ' + len + ' · ' + escapeHtml(st.label) + '">' +
    '<span class="rd-in"><span class="rd-num">' + (ports.document.numbering().beats[row.id]?.short ?? "") + '</span>' +
    (st.id === "shot" ? CHECK_SVG : '') +
    '<span class="rd-len">' + len + '</span>' +
    '<span class="rd-stat">' + escapeHtml(st.label) + '</span>' +
    (snip ? '<span class="rd-snip">' + escapeHtml(snip) + '</span>' : '') +
    '</span>' + brollTicksHtml(row) +
    '</button>';
}

function placeLength(strip: HTMLElement, total: number, trackWidth: number): number {
  const el = strip.querySelector<HTMLElement>(".rd-length");
  state.lengthAt = { left: null, width: 0, fit: -1 };
  if (!el) return trackWidth;
  const all = el.offsetWidth;
  if (!all) return trackWidth;
  const totalEl = el.querySelector<HTMLElement>(".rd-length-total");
  const slotEl = el.querySelector<HTMLElement>(".rd-length-slot");
  const tw = totalEl ? totalEl.offsetWidth : 0;
  const sw = slotEl && slotEl.textContent ? slotEl.offsetWidth : 0;
  const pad = all - tw - (el.classList.contains("is-short") ? 0 : sw);
  const widths = sw ? [pad + tw + sw, pad + tw] : [pad + tw];
  const p = rundownLengthPlace(total, state.extraSeconds, trackWidth, widths);
  el.classList.toggle("is-short", p.fit === 1);
  el.classList.toggle("is-none", p.fit === -1);
  el.classList.remove("is-covered");
  if (p.left !== null) el.style.left = p.left + "px";
  strip.classList.toggle("has-length-delta", p.fit === 0 && sw > 0);
  state.lengthAt = { left: p.left, width: p.fit === -1 ? 0 : widths[p.fit] as number, fit: p.fit, pinned: p.pinned };
  return p.width;
}

function lengthCovered(Z: readonly number[] | null): void {
  if (state.lengthAt.left === null || state.lengthAt.pinned) return;
  const strip = stripEl();
  const el = strip && strip.querySelector(".rd-length");
  if (el) el.classList.toggle("is-covered", !!Z && (Z[state.base.n] as number) + 1 > state.lengthAt.left);
}

function overLength(x: number): boolean {
  return state.lengthAt.left !== null && x >= state.lengthAt.left - 2 && x <= state.lengthAt.left + state.lengthAt.width + 2;
}

function segmentHtml(row: BeatRow, b: RundownBlock, isCurrent: boolean): string {
  const st = rowStatus(row.status) || ROW_STATUSES[0] as StatusLook;
  return '<span class="rd-seg is-' + escapeHtml(st.id) + (isCurrent ? ' is-current' : '') +
    '" style="left:' + b.left + 'px;width:' + b.width + 'px"></span>';
}

export function renderRundown(): void {
  const strip = document.getElementById("rundown");
  if (!strip || !ports) return;
  const rows = ports.document.current()?.rows ?? [];
  strip.hidden = !rows.length;
  if (!rows.length) { lensReset(); return; }
  const track = strip.querySelector<HTMLElement>(".rundown-track");
  const blocksEl = strip.querySelector<HTMLElement>(".rundown-blocks");
  const rulerEl = strip.querySelector(".rundown-ruler");
  const playhead = strip.querySelector<HTMLElement>(".rundown-playhead");
  if (!track || !blocksEl || !rulerEl) return;
  const trackWidth = track.clientWidth;
  if (!trackWidth) return;

  const doc = ports.document.current();
  const beats = rows.map(function (r) { return { seconds: rowSeconds(r, doc, ports.text.productionReaders), status: r.status }; });
  const total = beats.reduce(function (n, sc) { return n + sc.seconds; }, 0);
  const width = placeLength(strip, total, trackWidth);
  const lay = rundownRestLayout(beats, total, state.extraSeconds, width, REST_MIN_PX);
  const span = lay.spanSeconds;
  const s = lay.pxPerSecond;
  const blocks = lay.blocks;
  const right = Math.max(0, tenth(trackWidth - width)) + "px";
  if (blocksEl.style.right !== right) blocksEl.style.right = right;

  const hasScenes = !!rows.length;
  const scenesEl = hasScenes || state.lastScenesHtml ? strip.querySelector<HTMLElement>(".rundown-sections") : null;
  if (scenesEl) {
    const groups = ports.document.numbering().scenes;
    scenesEl.hidden = !groups.length || state.minimized;
    if (groups.length || state.lastScenesHtml) {
      const labels = groups.map(group => {
        const first = blocks[group.start], last = blocks[group.end - 1];
        if (!first || !last) return "";
        return '<span class="rd-section" data-start="' + group.start + '" data-end="' + group.end + '" title="' + escapeHtml(group.letter + (group.name ? " " + group.name : "")) + '" style="left:' + first.left +
          'px;width:' + (last.left + last.width - first.left) + 'px">' + escapeHtml(group.letter + (group.name ? " " + group.name : "")) + '</span>';
      }).join("");
      if (labels !== state.lastScenesHtml) {
        const shape = labels.replace(GEOMETRY_STYLE, "");
        const placed = groups.filter(group => blocks[group.start] && blocks[group.end - 1]);
        if (shape === state.lastScenesShape && state.sceneLabels.length === placed.length && state.sceneLabels[0]?.el.parentElement === scenesEl) {
          placed.forEach((group, i) => {
            const first = blocks[group.start] as RundownBlock, last = blocks[group.end - 1] as RundownBlock;
            const el = (state.sceneLabels[i] as { el: HTMLElement }).el;
            el.style.left = first.left + "px";
            el.style.width = (last.left + last.width - first.left) + "px";
          });
        } else {
          scenesEl.innerHTML = labels;
          state.lastScenesShape = shape;
          state.sceneLabels = Array.from(scenesEl.querySelectorAll<HTMLElement>(".rd-section"), el => ({
            el, start: Number(el.dataset.start), end: Number(el.dataset.end)
          }));
        }
        state.lastScenesHtml = labels;
      }
    }
  }

  const current = state.currentRowId && rows.some(function (r) { return r.id === state.currentRowId; }) ? state.currentRowId : null;
  const tabRow = current || (rows[0] as BeatRow).id;
  let html = "";
  blocks.forEach(function (b, i) {
    html += state.minimized
      ? segmentHtml(rows[i] as BeatRow, b, (rows[i] as BeatRow).id === current)
      : blockHtml(rows[i] as BeatRow, b, (rows[i] as BeatRow).id === current, (rows[i] as BeatRow).id === tabRow);
  });
  let rewritten = false;
  let repositioned = false;
  if (html !== state.lastBlocksHtml) {
    const shape = html.replace(GEOMETRY_STYLE, "");
    const els = state.base.els;
    if (!state.minimized && shape === state.lastBlocksShape && els.length === blocks.length && els[0]?.parentElement === blocksEl) {
      blocks.forEach(function (b, i) {
        (els[i] as HTMLElement).style.left = b.left + "px";
        (els[i] as HTMLElement).style.width = b.width + "px";
      });
      repositioned = true;
    } else {
      const hadFocus = blocksEl.contains(document.activeElement) ? (document.activeElement as Element).getAttribute("data-row") : null;
      blocksEl.innerHTML = html;
      state.lastBlocksShape = shape;
      rewritten = true;
      if (hadFocus) {
        const again = blocksEl.querySelector<HTMLElement>('.rd-block[data-row="' + cssAttr(hadFocus) + '"]');
        if (again) again.focus({ preventScroll: true });
      }
    }
    state.lastBlocksHtml = html;
  }

  if (!state.minimized) {
    const ticks = rundownTicks(span, s, width, lay.x);
    const ruler = ticks.map(function (t) {
      return '<span class="rd-tick' + (t.major ? ' is-major' : '') + '" style="left:' + t.x + 'px"></span>' +
        (t.label ? '<span class="rd-label" style="left:' + (t.x + 4) + 'px">' + t.label + '</span>' : '');
    }).join("");
    if (ruler !== state.lastRulerHtml) {
      const shape = ruler.replace(GEOMETRY_STYLE, "");
      const marks = rulerEl.children;
      if (shape === state.lastRulerShape && marks.length === ticks.length + ticks.filter(function (t) { return t.label; }).length) {
        let m = 0;
        ticks.forEach(function (t) {
          (marks[m++] as HTMLElement).style.left = t.x + "px";
          if (t.label) (marks[m++] as HTMLElement).style.left = (t.x + 4) + "px";
        });
      } else {
        rulerEl.innerHTML = ruler;
        state.lastRulerShape = shape;
      }
      state.lastRulerHtml = ruler;
    }
  }

  let at = -1;
  for (let j = 0; j < rows.length; j++) if ((rows[j] as BeatRow).id === current) at = j;

  const countChanged = rows.length !== state.base.n;
  const widthChanged = width !== state.base.W;
  state.base.blocks = blocks;
  state.base.n = rows.length;
  state.base.W = width;
  state.base.pps = s;
  state.base.X = lay.knots;
  state.base.current = at;
  if (rewritten || countChanged) {
    state.base.els = state.minimized ? [] : Array.prototype.slice.call(blocksEl.querySelectorAll(".rd-block"));
    state.base.lefts = blocks.map(function (b) { return b.left; });
    state.base.widths = blocks.map(function (b) { return b.width; });
    state.base.keep = [];
  } else if (repositioned) {
    state.base.lefts = blocks.map(function (b) { return b.left; });
    state.base.widths = blocks.map(function (b) { return b.width; });
  }
  state.base.shot = rows.map(function (r) { const st = rowStatus(r.status); return !!st && st.id === "shot"; });

  if (playhead) {
    playhead.hidden = at === -1;
    if (at !== -1) playhead.style.left = tenth((blocks[at] as RundownBlock).left - 1) + "px";
  }

  if (state.minimized) lensReset();
  else if (state.lens.Z) lensRepainted(countChanged, widthChanged);

  const knotsKey = state.base.X.join(",");
  const moved = s !== state.lastLayout.pxPerSecond || width !== state.lastLayout.width || knotsKey !== state.lastKnotsKey;
  state.lastKnotsKey = knotsKey;
  state.lastLayout = { pxPerSecond: s, spanSeconds: span, totalSeconds: total, width: width, x: lay.x };
  if (moved) paintListeners.forEach(function (fn) { try { fn(rundownLayout()); } catch (e) { } });
}

const DROP_HIT_PX = 20;

const LENS_HOLD_MS = 950;
export const LENS_HOLD_PX = 240;

function lensOpts(): LensOpts | undefined {
  return state.lens.hold ? { minWidth: LENS_HOLD_PX } : undefined;
}

function holdClear(): void {
  if (state.lens.holdTimer) { clearTimeout(state.lens.holdTimer); state.lens.holdTimer = 0; }
  state.lens.holdAt = -1;
  if (state.lens.hold) {
    state.lens.hold = false;
    const strip = stripEl();
    if (strip) strip.classList.remove("is-held");
  }
}

function holdTrack(i: number): void {
  if (i === state.lens.holdAt) return;
  holdClear();
  if (i < 0) return;
  state.lens.holdAt = i;
  state.lens.holdTimer = setTimeout(function () {
    state.lens.holdTimer = 0;
    if (!state.lens.on || state.lens.src !== "pointer" || state.lens.holdAt !== i) return;
    state.lens.hold = true;
    const strip = stripEl();
    if (strip) strip.classList.add("is-held");
    lensKick();
  }, LENS_HOLD_MS);
}

function beatAt(Z: readonly number[], x: number): number {
  for (let i = 0; i < state.base.n; i++) if (x >= (Z[i] as number) && x < (Z[i + 1] as number)) return i;
  return -1;
}

function prefersReducedMotion(): boolean {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
}

function stripEl(): HTMLElement | null { return document.getElementById("rundown"); }

function lensAllowed(): boolean {
  const strip = stripEl();
  return !state.minimized && !!strip && !strip.hidden && state.base.n > 0 && state.base.W > 0 && !!state.base.X;
}

function slots(): number[] {
  return state.base.X as number[];
}

function lensTarget(): number[] {
  if (!state.lens.on) return slots();
  const layout = (index: number, anchor: number): number[] => rundownLensIndex(slots(), index, anchor, lensOpts());
  return state.lens.src === "focus" ? layout(state.lens.p, state.lens.a) :
    lensIndexFit(state.lens.p, state.lens.a, layout, state.base.n, state.base.W);
}

function applyKnots(Z: readonly number[]): void {
  const els = state.base.els;
  for (let i = 0; i < state.base.n && i < els.length; i++) {
    const left = tenth(Z[i] as number);
    const width = Math.max(BLOCK_MIN_PX, tenth((Z[i + 1] as number) - (Z[i] as number) - BLOCK_GAP_PX));
    if (left !== state.base.lefts[i]) { (els[i] as HTMLElement).style.left = left + "px"; state.base.lefts[i] = left; }
    if (width !== state.base.widths[i]) { (els[i] as HTMLElement).style.width = width + "px"; state.base.widths[i] = width; }
    const rest = state.base.blocks[i];
    if (rest) {
      const k = rundownKeepLabels(rest, width, state.base.shot && state.base.shot[i]);
      const key = (k.number ? "n" : "") + (k.length ? "l" : "");
      if (key !== state.base.keep[i]) {
        (els[i] as HTMLElement).classList.toggle("keep-num", k.number);
        (els[i] as HTMLElement).classList.toggle("keep-len", k.length);
        state.base.keep[i] = key;
      }
    }
  }
  if (state.sceneLabels.length) paintSceneLabels();
  const strip = stripEl();
  const playhead = strip && strip.querySelector<HTMLElement>(".rundown-playhead");
  if (playhead && state.base.current !== -1) {
    const ph = tenth((Z[state.base.current] as number) - 1);
    playhead.style.left = ph + "px";
    playhead.hidden = ph < -1 || ph > state.base.W;
  }
  const blocksEl = strip && strip.querySelector(".rundown-blocks");
  if (blocksEl) {
    blocksEl.classList.toggle("over-l", (Z[0] as number) < -0.5);
    blocksEl.classList.toggle("over-r", (Z[Z.length - 1] as number) > state.base.W + 0.5);
  }
  if (state.drop.x !== null) showDrop(state.drop.x);
  lengthCovered(Z);
}

function paintSceneLabels(): void {
  for (const label of state.sceneLabels) {
    const left = state.base.lefts[label.start] ?? 0;
    const right = (state.base.lefts[label.end - 1] ?? left) + (state.base.widths[label.end - 1] ?? 0);
    label.el.style.left = left + "px";
    label.el.style.width = Math.max(0, right - left) + "px";
  }
}

function lensFrame(now: number): void {
  state.lens.raf = 0;
  if (!state.lens.Z || !state.base.X || state.lens.Z.length !== state.base.X.length) { lensSettle(); return; }
  const dt = state.lens.last ? Math.min(64, Math.max(1, now - state.lens.last)) : 16;
  state.lens.last = now;
  const T = lensTarget();
  if (state.lens.easeNext) { state.lens.easeAt = now; state.lens.easeNext = false; }
  let alpha = 1 - Math.exp(-dt / LENS_GLIDE_MS);
  if (prefersReducedMotion()) alpha = 1;
  else if (state.lens.easeAt >= 0) {
    const u = (now - state.lens.easeAt) / LENS_EASE_MS;
    if (u >= 1) state.lens.easeAt = -1;
    else alpha *= Math.max(LENS_EASE_FLOOR, u * u * (3 - 2 * u));
  }
  const Z = state.lens.Z;
  const moving = T.some((target, i) => Math.abs(target - (Z[i] as number)) > 0.05);
  // why: A shared interpolation weight preserves the fixed pointer anchor until the whole layout settles.
  for (let i = 0; i < T.length; i++) {
    Z[i] = moving ? (Z[i] as number) + ((T[i] as number) - (Z[i] as number)) * alpha : T[i] as number;
  }
  applyKnots(Z);
  if (!moving) {
    state.lens.last = 0;
    if (!state.lens.on) lensSettle();
    return;
  }
  state.lens.raf = requestAnimationFrame(lensFrame);
}

function lensKick(): void {
  if (!state.lens.raf) state.lens.raf = requestAnimationFrame(lensFrame);
}

function lensStart(): void {
  if (!state.lens.Z) {
    state.lens.Z = (state.base.X as number[]).slice();
    state.lens.last = 0;
    state.lens.easeNext = true;
  }
  const strip = stripEl();
  if (strip) strip.classList.add("is-lensed");
}

function lensSettle(): void {
  if (state.lens.raf) { cancelAnimationFrame(state.lens.raf); state.lens.raf = 0; }
  const had = !!state.lens.Z;
  state.lens.Z = null;
  state.lens.last = 0;
  const strip = stripEl();
  if (!strip) return;
  if (had) {
    for (let i = 0; i < state.base.els.length && i < state.base.blocks.length; i++) {
      const b = state.base.blocks[i] as RundownBlock;
      (state.base.els[i] as HTMLElement).style.left = b.left + "px";
      (state.base.els[i] as HTMLElement).style.width = b.width + "px";
      state.base.lefts[i] = b.left;
      state.base.widths[i] = b.width;
    }
    if (state.sceneLabels.length) paintSceneLabels();
    const playhead = strip.querySelector<HTMLElement>(".rundown-playhead");
    if (playhead && state.base.current !== -1 && state.base.blocks[state.base.current]) {
      playhead.style.left = tenth((state.base.blocks[state.base.current] as RundownBlock).left - 1) + "px";
      playhead.hidden = false;
    }
    lengthCovered(null);
  }
  const blocksEl = strip.querySelector(".rundown-blocks");
  if (blocksEl) blocksEl.classList.remove("over-l", "over-r");
  if (strip.classList.contains("is-lensed")) {
    strip.classList.remove("is-lensed");
    if (!prefersReducedMotion()) {
      [".rundown-ruler", ".rundown-overlay"].forEach(function (sel) {
        const el = strip.querySelector(sel);
        if (el && el.animate) {
          try { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "cubic-bezier(0.2, 0, 0, 1)" }); } catch (e) {}
        }
      });
    }
  }
}

function lensReset(): void {
  holdClear();
  state.lens.on = false;
  state.lens.src = null;
  state.lens.x = null;
  state.lens.ref = null;
  lensSettle();
}

function lensRepainted(countChanged: boolean, widthChanged: boolean): void {
  if (!lensAllowed()) { lensReset(); return; }
  if (countChanged || (state.lens.Z as number[]).length !== (state.base.X as number[]).length) {
    holdClear();
    state.lens.Z = (state.base.X as number[]).slice();
    if (state.lens.x !== null) {
      state.lens.ref = null;
      lensAt(state.lens.x, state.lens.src ?? "pointer", state.lens.t);
    } else if (state.lens.src === "focus") lensOff();
  } else if (state.lens.on && state.lens.x !== null) {
    if (widthChanged) {
      state.lens.x = clamp(state.lens.x, 0, state.base.W);
      const x = state.lens.x;
      const q = x <= 0 ? 0 : x >= state.base.W ? state.base.n : lensIndexAt(state.lens.Z as number[], x);
      state.lens.ref = { x, q };
    }
    indexFocus(state.lens.x);
  }
  applyKnots(state.lens.Z as number[]);
  lensKick();
}

function indexFocus(x: number): void {
  const lens = state.lens;
  if (!lens.ref) lens.ref = { x: x, q: lensIndexAt(lens.Z ?? slots(), x) };
  const proposed = lensIndexMap(lens.ref, x, state.base.W, state.base.n);
  lens.p = proposed;
  lens.a = x;
  if (lens.Z) lens.Z = lensIndexFit(proposed, x, () => lens.Z as number[], state.base.n, state.base.W);
}

function lensAt(x: number, src: LensSource, t: number): void {
  if (!lensAllowed()) return;
  x = clamp(x, 0, state.base.W);
  lensStart();
  if (!state.lens.on || state.lens.src !== src) state.lens.ref = null;
  if (src === "pointer" && state.lens.hold && beatAt(state.lens.Z as number[], x) === state.lens.holdAt) {
    state.lens.ref = { x, q: lensIndexAt(state.lens.Z as number[], x) };
  }
  indexFocus(x);
  state.lens.on = true;
  state.lens.src = src;
  state.lens.x = x;
  state.lens.t = t;
  if (src === "pointer") holdTrack(beatAt(state.lens.Z as number[], x)); else holdClear();
  lensKick();
}

function lensFocus(i: number): void {
  if (!lensAllowed() || state.noHover || i < 0 || i >= state.base.n) return;
  if (state.lens.on && (state.lens.src === "pointer" || state.lens.src === "drag")) return;
  lensStart();
  state.lens.on = true;
  state.lens.src = "focus";
  state.lens.x = null;
  state.lens.p = i + 0.5;
  state.lens.a = clamp((((state.lens.Z as number[])[i] as number) + ((state.lens.Z as number[])[i + 1] as number)) / 2, 0, state.base.W);
  lensKick();
}

function lensOff(src?: LensSource): void {
  if (src && state.lens.src !== src) return;
  holdClear();
  state.lens.on = false;
  state.lens.src = null;
  state.lens.x = null;
  state.lens.ref = null;
  if (state.lens.Z) { state.lens.easeNext = true; lensKick(); }
}

function updateRundownMinControls(): void {
  const item = document.getElementById("menu-rundown-min");
  if (item) item.setAttribute("aria-checked", state.minimized ? "true" : "false");
  const strip = stripEl();
  if (!strip) return;
  strip.classList.toggle("is-min", state.minimized);
  const toggle = strip.querySelector<HTMLElement>(".rundown-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", state.minimized ? "false" : "true");
    const words = state.minimized ? "Show the rundown" : "Minimise the rundown";
    toggle.setAttribute("aria-label", words);
    toggle.title = words;
  }
}

function setRundownMinimized(on: boolean, persist?: boolean): void {
  on = !!on;
  if (persist !== false) ports.minimized.setRundownMin(on);
  if (on === state.minimized) { updateRundownMinControls(); return; }
  state.minimized = on;
  lensReset();
  hideDrop();
  updateRundownMinControls();
  renderRundown();
}

export function isRundownMinimized(): boolean { return state.minimized; }

export function toggleRundownMinimized(): void {
  setRundownMinimized(!state.minimized);
}

function dragIndex(): number {
  const id = ports.rowDrag.dragging();
  return id ? ports.document.read(function (doc) { return rowIndexOf(doc, id); }) : -1;
}

function dropAllowed(): boolean {
  return !!ports.rowDrag.dragging() && !state.minimized && state.base.n > 0 && !!state.base.X && !!ports.document.current();
}

function ensureDropEls(track: Element): DropEls {
  let marker = track.querySelector<HTMLElement>(".rundown-drop");
  if (!marker) {
    marker = document.createElement("div");
    marker.className = "rundown-drop";
    marker.setAttribute("aria-hidden", "true");
    marker.hidden = true;
    track.appendChild(marker);
  }
  let label = track.querySelector<HTMLElement>(".rundown-drop-label");
  if (!label) {
    label = document.createElement("div");
    label.className = "rundown-drop-label";
    label.setAttribute("role", "status");
    label.hidden = true;
    track.appendChild(label);
  }
  return { marker: marker, label: label };
}

function showDrop(x: number): void {
  const strip = stripEl();
  const track = strip && strip.querySelector(".rundown-track");
  if (!track || !dropAllowed()) { hideDrop(); return; }
  state.drop.x = x;
  const K = state.lens.Z && state.lens.Z.length === (state.base.X as number[]).length ? state.lens.Z : state.base.X as number[];
  let g = rundownDropGap(K, x, dragIndex(), DROP_HIT_PX);
  if (g !== -1 && (gapX(K, g) < -0.5 || gapX(K, g) > state.base.W + 0.5)) g = -1;
  state.drop.gap = g;
  const els = ensureDropEls(track);
  if (g === -1) {
    els.marker.hidden = true;
    els.label.hidden = true;
    return;
  }
  const gx = tenth(gapX(K, g));
  els.marker.hidden = false;
  els.marker.style.left = gx + "px";
  const words = g === 0 ? "Move to the start" : "Move to after beat " + (ports.document.numbering().beats[ports.document.current()?.rows[g - 1]?.id ?? ""]?.full ?? "");
  if (els.label.textContent !== words) els.label.textContent = words;
  els.label.hidden = false;
  const half = (els.label.offsetWidth || 0) / 2;
  els.label.style.left = tenth(clamp(gx, half, Math.max(half, state.base.W - half))) + "px";
}

function hideDrop(): void {
  state.drop.x = null;
  state.drop.gap = -1;
  const strip = stripEl();
  if (!strip) return;
  const marker = strip.querySelector<HTMLElement>(".rundown-drop");
  const label = strip.querySelector<HTMLElement>(".rundown-drop-label");
  if (marker) marker.hidden = true;
  if (label) label.hidden = true;
}

function endDragOver(): void {
  if (state.drop.x !== null) hideDrop();
  lensOff("drag");
}

function followMovedBeat(rowId: string): void {
  ports.actions.invoke("reveal-row", "button", rowId);
  const rowEl = document.querySelector<HTMLElement>('#rows .row[data-id="' + cssAttr(rowId) + '"]');
  if (!rowEl) return;
  const rect = rowEl.getBoundingClientRect();
  let shift = 0;
  try {
    const tf = getComputedStyle(rowEl).transform;
    if (tf && tf !== "none" && typeof DOMMatrixReadOnly === "function") shift = new DOMMatrixReadOnly(tf).m42 || 0;
  } catch (e) {}
  const top = rect.top - shift;
  const topbar = document.querySelector(".topbar");
  const headerBottom = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
  const room = window.innerHeight - headerBottom;
  const y = (window.scrollY || 0) + top - headerBottom - Math.max(0, (room - rect.height) / 2);
  window.scrollTo({ top: Math.max(0, y), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  rowEl.classList.remove("just-merged");
  void rowEl.offsetWidth;
  rowEl.classList.add("just-merged");
  const cell = rowEl.querySelector<HTMLElement>(".audio-cell .cell-editable");
  if (cell) cell.focus({ preventScroll: true });
}

function trackX(e: MouseEvent): number {
  const strip = stripEl();
  const track = strip && strip.querySelector(".rundown-track");
  if (!track) return 0;
  return e.clientX - track.getBoundingClientRect().left;
}

function onStripDragOver(e: DragEvent): void {
  if (!dropAllowed()) return;
  e.preventDefault();
  try { (e.dataTransfer as DataTransfer).dropEffect = "move"; } catch (err) {}
  const x = trackX(e);
  lensAt(x, "drag", e.timeStamp);
  showDrop(x);
}

function onStripDrop(e: DragEvent): void {
  const id = ports.rowDrag.dragging();
  if (!id) return;
  e.preventDefault();
  const allowed = dropAllowed();
  if (allowed) showDrop(trackX(e));
  const g = allowed ? state.drop.gap : -1;
  ports.rowDrag.end();
  hideDrop();
  lensOff();
  const doc = ports.document.current();
  if (g < 0 || !doc) return;
  const rows = doc.rows;
  if (g === 0) ports.cells.moveRow(id, (rows[0] as BeatRow).id, false);
  else ports.cells.moveRow(id, (rows[g - 1] as BeatRow).id, true);
  followMovedBeat(id);
}

export function goToBeat(rowId: string | null): void {
  ports.actions.invoke("reveal-row", "button", rowId);
  const rowEl = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"]');
  if (!rowEl) return;
  rowEl.scrollIntoView({ block: "center" });
  const cell = rowEl.querySelector<HTMLElement>(".audio-cell .cell-editable");
  if (cell) cell.focus({ preventScroll: true });
}

function noteCurrentRow(el: Element | null): void {
  const rowEl = el && el.closest ? el.closest("#rows .row") : null;
  const id = rowEl ? rowEl.getAttribute("data-id") : null;
  if (!id || id === state.currentRowId) return;
  state.currentRowId = id;
  renderRundown();
}

function ensureToggle(strip: HTMLElement): HTMLButtonElement {
  let toggle = strip.querySelector<HTMLButtonElement>(".rundown-toggle");
  if (toggle) return toggle;
  toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "rundown-toggle";
  toggle.setAttribute("aria-controls", "rundown");
  toggle.innerHTML = '<svg aria-hidden="true" focusable="false"><use href="#i-chevron-down"/></svg>';
  strip.appendChild(toggle);
  return toggle;
}

function lensDebug(): LensDebug {
  return {
    on: state.lens.on, src: state.lens.src, p: state.lens.p, a: state.lens.a, hold: state.lens.hold, holdAt: state.lens.holdAt,
    Z: state.lens.Z ? state.lens.Z.slice() : null, X: state.base.X ? state.base.X.slice() : null,
    starts: state.base.blocks.map(function (b) { return b.start; }),
    dropGap: state.drop.gap, minimized: state.minimized,
    W: state.base.W, length: { left: state.lengthAt.left, width: state.lengthAt.width, fit: state.lengthAt.fit, pinned: !!state.lengthAt.pinned }
  };
}

export function startRundown(given: RundownPorts): RundownOwner {
  const strip = document.getElementById("rundown");
  const rowsEl = document.getElementById("rows");
  ports = given;
  const offs: (() => void)[] = [];
  let disposed = false;
  const owner: RundownOwner = { mounted: function () { return !disposed; }, minimized: isRundownMinimized, toggleMinimized: toggleRundownMinimized, goToBeat: goToBeat, dispose: function () {
    if (disposed) return;
    disposed = true;
    while (offs.length) (offs.pop() as () => void)();
    holdClear();
    if (state.lens.raf) { cancelAnimationFrame(state.lens.raf); state.lens.raf = 0; }
    (ports as unknown) = null;
  } };
  if (!strip) return owner;
  function listen<K extends keyof DocumentEventMap>(target: EventTarget, type: K, fn: (e: DocumentEventMap[K]) => void): void {
    target.addEventListener(type, fn as EventListener);
    offs.push(function () { target.removeEventListener(type, fn as EventListener); });
  }
  try { state.noHover = !!(window.matchMedia && window.matchMedia("(hover: none)").matches); } catch (e) {}
  state.minimized = ports.minimized.rundownMin();
  const toggle = ensureToggle(strip);
  updateRundownMinControls();
  listen(toggle, "click", function () { ports.actions.invoke("toggle-rundown-min", "button"); });
  offs.push(ports.changes.onChange(function (change) {
    if (change.name !== "rundownMin") return;
    const v: unknown = change.value;
    const on = v === true || v === "1" || v === 1 ? true : v === false || v === "0" || v === 0 ? false : ports.minimized.rundownMin();
    setRundownMinimized(on, false);
  }, { elsewhere: false }));

  if (rowsEl) listen(rowsEl, "focusin", function (e) { noteCurrentRow(e.target as Element | null); });
  listen(document, "selectionchange", function () { noteCurrentRow(document.activeElement); });
  listen(strip, "click", function (e) {
    const b = (e.target as Element).closest ? (e.target as Element).closest(".rd-block") : null;
    if (b) goToBeat(b.getAttribute("data-row"));
  });
  listen(strip, "keydown", function (e) {
    const b = (e.target as Element).closest ? (e.target as Element).closest<HTMLElement>(".rd-block") : null;
    if (!b) return;
    let next: HTMLElement | null | undefined;
    if (e.key === "ArrowRight") next = b.nextElementSibling as HTMLElement | null;
    else if (e.key === "ArrowLeft") next = b.previousElementSibling as HTMLElement | null;
    else if (e.key === "Home") next = (b.parentNode as ParentNode).querySelector<HTMLElement>(".rd-block");
    else if (e.key === "End") { const all = (b.parentNode as ParentNode).querySelectorAll<HTMLElement>(".rd-block"); next = all[all.length - 1]; }
    else return;
    e.preventDefault();
    if (next && next.classList.contains("rd-block")) {
      b.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
  });

  const track = strip.querySelector(".rundown-track");
  if (track) {
    listen(track, "pointermove", function (e) {
      if (e.pointerType === "touch" || ports.rowDrag.dragging()) return;
      const x = trackX(e);
      if (overLength(x)) { lensOff("pointer"); return; }
      lensAt(x, "pointer", e.timeStamp);
    });
    listen(track, "pointerleave", function () { lensOff("pointer"); });
  }
  listen(strip, "focusin", function (e) {
    const b = (e.target as Element).closest ? (e.target as Element).closest(".rd-block") : null;
    if (!b) return;
    let visible = false;
    try { visible = b.matches(":focus-visible"); } catch (err) {}
    if (visible) lensFocus(Number(b.getAttribute("data-i")));
  });
  listen(strip, "focusout", function (e) {
    if (e.relatedTarget && strip.contains(e.relatedTarget as Node)) return;
    lensOff("focus");
  });

  listen(strip, "dragover", onStripDragOver);
  listen(strip, "drop", onStripDrop);
  listen(document, "dragover", function (e) {
    if (state.drop.x === null && state.lens.src !== "drag") return;
    if (e.target && (e.target as Element).closest && (e.target as Element).closest("#rundown")) return;
    endDragOver();
  });
  listen(document, "dragend", endDragOver);
  listen(document, "drop", function (e) {
    if (e.target && (e.target as Element).closest && (e.target as Element).closest("#rundown")) return;
    endDragOver();
  });

  if (typeof ResizeObserver === "function") {
    const resized = new ResizeObserver(function () { renderRundown(); });
    resized.observe(strip);
    offs.push(function () { resized.disconnect(); });
  }
  exposeTestHook("__rundownTest", (): RundownTestHooks => ({ lens: lensDebug, setMinimized: setRundownMinimized, x: rundownX }), (withdraw) => { offs.push(withdraw); });
  return owner;
}
