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

/* ================= the writer =================

   A word-processor view of the audio column: the whole narration as one
   continuous document, laid out for writing rather than for scanning
   against picture. The prompter reads this column; this writes it.

   The load-bearing decision is that it edits the SAME rows the split view
   does. Every paragraph here is a real .cell-editable carrying a row's
   own data-id/data-field, so the shared input handlers give it the tag
   shortcuts, the Tab completion, Ctrl+B, paste-as-plain-text and the
   sanitising pass for nothing, and write straight back into state. There
   is no parse step, no second copy of the document, and nothing to
   reconcile when it closes.

   One paragraph is one scene. That is what lets Enter mean something
   here: a new paragraph is a new scene, which is the beat a writer is
   reaching for anyway, and it keeps this view and the split view exactly
   in step in both directions. */

export var writerOpen = false;
var writerGutterMode = "visuals"; /* visuals | numbers | compact */
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
      /* The same cell builder as the split view's own field (05-render.js),
         bare: the writer has no per-paragraph toolbar. */
      editableCellHtml({
        className: "wr-para",
        rowId: row.id,
        field: "audioText",
        value: row.audioText,
        placeholder: "Write what gets said…"
      }) +
    '</div>';
}

/* Where the caret is, as (row, characters into that row) — the one form
   that survives the paragraphs being rebuilt underneath it. */
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
  /* render() reaches here too — a version restored, someone else's edits
     merging in from the server mid-sentence. Whoever called, the writing
     position has to come back afterwards, or the rebuild costs a word. */
  var caret = writerCaretState();
  /* The title can change underneath this too — a version restored, a
     rename merging in from the server. Same guard render() uses for
     #doc-title: never overwrite what someone is in the middle of typing.
     Without it the stale value sat there and the next keystroke in the
     field committed it back over the change that had just arrived. */
  var titleEl = document.getElementById("writer-title");
  if (document.activeElement !== titleEl) titleEl.value = S.state.title || "";
  if (!S.state.rows.length) {
    doc.innerHTML = '<div class="writer-empty">Nothing to write into yet — close this and add a scene.</div>';
  } else {
    doc.innerHTML = renderRowGroups(S.state.rows, writerBlockHtml);
    doc.querySelectorAll(".wr-para").forEach(ensureTrailingCaretSpot);
  }
  S.writerLastCell = null;
  /* a no-op if that scene is gone — the callers that know better (a split,
     a join) place the caret themselves right after this returns */
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

/* Same reasoning as scheduleProductionRefresh(): counting every word in
   the document is cheap once and wasteful once per keystroke — so it rides
   the same idle refresh (07-production-tags.js). */
export function scheduleWriterStats() {
  if (!writerOpen) return;
  scheduleIdleRefresh("writerStats");
}

/* ---- caret plumbing ---- */

/* The inverse of placeCaretAtTextOffset: how far the caret sits into
   `el`'s plain text right now. Same technique writerCaretState() uses for
   the writer's own paragraphs, generalised to any element — Alt+Up/
   Alt+Down (21-events.js) uses it in the split view too, where the row
   being moved keeps its id and field but render() only ever lands the
   caret at the end of the cell, not back at the exact offset it was at. */
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

/* Put the caret at a plain-text offset inside a block. Used after a merge
   so it lands exactly where the two scenes were joined, rather than at
   the top of the paragraph they became. */
export function placeCaretAtTextOffset(el, offset) {
  var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  var node, seen = 0, target = null, targetOffset = 0;
  while ((node = walker.nextNode())) {
    var len = node.nodeValue.length;
    if (seen + len >= offset) { target = node; targetOffset = offset - seen; break; }
    seen += len;
  }
  var range = document.createRange();
  /* a tag anchor is contenteditable="false" — the caret can never sit
     inside one, so an offset that lands there goes just past it instead */
  var atomic = target && target.parentNode.closest && target.parentNode.closest(".tag-anchor");
  if (atomic) {
    /* Which side matters. An offset landing *inside* the tag has to come
       out after it, but offset 0 of a scene that begins with a tag means
       the very start of the scene — putting the caret after the tag there
       sent the first thing typed into a freshly split scene to the wrong
       side of its own label. */
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

/* "Is the caret at the very start (or end) of this block?" — measured by
   cloning the content on that side rather than by comparing node offsets,
   because offset 0 of the *second* text node is not the start of the
   paragraph, and a <br> or a tag anchor sitting at the edge has to count
   as content. */
function caretAtEdge(cellEl, range, edge) {
  var probe = document.createRange();
  probe.selectNodeContents(cellEl);
  if (edge === "start") probe.setEnd(range.startContainer, range.startOffset);
  else probe.setStart(range.endContainer, range.endOffset);
  var frag = probe.cloneContents();
  /* NOT querySelector("*"): cloneContents() also emits a shallow, empty
     clone of every partially-contained ancestor, so a caret at the start
     of a bold word produced <strong></strong> and read as "there is
     content before me". Backspace then refused to join, and because each
     paragraph is its own editing host the browser's own Backspace cannot
     cross it either — the key did nothing at all, forever, on any scene
     whose narration begins with formatting. Only things that occupy space
     without text count. */
  return !frag.textContent && !frag.querySelector("br, img");
}

/* ---- splitting and joining scenes ---- */

/* Enter: everything from the caret to the end of the paragraph becomes a
   scene of its own, directly below. Its visual is left empty, which is
   the honest state for a beat of narration nobody has framed a shot for
   yet, and the caret follows the text it moved. The mechanics are shared
   with the split view's Alt+Enter — see splitRowFieldCore(). */
function splitWriterRow(cellEl) {
  var res = splitRowFieldCore(cellEl);
  if (!res) return;
  markDirty();
  renderWriter();
  focusWriterBlock(res.created.id, 0);
}

/* Backspace at the very start of a paragraph — and Delete at the very end
   — joins two scenes, the way they join in any word processor.

   The narration merges. The visual is the awkward half: it has nowhere to
   go when BOTH scenes have one, and silently throwing a shot description
   away is not something a single keystroke should ever do, so that is the
   one case this refuses and sends to the split view instead. */
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

  /* measured off the DOM, not off htmlToPlainText(), which trims */
  var prevEl = document.querySelector('#writer-doc .wr-para[data-id="' + cssAttr(prev.id) + '"]');
  var joinAt = prevEl ? prevEl.textContent.length : 0;

  /* whatever was typed before the key is its own undo entry; the join is
     one of its own */
  breakUndoCoalescing();
  var a = prev.audioText || "", b = cur.audioText || "";
  /* The caret lands *before* the joining space, so one more Backspace
     closes the two up tight — which is what someone who did not want a
     space there is about to press anyway. */
  if (/<img|video-embed-card/.test(a + b)) {
    /* a paragraph still holding a picture (pasted before design D7) is not
       one the model can hold, so its HTML is joined as it always was */
    prev.audioText = a + ((a && b && !/(<br\s*\/?>|\s)$/i.test(a)) ? " " : "") + b;
  } else {
    /* Through the model (#85): the marks go with their words, and a comment
       whose phrase a split cut in two is one anchor again (joinCells). */
    var ca = fromHtml(a), cb = fromHtml(b);
    var glue = cellLength(ca) && cellLength(cb) && !/\s$/.test(projection(ca)) ? " " : "";
    prev.audioText = toHtml(joinCells(ca, cb, glue));
  }
  if (curHasVisual) {
    prev.visualText = cur.visualText;
    /* its whole gallery comes with it (#135) */
    setRowSlots(prev, rowSlots(cur));
  }
  /* Same rule mergeStates() uses for two people editing at once: status is
     not a value to pick between, it is progress to accumulate. Joining a
     To-do scene onto a Shot one — or the other way round — must never
     un-shoot footage somebody has already filmed. Without this the shot
     description was carried up and the green dot quietly left behind. */
  var rank = { todo: 0, ready: 1, shot: 2 };
  if ((rank[cur.status] || 0) > (rank[prev.status] || 0)) prev.status = cur.status;
  stampRow(prev);
  S.state.rows.splice(intoIdx + 1, 1);
  /* the row the comments' words came from is gone: they point where their
     marks are now, in the same undo entry */
  syncCommentAnchors(S.state);
  markDirty();
  renderWriter();
  focusWriterBlock(prev.id, joinAt);
}

/* Runs in the CAPTURE phase on #writer-doc, ahead of the shared
   onRootKeydown bound to the same element — Enter means "new scene" here
   and "<br>" there, and only the capture listener can get in first and
   stop the other from also acting on the same keystroke. */
export function onWriterKeydown(e) {
  var cellEl = e.target.classList && e.target.classList.contains("wr-para") ? e.target : null;
  if (!cellEl) return;

  /* Every Enter is decided here. Plain Shift+Enter is the one that falls
     through, to onRootKeydown's line break. Anything else splits —
     including Ctrl+Enter, which means "next scene" everywhere else in the
     app and would otherwise reach onRootKeydown's addRowAndFocus(), which
     looks up #rows and drops focus into a cell behind this overlay. */
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

/* ---- the bar ---- */

/* The formatting buttons act on whichever paragraph was last focused.
   mousedown is where the default has to be prevented — by the time click
   fires, the selection they were meant to format is already gone. */
export function onWriterFormat(btn) {
  var cellEl = S.writerLastCell;
  if (!cellEl || !cellEl.isConnected) return;
  var cmd = btn.getAttribute("data-cmd");
  cellEl.focus();
  /* A paragraph is a row field, so the format is an edit of its model like
     the split view's (toggleCellFormat, 05-render.js). */
  toggleCellFormat(cellEl, cmd);
  updateWriterFormatState();
}

export function updateWriterFormatState() {
  var live = writerOpen && S.writerLastCell && S.writerLastCell.isConnected;
  /* the model's answer (cellFormatState) */
  var model = live ? cellFormatState(S.writerLastCell) : null;
  ["bold", "italic", "underline"].forEach(function (cmd) {
    var btn = document.querySelector('.writer-bar .wr-fmt[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("is-active", !!(model && model[cmd]));
  });
  var hi = document.querySelector('.writer-bar .wr-fmt[data-cmd="highlight"]');
  if (hi) hi.classList.toggle("is-active", !!(model && model.highlight));
}

/* The button shows the mode it is currently in and cycles on click — the
   same idiom as the scene status dot, rather than three buttons' worth of
   bar for a setting most people set once. Lit while the margin is showing
   something, so "nothing there" reads as off at a glance and the label
   says which of the two showing states it is. */
var WRITER_GUTTER_MODES = ["visuals", "numbers", "compact"];
var WRITER_GUTTER_LABELS = { visuals: "Visuals", numbers: "Numbers", compact: "Compact" };

/* How big you like your text is about you, not about the script — so it
   lives beside the author name and the dismissed tagging help, not in the
   document, where it would follow the file to whoever opened it next. */
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
  /* No stored size means no inline value at all, so the stylesheet's own
     --wr-font stands — which is how the phone gets a smaller default
     without overriding a size somebody actually chose. */
  if (px == null) {
    el.style.removeProperty("--wr-font");
    /* leave the slider showing what is actually rendering rather than its
       markup default, which is a different number on a phone */
    var actual = parseFloat(getComputedStyle(el).getPropertyValue("--wr-font"));
    if (isFinite(actual)) document.getElementById("wr-size").value = String(Math.round(actual));
    return;
  }
  var n = Math.min(WRITER_SIZE_MAX, Math.max(WRITER_SIZE_MIN, Math.round(px)));
  el.style.setProperty("--wr-font", n + "px");
  document.getElementById("wr-size").value = String(n);
  /* stored and announced, so Settings (#181) follows the writer's slider */
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

/* ---- opening and closing ---- */

export function openWriter() {
  var el = document.getElementById("writer");
  /* The writer is a mode, not a layer. A side panel left open underneath
     it is either covered or showing through the edge, and on a phone it
     is the whole screen — so they close, the same way they would if you
     had navigated somewhere else (invariant #16). */
  closeAllSidePanels();
  if (findOpen) closeFindBar();
  document.getElementById("writer-title").value = S.state.title || "";
  mirrorFileChipToWriter();
  applyWriterSize(readWriterSize(), false);
  setWriterGutter(writerGutterMode); /* whatever it was left on last time */
  /* It fades in over the split view (#136, app.css "Present and the Writer
     arriving and leaving") — pixels only. The paragraphs, the scroll and
     the caret below are all in place in this call, while it is still
     nearly clear, so typing straight away lands where it always did. An
     opacity fade moves nothing, so the caret's scrollIntoView measures the
     page it will settle on. The side panels closed just above slide out
     beneath it, starting in the same frame. */
  el.inert = false;
  el.hidden = false;
  writerOpen = true;
  renderWriter();
  document.getElementById("writer-scroll").scrollTop = 0;

  /* Land in the first scene with nothing said in it yet — that is where
     someone who opened this to write is heading. Failing that, the end of
     the last one, to carry on from where the narration stops. */
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
  /* The paragraph still under the caret has not been through focusout, so
     its last few keystrokes are in the DOM and not yet in state. Commit
     them before the split view re-reads state and paints over them. */
  var active = document.activeElement;
  if (active && active.classList && active.classList.contains("wr-para")) {
    var clean = sanitizeHtml(active.innerHTML);
    if (clean !== storedHtmlFromDom(active.innerHTML)) active.innerHTML = clean;
    syncFieldFromDom(active);
  }
  /* Only now does anything about leaving happen (#136). The writer fades
     out over the split view instead of vanishing, so it is still on screen
     for a moment — and a focused paragraph in it would go on taking
     keystrokes nobody could see, after the save above. So the focus leaves
     it first (the focusout a real click on Close gives it anyway), and
     inert keeps the fading layer out of reach: a click during the fade
     lands on the split view, which render() below has already painted. */
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.inert = true;
  el.hidden = true;
  writerOpen = false;
  S.writerLastCell = null;
  hideTagGhost();
  render();
}

/* The split view is painted by the time closeWriter() returns, so the
   scroll and the flash start at once and the writer fades out over the
   scene they settle on (#136) — with the fade off or unsupported, it is
   simply gone and they land the same. */
export function jumpFromWriterToRow(rowId) {
  closeWriter();
  var target = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"]');
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("just-merged");
  void target.offsetWidth;
  target.classList.add("just-merged");
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
