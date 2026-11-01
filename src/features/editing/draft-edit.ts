import { cellSelection, setCellSelection } from "../common/cell-selection.ts";
import { isDraftBox } from "./cell-page.ts";
import { clamp, clampRange, deleteRange, insertCell, insertText, markThroughout, setMark } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { cellLength, normalizeCell, projection } from "../../core/text/runs.ts";
import type { DraftEditPorts } from "./ports.ts";
import type { CellInput, MarkName, Run } from "../../core/text/runs.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";

type MediaPredicate = (ch: string | undefined) => boolean;
interface DraftMediaTable {
  media: Record<string, string>;
  add: (html: string) => string;
  isMedia: MediaPredicate;
  cell: (html: unknown) => Run[];
  html: (cell: CellInput) => string;
  markThroughout: (cell: CellInput, from: number, to: number, name: string) => boolean;
  toggleMark: (cell: CellInput, from: number, to: number, name: string) => Run[];
}
interface DraftSnapshot {
  html: string;
  sel: CellRange | null;
}
interface DraftBoxHistory {
  stack: DraftSnapshot[];
  index: number;
  pending: boolean;
  kind: "delete" | "insert" | null;
  lastSel: CellRange | null;
}
type DraftEditResult = { cell: CellInput; sel?: CellRange | null } | null;
type DraftEditOperation = (cell: Run[], sel: CellRange | null, media: DraftMediaTable) => DraftEditResult;
let ports: DraftEditPorts | null = null;

const PUA_FIRST = 0xE000;
const PUA_LAST = 0xF8FF;
const PUA_RE = /[\uE000-\uF8FF]/g;
const HISTORY_LIMIT = 200;
const TYPING_PAUSE_MS = 800;

function isMediaEl(node: Node | null): node is HTMLElement {
  if (!node || node.nodeType !== 1) return false;
  if ((node as Element).tagName === "IMG") return true;
  return (node as Element).tagName === "A" && !!(node as Element).classList && (node as Element).classList.contains("video-embed-card");
}

export function mediaTable(texts?: readonly unknown[] | null): DraftMediaTable {
  const reserved: Record<string, boolean> = {};
  (texts || []).forEach(function (t) {
    String(t == null ? "" : t).replace(PUA_RE, function (ch) { reserved[ch] = true; return ch; });
  });
  let next = PUA_FIRST;
  const table: DraftMediaTable = {
    media: {},
    add: function (html) {
      while (next <= PUA_LAST && reserved[String.fromCharCode(next)]) next++;
      if (next > PUA_LAST) return "";
      const ch = String.fromCharCode(next++);
      reserved[ch] = true;
      table.media[ch] = html;
      return ch;
    },
    isMedia: function (ch) { return (Object.prototype.hasOwnProperty as MediaPredicate).call(table.media, ch); },
    cell: function (html) { return (ports as DraftEditPorts).text.fromHtml(liftMedia(html, table)); },
    html: function (cell) { return dropMedia(toHtml(stripMediaMarks(cell, table.isMedia)), table); },
    markThroughout: function (cell, from, to, name) { return markThroughoutText(cell, from, to, name, table.isMedia); },
    toggleMark: function (cell, from, to, name) {
      return setMark(cell, from, to, name as MarkName, !markThroughoutText(cell, from, to, name, table.isMedia));
    }
  };
  return table;
}

export function liftMedia(html: unknown, table: DraftMediaTable) {
  const body = (ports as DraftEditPorts).text.inertBody((ports as DraftEditPorts).text.sanitizeHtml(html == null ? "" : String(html)));
  const found: HTMLElement[] = [];
  (function walk(node: Node) {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (isMediaEl(c)) found.push(c);
      else if (c.nodeType === 1) walk(c);
    }
  })(body);
  found.forEach(function (el) {
    const ch = table.add(el.outerHTML);
    if (ch) (el.parentNode as ParentNode).replaceChild(body.ownerDocument.createTextNode(ch), el);
    else (el.parentNode as ParentNode).removeChild(el);
  });
  return body.innerHTML;
}

function dropMedia(html: string, table: DraftMediaTable) {
  return html.replace(PUA_RE, function (ch) { return table.isMedia(ch) ? (table.media[ch] as string) : ch; });
}

export function stripMediaMarks(cell: CellInput, isMedia: MediaPredicate) {
  const out: Run[] = [];
  normalizeCell(cell).forEach(function (r) {
    if (r.atom) { out.push(r); return; }
    let buf = "";
    for (let i = 0; i < r.text.length; i++) {
      const ch = r.text[i] as string;
      if (!isMedia(ch)) { buf += ch; continue; }
      if (buf) out.push({ text: buf, marks: r.marks });
      buf = "";
      out.push({ text: ch, marks: {} });
    }
    if (buf) out.push({ text: buf, marks: r.marks });
  });
  return normalizeCell(out);
}

export function markThroughoutText(cell: CellInput, from: number, to: number, name: string, isMedia: MediaPredicate) {
  const a = Math.min(from, to), b = Math.max(from, to);
  const proj = projection(cell);
  let seen = false, start = a;
  for (let i = a; i <= b; i++) {
    if (i < b && !isMedia(proj[i])) continue;
    if (i > start) {
      const words = proj.slice(start, i).replace(/[\n\uFFFC]/g, "");
      if (words) {
        if (!markThroughout(cell, start, i, name as MarkName)) return false;
        seen = true;
      }
    }
    start = i + 1;
  }
  return seen;
}

export function newHistory(snap: DraftSnapshot): DraftBoxHistory {
  return { stack: [snap], index: 0, pending: false, kind: null, lastSel: null };
}

export function historyCommit(h: DraftBoxHistory, snap: DraftSnapshot) {
  if (!h.pending) return false;
  h.pending = false;
  h.kind = null;
  if (snap.html === (h.stack[h.index] as DraftSnapshot).html) {
    (h.stack[h.index] as DraftSnapshot).sel = snap.sel;
    return false;
  }
  historyPush(h, snap);
  return true;
}

export function historyPush(h: DraftBoxHistory, snap: DraftSnapshot) {
  h.stack.length = h.index + 1;
  h.stack.push(snap);
  if (h.stack.length > HISTORY_LIMIT) h.stack.splice(0, h.stack.length - HISTORY_LIMIT);
  h.index = h.stack.length - 1;
  h.pending = false;
  h.kind = null;
}

export function historyNoteSelection(h: DraftBoxHistory, sel: CellRange | null) {
  if (!h.pending && sel) (h.stack[h.index] as DraftSnapshot).sel = sel;
}

export function historyUndo(h: DraftBoxHistory, now: DraftSnapshot) {
  historyCommit(h, now);
  if (h.index === 0) return null;
  h.index--;
  return h.stack[h.index];
}

export function historyRedo(h: DraftBoxHistory, now: DraftSnapshot) {
  if (h.pending) { historyCommit(h, now); return null; }
  if (h.index >= h.stack.length - 1) return null;
  h.index++;
  return h.stack[h.index];
}

let histories = new WeakMap<Element, DraftBoxHistory>();
const timers = new Map<Element, ReturnType<typeof setTimeout>>();
let composing = new WeakSet<Element>();

function boxHtml(box: Element) {
  let html = box.innerHTML;
  if (html.indexOf("\u200B") !== -1) html = html.replace(/\u200B/g, "");
  return (ports as DraftEditPorts).text.storedHtmlFromDom(html);
}

function snapshot(box: Element) {
  return { html: boxHtml(box), sel: cellSelection(box) };
}

function historyFor(box: Element) {
  let h = histories.get(box);
  if (!h) {
    h = newHistory(snapshot(box));
    histories.set(box, h);
  }
  return h;
}

function clearTimer(box: Element) {
  const t = timers.get(box);
  if (t) clearTimeout(t);
  timers.delete(box);
}

function commitTyping(box: Element) {
  clearTimer(box);
  const h = histories.get(box);
  if (h && h.pending) historyCommit(h, snapshot(box));
}

export function resetDraftHistory(box: Element | null | undefined) {
  if (!box) return;
  clearTimer(box);
  histories.delete(box);
}

export function draftModel(box: Element, reserve?: string[] | null) {
  const html = boxHtml(box);
  const table = mediaTable([html].concat(reserve || []));
  return { cell: table.cell(html), media: table, html: html };
}

export function editDraft(box: Element, fn: DraftEditOperation, reserve?: string[] | null) {
  if (!isDraftBox(box)) return null;
  const h = historyFor(box);
  commitTyping(box);
  const sel = cellSelection(box);
  historyNoteSelection(h, sel);
  const m = draftModel(box, reserve);
  const out = fn(m.cell, sel, m.media);
  if (!out || !out.cell) return null;
  const next = m.media.html(out.cell);
  if (next !== m.html) box.innerHTML = next;
  (box as HTMLElement).focus({ preventScroll: true });
  if (out.sel) setCellSelection(box, out.sel.from, out.sel.to);
  if (next !== m.html) historyPush(h, { html: boxHtml(box), sel: out.sel || null });
  else historyNoteSelection(h, out.sel || null);
  return box;
}

function restore(box: Element, snap: DraftSnapshot) {
  box.innerHTML = snap.html;
  (box as HTMLElement).focus({ preventScroll: true });
  if (snap.sel) setCellSelection(box, snap.sel.from, snap.sel.to);
  else {
    const r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(false);
    const s = window.getSelection();
    (s as Selection).removeAllRanges();
    (s as Selection).addRange(r);
  }
}

export function draftUndo(box: Element) {
  if (!isDraftBox(box) || composing.has(box)) return false;
  clearTimer(box);
  const snap = historyUndo(historyFor(box), snapshot(box));
  if (snap) restore(box, snap);
  return !!snap;
}

export function draftRedo(box: Element) {
  if (!isDraftBox(box) || composing.has(box)) return false;
  clearTimer(box);
  const snap = historyRedo(historyFor(box), snapshot(box));
  if (snap) restore(box, snap);
  return !!snap;
}

export function noteDraftBeforeInput(box: Element, e: { isComposing?: boolean; inputType?: string }) {
  if (!isDraftBox(box)) return;
  const h = historyFor(box);
  if (e.isComposing || composing.has(box)) return;
  const kind = /^delete/.test(e.inputType || "") ? "delete" : "insert";
  const sel = cellSelection(box);
  if (h.pending) {
    const jumped = !sel || !h.lastSel || sel.from !== h.lastSel.to || sel.to !== h.lastSel.to;
    if (kind !== h.kind || jumped) {
      clearTimer(box);
      historyCommit(h, { html: boxHtml(box), sel: sel });
    }
  } else {
    historyNoteSelection(h, sel);
  }
  h.kind = kind;
}

export function noteDraftInput(box: Element) {
  if (!isDraftBox(box)) return;
  const h = historyFor(box);
  h.pending = true;
  h.lastSel = cellSelection(box);
  schedulePauseCommit(box);
}

function schedulePauseCommit(box: Element) {
  clearTimer(box);
  timers.set(box, setTimeout(function () {
    timers.delete(box);
    if (composing.has(box)) return;
    commitTyping(box);
  }, TYPING_PAUSE_MS));
}

export function noteDraftComposition(box: Element, on: boolean) {
  if (!isDraftBox(box)) return;
  if (on) {
    const hs = historyFor(box);
    commitTyping(box);
    historyNoteSelection(hs, cellSelection(box));
    composing.add(box);
  } else {
    composing.delete(box);
    const h = histories.get(box);
    if (h && h.pending) schedulePauseCommit(box);
  }
}

export function noteDraftFocus(box: Element) {
  if (isDraftBox(box)) historyFor(box);
}

export function pasteIntoDraft(box: Element, html: string, text: string) {
  const clean = html ? (ports as DraftEditPorts).text.sanitizeHtml(html) : "";
  if (!clean && !text) return null;
  return editDraft(box, function (cell, sel, media) {
    const r = sel ? clampRange(cell, sel.from, sel.to) : { from: cellLength(cell), to: cellLength(cell) };
    const rest = deleteRange(cell, r.from, r.to);
    const from = clamp(rest, r.from);
    const next = clean ? insertCell(rest, from, media.cell(clean)).cell : insertText(rest, from, text);
    const at = from + cellLength(next) - cellLength(rest);
    return { cell: next, sel: { from: at, to: at } };
  }, [clean, text]);
}

export function appendDraftMedia(box: Element, mediaHtml: string) {
  return editDraft(box, function (cell, sel, media) {
    const ch = media.add(mediaHtml);
    if (!ch) return null;
    const n = cellLength(cell);
    return { cell: insertText(cell, n, "\n" + ch + "\n", {}), sel: sel || { from: n + 2, to: n + 2 } };
  }, [mediaHtml]);
}

export function startDraftEdit(given: DraftEditPorts) {
  ports = given;
  histories = new WeakMap<Element, DraftBoxHistory>();
  composing = new WeakSet<Element>();
  let disposed = false;
  return { dispose: function () {
    if (disposed) return;
    disposed = true;
    timers.forEach(function (timer) { clearTimeout(timer); });
    timers.clear();
    histories = new WeakMap<Element, DraftBoxHistory>();
    composing = new WeakSet<Element>();
    ports = null;
  } };
}
