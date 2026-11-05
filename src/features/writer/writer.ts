import { formatDuration, totalSeconds } from "../../core/production/timing.ts";
import { cssAttr } from "../common/dom.ts";
import { withinOneBeat } from "../../core/flow/flow.ts";
import { WRITER_SIZE_MAX, WRITER_SIZE_MIN } from "../../application/preferences/preferences.ts";
import { rememberCellSelection } from "../common/cell-selection.ts";
import { domToPos, posToDom } from "../common/cell-dom.ts";
import { beatPos, caretAt } from "../../core/flow/flow.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";

import type { FlowWriterMaker, WriterFeaturePorts } from "./ports.ts";
import type { FlowWriter } from "./flow-writer.ts";
import type { UndoDirection } from "../../application/editing/undo/undo.ts";
import type { DocumentView } from "../../application/session/document-session.ts";

type WriterDocument = Pick<DocumentView, "title" | "rows">;
type WriterCurrentDocument = (...args: Parameters<WriterFeaturePorts["document"]["current"]>) => WriterDocument | null;
type WriterRow = DocumentView["rows"][number];
interface WriterRedoBoundary {
  top: ReturnType<WriterFeaturePorts["undo"]["last"]>;
  mark: number;
  lifetime: ReturnType<WriterFeaturePorts["undo"]["lifetime"]>;
  serial: number;
}
let currentDocument: WriterFeaturePorts["document"]["current"] | null;
let editAllowed: WriterFeaturePorts["edits"]["allowed"] | null;
let productionReaders: WriterFeaturePorts["text"]["productionReaders"] | null;
let htmlToPlainText: WriterFeaturePorts["text"]["htmlToPlainText"] | null;
let editorSelection: WriterFeaturePorts["editing"]["selection"] | null;
let paintGuard: WriterFeaturePorts["editing"]["paint"] | null;
let lastUndoEntry: WriterFeaturePorts["undo"]["last"] | null;
let nextRedoEntry: WriterFeaturePorts["undo"]["nextRedo"] | null;
let undoLifetime: WriterFeaturePorts["undo"]["lifetime"] | null;
let undoMark: WriterFeaturePorts["undo"]["mark"] | null;
let undoSerial: WriterFeaturePorts["undo"]["serial"] | null;
let sidePanels: WriterFeaturePorts["panels"] | null;
let preferences: WriterFeaturePorts["preferences"] | null;
let viewFlags: WriterFeaturePorts["view"] | null;
let showToast: WriterFeaturePorts["notices"]["show"] | null;
let appActions: WriterFeaturePorts["actions"] | null;
let hideTagGhost: WriterFeaturePorts["dismissTagGhost"] | null;
let scheduleIdleRefresh: WriterFeaturePorts["scheduleStats"] | null;
let activeWriter: object | null = null;
let flowMaker: FlowWriterMaker | null = null;
let flowWriter: FlowWriter | null = null;
let flowUndoStep: ((dir: UndoDirection) => void) | null = null;
let selectionFormatting: WriterFeaturePorts["formatting"] | null = null;
let writerLinkCell: HTMLElement | null = null;
let stopWriterLinks: (() => void) | null = null;

let writerUndoMark = 0;
let reopenOnRedo: WriterRedoBoundary | null = null;

export function renderWriter() {
  (paintGuard as WriterFeaturePorts["editing"]["paint"])().whilePainting(function () { paintWriterDraw(drawWriter()); });
}

export function drawWriter() {
  const doc = (currentDocument as WriterCurrentDocument)() as WriterDocument;
  return {
    title: doc.title || "",
    readOnly: !(editAllowed as WriterFeaturePorts["edits"]["allowed"])()
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
  }
}

let writerWordTotal = 0;

function setWriterStat(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLElement;
  if (el.textContent === value) return;
  const child = el.firstChild;
  // why: replacing text children invalidates body :has() rules across the hidden split view
  if (child?.nodeType === 3 && el.childNodes.length === 1) (child as Text).data = value;
  else el.textContent = value;
}

function updateWriterSelectionCount() {
  const selected = flowWriter?.selectedText();
  const words = selected == null ? writerWordTotal
    : (productionReaders as WriterFeaturePorts["text"]["productionReaders"]).wordCount(escapeHtml(selected));
  setWriterStat("wr-words", words.toLocaleString());
}

export function updateWriterStats() {
  const doc = (currentDocument as WriterCurrentDocument)();
  if (!(viewFlags as WriterFeaturePorts["view"])().writerOpen() || !doc) return;
  let words = 0;
  doc.rows.forEach(function (row) { words += (productionReaders as WriterFeaturePorts["text"]["productionReaders"]).wordCount(row.audioText); });
  writerWordTotal = words;
  setWriterStat("wr-scenes", String(doc.rows.length));
  updateWriterSelectionCount();
  setWriterStat("wr-runtime", formatDuration(totalSeconds((currentDocument as WriterCurrentDocument)() as WriterDocument, (productionReaders as WriterFeaturePorts["text"]["productionReaders"]))));
}

export function scheduleWriterStats() {
  if (!(viewFlags as WriterFeaturePorts["view"])().writerOpen()) return;
  (scheduleIdleRefresh as WriterFeaturePorts["scheduleStats"])("writerStats");
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
  if (flowWriter) updateWriterSelectionCount();
  const model = flowWriter?.marks();
  ["bold", "italic", "underline", "strikeThrough", "direction"].forEach(function (cmd) {
    const btn = document.querySelector<HTMLElement>('.writer-bar .wr-fmt[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("is-active", !!(model && (model as Record<string, unknown>)[cmd]));
  });
  const hi = document.querySelector<HTMLElement>('.writer-bar .wr-fmt[data-cmd="highlight"]');
  if (hi) hi.classList.toggle("is-active", !!(model && (model as Record<string, unknown>).highlight));
}

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

export function openWriter(keepMark?: number | null) {
  const selection = window.getSelection();
  const node = selection?.focusNode;
  const cell = (node?.nodeType === 3 ? node.parentElement : node as Element | null)?.closest?.('#rows .cell-editable[data-id]');
  const offset = cell && node ? domToPos(cell, node, selection?.focusOffset ?? 0) : null;
  const remembered = (editorSelection as WriterFeaturePorts["editing"]["selection"])().resolve();
  const rowId = cell?.getAttribute("data-id") ?? remembered?.rowId;
  const at = rowId ? caretAt(beatPos(rowId, offset ?? remembered?.head ?? 0)) : null;
  const el = (document.getElementById("writer") as HTMLElement);
  writerUndoMark = keepMark == null ? (undoMark as WriterFeaturePorts["undo"]["mark"])() : keepMark;
  reopenOnRedo = null;
  (sidePanels as WriterFeaturePorts["panels"])().open("comments-panel");
  if ((viewFlags as WriterFeaturePorts["view"])().findOpen()) (appActions as WriterFeaturePorts["actions"]).invoke("find", "button", "close");
  (document.getElementById("writer-title") as HTMLInputElement).value = ((currentDocument as WriterCurrentDocument)() as WriterDocument).title || "";
  applyWriterSize(readWriterSize(), false);
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
  if (flowWriter && at) flowWriter.place(at, true);
  else if (blank) flowWriter?.caret(blank.id, 0);
  else if (rows.length) flowWriter?.caret((rows[rows.length - 1] as WriterRow).id, "end");
  updateWriterFormatState();
}

function attachFlowWriter() {
  if (!flowMaker || flowWriter) return;
  const root = (document.getElementById("writer-doc") as HTMLElement);
  root.textContent = "";
  root.classList.add("is-flow");
  root.setAttribute("data-undo-owner", "document");
  root.setAttribute("spellcheck", "true");
  root.setAttribute("tabindex", "0");
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
  const wasStale = flowMaker?.splitReady() === false;
  const at = flow?.finish()?.head;
  detachFlowWriter();
  if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  el.inert = true;
  el.hidden = true;
  if (flow) flowMaker?.prepareSplit(at?.kind === "beat" ? at.rowId : undefined);
  (viewFlags as WriterFeaturePorts["view"])().setWriterOpen(false);
  (hideTagGhost as WriterFeaturePorts["dismissTagGhost"])();
  if (flow) {
    if (wasStale || !flowMaker?.splitReady()) return;
    if (at?.kind === "beat") {
      const cell = document.querySelector<HTMLElement>('#rows .cell-editable[data-id="' + cssAttr(at.rowId) + '"][data-field="audioText"]');
      if (cell) {
        cell.focus({ preventScroll: true });
        const point = posToDom(cell, at.offset);
        window.getSelection()?.setBaseAndExtent(point.node, point.offset, point.node, point.offset);
        rememberCellSelection((editorSelection as WriterFeaturePorts["editing"]["selection"])(), cell);
        cell.scrollIntoView({ block: "center" });
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
  if (!target.closest("#writer-doc.is-flow, .wr-flow-visual-text") && target.id !== "writer-title") return false;
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
  flowMaker = given.flow;
  currentDocument = given.document.current;
  editAllowed = given.edits.allowed;
  productionReaders = given.text.productionReaders;
  htmlToPlainText = given.text.htmlToPlainText;
  editorSelection = given.editing.selection;
  paintGuard = given.editing.paint;
  lastUndoEntry = given.undo.last;
  nextRedoEntry = given.undo.nextRedo;
  undoLifetime = given.undo.lifetime;
  undoMark = given.undo.mark;
  undoSerial = given.undo.serial;
  sidePanels = given.panels;
  preferences = given.preferences;
  viewFlags = given.view;
  showToast = given.notices.show;
  appActions = given.actions;
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
    onWriterFormat, updateWriterFormatState, readWriterSize, applyWriterSize,
    openWriter, closeWriter, writerUndoStep,
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
      writerUndoMark = 0;
      writerWordTotal = 0;
      reopenOnRedo = null;
      lastRefusalAt = 0;
      currentDocument = null;
      editAllowed = null;
      productionReaders = null;
      htmlToPlainText = null;
      editorSelection = null;
      paintGuard = null;
      lastUndoEntry = null;
      nextRedoEntry = null;
      undoLifetime = null;
      undoMark = null;
      undoSerial = null;
      sidePanels = null;
      preferences = null;
      viewFlags = null;
      showToast = null;
      appActions = null;
      hideTagGhost = null;
      scheduleIdleRefresh = null;
    }
  };
}
