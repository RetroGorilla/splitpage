import { formatDuration, pad2 } from "../core/production/timing.ts";
import { totalSeconds } from "./01-scene-status.js";
import { renderRowGroups } from "./01b-hide-shot.js";
import { rowIndexOf } from "../core/document/rows.ts";
import { sidePanels } from "../legacy/panels-bridge.ts";
import { ensureTrailingCaretSpot, sanitizeHtml, storedHtmlFromDom } from "./04-richtext.js";
import { cssAttr } from "../features/common/dom.ts";
import {
  cellFormatState,
  editableCellHtml,
  toggleCellDirection,
  toggleCellFormat
} from "./05-render.js";
import { splitRowFieldCore } from "./06-rows.js";
import { hideTagGhost, scheduleIdleRefresh } from "./07-production-tags.js";
import { closeFindBar } from "./09-find-replace.js";
import { breakUndoCoalescing, lastUndoEntry, nextRedoEntry, undoLifetime, undoMark, undoSerial } from "./12a-undo.js";
import { bothScenesHaveVisual, joinScenesCommand } from "../application/commands/split-join.ts";
import { WRITER_SIZE_MAX, WRITER_SIZE_MIN } from "../application/preferences/preferences.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { htmlToPlainText } from "../legacy/plain-text.ts";
import { VIEWING_ONLY } from "../application/collaboration/review.ts";
import { currentDocument, editAllowed, readSession, runCommand, sessionTextPorts } from "../legacy/session-bridge.ts";
import { cellEditing, editorSelection, focusMemory, paintGuard } from "../legacy/editor-bridge.ts";
import { preferences, viewFlags } from "../legacy/preferences-bridge.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { placeEditorSelection, rememberCellSelection } from "../features/editing/cell-selection.ts";
import { placeCaretAtTextOffset } from "../features/editing/caret.ts";
import { gallerySize } from "../core/document/gallery.ts";
import { escapeHtml, truncateForPreview } from "../core/document/text-policy.ts";

var writerGutterMode = "visuals";
var writerUndoMark = 0;
var reopenOnRedo = null;

function writerBlockHtml(row, i) {
  var visual;
  if (gallerySize(row)) {
    var caption = truncateForPreview(htmlToPlainText(row.visualText), 42);
    visual = '<span class="wr-visual-img">▣</span> ' + escapeHtml(caption || "reference image");
  } else {
    visual = escapeHtml(truncateForPreview(htmlToPlainText(row.visualText), 58));
  }
  var id = escapeHtml(row.id);
  return '<div class="wr-block" data-row="' + id + '">' +
      '<div class="wr-gutter" data-action="writer-jump" data-row="' + id +
        '" title="Open this scene in the split view">' +
        '<span class="wr-num">' + pad2(i + 1) + '</span>' +
        '<span class="wr-visual">' + visual + '</span>' +
      '</div>' +
      editableCellHtml({
        className: "wr-para",
        rowId: row.id,
        field: "audioText",
        value: row.audioText,
        placeholder: "Write what gets said…",
        readOnly: !editAllowed()
      }) +
    '</div>';
}

export function renderWriter() {
  paintGuard().whilePainting(function () { paintWriterDraw(drawWriter()); });
}

export function drawWriter() {
  var doc = currentDocument();
  return {
    title: doc.title || "",
    readOnly: !editAllowed(),
    html: doc.rows.length ? renderRowGroups(doc.rows, writerBlockHtml) : null
  };
}

export function paintWriterDraw(draw) {
  var doc = document.getElementById("writer-doc");
  var active = document.activeElement;
  var caret = viewFlags().writerOpen() && active && active.classList && active.classList.contains("wr-para") && doc.contains(active)
    ? rememberCellSelection(editorSelection(), active) : null;
  var titleEl = document.getElementById("writer-title");
  if (document.activeElement !== titleEl) titleEl.value = draw.title;
  titleEl.readOnly = draw.readOnly;
  if (draw.html === null) {
    doc.innerHTML = '<div class="writer-empty">Nothing to write into yet — close this and add a scene.</div>';
  } else {
    doc.innerHTML = draw.html;
    doc.querySelectorAll(".wr-para").forEach(ensureTrailingCaretSpot);
  }
  editorSelection().notePainted(doc);
  focusMemory().focusedParagraph(null);
  if (caret) {
    var placed = placeEditorSelection(editorSelection(), doc);
    if (placed) {
      focusMemory().focusedParagraph(placed);
      placed.scrollIntoView({ block: "nearest" });
    }
  }
  updateWriterStats();
}

export function updateWriterStats() {
  var doc = currentDocument();
  if (!viewFlags().writerOpen() || !doc) return;
  var words = 0;
  doc.rows.forEach(function (row) { words += productionReaders.wordCount(row.audioText); });
  document.getElementById("wr-scenes").textContent = String(doc.rows.length);
  document.getElementById("wr-words").textContent = words.toLocaleString();
  document.getElementById("wr-runtime").textContent = formatDuration(totalSeconds());
}

export function scheduleWriterStats() {
  if (!viewFlags().writerOpen()) return;
  scheduleIdleRefresh("writerStats");
}

function focusWriterBlock(rowId, offset) {
  var el = document.querySelector('#writer-doc .wr-para[data-id="' + cssAttr(rowId) + '"]');
  if (!el) return;
  el.focus();
  if (offset === "end") {
    var range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    placeCaretAtTextOffset(el, offset || 0);
  }
  focusMemory().focusedParagraph(el);
  el.scrollIntoView({ block: "nearest" });
}

function caretAtEdge(cellEl, range, edge) {
  var probe = document.createRange();
  probe.selectNodeContents(cellEl);
  if (edge === "start") probe.setEnd(range.startContainer, range.startOffset);
  else probe.setStart(range.endContainer, range.endOffset);
  var frag = probe.cloneContents();
  return !frag.textContent && !frag.querySelector("br, img");
}

function splitWriterRow(cellEl) {
  var res = paintGuard().whileShown(function () { return splitRowFieldCore(cellEl); });
  if (!res) return;
  renderWriter();
  focusWriterBlock(res.id, 0);
}

function mergeWriterRows(intoIdx) {
  var rows = currentDocument().rows;
  var prev = rows[intoIdx];
  var cur = rows[intoIdx + 1];
  if (!prev || !cur) return;
  if (readSession(bothScenesHaveVisual(prev.id, htmlToPlainText))) {
    showToast("Both scenes have a visual — join them in the split view, so you can pick which one to keep.", "warn");
    return;
  }

  var prevEl = document.querySelector('#writer-doc .wr-para[data-id="' + cssAttr(prev.id) + '"]');
  var joinAt = prevEl ? prevEl.textContent.length : 0;

  breakUndoCoalescing();
  var ports = Object.assign({}, sessionTextPorts, { plainText: htmlToPlainText });
  var outcome = paintGuard().whileShown(function () { return runCommand(joinScenesCommand(prev.id, ports)); });
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind !== "applied" && outcome.kind !== "committed") return;
  renderWriter();
  focusWriterBlock(prev.id, joinAt);
}

export function onWriterKeydown(e) {
  var cellEl = e.target.classList && e.target.classList.contains("wr-para") ? e.target : null;
  if (!cellEl) return;

  if (e.key === "Enter") {
    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    hideTagGhost();
    splitWriterRow(cellEl);
    return;
  }
  if (e.key !== "Backspace" && e.key !== "Delete") return;

  var sel = window.getSelection();
  if (!sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if (!range.collapsed || !cellEl.contains(range.startContainer)) return;
  var idx = readSession(function (doc) { return rowIndexOf(doc, cellEl.getAttribute("data-id")); });
  if (idx === -1) return;

  if (e.key === "Backspace" && idx > 0 && caretAtEdge(cellEl, range, "start")) {
    e.preventDefault();
    e.stopPropagation();
    cellEditing().sync(cellEl);
    mergeWriterRows(idx - 1);
  } else if (e.key === "Delete" && idx < currentDocument().rows.length - 1 && caretAtEdge(cellEl, range, "end")) {
    e.preventDefault();
    e.stopPropagation();
    cellEditing().sync(cellEl);
    mergeWriterRows(idx);
  }
}

export function onWriterFormat(btn) {
  var cellEl = focusMemory().writerParagraph();
  if (!cellEl || !cellEl.isConnected) return;
  var cmd = btn.getAttribute("data-cmd");
  cellEl.focus();
  if (cmd === "direction") toggleCellDirection(cellEl);
  else toggleCellFormat(cellEl, cmd);
  updateWriterFormatState();
}

export function updateWriterFormatState() {
  var paragraph = viewFlags().writerOpen() ? focusMemory().writerParagraph() : null;
  var live = paragraph && paragraph.isConnected;
  var model = live ? cellFormatState(paragraph) : null;
  ["bold", "italic", "underline", "direction"].forEach(function (cmd) {
    var btn = document.querySelector('.writer-bar .wr-fmt[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("is-active", !!(model && model[cmd]));
  });
  var hi = document.querySelector('.writer-bar .wr-fmt[data-cmd="highlight"]');
  if (hi) hi.classList.toggle("is-active", !!(model && model.highlight));
}

var WRITER_GUTTER_MODES = ["visuals", "numbers", "compact"];
var WRITER_GUTTER_LABELS = { visuals: "Visuals", numbers: "Numbers", compact: "Compact" };

export function readWriterSize() {
  return preferences().writerSize();
}

export function applyWriterSize(px, remember) {
  var el = document.getElementById("writer");
  if (px == null) {
    el.style.removeProperty("--wr-font");
    var actual = parseFloat(getComputedStyle(el).getPropertyValue("--wr-font"));
    if (isFinite(actual)) document.getElementById("wr-size").value = String(Math.round(actual));
    return;
  }
  var n = Math.min(WRITER_SIZE_MAX, Math.max(WRITER_SIZE_MIN, Math.round(px)));
  el.style.setProperty("--wr-font", n + "px");
  document.getElementById("wr-size").value = String(n);
  if (remember) preferences().setWriterSize(n);
}

function setWriterGutter(mode) {
  if (WRITER_GUTTER_MODES.indexOf(mode) === -1) mode = "visuals";
  writerGutterMode = mode;
  document.getElementById("writer").setAttribute("data-gutter", mode);
  var btn = document.getElementById("wr-gutter-mode");
  btn.textContent = WRITER_GUTTER_LABELS[mode];
  btn.classList.toggle("is-active", mode !== "compact");
}

export function cycleWriterGutter() {
  var i = WRITER_GUTTER_MODES.indexOf(writerGutterMode);
  setWriterGutter(WRITER_GUTTER_MODES[(i + 1) % WRITER_GUTTER_MODES.length]);
}

export function openWriter(keepMark) {
  var el = document.getElementById("writer");
  writerUndoMark = keepMark == null ? undoMark() : keepMark;
  reopenOnRedo = null;
  sidePanels().closeAll();
  if (viewFlags().findOpen()) closeFindBar();
  document.getElementById("writer-title").value = currentDocument().title || "";
  applyWriterSize(readWriterSize(), false);
  setWriterGutter(writerGutterMode);
  el.inert = false;
  el.hidden = false;
  viewFlags().setWriterOpen(true);
  renderWriter();
  document.getElementById("writer-scroll").scrollTop = 0;

  var rows = currentDocument().rows;
  var blank = null;
  for (var i = 0; i < rows.length; i++) {
    if (!htmlToPlainText(rows[i].audioText)) { blank = rows[i]; break; }
  }
  if (blank) focusWriterBlock(blank.id, 0);
  else if (rows.length) focusWriterBlock(rows[rows.length - 1].id, "end");
  updateWriterFormatState();
}

export function closeWriter() {
  var el = document.getElementById("writer");
  if (el.hidden) return;
  var active = document.activeElement;
  if (active && active.classList && active.classList.contains("wr-para")) {
    var clean = sanitizeHtml(active.innerHTML);
    if (clean !== storedHtmlFromDom(active.innerHTML)) active.innerHTML = clean;
    cellEditing().sync(active);
  }
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.inert = true;
  el.hidden = true;
  viewFlags().setWriterOpen(false);
  focusMemory().focusedParagraph(null);
  hideTagGhost();
}

export function writerUndoStep(dir) {
  if (viewFlags().writerOpen()) {
    if (dir === "redo") {
      var next = nextRedoEntry();
      return !next || next.n <= writerUndoMark;
    }
    var top = lastUndoEntry();
    if (top && top.n > writerUndoMark) return false;
    var mark = writerUndoMark;
    closeWriter();
    reopenOnRedo = { top: lastUndoEntry(), mark: mark, lifetime: undoLifetime(), serial: undoSerial() };
    return true;
  }
  var pending = reopenOnRedo;
  reopenOnRedo = null;
  if (!pending || dir !== "redo") return false;
  if (undoLifetime() !== pending.lifetime || lastUndoEntry() !== pending.top || undoSerial() !== pending.serial) return false;
  openWriter(pending.mark);
  return true;
}

export function jumpFromWriterToRow(rowId) {
  closeWriter();
  var target = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"]');
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("just-merged");
  void target.offsetWidth;
  target.classList.add("just-merged");
}

var REFUSAL_BURST_MS = 2000;
var EDIT_CHORDS = ["z", "y", "b", "i", "u"];
var GUARDED_EVENTS = ["keydown", "beforeinput", "input", "paste", "cut", "click"];
var lastRefusalAt = 0;

function refuseWriterEdit() {
  var now = Date.now();
  if (now - lastRefusalAt > REFUSAL_BURST_MS) showToast(VIEWING_ONLY, "warn");
  lastRefusalAt = now;
}

function isEditKey(e) {
  var name = String(e.key || "");
  var chord = e.ctrlKey || e.metaKey;
  if (name === "Enter" || name === "Backspace" || name === "Delete") return true;
  if (chord) return EDIT_CHORDS.indexOf(name.toLowerCase()) !== -1;
  if (e.altKey) return name === "ArrowUp" || name === "ArrowDown";
  return name.length === 1 && name !== " ";
}

function attemptsEdit(e) {
  var target = e.target;
  if (!target || !target.closest) return false;
  if (e.type === "click") return !!target.closest(".wr-fmt");
  if (!target.closest(".wr-para") && target.id !== "writer-title") return false;
  return e.type !== "keydown" || isEditKey(e);
}

function guardWriterEdit(e) {
  if (editAllowed() || !attemptsEdit(e)) return;
  e.preventDefault();
  e.stopPropagation();
  refuseWriterEdit();
  if (e.type === "input") {
    renderWriter();
    document.getElementById("writer-title").value = currentDocument().title || "";
  }
}

export function __init() {
  var root = document.getElementById("writer");
  GUARDED_EVENTS.forEach(function (type) { root.addEventListener(type, guardWriterEdit, true); });
}
