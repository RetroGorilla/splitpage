import { inFront } from "../../application/screen.ts";
import type { ScriptZoomControls } from "./actions.ts";
import type { ScriptZoomPorts } from "./ports.ts";

interface Anchor {
  el: Element;
  y: number;
  frac: number;
}

interface ScriptScaleOptions {
  now?: boolean;
  noStore?: boolean;
  quiet?: boolean;
}

interface ScriptZoomMount extends ScriptZoomControls {
  readonly mounted: () => boolean;
  readonly dispose: () => void;
}

let ports: ScriptZoomPorts | null = null;

const SCRIPT_SCALE_MIN = 0.7;
const SCRIPT_SCALE_MAX = 2;
const KEY_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

let scale = 1;
let target = 1;
let frame = 0;
let anchor: Anchor | null = null;
let readoutTimer: ReturnType<typeof setTimeout> | 0 = 0;
const settleFrames = new Set<number>();
let storing = false;

function clampScriptScale(v: unknown): number {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.min(SCRIPT_SCALE_MAX, Math.max(SCRIPT_SCALE_MIN, n));
}

export function scriptScale(): number { return scale; }

function paintScale(v: number): void {
  const root = document.getElementById("root");
  if (root) root.style.setProperty("--script-scale", String(Math.round(v * 1000) / 1000));
}

function noteAnchor(y: number, el: Element | null): void {
  let hold: Element | null | undefined = el && el.closest && (el.closest("#rows .cell-editable") || el.closest("#rows .row"));
  if (!hold) {
    const rows = document.querySelectorAll("#rows > .row");
    for (let i = 0; i < rows.length; i++) {
      const r = (rows[i] as Element).getBoundingClientRect();
      if (r.bottom >= y) { hold = rows[i]; break; }
    }
  }
  if (!hold) { anchor = null; return; }
  const rect = hold.getBoundingClientRect();
  anchor = { el: hold, y: y, frac: rect.height ? (y - rect.top) / rect.height : 0 };
}

function holdAnchor(): void {
  if (!anchor || !anchor.el.isConnected) return;
  const rect = anchor.el.getBoundingClientRect();
  const now = rect.top + anchor.frac * rect.height;
  const dy = now - anchor.y;
  if (Math.abs(dy) >= 0.5) window.scrollBy(0, dy);
}

function step(): void {
  frame = 0;
  const diff = target - scale;
  scale = Math.abs(diff) < 0.004 ? target : scale + diff * 0.35;
  paintScale(scale);
  holdAnchor();
  if (scale !== target) frame = requestAnimationFrame(step);
  else { storeScale(); settleAnchor(); }
}

function storeScale(): void {
  storing = true;
  try {
    if (Math.abs(scale - 1) < 0.005) (ports as ScriptZoomPorts).scale.clearScriptScale();
    else (ports as ScriptZoomPorts).scale.setScriptScale(scale);
  }
  finally { storing = false; }
}

function settleAnchor(): void {
  afterFrame(function () {
    afterFrame(function () { if (!frame) holdAnchor(); });
  });
}

function afterFrame(run: () => void): void {
  const id = requestAnimationFrame(function () {
    settleFrames.delete(id);
    run();
  });
  settleFrames.add(id);
}

function scheduleStep(): void {
  if (!frame) frame = requestAnimationFrame(step);
}

export function setScriptScale(v: unknown, opts?: ScriptScaleOptions): void {
  const options = opts || {};
  target = clampScriptScale(v);
  if (options.now) {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    scale = target;
    paintScale(scale);
    holdAnchor();
    settleAnchor();
    if (!options.noStore) storeScale();
  } else {
    scheduleStep();
  }
  if (!options.quiet) showReadout(target);
}

export function stepScriptScale(dir: number): void {
  const from = target;
  let next = from;
  if (dir > 0) {
    for (let i = 0; i < KEY_STEPS.length; i++) if ((KEY_STEPS[i] as number) > from + 0.001) { next = (KEY_STEPS[i] as number); break; }
  } else {
    for (let j = KEY_STEPS.length - 1; j >= 0; j--) if ((KEY_STEPS[j] as number) < from - 0.001) { next = (KEY_STEPS[j] as number); break; }
  }
  anchorAtCaretOrMiddle();
  setScriptScale(next);
}

export function resetScriptScale(): void {
  anchorAtCaretOrMiddle();
  setScriptScale(1, { now: true });
}

function anchorAtCaretOrMiddle(): void {
  const active = document.activeElement;
  const cell = active && active.closest && active.closest("#rows .cell-editable");
  if (cell) {
    const r = cell.getBoundingClientRect();
    if (r.bottom > 0 && r.top < window.innerHeight) {
      const sel = window.getSelection();
      let y = r.top + r.height / 2;
      if (sel && sel.rangeCount) {
        const cr = sel.getRangeAt(0).getBoundingClientRect();
        if (cr && (cr.top || cr.bottom)) y = (cr.top + cr.bottom) / 2;
      }
      noteAnchor(y, cell);
      return;
    }
  }
  const mid = window.innerHeight / 2;
  noteAnchor(mid, document.elementFromPoint(window.innerWidth / 2, mid));
}

function readoutEl(): HTMLElement {
  let el = document.getElementById("script-zoom-readout");
  if (el) return el;
  el = document.createElement("button");
  (el as HTMLButtonElement).type = "button";
  el.id = "script-zoom-readout";
  el.className = "script-zoom-readout";
  el.hidden = true;
  el.title = "Script size — click to go back to 100 %";
  el.setAttribute("aria-live", "polite");
  el.addEventListener("click", resetScriptScale);
  el.addEventListener("mouseenter", pauseReadout);
  el.addEventListener("mouseleave", hideReadoutSoon);
  document.body.appendChild(el);
  return el;
}

function pauseReadout(): void {
  clearTimeout(readoutTimer);
}

function showReadout(v: number): void {
  const el = readoutEl();
  el.textContent = "Script " + Math.round(v * 100) + " %";
  el.hidden = false;
  el.classList.remove("is-leaving");
  hideReadoutSoon();
}

function hideReadoutSoon(): void {
  clearTimeout(readoutTimer);
  readoutTimer = setTimeout(function () {
    const el = document.getElementById("script-zoom-readout");
    if (el) el.hidden = true;
  }, 1800);
}

export function scriptViewActive(): boolean {
  return !inFront(["loading", "prompter", "writer"], (ports as ScriptZoomPorts).screen()) &&
    !document.documentElement.classList.contains("is-newtab-open");
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey || !scriptViewActive()) return;
  e.preventDefault();
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 33;
  else if (e.deltaMode === 2) dy *= 600;
  dy = Math.max(-300, Math.min(300, dy));
  noteAnchor(e.clientY, e.target as Element | null);
  setScriptScale(target * Math.exp(-dy * 0.001));
}

function zoomKey(e: KeyboardEvent): number {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return 0;
  const k = e.key, c = e.code;
  if (k === "+" || k === "=" || c === "NumpadAdd" || c === "Equal") return 1;
  if (k === "-" || k === "_" || k === "−" || c === "NumpadSubtract" || c === "Minus") return -1;
  if (k === "0" || c === "Numpad0" || c === "Digit0") return 2;
  return 0;
}

function onKeydown(e: KeyboardEvent): void {
  const z = zoomKey(e);
  if (!z) return;
  const id = z === 2 ? "script-zoom-reset" : z > 0 ? "script-zoom-in" : "script-zoom-out";
  if ((ports as ScriptZoomPorts).actions.invoke(id, "shortcut").kind === "ran") e.preventDefault();
}

export function startScriptZoom(given: ScriptZoomPorts): ScriptZoomMount {
  ports = given;
  scale = target = ports.scale.scriptScale();
  paintScale(scale);
  const rowsEl = document.getElementById("rows");
  if (rowsEl) rowsEl.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("keydown", onKeydown, true);
  const stopChanges = ports.changes.onChange(function (change) {
    if (change.name !== "scriptScale" || (!change.elsewhere && storing)) return;
    const v = change.elsewhere || change.value == null ? (ports as ScriptZoomPorts).scale.scriptScale() : clampScriptScale(parseFloat(change.value));
    anchorAtCaretOrMiddle();
    setScriptScale(v, { now: true, quiet: true, noStore: true });
  });
  let disposed = false;
  return { mounted: function () { return !disposed; }, scriptViewActive, stepScriptScale, resetScriptScale, dispose: function () {
    if (disposed) return;
    disposed = true;
    if (rowsEl) rowsEl.removeEventListener("wheel", onWheel);
    document.removeEventListener("keydown", onKeydown, true);
    stopChanges();
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    settleFrames.forEach(function (id) { cancelAnimationFrame(id); });
    settleFrames.clear();
    clearTimeout(readoutTimer);
    readoutTimer = 0;
    const readout = document.getElementById("script-zoom-readout");
    if (readout) {
      readout.removeEventListener("click", resetScriptScale);
      readout.removeEventListener("mouseenter", pauseReadout);
      readout.removeEventListener("mouseleave", hideReadoutSoon);
      readout.remove();
    }
    anchor = null;
    ports = null;
  } };
}
