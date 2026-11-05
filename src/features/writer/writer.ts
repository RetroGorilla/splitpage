import { numberHtml } from "../common/number-html.ts";
import { editableCellHtml } from "../common/editable-cell.ts";
import { formatDuration, totalSeconds } from "../../core/production/timing.ts";
import { rowIndexOf } from "../../core/document/rows.ts";
import { ensureTrailingCaretSpot, cssAttr } from "../common/dom.ts";
import { bothBeatsHaveVisual, joinBeatsCommand } from "../../application/commands/split-join.ts";
import { withinOneBeat } from "../../core/flow/flow.ts";
import { WRITER_SIZE_MAX, WRITER_SIZE_MIN } from "../../application/preferences/preferences.ts";
import { placeEditorSelection, rememberCellSelection } from "../common/cell-selection.ts";
import { placeCaretAtTextOffset } from "../common/caret.ts";
import { domToPos, posToDom } from "../common/cell-dom.ts";
import { beatPos, caretAt } from "../../core/flow/flow.ts";
import { gallerySize } from "../../core/document/gallery.ts";
import { escapeHtml, truncateForPreview } from "../../core/document/text-policy.ts";

import type { FlowWriterMaker, WriterFeaturePorts } from "./ports.ts";
import type { FlowWriter } from "./flow-writer.ts";
import type { UndoDirection } from "../../application/editing/undo/undo.ts";
import type { DocumentView } from "../../application/session/document-session.ts";

type WriterDocument = Pick<DocumentView, "title" | "rows">;
type WriterCurrentDocument = (...args: Parameters<WriterFeaturePorts["document"]["current"]>) => WriterDocument | null;
type WriterRow = DocumentView["rows"][number];
type WriterToggleFormat = (
  cell: Parameters<WriterFeaturePorts["formatting"]["toggle"]>[0],
  command: Parameters<WriterFeaturePorts["formatting"]["toggle"]>[1] | null
) => ReturnType<WriterFeaturePorts["formatting"]["toggle"]>;
interface WriterRedoBoundary {
  top: ReturnType<WriterFeaturePorts["undo"]["last"]>;
  mark: number;
  lifetime: ReturnType<WriterFeaturePorts["undo"]["lifetime"]>;
  serial: number;
}
let numbering: WriterFeaturePorts["document"]["numbering"] | null;
let currentDocument: WriterFeaturePorts["document"]["current"] | null;
let readSession: WriterFeaturePorts["document"]["read"] | null;
let editAllowed: WriterFeaturePorts["edits"]["allowed"] | null;
let runCommand: WriterFeaturePorts["edits"]["run"] | null;
let sessionTextPorts: WriterFeaturePorts["edits"]["text"] | null;
let sanitizeHtml: WriterFeaturePorts["text"]["sanitizeHtml"] | null;
let storedHtmlFromDom: WriterFeaturePorts["text"]["storedHtmlFromDom"] | null;
let productionReaders: WriterFeaturePorts["text"]["productionReaders"] | null;
let htmlToPlainText: WriterFeaturePorts["text"]["htmlToPlainText"] | null;
let cellEditing: WriterFeaturePorts["editing"]["cells"] | null;
let editorSelection: WriterFeaturePorts["editing"]["selection"] | null;
let focusMemory: WriterFeaturePorts["editing"]["focus"] | null;
let paintGuard: WriterFeaturePorts["editing"]["paint"] | null;
let breakUndoCoalescing: WriterFeaturePorts["undo"]["breakCoalescing"] | null;
let lastUndoEntry: WriterFeaturePorts["undo"]["last"] | null;
let nextRedoEntry: WriterFeaturePorts["undo"]["nextRedo"] | null;
let undoLifetime: WriterFeaturePorts["undo"]["lifetime"] | null;
let undoMark: WriterFeaturePorts["undo"]["mark"] | null;
let undoSerial: WriterFeaturePorts["undo"]["serial"] | null;
let splitRowFieldCore: WriterFeaturePorts["rows"]["splitField"] | null;
let renderRowGroups: WriterFeaturePorts["hiding"]["renderGroups"] | null;
let sidePanels: WriterFeaturePorts["panels"] | null;
let preferences: WriterFeaturePorts["preferences"] | null;
let viewFlags: WriterFeaturePorts["view"] | null;
let showToast: WriterFeaturePorts["notices"]["show"] | null;
let appActions: WriterFeaturePorts["actions"] | null;
let cellFormatState: WriterFeaturePorts["formatting"]["state"] | null;
let toggleCellDirection: WriterFeaturePorts["formatting"]["direction"] | null;
let toggleCellFormat: WriterFeaturePorts["formatting"]["toggle"] | null;
let hideTagGhost: WriterFeaturePorts["dismissTagGhost"] | null;
let scheduleIdleRefresh: WriterFeaturePorts["scheduleStats"] | null;
let activeWriter: object | null = null;
let flowMaker: FlowWriterMaker | null = null;
let flowWriter: FlowWriter | null = null;
let flowUndoStep: ((dir: UndoDirection) => void) | null = null;
let selectionFormatting: WriterFeaturePorts["formatting"] | null = null;
let writerLinkCell: HTMLElement | null = null;
let stopWriterLinks: (() => void) | null = null;

let writerGutterMode = "visuals";
let writerUndoMark = 0;
let reopenOnRedo: WriterRedoBoundary | null = null;

function writerBlockHtml(row: WriterRow) {
  let visual;
  if (gallerySize(row)) {
    const caption = truncateForPreview((htmlToPlainText as WriterFeaturePorts["text"]["htmlToPlainText"])(row.visualText), 42);
    visual = '<span class="wr-visual-img">▣</span> ' + escapeHtml(caption || "reference image");
  } else {
    visual = escapeHtml(truncateForPreview((htmlToPlainText as WriterFeaturePorts["text"]["htmlToPlainText"])(row.visualText), 58));
  }
  const id = escapeHtml(row.id);
  return '<div class="wr-block" data-row="' + id + '">' +
      '<div class="wr-gutter" data-action="writer-jump" data-row="' + id +
        '" title="Open this beat in the split view">' +
        '<span class="wr-num">' + numberHtml(((numbering as WriterFeaturePorts["document"]["numbering"])().beats[row.id]?.full ?? "")) + '</span>' +
        '<span class="wr-visual">' + visual + '</span>' +
      '</div>' +
      editableCellHtml({
        className: "wr-para",
        rowId: row.id,
        field: "audioText",
        value: row.audioText,
        placeholder: "Write what gets said…",
        readOnly: !(editAllowed as WriterFeaturePorts["edits"]["allowed"])()
      }) +
    '</div>';
}

export function renderWriter() {
  (paintGuard as WriterFeaturePorts["editing"]["paint"])().whilePainting(function () { paintWriterDraw(drawWriter()); });
}

export function drawWriter() {
  const doc = (currentDocument as WriterCurrentDocument)() as WriterDocument;
  return {
    title: doc.title || "",
    readOnly: !(editAllowed as WriterFeaturePorts["edits"]["allowed"])(),
    html: flowWriter ? "" : doc.rows.length ? (renderRowGroups as WriterFeaturePorts["hiding"]["renderGroups"])(doc.rows, writerBlockHtml) : null
  };
}

export function paintWriterDraw(draw: ReturnType<typeof drawWriter>) {
  const doc = (document.getElementById("writer-doc") as HTMLElement);
  if (flowWriter && !flowWriter.isCurrent()) {
    detachFlowWriter();
    attachFlowWriter();
    writerUndoMark = (undoMark as WriterFeaturePorts["undo"]["mark"])();
    reopenOnRedo = null;
  }
  if (flowWriter) {
    const title = (document.getElementById("writer-title") as HTMLInputElement);
    if (document.activeElement !== title) title.value = draw.title;
    title.readOnly = draw.readOnly;
    doc.setAttribute("contenteditable", draw.readOnly ? "false" : "true");
    flowWriter.repaint();
    updateWriterStats();
    return;
  }
  const active = document.activeElement;
  const caret = (viewFlags as WriterFeaturePorts["view"])().writerOpen() && active && active.classList && active.classList.contains("wr-para") && doc.contains(active)
    ? rememberCellSelection((editorSelection as WriterFeaturePorts["editing"]["selection"])(), active) : null;
  const titleEl = (document.getElementById("writer-title") as HTMLInputElement);
  if (document.activeElement !== titleEl) titleEl.value = draw.title;
  titleEl.readOnly = draw.readOnly;
  if (draw.html === null) {
    doc.innerHTML = '<div class="writer-empty">Nothing to write into yet — close this and add a beat.</div>';
  } else {
    doc.innerHTML = draw.html;
    doc.querySelectorAll(".wr-para").forEach(ensureTrailingCaretSpot);
  }
  (editorSelection as WriterFeaturePorts["editing"]["selection"])().notePainted(doc);
  (focusMemory as WriterFeaturePorts["editing"]["focus"])().focusedParagraph(null);
  if (caret) {
    const placed = placeEditorSelection((editorSelection as WriterFeaturePorts["editing"]["selection"])(), doc);
    if (placed) {
      (focusMemory as WriterFeaturePorts["editing"]["focus"])().focusedParagraph(placed);
      placed.scrollIntoView({ block: "nearest" });
    }
  }
  updateWriterStats();
}

export function updateWriterStats() {
  const doc = (currentDocument as WriterCurrentDocument)();
  if (!(viewFlags as WriterFeaturePorts["view"])().writerOpen() || !doc) return;
  let words = 0;
  doc.rows.forEach(function (row) { words += (productionReaders as WriterFeaturePorts["text"]["productionReaders"]).wordCount(row.audioText); });
  const selected = flowWriter?.selectedText();
  if (selected != null) words = (productionReaders as WriterFeaturePorts["text"]["productionReaders"]).wordCount(escapeHtml(selected));
  (document.getElementById("wr-scenes") as HTMLElement).textContent = String(doc.rows.length);
  (document.getElementById("wr-words") as HTMLElement).textContent = words.toLocaleString();
  (document.getElementById("wr-runtime") as HTMLElement).textContent = formatDuration(totalSeconds((currentDocument as WriterCurrentDocument)() as WriterDocument, (productionReaders as WriterFeaturePorts["text"]["productionReaders"])));
}

export function scheduleWriterStats() {
  if (!(viewFlags as WriterFeaturePorts["view"])().writerOpen()) return;
  (scheduleIdleRefresh as WriterFeaturePorts["scheduleStats"])("writerStats");
}

function focusWriterBlock(rowId: string, offset?: number | "end") {
  if (flowWriter) { flowWriter.caret(rowId, offset ?? 0); return; }
  const el = document.querySelector<HTMLElement>('#writer-doc .wr-para[data-id="' + cssAttr(rowId) + '"]');
  if (!el) return;
  el.focus();
  if (offset === "end") {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    placeCaretAtTextOffset(el, offset || 0);
  }
  (focusMemory as WriterFeaturePorts["editing"]["focus"])().focusedParagraph(el);
  el.scrollIntoView({ block: "nearest" });
}

function caretAtEdge(cellEl: Element, range: Range, edge: "start" | "end") {
  const probe = document.createRange();
  probe.selectNodeContents(cellEl);
  if (edge === "start") probe.setEnd(range.startContainer, range.startOffset);
  else probe.setStart(range.endContainer, range.endOffset);
  const frag = probe.cloneContents();
  return !frag.textContent && !frag.querySelector("br, img");
}

function splitWriterRow(cellEl: Element) {
  const res = (paintGuard as WriterFeaturePorts["editing"]["paint"])().whileShown(function () { return (splitRowFieldCore as WriterFeaturePorts["rows"]["splitField"])(cellEl); });
  if (!res) return;
  renderWriter();
  focusWriterBlock(res.id, 0);
}

function mergeWriterRows(intoIdx: number) {
  const rows = ((currentDocument as WriterCurrentDocument)() as WriterDocument).rows;
  const prev = rows[intoIdx];
  const cur = rows[intoIdx + 1];
  if (!prev || !cur) return;
  if ((readSession as WriterFeaturePorts["document"]["read"])(bothBeatsHaveVisual(prev.id, (htmlToPlainText as WriterFeaturePorts["text"]["htmlToPlainText"])))) {
    (showToast as WriterFeaturePorts["notices"]["show"])("Both beats have a visual — join them in the split view, so you can pick which one to keep.", "warn");
    return;
  }

  const prevEl = document.querySelector<HTMLElement>('#writer-doc .wr-para[data-id="' + cssAttr(prev.id) + '"]');
  const joinAt = prevEl ? prevEl.textContent.length : 0;

  (breakUndoCoalescing as WriterFeaturePorts["undo"]["breakCoalescing"])();
  const ports = Object.assign({}, (sessionTextPorts as WriterFeaturePorts["edits"]["text"]), { plainText: (htmlToPlainText as WriterFeaturePorts["text"]["htmlToPlainText"]) });
  const outcome = (paintGuard as WriterFeaturePorts["editing"]["paint"])().whileShown(function () { return (runCommand as WriterFeaturePorts["edits"]["run"])(joinBeatsCommand(prev.id, ports)); });
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind !== "applied" && outcome.kind !== "committed") return;
  renderWriter();
  focusWriterBlock(prev.id, joinAt);
}

export function onWriterKeydown(e: KeyboardEvent) {
  const cellEl = (e.target as HTMLElement).classList && (e.target as HTMLElement).classList.contains("wr-para") ? e.target as HTMLElement : null;
  if (!cellEl) return;

  if (e.key === "Enter") {
    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    (hideTagGhost as WriterFeaturePorts["dismissTagGhost"])();
    splitWriterRow(cellEl);
    return;
  }
  if (e.key !== "Backspace" && e.key !== "Delete") return;

  const sel = window.getSelection() as Selection;
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !cellEl.contains(range.startContainer)) return;
  const idx = (readSession as WriterFeaturePorts["document"]["read"])(function (doc) { return rowIndexOf(doc, cellEl.getAttribute("data-id")); });
  if (idx === -1) return;

  if (e.key === "Backspace" && idx > 0 && caretAtEdge(cellEl, range, "start")) {
    e.preventDefault();
    e.stopPropagation();
    (cellEditing as WriterFeaturePorts["editing"]["cells"])().sync(cellEl);
    mergeWriterRows(idx - 1);
  } else if (e.key === "Delete" && idx < ((currentDocument as WriterCurrentDocument)() as WriterDocument).rows.length - 1 && caretAtEdge(cellEl, range, "end")) {
    e.preventDefault();
    e.stopPropagation();
    (cellEditing as WriterFeaturePorts["editing"]["cells"])().sync(cellEl);
    mergeWriterRows(idx);
  }
}

export function onWriterFormat(btn: Element) {
  if (flowWriter) {
    const command = btn.getAttribute("data-cmd") ?? "";
    if (command === "tag" || command === "link") {
      const range = flowWriter.selection();
      if (!range || !withinOneBeat(range) || range.head.kind !== "beat") return;
      flowWriter.place(range);
      const beat = document.querySelector<HTMLElement>('#writer-doc .wr-beat[data-id="' + cssAttr(range.head.rowId) + '"]');
      if (!beat) return;
      if (command === "link") writerLinkCell = beat;
      const bar = document.querySelector(".writer-bar");
      if (bar) selectionFormatting?.selection(btn, beat, bar);
    }
    else if (command === "comment") flowWriter.comment();
    else flowWriter.format(command);
    updateWriterFormatState();
    return;
  }
  const cellEl = (focusMemory as WriterFeaturePorts["editing"]["focus"])().writerParagraph();
  if (!cellEl || !cellEl.isConnected) return;
  const cmd = btn.getAttribute("data-cmd");
  (cellEl as HTMLElement).focus();
  if (cmd === "direction") (toggleCellDirection as WriterFeaturePorts["formatting"]["direction"])(cellEl);
  else (toggleCellFormat as WriterToggleFormat)(cellEl, cmd);
  updateWriterFormatState();
}

export function updateWriterFormatState() {
  const range = flowWriter?.selection();
  const crossBeat = !!range && !withinOneBeat(range);
  const comment = document.querySelector<HTMLButtonElement>('.writer-bar .wr-fmt[data-cmd="comment"]');
  if (comment) {
    comment.disabled = crossBeat;
    comment.title = crossBeat ? "Comments must stay within one beat." : "Comment on the selected words";
  }
  ["tag", "link"].forEach(command => {
    const button = document.querySelector<HTMLButtonElement>('.writer-bar .wr-fmt[data-cmd="' + command + '"]');
    if (!button) return;
    button.disabled = crossBeat;
    button.title = crossBeat ? (command === "tag" ? "Tags" : "Links") + " must stay within one beat."
      : command === "tag" ? "Label as a prop, location, cast member or effect" : "Add link";
  });
  if (flowWriter) updateWriterStats();
  const paragraph = (viewFlags as WriterFeaturePorts["view"])().writerOpen() ? (focusMemory as WriterFeaturePorts["editing"]["focus"])().writerParagraph() : null;
  const live = paragraph && paragraph.isConnected;
  const model = flowWriter ? flowWriter.marks() : live ? (cellFormatState as WriterFeaturePorts["formatting"]["state"])(paragraph) : null;
  ["bold", "italic", "underline", "strikeThrough", "direction"].forEach(function (cmd) {
    const btn = document.querySelector<HTMLElement>('.writer-bar .wr-fmt[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("is-active", !!(model && (model as Record<string, unknown>)[cmd]));
  });
  const hi = document.querySelector<HTMLElement>('.writer-bar .wr-fmt[data-cmd="highlight"]');
  if (hi) hi.classList.toggle("is-active", !!(model && (model as Record<string, unknown>).highlight));
}

const WRITER_GUTTER_MODES = ["visuals", "numbers", "compact"];
const WRITER_GUTTER_LABELS: Record<string, string> = { visuals: "Visuals", numbers: "Numbers", compact: "Compact" };

export function readWriterSize() {
  return (preferences as WriterFeaturePorts["preferences"])().writerSize();
}

export function applyWriterSize(px: number | null, remember: boolean) {
  const el = (document.getElementById("writer") as HTMLElement);
  if (px == null) {
    el.style.removeProperty("--wr-font");
    const actual = parseFloat(getComputedStyle(el).getPropertyValue("--wr-font"));
    if (isFinite(actual)) (document.getElementById("wr-size") as HTMLInputElement).value = String(Math.round(actual));
    return;
  }
  const n = Math.min(WRITER_SIZE_MAX, Math.max(WRITER_SIZE_MIN, Math.round(px)));
  el.style.setProperty("--wr-font", n + "px");
  (document.getElementById("wr-size") as HTMLInputElement).value = String(n);
  if (remember) (preferences as WriterFeaturePorts["preferences"])().setWriterSize(n);
}

function setWriterGutter(mode: string) {
  if (WRITER_GUTTER_MODES.indexOf(mode) === -1) mode = "visuals";
  writerGutterMode = mode;
  (document.getElementById("writer") as HTMLElement).setAttribute("data-gutter", mode);
  const btn = (document.getElementById("wr-gutter-mode") as HTMLElement);
  btn.textContent = WRITER_GUTTER_LABELS[mode] as string;
  btn.classList.toggle("is-active", mode !== "compact");
}

export function cycleWriterGutter() {
  const i = WRITER_GUTTER_MODES.indexOf(writerGutterMode);
  setWriterGutter(WRITER_GUTTER_MODES[(i + 1) % WRITER_GUTTER_MODES.length] as string);
}

export function openWriter(keepMark?: number | null) {
  const flow = !!flowMaker?.enabled();
  const selection = window.getSelection();
  const node = selection?.focusNode;
  const cell = (node?.nodeType === 3 ? node.parentElement : node as Element | null)?.closest?.('#rows .cell-editable[data-id]');
  const offset = cell && node ? domToPos(cell, node, selection?.focusOffset ?? 0) : null;
  const remembered = flow ? (editorSelection as WriterFeaturePorts["editing"]["selection"])().resolve() : null;
  const rowId = cell?.getAttribute("data-id") ?? remembered?.rowId;
  const at = flow && rowId ? caretAt(beatPos(rowId, offset ?? remembered?.head ?? 0)) : null;
  const el = (document.getElementById("writer") as HTMLElement);
  writerUndoMark = keepMark == null ? (undoMark as WriterFeaturePorts["undo"]["mark"])() : keepMark;
  reopenOnRedo = null;
  if (flow) (sidePanels as WriterFeaturePorts["panels"])().open("comments-panel");
  else (sidePanels as WriterFeaturePorts["panels"])().closeAll();
  if ((viewFlags as WriterFeaturePorts["view"])().findOpen()) (appActions as WriterFeaturePorts["actions"]).invoke("find", "button", "close");
  (document.getElementById("writer-title") as HTMLInputElement).value = ((currentDocument as WriterCurrentDocument)() as WriterDocument).title || "";
  applyWriterSize(readWriterSize(), false);
  setWriterGutter(writerGutterMode);
  el.inert = false;
  el.hidden = false;
  (viewFlags as WriterFeaturePorts["view"])().setWriterOpen(true);
  attachFlowWriter();
  renderWriter();
  (document.getElementById("writer-scroll") as HTMLElement).scrollTop = 0;

  const rows = ((currentDocument as WriterCurrentDocument)() as WriterDocument).rows;
  let blank: WriterRow | null | undefined = null;
  for (let i = 0; i < rows.length; i++) {
    if (!(htmlToPlainText as WriterFeaturePorts["text"]["htmlToPlainText"])((rows[i] as WriterRow).audioText)) { blank = rows[i]; break; }
  }
  if (flowWriter && at) flowWriter.place(at);
  else if (blank) focusWriterBlock(blank.id, 0);
  else if (rows.length) focusWriterBlock((rows[rows.length - 1] as WriterRow).id, "end");
  updateWriterFormatState();
}

function attachFlowWriter() {
  if (!flowMaker || flowWriter || !flowMaker.enabled()) return;
  const root = (document.getElementById("writer-doc") as HTMLElement);
  root.textContent = "";
  root.classList.add("is-flow");
  root.setAttribute("data-undo-owner", "document");
  root.setAttribute("spellcheck", "true");
  root.setAttribute("tabindex", "0");
  (document.querySelector('.writer-bar .wr-fmt[data-cmd="comment"]') as HTMLElement).hidden = false;
  flowWriter = flowMaker.create(root, updateWriterFormatState, (dir) => { flowUndoStep?.(dir); });
  stopWriterLinks = mountWriterLinks();
}

function detachFlowWriter() {
  if (!flowWriter) return;
  stopWriterLinks?.();
  stopWriterLinks = null;
  flowWriter.dispose();
  flowWriter = null;
  updateWriterFormatState();
  const root = (document.getElementById("writer-doc") as HTMLElement);
  root.classList.remove("is-flow");
  root.removeAttribute("data-undo-owner");
  root.removeAttribute("contenteditable");
  root.removeAttribute("spellcheck");
  root.removeAttribute("tabindex");
  root.textContent = "";
}

export function connectFlowUndo(step: ((dir: UndoDirection) => void) | null) {
  flowUndoStep = step;
}

export function writerReplayed(steps: readonly unknown[]) {
  if (!flowWriter || !(viewFlags as WriterFeaturePorts["view"])().writerOpen()) return false;
  flowWriter.afterReplay(steps);
  return true;
}

export function writerFlowControl() {
  return flowWriter;
}

export function closeWriter() {
  const el = (document.getElementById("writer") as HTMLElement);
  if (el.hidden) return;
  const flow = flowWriter;
  const at = flow?.finish()?.head;
  detachFlowWriter();
  const active = document.activeElement;
  if (active && active.classList && active.classList.contains("wr-para")) {
    const clean = (sanitizeHtml as WriterFeaturePorts["text"]["sanitizeHtml"])(active.innerHTML);
    if (clean !== (storedHtmlFromDom as WriterFeaturePorts["text"]["storedHtmlFromDom"])(active.innerHTML)) active.innerHTML = clean;
    (cellEditing as WriterFeaturePorts["editing"]["cells"])().sync(active);
  }
  if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  el.inert = true;
  el.hidden = true;
  (viewFlags as WriterFeaturePorts["view"])().setWriterOpen(false);
  (focusMemory as WriterFeaturePorts["editing"]["focus"])().focusedParagraph(null);
  (hideTagGhost as WriterFeaturePorts["dismissTagGhost"])();
  if (flow) {
    flowMaker?.refreshSplit(at?.kind === "beat" ? at.rowId : undefined);
    if (at?.kind === "beat") {
      const cell = document.querySelector<HTMLElement>('#rows .cell-editable[data-id="' + cssAttr(at.rowId) + '"][data-field="audioText"]');
      if (cell) {
        cell.focus({ preventScroll: true });
        const point = posToDom(cell, at.offset);
        window.getSelection()?.setBaseAndExtent(point.node, point.offset, point.node, point.offset);
        rememberCellSelection((editorSelection as WriterFeaturePorts["editing"]["selection"])(), cell);
        cell.scrollIntoView({ block: "nearest" });
      }
    }
  }
}

export function writerUndoStep(dir: string) {
  if ((viewFlags as WriterFeaturePorts["view"])().writerOpen()) {
    flowWriter?.beforeReplay(dir as UndoDirection);
    if (dir === "redo") {
      const next = (nextRedoEntry as WriterFeaturePorts["undo"]["nextRedo"])();
      return !next || next.n <= writerUndoMark;
    }
    const top = (lastUndoEntry as WriterFeaturePorts["undo"]["last"])();
    if (top && top.n > writerUndoMark) return false;
    const mark = writerUndoMark;
    closeWriter();
    reopenOnRedo = { top: (lastUndoEntry as WriterFeaturePorts["undo"]["last"])(), mark: mark, lifetime: (undoLifetime as WriterFeaturePorts["undo"]["lifetime"])(), serial: (undoSerial as WriterFeaturePorts["undo"]["serial"])() };
    return true;
  }
  const pending = reopenOnRedo;
  reopenOnRedo = null;
  if (!pending || dir !== "redo") return false;
  if ((undoLifetime as WriterFeaturePorts["undo"]["lifetime"])() !== pending.lifetime || (lastUndoEntry as WriterFeaturePorts["undo"]["last"])() !== pending.top || (undoSerial as WriterFeaturePorts["undo"]["serial"])() !== pending.serial) return false;
  openWriter(pending.mark);
  return true;
}

export function jumpFromWriterToRow(rowId: string | null) {
  closeWriter();
  const target = document.querySelector<HTMLElement>('#rows .row[data-id="' + cssAttr(rowId) + '"]');
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("just-merged");
  void target.offsetWidth;
  target.classList.add("just-merged");
}

const VIEWING_ONLY = "Viewing only — you can comment on this script, but not change it.";
const REFUSAL_BURST_MS = 2000;
const EDIT_CHORDS = ["z", "y", "b", "i", "u"];
const GUARDED_EVENTS = ["keydown", "beforeinput", "input", "paste", "cut", "click"];
let lastRefusalAt = 0;

function refuseWriterEdit() {
  const now = Date.now();
  if (now - lastRefusalAt > REFUSAL_BURST_MS) (showToast as WriterFeaturePorts["notices"]["show"])(VIEWING_ONLY, "warn");
  lastRefusalAt = now;
}

function isEditKey(e: KeyboardEvent) {
  const name = String(e.key || "");
  const chord = e.ctrlKey || e.metaKey;
  if (name === "Enter" || name === "Backspace" || name === "Delete") return true;
  if (chord) return EDIT_CHORDS.indexOf(name.toLowerCase()) !== -1;
  if (e.altKey) return name === "ArrowUp" || name === "ArrowDown";
  return name.length === 1 && name !== " ";
}

function attemptsEdit(e: Event) {
  const target = e.target as Element | null;
  if (!target || !target.closest) return false;
  if (e.type === "click") return !!target.closest(".wr-fmt");
  if (!target.closest(".wr-para, #writer-doc.is-flow, .wr-flow-visual-text") && target.id !== "writer-title") return false;
  return e.type !== "keydown" || isEditKey(e as KeyboardEvent);
}

function guardWriterEdit(e: Event) {
  if ((editAllowed as WriterFeaturePorts["edits"]["allowed"])() || !attemptsEdit(e)) return;
  e.preventDefault();
  e.stopPropagation();
  refuseWriterEdit();
  if (e.type === "input") {
    renderWriter();
    (document.getElementById("writer-title") as HTMLInputElement).value = ((currentDocument as WriterCurrentDocument)() as WriterDocument).title || "";
  }
}

function mountWriterLinks(): () => void {
  const formatting = selectionFormatting as WriterFeaturePorts["formatting"];
  const bar = document.querySelector<HTMLElement>(".writer-bar") as HTMLElement;
  function finishLink(confirm: boolean): void {
    const range = flowWriter?.selection();
    if (confirm) formatting.confirmLink(bar, writerLinkCell);
    else formatting.cancelLink(bar);
    writerLinkCell = null;
    flowWriter?.repaint();
    if (range && withinOneBeat(range) && range.head.kind === "beat") {
      flowWriter?.place(confirm ? caretAt(beatPos(range.head.rowId, Math.max(range.anchor.offset, range.head.offset))) : range);
    }
  }
  function onClick(event: MouseEvent): void {
    const button = (event.target as Element).closest('[data-action="link-confirm"], [data-action="link-cancel"]');
    if (!button) return;
    event.stopPropagation();
    finishLink(button.getAttribute("data-action") === "link-confirm");
  }
  function onKey(event: KeyboardEvent): void {
    if (!(event.target as Element).matches(".link-popover input")) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finishLink(event.key === "Enter");
  }
  bar.addEventListener("click", onClick);
  bar.addEventListener("keydown", onKey);
  return () => {
    bar.removeEventListener("click", onClick);
    bar.removeEventListener("keydown", onKey);
    formatting.cancelLink(bar);
    writerLinkCell = null;
  };
}

export function startWriter(given: WriterFeaturePorts) {
  flowMaker = given.flow ?? null;
  numbering = given.document.numbering;
  currentDocument = given.document.current;
  readSession = given.document.read;
  editAllowed = given.edits.allowed;
  runCommand = given.edits.run;
  sessionTextPorts = given.edits.text;
  sanitizeHtml = given.text.sanitizeHtml;
  storedHtmlFromDom = given.text.storedHtmlFromDom;
  productionReaders = given.text.productionReaders;
  htmlToPlainText = given.text.htmlToPlainText;
  cellEditing = given.editing.cells;
  editorSelection = given.editing.selection;
  focusMemory = given.editing.focus;
  paintGuard = given.editing.paint;
  breakUndoCoalescing = given.undo.breakCoalescing;
  lastUndoEntry = given.undo.last;
  nextRedoEntry = given.undo.nextRedo;
  undoLifetime = given.undo.lifetime;
  undoMark = given.undo.mark;
  undoSerial = given.undo.serial;
  splitRowFieldCore = given.rows.splitField;
  renderRowGroups = given.hiding.renderGroups;
  sidePanels = given.panels;
  preferences = given.preferences;
  viewFlags = given.view;
  showToast = given.notices.show;
  appActions = given.actions;
  cellFormatState = given.formatting.state;
  toggleCellDirection = given.formatting.direction;
  toggleCellFormat = given.formatting.toggle;
  hideTagGhost = given.dismissTagGhost;
  scheduleIdleRefresh = given.scheduleStats;
  selectionFormatting = given.formatting;
  const mine = {};
  activeWriter = mine;
  let disposed = false;
  const root = (document.getElementById("writer") as HTMLElement);
  GUARDED_EVENTS.forEach(function (type) { root.addEventListener(type, guardWriterEdit, true); });
  return {
    renderWriter, drawWriter, paintWriterDraw, updateWriterStats, scheduleWriterStats,
    onWriterKeydown, onWriterFormat, updateWriterFormatState, readWriterSize, applyWriterSize,
    cycleWriterGutter, openWriter, closeWriter, writerUndoStep, jumpFromWriterToRow,
    connectFlowUndo, writerReplayed, writerFlowControl,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      if (activeWriter !== mine) return;
      activeWriter = null;
      GUARDED_EVENTS.forEach(function (type) { root.removeEventListener(type, guardWriterEdit, true); });
      closeWriter();
      detachFlowWriter();
      selectionFormatting = null;
      writerLinkCell = null;
      flowMaker = null;
      flowUndoStep = null;
      given.cancelStats();
      writerGutterMode = "visuals";
      writerUndoMark = 0;
      reopenOnRedo = null;
      lastRefusalAt = 0;
      currentDocument = null;
      readSession = null;
      editAllowed = null;
      runCommand = null;
      sessionTextPorts = null;
      sanitizeHtml = null;
      storedHtmlFromDom = null;
      productionReaders = null;
      htmlToPlainText = null;
      cellEditing = null;
      editorSelection = null;
      focusMemory = null;
      paintGuard = null;
      breakUndoCoalescing = null;
      lastUndoEntry = null;
      nextRedoEntry = null;
      undoLifetime = null;
      undoMark = null;
      undoSerial = null;
      splitRowFieldCore = null;
      renderRowGroups = null;
      sidePanels = null;
      preferences = null;
      viewFlags = null;
      showToast = null;
      appActions = null;
      cellFormatState = null;
      toggleCellDirection = null;
      toggleCellFormat = null;
      hideTagGhost = null;
      scheduleIdleRefresh = null;
    }
  };
}
