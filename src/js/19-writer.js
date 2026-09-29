import { S } from "./_state.js";
import { writePref } from "./00p-prefs.js";
import { formatDuration, totalSeconds, wordCount } from "./01-scene-status.js";
import { renderRowGroups } from "./01b-hide-shot.js";
import { escapeHtml } from "./02-state.js";
import { gallerySize, rowSlots, setRowSlots } from "./02d-gallery.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { closeAllSidePanels } from "./03b-side-panels.js";
import {
  cssAttr,
  ensureTrailingCaretSpot,
  sanitizeHtml,
  storedHtmlFromDom
} from "./04-richtext.js";
import { cellLength, fromHtml, joinCells, projection, syncCommentAnchors, toHtml } from "./04c-doc-model.js";
import {
  cellFormatState,
  editableCellHtml,
  pad2,
  render,
  syncFieldFromDom,
  toggleCellDirection,
  toggleCellFormat
} from "./05-render.js";
import { splitRowFieldCore } from "./06-rows.js";
import { hideTagGhost, scheduleIdleRefresh } from "./07-production-tags.js";
import { closeFindBar, findOpen } from "./09-find-replace.js";
import { truncateForPreview } from "./11-import.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { breakUndoCoalescing } from "./12a-undo.js";
import { htmlToPlainText } from "./14-export.js";
import { mirrorFileChipToWriter } from "./18-local-files.js";

export var writerOpen = false;
var writerGutterMode = "visuals";
S.writerLastCell = null;

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
        placeholder: "Write what gets said…"
      }) +
    '</div>';
}

function writerCaretState() {
  var active = document.activeElement;
  if (!writerOpen || !active || !active.classList || !active.classList.contains("wr-para")) return null;
  var sel = window.getSelection();
  if (!sel.rangeCount) return null;
  var range = sel.getRangeAt(0);
  if (!active.contains(range.startContainer)) return null;
  var probe = document.createRange();
  probe.selectNodeContents(active);
  probe.setEnd(range.startContainer, range.startOffset);
  return { id: active.getAttribute("data-id"), offset: probe.toString().length };
}

export function renderWriter() {
  var doc = document.getElementById("writer-doc");
  var caret = writerCaretState();
  var titleEl = document.getElementById("writer-title");
  if (document.activeElement !== titleEl) titleEl.value = S.state.title || "";
  if (!S.state.rows.length) {
    doc.innerHTML = '<div class="writer-empty">Nothing to write into yet — close this and add a scene.</div>';
  } else {
    doc.innerHTML = renderRowGroups(S.state.rows, writerBlockHtml);
    doc.querySelectorAll(".wr-para").forEach(ensureTrailingCaretSpot);
  }
  S.writerLastCell = null;
  if (caret) focusWriterBlock(caret.id, caret.offset);
  updateWriterStats();
}

export function updateWriterStats() {
  if (!writerOpen || !S.state) return;
  var words = 0;
  S.state.rows.forEach(function (row) { words += wordCount(row.audioText); });
  document.getElementById("wr-scenes").textContent = String(S.state.rows.length);
  document.getElementById("wr-words").textContent = words.toLocaleString();
  document.getElementById("wr-runtime").textContent = formatDuration(totalSeconds());
}

export function scheduleWriterStats() {
  if (!writerOpen) return;
  scheduleIdleRefresh("writerStats");
}

export function caretTextOffset(el) {
  var sel = window.getSelection();
  if (!sel.rangeCount) return 0;
  var range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  var probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length;
}

export function placeCaretAtTextOffset(el, offset) {
  var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  var node, seen = 0, target = null, targetOffset = 0;
  while ((node = walker.nextNode())) {
    var len = node.nodeValue.length;
    if (seen + len >= offset) { target = node; targetOffset = offset - seen; break; }
    seen += len;
  }
  var range = document.createRange();
  var atomic = target && target.parentNode.closest && target.parentNode.closest(".tag-anchor");
  if (atomic) {
    if (targetOffset <= 0 && target === atomic.firstChild) {
      range.setStartBefore(atomic);
    } else {
      range.setStartAfter(atomic);
    }
  } else if (target) {
    range.setStart(target, Math.min(targetOffset, target.nodeValue.length));
  } else {
    range.selectNodeContents(el);
  }
  range.collapse(true);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
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
  S.writerLastCell = el;
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
  var res = splitRowFieldCore(cellEl);
  if (!res) return;
  markDirty();
  renderWriter();
  focusWriterBlock(res.created.id, 0);
}

function mergeWriterRows(intoIdx) {
  var prev = S.state.rows[intoIdx];
  var cur = S.state.rows[intoIdx + 1];
  if (!prev || !cur) return;
  var prevHasVisual = !!(htmlToPlainText(prev.visualText) || gallerySize(prev));
  var curHasVisual = !!(htmlToPlainText(cur.visualText) || gallerySize(cur));
  if (prevHasVisual && curHasVisual) {
    showToast("Both scenes have a visual — join them in the split view, so you can pick which one to keep.", "warn");
    return;
  }

  var prevEl = document.querySelector('#writer-doc .wr-para[data-id="' + cssAttr(prev.id) + '"]');
  var joinAt = prevEl ? prevEl.textContent.length : 0;

  breakUndoCoalescing();
  var a = prev.audioText || "", b = cur.audioText || "";
  if (/<img|video-embed-card/.test(a + b)) {
    prev.audioText = a + ((a && b && !/(<br\s*\/?>|\s)$/i.test(a)) ? " " : "") + b;
  } else {
    var ca = fromHtml(a), cb = fromHtml(b);
    var glue = cellLength(ca) && cellLength(cb) && !/\s$/.test(projection(ca)) ? " " : "";
    prev.audioText = toHtml(joinCells(ca, cb, glue));
  }
  if (curHasVisual) {
    prev.visualText = cur.visualText;
    setRowSlots(prev, rowSlots(cur));
  }
  var rank = { todo: 0, ready: 1, shot: 2 };
  if ((rank[cur.status] || 0) > (rank[prev.status] || 0)) prev.status = cur.status;
  stampRow(prev);
  S.state.rows.splice(intoIdx + 1, 1);
  syncCommentAnchors(S.state);
  markDirty();
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
  var idx = findRowIndex(cellEl.getAttribute("data-id"));
  if (idx === -1) return;

  if (e.key === "Backspace" && idx > 0 && caretAtEdge(cellEl, range, "start")) {
    e.preventDefault();
    e.stopPropagation();
    syncFieldFromDom(cellEl);
    mergeWriterRows(idx - 1);
  } else if (e.key === "Delete" && idx < S.state.rows.length - 1 && caretAtEdge(cellEl, range, "end")) {
    e.preventDefault();
    e.stopPropagation();
    syncFieldFromDom(cellEl);
    mergeWriterRows(idx);
  }
}

export function onWriterFormat(btn) {
  var cellEl = S.writerLastCell;
  if (!cellEl || !cellEl.isConnected) return;
  var cmd = btn.getAttribute("data-cmd");
  cellEl.focus();
  if (cmd === "direction") toggleCellDirection(cellEl);
  else toggleCellFormat(cellEl, cmd);
  updateWriterFormatState();
}

export function updateWriterFormatState() {
  var live = writerOpen && S.writerLastCell && S.writerLastCell.isConnected;
  var model = live ? cellFormatState(S.writerLastCell) : null;
  ["bold", "italic", "underline", "direction"].forEach(function (cmd) {
    var btn = document.querySelector('.writer-bar .wr-fmt[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("is-active", !!(model && model[cmd]));
  });
  var hi = document.querySelector('.writer-bar .wr-fmt[data-cmd="highlight"]');
  if (hi) hi.classList.toggle("is-active", !!(model && model.highlight));
}

var WRITER_GUTTER_MODES = ["visuals", "numbers", "compact"];
var WRITER_GUTTER_LABELS = { visuals: "Visuals", numbers: "Numbers", compact: "Compact" };

export var WRITER_SIZE_KEY = "splitpage-writer-size";
export var WRITER_SIZE_MIN = 16, WRITER_SIZE_MAX = 34;

export function readWriterSize() {
  var n;
  try { n = parseInt(localStorage.getItem(WRITER_SIZE_KEY), 10); } catch (e) { n = NaN; }
  if (!isFinite(n)) return null;
  return Math.min(WRITER_SIZE_MAX, Math.max(WRITER_SIZE_MIN, n));
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
  if (remember) writePref(WRITER_SIZE_KEY, String(n));
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

export function openWriter() {
  var el = document.getElementById("writer");
  closeAllSidePanels();
  if (findOpen) closeFindBar();
  document.getElementById("writer-title").value = S.state.title || "";
  mirrorFileChipToWriter();
  applyWriterSize(readWriterSize(), false);
  setWriterGutter(writerGutterMode);
  el.inert = false;
  el.hidden = false;
  writerOpen = true;
  renderWriter();
  document.getElementById("writer-scroll").scrollTop = 0;

  var blank = null;
  for (var i = 0; i < S.state.rows.length; i++) {
    if (!htmlToPlainText(S.state.rows[i].audioText)) { blank = S.state.rows[i]; break; }
  }
  if (blank) focusWriterBlock(blank.id, 0);
  else if (S.state.rows.length) focusWriterBlock(S.state.rows[S.state.rows.length - 1].id, "end");
  updateWriterFormatState();
}

export function closeWriter() {
  var el = document.getElementById("writer");
  if (el.hidden) return;
  var active = document.activeElement;
  if (active && active.classList && active.classList.contains("wr-para")) {
    var clean = sanitizeHtml(active.innerHTML);
    if (clean !== storedHtmlFromDom(active.innerHTML)) active.innerHTML = clean;
    syncFieldFromDom(active);
  }
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.inert = true;
  el.hidden = true;
  writerOpen = false;
  S.writerLastCell = null;
  hideTagGhost();
  render();
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

export function __init() {}
