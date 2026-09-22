import { S } from "./_state.js";
import { HIGHLIGHT_COLOR } from "./00-prelude.js";
import {
  ROW_STATUSES,
  formatDuration,
  rowSeconds,
  rowStatus,
  updateScriptStats
} from "./01-scene-status.js";
import { hiddenShotStripHtml, rowGroupItems } from "./01b-hide-shot.js";
import { escapeHtml, makeId } from "./02-state.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { buildVideoCardEl, cssAttr, ensureTrailingCaretSpot } from "./04-richtext.js";
import { rowMotionKey, withRowMotion } from "./04a-row-motion.js";
import {
  healTagRegistry,
  openTagComposer,
  productionIndexStats,
  resetProductionIndexStats,
  scheduleUntaggedScan,
  tagFieldOccurrences,
  updateTagBadges
} from "./07-production-tags.js";
import { renderProduction } from "./08-production-panels.js";
import { scheduleBrollRefresh } from "./08c-broll.js";
import {
  captureReplyDrafts,
  deleteCommentArmTimer,
  formatTimestamp,
  openCommentComposer,
  renderComments,
  syncAnchorResolvedClasses,
  updateCommentsCount
} from "./10-comments.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { reviewMode } from "./13-hosted.js";
import { paintPresence } from "./13a-presence.js";
import { renderWriter, writerOpen } from "./19-writer.js";

/* ================= rendering =================

   #rows is reconciled, not rebuilt (#84). Every row is keyed by its id
   (a collapsed run of shot scenes by the ids it covers — 01b-hide-shot.js),
   and a row's markup is built from five parts: its class, its gutter, its
   visual media, and its two fields. The strings rowParts() builds ARE the
   change detection: each row element carries the parts it was last painted
   from (ROW_SIG), and a part whose freshly built string is the same string
   is left alone, DOM node and all. So:

   - render() walks the document, reuses the element of every row still in
     it, repaints only the parts whose markup would differ, creates rows
     that are new, drops rows that are gone, and moves what moved — keeping
     the row that holds the caret where it is while the rest move around it.
   - renderRow(rowId) is the same repaint for one row: a status change, a
     stamp. It is what invariant #7 ("repaint a row, don't re-render the
     document") asks for, and it is now the easy path rather than a
     hand-kept mirror of rowHtml().
   - Typing writes the field it came from back into the row's signature
     (syncFieldFromDom → noteFieldPainted): the DOM already says what state
     now says, so the next render has nothing to do there, and the caret in
     it survives a structural change anywhere else in the document. */

export function pad2(n) { return n < 10 ? "0" + n : "" + n; }

/* ---- the one builder for an editable cell ----

   A script field in #rows, a writer paragraph (19-writer.js) and a reply box
   (10-comments.js) are the same thing: a .cell-editable, and — for the two
   that carry a toolbar — the .field-wrap around it with its mini toolbar and
   link popover. They share the input handlers (HANDOFF §3.5), so they share
   the markup too. */

var LINK_POPOVER_HTML =
  '<div class="link-popover" hidden>' +
    '<input type="url" placeholder="https://example.com" data-role="link-input">' +
    '<button type="button" data-action="link-confirm">Add</button>' +
    '<button type="button" data-action="link-cancel">Cancel</button>' +
  '</div>';

var COMMENT_BUTTON_HTML = '<button type="button" data-cmd="comment" title="Comment on selected text">💬 Comment</button>';

var CELL_TOOLBARS = {
  script: {
    label: "Text formatting",
    buttons:
      '<button type="button" data-cmd="bold" title="Bold (Ctrl+B)">B</button>' +
      '<button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
      '<button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
      '<button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>' +
      '<span class="tb-sep"></span>' +
      '<button type="button" data-cmd="highlight" title="Highlight"><span class="hl-dot"></span>HL</button>' +
      '<button type="button" data-cmd="link" title="Add link">Link</button>' +
      '<span class="tb-sep"></span>' +
      COMMENT_BUTTON_HTML +
      '<button type="button" data-cmd="tag" title="Label as a prop, location, cast member or effect">🏷 Tag</button>'
  },
  /* A review session (13-hosted.js) gets the same field with the writing
     taken out of it: a toolbar holding only the one thing it may still do. */
  review: { label: "Text formatting", buttons: COMMENT_BUTTON_HTML },
  reply: {
    label: "Reply formatting",
    buttons:
      '<button type="button" data-cmd="bold" title="Bold">B</button>' +
      '<button type="button" data-cmd="italic" title="Italic"><i>I</i></button>' +
      '<button type="button" data-cmd="underline" title="Underline"><u>U</u></button>' +
      '<button type="button" data-cmd="link" title="Add link">Link</button>'
  }
};

/* `o`: value (trusted, already-sanitised HTML), placeholder, rowId + field
   (a script cell's data-id/data-field; omitted for a reply box), className
   (extra classes ahead of cell-editable), readOnly (a review session:
   `tabindex` replaces what contenteditable was giving the cell — something
   to focus, so :focus-within still reveals the toolbar when the reader
   selects the words to comment on), toolbar ("script" | "review" | "reply";
   omitted for a bare cell, as the writer's paragraphs are), wrapStyle. */
export function editableCellHtml(o) {
  var cell =
    '<div class="' + (o.className ? o.className + ' ' : '') + 'cell-editable" contenteditable="' +
      (o.readOnly ? 'false" tabindex="0' : 'true') + '"' +
      (o.rowId != null ? ' data-id="' + escapeHtml(o.rowId) + '" data-field="' + escapeHtml(o.field) + '"' : '') +
      ' data-placeholder="' + escapeHtml(o.placeholder || "") + '">' + (o.value || "") +
    '</div>';
  var toolbar = o.toolbar ? CELL_TOOLBARS[o.toolbar] : null;
  if (!toolbar) return cell;
  return (
    '<div class="field-wrap"' + (o.wrapStyle ? ' style="' + o.wrapStyle + '"' : '') + '>' +
      '<div class="mini-toolbar" role="toolbar" aria-label="' + toolbar.label + '">' + toolbar.buttons + '</div>' +
      cell +
      LINK_POPOVER_HTML +
    '</div>'
  );
}

/* ---- a row, as parts ---- */

var FIELD_PLACEHOLDERS = {
  visualText: "Describe what is on screen…",
  audioText: "Write what gets said…"
};

function rowFieldHtml(row, field, review) {
  return editableCellHtml({
    rowId: row.id,
    field: field,
    value: row[field],
    placeholder: FIELD_PLACEHOLDERS[field],
    readOnly: review,
    toolbar: review ? "review" : "script"
  });
}

/* Reordering, status, insert/delete and the image controls are all
   document writes the server would refuse from a review session — so
   they are not rendered at all rather than rendered and then refused.
   The scene number, its duration and its status colour still show: this
   is a reader's view of the script, not a stripped-down one. */
function rowGutterHtml(row, index, review) {
  var st = rowStatus(row.status) || ROW_STATUSES[0];
  var secs = rowSeconds(row);
  return (
    '<div class="gutter">' +
      (review
        ? '<div class="row-head"><span class="row-num">' + pad2(index + 1) + '</span></div>'
        : '<div class="row-head" data-action="drag-grip" data-id="' + row.id +
            '" title="Drag to reorder — or use the arrows below">' +
            '<span class="drag-grip" aria-hidden="true"></span>' +
            '<span class="row-num">' + pad2(index + 1) + '</span>' +
          '</div>') +
      (secs >= 0.5 ? '<div class="row-dur" title="Estimated read time">' + formatDuration(secs) + '</div>' : '') +
      (review
        ? '<span class="status-btn is-static" title="' + escapeHtml(st.label) +
            '" aria-label="Scene status: ' + escapeHtml(st.label) + '">' +
            '<span class="status-dot ' + st.cls + '" style="--st:' + st.color + '"></span>' +
          '</span>'
        : '<button class="status-btn" type="button" data-action="cycle-status" data-id="' + row.id +
            '" title="' + escapeHtml(st.label) + ' — click to change" aria-label="Scene status: ' + escapeHtml(st.label) + '">' +
            '<span class="status-dot ' + st.cls + '" style="--st:' + st.color + '"></span>' +
          '</button>' +
          '<button class="gutter-btn" type="button" data-action="move-up" data-id="' + row.id + '" title="Move up" aria-label="Move row up">↑</button>' +
          '<button class="gutter-btn" type="button" data-action="move-down" data-id="' + row.id + '" title="Move down" aria-label="Move row down">↓</button>' +
          '<button class="gutter-btn" type="button" data-action="insert-below" data-id="' + row.id + '" title="Insert row below" aria-label="Insert row below">+</button>' +
          '<button class="gutter-btn danger" type="button" data-action="delete-row" data-id="' + row.id + '" title="Delete row" aria-label="Delete row">×</button>') +
      (row.updatedBy
        ? '<div class="row-meta" title="Last edited by ' + escapeHtml(row.updatedBy) + '">' +
            escapeHtml(String(row.updatedBy).split(/\s+/)[0]) + '<br>' + formatTimestamp(row.updatedAt) + '</div>'
        : '') +
    '</div>'
  );
}

function rowMediaHtml(row, review) {
  var imageBlock;
  if (row.visualImage) {
    imageBlock =
      '<div class="image-thumb-wrap">' +
        '<img src="' + escapeHtml(row.visualImage) + '" alt="">' +
        (review ? '' :
          '<div class="image-thumb-actions">' +
            '<button type="button" data-action="image-replace" data-id="' + row.id + '">Replace</button>' +
            '<button type="button" data-action="image-remove" data-id="' + row.id + '">Remove</button>' +
          '</div>') +
      '</div>';
  } else if (review) {
    imageBlock = "";
  } else {
    imageBlock =
      '<button type="button" class="image-clip" data-action="image-add" data-id="' + row.id +
        '" title="Attach a reference image — or drag one anywhere onto this scene’s visual column">' +
        '<span class="clip-icon" aria-hidden="true">📎</span>Image</button>';
  }
  return '<div class="visual-media' + (row.visualImage ? '' : ' is-empty') + '" data-id="' +
    row.id + '">' + imageBlock + '</div>';
}

/* Everything a row's markup is made of. Each value is the exact string
   that part renders as, and that string is also its render signature. */
function rowParts(row, index) {
  var review = reviewMode();
  return {
    cls: "row" + (row.status === "shot" ? " is-shot" : ""),
    gutter: rowGutterHtml(row, index, review),
    media: rowMediaHtml(row, review),
    visualText: rowFieldHtml(row, "visualText", review),
    audioText: rowFieldHtml(row, "audioText", review)
  };
}

function rowHtmlFromParts(row, p) {
  return (
    '<div class="' + p.cls + '" data-id="' + row.id + '">' +
      p.gutter +
      '<div class="cell visual-cell">' + p.media + p.visualText + '</div>' +
      '<div class="cell audio-cell">' + p.audioText + '</div>' +
    '</div>'
  );
}

/* The parts a row element was last painted from. An expando rather than an
   attribute, so it never shows up in the row's own markup. */
var ROW_SIG = "__splitpageRowSig";
var PATCHED_PARTS = ["gutter", "media", "visualText", "audioText"];

function childWithClass(el, cls) {
  if (!el) return null;
  for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.classList.contains(cls)) return c;
  }
  return null;
}

function rowPartEl(rowEl, part) {
  if (part === "gutter") return childWithClass(rowEl, "gutter");
  if (part === "media") return childWithClass(childWithClass(rowEl, "visual-cell"), "visual-media");
  if (part === "visualText") return childWithClass(childWithClass(rowEl, "visual-cell"), "field-wrap");
  return childWithClass(childWithClass(rowEl, "audio-cell"), "field-wrap");
}

var partTemplate = null;
function nodeFromHtml(html) {
  if (!partTemplate) partTemplate = document.createElement("template");
  partTemplate.innerHTML = html;
  return partTemplate.content.firstElementChild;
}

function newRowEl(row, index) {
  var p = rowParts(row, index);
  var el = nodeFromHtml(rowHtmlFromParts(row, p));
  el[ROW_SIG] = p;
  el.querySelectorAll(".cell-editable").forEach(ensureTrailingCaretSpot);
  cellsPainted += 2;
  return el;
}

/* What a full rebuild used to reset for free on a row it did not otherwise
   change: the row's own class and attributes (a drag's `draggable` and
   `is-dragging`, a drop marker) and its two column wrappers' classes (an
   image drag's `drag-over`). Only written when they differ. */
function resetRowShell(rowEl, cls) {
  if (rowEl.className !== cls) rowEl.className = cls;
  for (var i = rowEl.attributes.length - 1; i >= 0; i--) {
    var name = rowEl.attributes[i].name;
    if (name !== "class" && name !== "data-id") rowEl.removeAttribute(name);
  }
  var vc = childWithClass(rowEl, "visual-cell");
  if (vc && vc.className !== "cell visual-cell") vc.className = "cell visual-cell";
  var ac = childWithClass(rowEl, "audio-cell");
  if (ac && ac.className !== "cell audio-cell") ac.className = "cell audio-cell";
}

/* Repaint the parts of one row element whose markup changed. Returns
   whether anything was replaced, or null when the element cannot be
   patched at all (its parts are not where rowHtml puts them) and has to be
   built again. A control that had focus in a replaced gutter or media part
   — the status button just clicked — gets it back on its replacement. */
function paintRow(rowEl, row, index) {
  var sig = rowEl[ROW_SIG];
  if (!sig) return null;
  var p = rowParts(row, index);
  var parts = [];
  for (var i = 0; i < PATCHED_PARTS.length; i++) {
    var k = PATCHED_PARTS[i];
    if (sig[k] === p[k]) continue;
    var old = rowPartEl(rowEl, k);
    if (!old) return null;
    parts.push({ key: k, el: old });
  }
  resetRowShell(rowEl, p.cls);
  parts.forEach(function (part) {
    var active = document.activeElement;
    var action = active && active !== part.el && part.el.contains(active) &&
      active.getAttribute && active.getAttribute("data-action");
    var fresh = nodeFromHtml(p[part.key]);
    part.el.parentNode.replaceChild(fresh, part.el);
    if (part.key === "visualText" || part.key === "audioText") {
      ensureTrailingCaretSpot(fresh.querySelector(".cell-editable"));
      cellsPainted++;
    } else if (action) {
      var again = fresh.querySelector('[data-action="' + cssAttr(action) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  });
  rowEl[ROW_SIG] = p;
  if (parts.length) rowsPainted++;
  return parts.length > 0;
}

/* The single-row primitive. Repaints `rowId` in place from state — only the
   parts that changed — and says whether it could: false when the row is
   not on screen (folded into a shot strip, or gone), in which case the
   caller renders the document instead. Focus-safe: a field whose text did
   not change is never touched, so a caret mid-sentence survives. */
export function renderRow(rowId) {
  if (!S.state) return false;
  var idx = findRowIndex(rowId);
  var rowsEl = document.getElementById("rows");
  if (idx === -1 || !rowsEl) return false;
  var rowEl = rowsEl.querySelector(':scope > .row[data-id="' + cssAttr(rowId) + '"]');
  if (!rowEl) return false;
  var touched = paintRow(rowEl, S.state.rows[idx], idx);
  if (touched === null) {
    rowsEl.replaceChild(newRowEl(S.state.rows[idx], idx), rowEl);
    rowsPainted++;
    touched = true;
  }
  /* The presence marks (13a-presence.js) live in the gutter and the
     field-wrap — a replaced part took its mark with it. */
  if (touched) paintPresence();
  return true;
}

/* Typing has just made state match what this cell already shows, so the
   row's signature for that field is brought up to date with it — the next
   render then leaves the field, and the caret in it, alone. Only a cell in
   #rows counts: a writer paragraph edits the same row while the #rows copy
   of it stays behind, and that one must still be repainted. */
function noteFieldPainted(cellEl, field, row) {
  var rowEl = cellEl.closest(".row");
  if (!rowEl || !rowEl[ROW_SIG] || !rowEl.parentNode || rowEl.parentNode.id !== "rows") return;
  if (rowEl.getAttribute("data-id") !== row.id) return;
  rowEl[ROW_SIG][field] = rowFieldHtml(row, field, reviewMode());
}

/* ---- keyed reconcile ---- */

/* The longest run of `positions[from..to)` that is already in increasing
   order, restricted to values strictly between lo and hi — marked in
   `keep`. Those nodes stay where they are; everything else is moved around
   them. -1 (a node that is new) never takes part. */
function markLongestIncreasing(positions, from, to, lo, hi, keep) {
  var tails = [], tailAt = [], prev = {};
  for (var i = from; i < to; i++) {
    var p = positions[i];
    if (p < 0 || p <= lo || p >= hi) continue;
    var a = 0, b = tails.length;
    while (a < b) {
      var m = (a + b) >> 1;
      if (tails[m] < p) a = m + 1; else b = m;
    }
    prev[i] = a > 0 ? tailAt[a - 1] : -1;
    tails[a] = p;
    tailAt[a] = i;
  }
  var k = tails.length ? tailAt[tails.length - 1] : -1;
  while (k !== -1) { keep[k] = true; k = prev[k]; }
}

var EMPTY_ROWS_HTML =
  '<div class="empty-state">' +
    '<div>No rows yet. Each row pairs what is on screen with what gets said.</div>' +
    '<button class="btn btn-accent" type="button" data-action="add-row">+ Add your first row</button>' +
  '</div>';

/* Make #rows hold exactly rowGroupItems(state.rows), in order, reusing
   every element whose key is still wanted. `pinned` is the row holding
   focus: it is never moved (a moved node loses focus in the browser), so
   the order is fixed up by moving the others around it. */
function reconcileRows(rowsEl, pinned) {
  if (!S.state.rows.length) {
    rowsEl.innerHTML = EMPTY_ROWS_HTML;
    return;
  }
  var items = rowGroupItems(S.state.rows);
  var existing = new Map();
  Array.prototype.slice.call(rowsEl.children).forEach(function (el) {
    var key = rowMotionKey(el);
    var reusable = key && !existing.has(key) && (key.indexOf("strip:") === 0 || el[ROW_SIG]);
    if (reusable) existing.set(key, el);
    else rowsEl.removeChild(el);
  });

  var nodes = items.map(function (item) {
    var key = item.strip ? "strip:" + item.strip.join(",") : "row:" + item.row.id;
    var el = existing.get(key);
    if (el) {
      existing.delete(key);
      /* A strip's markup is a function of its key alone. */
      if (item.strip || paintRow(el, item.row, item.index) !== null) return el;
      rowsEl.removeChild(el);
    }
    if (item.strip) return nodeFromHtml(hiddenShotStripHtml(item.strip));
    rowsPainted++;
    return newRowEl(item.row, item.index);
  });
  existing.forEach(function (el) { rowsEl.removeChild(el); });

  var at = new Map();
  for (var c = 0; c < rowsEl.children.length; c++) at.set(rowsEl.children[c], c);
  var positions = nodes.map(function (n) { return at.has(n) ? at.get(n) : -1; });
  var keep = [];
  var pin = pinned ? nodes.indexOf(pinned) : -1;
  if (pin !== -1 && positions[pin] >= 0) {
    markLongestIncreasing(positions, 0, pin, -1, positions[pin], keep);
    keep[pin] = true;
    markLongestIncreasing(positions, pin + 1, nodes.length, positions[pin], Infinity, keep);
  } else {
    markLongestIncreasing(positions, 0, nodes.length, -1, Infinity, keep);
  }
  var next = null;
  for (var i = nodes.length - 1; i >= 0; i--) {
    if (!keep[i]) rowsEl.insertBefore(nodes[i], next);
    next = nodes[i];
  }

  /* Belt and braces: the order is what the document says, whatever the
     arithmetic above got wrong. */
  var inOrder = rowsEl.children.length === nodes.length;
  for (var j = 0; inOrder && j < nodes.length; j++) inOrder = rowsEl.children[j] === nodes[j];
  if (!inOrder) nodes.forEach(function (n) { rowsEl.appendChild(n); });

  /* A reused field keeps whatever the user did to it — including deleting
     the zero-width caret spot after a trailing tag. A rebuild used to put
     it back on every render; this does, for every field, and it is a no-op
     (one lastChild check) wherever the spot is already there — including
     the fields just built, which had theirs added as they were made. */
  rowsEl.querySelectorAll(".cell-editable").forEach(ensureTrailingCaretSpot);
}

/* Where focus is before a render: the cell (anywhere — a writer paragraph
   counts, see restoreRenderFocus), the #rows row it sits in, and the exact
   selection inside it as plain node/offset values, which survive the row
   being moved where a live Range would not. */
function captureRenderFocus(rowsEl) {
  var active = document.activeElement;
  if (!active || !active.classList) return null;
  var out = { cell: null, id: null, field: null, rowEl: null, sel: null };
  if (active.classList.contains("cell-editable")) {
    out.cell = active;
    out.id = active.getAttribute("data-id");
    out.field = active.getAttribute("data-field");
  }
  if (rowsEl && rowsEl.contains(active)) {
    var rowEl = active.closest(".row");
    if (rowEl && rowEl.parentNode === rowsEl) out.rowEl = rowEl;
    var sel = window.getSelection();
    if (out.cell && sel && sel.rangeCount) {
      var r = sel.getRangeAt(0);
      if (active.contains(r.startContainer) && active.contains(r.endContainer)) {
        out.sel = { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset };
      }
    }
  }
  return (out.cell || out.rowEl) ? out : null;
}

function restoreRenderFocus(rowsEl, f) {
  if (!f || !f.cell) return;
  /* The #84 win: the cell was reused, so its content and caret are the
     user's own, exactly as they were. Nothing to do unless something took
     focus off it — then it gets it back, with the same selection. */
  if (f.rowEl && rowsEl.contains(f.cell)) {
    if (document.activeElement === f.cell) return;
    f.cell.focus({ preventScroll: true });
    if (f.sel && f.cell.contains(f.sel.sc) && f.cell.contains(f.sel.ec)) {
      try {
        var keepRange = document.createRange();
        keepRange.setStart(f.sel.sc, f.sel.so);
        keepRange.setEnd(f.sel.ec, f.sel.eo);
        var keepSel = window.getSelection();
        keepSel.removeAllRanges();
        keepSel.addRange(keepRange);
      } catch (e) {}
    }
    return;
  }
  /* The cell was rebuilt — its text changed under it (a merge landing, a
     tag applied) — or focus was never in #rows at all. render() can be
     reached from an async network completion while the user is mid-typing,
     so whichever cell had focus gets it back rather than leaving typing to
     land on <body>; the text under it is new, so the caret goes to the end
     of it, the safest default. */
  var cellEl = rowsEl.querySelector(
    '.cell-editable[data-id="' + cssAttr(f.id) + '"][data-field="' + cssAttr(f.field) + '"]');
  if (cellEl) {
    cellEl.focus();
    try {
      var range = document.createRange();
      range.selectNodeContents(cellEl);
      range.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }
}

/* Anything that points at DOM this render is about to destroy must be reset,
   or a later click acts on a stale target: an armed delete would fire without
   ever showing its confirm. A saved Range survives only as long as its cell
   does — see the end of render(). */
function resetTransientUiState() {
  clearTimeout(S.deleteArmTimer);
  S.deleteArmId = null;
  document.querySelectorAll("#rows .gutter-btn.danger.armed").forEach(function (b) {
    b.classList.remove("armed");
    b.textContent = "×";
  });
  clearTimeout(deleteCommentArmTimer);
  S.deleteCommentArmId = null;
  clearTimeout(S.tagDeleteArmTimer);
  S.tagDeleteArmId = null;
  S.tagAddingPersonFor = null;
}

/* How much rendering happened — full renders, rows with any part
   repainted, and editable fields built — read by tests/67-render-perf.txt
   through window.__renderTest, nothing else. */
var renderCalls = 0;
var rowsPainted = 0;
var cellsPainted = 0;

export function render() {
  if (!S.state) return;
  renderCalls++;
  resetTransientUiState();
  var rowsEl = document.getElementById("rows");
  var focus = captureRenderFocus(rowsEl);

  /* withRowMotion (04a-row-motion.js) measures the scenes, runs the
     callback below, measures again, and animates whatever ended up
     somewhere else — a reorder, an Alt+Up, a dropped drag, an insert, a
     run of shot scenes collapsing. It calls the callback synchronously and
     exactly once, so everything after this block still sees the finished
     DOM; only the paint is deferred. With reduced motion asked for, or on
     a document too long to be worth measuring, it is a direct call. */
  withRowMotion(rowsEl, function () {
    reconcileRows(rowsEl, focus && focus.rowEl);
  });
  restoreRenderFocus(rowsEl, focus);

  var titleInput = document.getElementById("doc-title");
  if (document.activeElement !== titleInput) titleInput.value = S.state.title || "";
  syncAnchorResolvedClasses();
  updateScriptStats();
  updateCommentsCount();
  /* Every live tag has a registry entry — the explicit step that used to
     happen as a side effect of reading the breakdown (07-production-tags.js). */
  healTagRegistry();
  updateTagBadges();
  /* Every route that puts new content into the document ends here — an
     import, a file opened, a version restored, a merge landing — and any
     of them can carry B-roll lines that never went through the typing
     path and so have no marker of their own. The refresh's own debounce
     is where they get one (see maybeAnchorBroll); scheduling rather than
     calling keeps it off this frame and out of the way of a caret. */
  scheduleBrollRefresh();
  renderProduction();
  captureReplyDrafts();
  renderComments();
  /* A full render means the document changed underneath the UI — a
     merge landing from the server, a version restored. The writer is not
     on the typing path (typing only ever reaches renderRow and the
     debounced counters), so rebuilding it here cannot cost anyone a
     caret, and leaving it stale would show narration that no longer
     matches what is being edited. */
  if (writerOpen) renderWriter();
  /* The ranges this holds point at text nodes a repaint may have replaced.
     Debounced rather than immediate: nothing is wrong in the meantime
     beyond a missing underline. */
  scheduleUntaggedScan();
  /* The gutter and field marks live outside the document (13a-presence.js)
     and a repainted part took its mark with it, so they are put back from
     the last answer rather than waiting for the next beat. */
  paintPresence();
  /* A link popover's saved selection is only good while its cell is still
     in the page — a reused field keeps it, a repainted one does not. */
  if (S.savedRangeCell && !S.savedRangeCell.isConnected) {
    S.savedRange = null;
    S.savedRangeCell = null;
  }
}

/* ================= field sync ================= */

export function syncFieldFromDom(cellEl) {
  var id = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var idx = findRowIndex(id);
  if (idx !== -1) {
    /* Strips the zero-width caret spot ensureTrailingCaretSpot() may have
       appended after a trailing tag/b-roll span — it exists only to give
       the DOM a place to put the caret and must never reach stored text. */
    var html = cellEl.innerHTML.indexOf("\u200B") === -1 ? cellEl.innerHTML : cellEl.innerHTML.replace(/\u200B/g, "");
    if (S.state.rows[idx][field] !== html) {
      S.state.rows[idx][field] = html;
      stampRow(S.state.rows[idx]);
      markDirty();
    }
    noteFieldPainted(cellEl, field, S.state.rows[idx]);
  }
}

/* ================= rich text commands ================= */

/* Is there anything after `node` that gives the last line a box to sit in?
   A zero-width caret spot does not count — it is ensureTrailingCaretSpot()'s
   scaffolding, and syncFieldFromDom() strips it back out again. */
function hasRenderedContentAfter(cellEl, node) {
  var r = document.createRange();
  r.setStartAfter(node);
  r.setEnd(cellEl, cellEl.childNodes.length);
  var frag = r.cloneContents();
  if (frag.querySelector("br, img, span, a, strong, em, u, s, mark")) return true;
  return frag.textContent.replace(/\u200B/g, "").length > 0;
}

/* A line break inside a cell, the way the browser's own Enter does it.
   This used to be insertHTML("<br>"), which inserts exactly one <br> — and
   a <br> at the very END of a block renders no line at all, so a break
   typed at the end of a scene looked like nothing happened, the next
   character landed BEFORE the <br> on the same line, and once a trailing
   <br> was there every later Enter in that cell was a complete no-op.
   insertLineBreak adds the second, sentinel <br> that gives the new last
   line a box, and consumes it again as soon as you type. */
export function insertLineBreak(cellEl) {
  try {
    if (document.execCommand("insertLineBreak")) return;
  } catch (err) {}
  /* Manual fallback for anything that does not implement the command. */
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if (!cellEl.contains(range.startContainer)) return;
  range.deleteContents();
  var br = document.createElement("br");
  range.insertNode(br);
  if (!hasRenderedContentAfter(cellEl, br)) {
    br.parentNode.insertBefore(document.createElement("br"), br.nextSibling);
  }
  range.setStartAfter(br);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function isSelectionInsideTag(root, tagName) {
  var sel = window.getSelection();
  if (!sel.rangeCount) return false;
  var node = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  while (node && node !== root) {
    if (node.tagName === tagName) return true;
    node = node.parentNode;
  }
  return false;
}

/* execCommand("hiliteColor"/"backColor") produces a styled <span
   style="background-color:...">, never a <mark>, in every modern
   browser — removeHighlight() below already knows to look for both, but
   the toggle DECISION point (handleToolbarCmd) and the toolbar's active-
   state indicator only ever checked for MARK, so clicking Highlight a
   second time re-applied it instead of removing it (the field only
   turned into a real <mark> — and so became toggle-able — once it had
   been blurred and sanitizeHtml() ran). */
function isSelectionHighlighted(root) {
  var sel = window.getSelection();
  if (!sel.rangeCount) return false;
  var node = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  while (node && node !== root) {
    if (node.tagName === "MARK" || (node.tagName === "SPAN" && node.style && node.style.backgroundColor)) return true;
    node = node.parentNode;
  }
  return false;
}

function unwrapElement(el) {
  var parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

export function applyHighlight() {
  var ok = false;
  try { ok = document.execCommand("hiliteColor", false, HIGHLIGHT_COLOR); } catch (e) {}
  if (!ok) { try { document.execCommand("backColor", false, HIGHLIGHT_COLOR); } catch (e) {} }
}

export function removeHighlight(cellEl) {
  var sel = window.getSelection();
  if (!sel.rangeCount) return;
  var node = sel.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  while (node && node !== cellEl) {
    if (node.tagName === "MARK" || (node.tagName === "SPAN" && node.style && node.style.backgroundColor)) {
      unwrapElement(node);
      return;
    }
    node = node.parentNode;
  }
}

export function updateToolbarState(cellEl) {
  var wrap = cellEl.closest(".field-wrap");
  if (!wrap) return;
  var toolbar = wrap.querySelector(".mini-toolbar");
  if (!toolbar) return;
  ["bold", "italic", "underline", "strikeThrough"].forEach(function (cmd) {
    var btn = toolbar.querySelector('[data-cmd="' + cmd + '"]');
    if (!btn) return;
    var on = false;
    try { on = document.queryCommandState(cmd); } catch (e) {}
    btn.classList.toggle("is-active", on);
  });
  var hiBtn = toolbar.querySelector('[data-cmd="highlight"]');
  if (hiBtn) hiBtn.classList.toggle("is-active", isSelectionHighlighted(cellEl));
}

export function handleToolbarCmd(btn) {
  var wrap = btn.closest(".field-wrap");
  var cellEl = wrap.querySelector(".cell-editable");
  var cmd = btn.getAttribute("data-cmd");
  cellEl.focus();
  if (cmd === "highlight") {
    if (isSelectionHighlighted(cellEl)) removeHighlight(cellEl);
    else applyHighlight();
    syncFieldFromDom(cellEl);
    updateToolbarState(cellEl);
    return;
  }
  if (cmd === "link") {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !rangeInside(sel.getRangeAt(0), cellEl)) {
      showToast("Select some text inside one cell, then add a link.", "warn");
      return;
    }
    S.savedRange = sel.getRangeAt(0).cloneRange();
    S.savedRangeCell = cellEl;
    var popover = wrap.querySelector(".link-popover");
    popover.hidden = false;
    var input = popover.querySelector("input");
    input.value = "";
    input.focus();
    return;
  }
  if (cmd === "comment") {
    var csel = window.getSelection();
    if (!csel.rangeCount || csel.isCollapsed || !rangeInside(csel.getRangeAt(0), cellEl)) {
      showToast("Select some text inside one cell, then add a comment.", "warn");
      return;
    }
    var quotedText = csel.toString();
    var cRange = csel.getRangeAt(0);
    var cmtId = makeId("c");
    var anchorSpanEl;
    try {
      anchorSpanEl = wrapRangeInComment(cRange, cmtId);
    } catch (e) {
      showToast("Could not anchor a comment to that selection.", "error");
      return;
    }
    csel.removeAllRanges();
    var afterC = document.createRange();
    afterC.setStartAfter(anchorSpanEl);
    afterC.collapse(true);
    csel.addRange(afterC);
    syncFieldFromDom(cellEl);
    openCommentComposer({
      id: cmtId,
      rowId: cellEl.getAttribute("data-id"),
      field: cellEl.getAttribute("data-field"),
      quotedText: quotedText
    });
    return;
  }
  if (cmd === "tag") {
    var tsel = window.getSelection();
    if (!tsel.rangeCount || tsel.isCollapsed || !rangeInside(tsel.getRangeAt(0), cellEl)) {
      showToast("Select the words you want to label first.", "warn");
      return;
    }
    var tagQuoted = tsel.toString().trim();
    /* Which occurrence of this phrase, among any others in the cell, the
       user actually selected — captured now, while the real Range still
       exists, since applyTag() runs after the modal has closed and can
       only re-find the phrase as plain text. Counted the same way
       tagFieldOccurrences() itself counts matches (word-boundary rule and
       document order), by re-running it in countOnly mode over just the
       text before the selection start, so the index lines up exactly. */
    var tagRange = tsel.getRangeAt(0);
    var beforeRange = document.createRange();
    beforeRange.selectNodeContents(cellEl);
    beforeRange.setEnd(tagRange.startContainer, tagRange.startOffset);
    var beforeDiv = document.createElement("div");
    beforeDiv.appendChild(beforeRange.cloneContents());
    var tagOccurrenceIndex = tagQuoted
      ? tagFieldOccurrences(beforeDiv.innerHTML, tagQuoted, "x", "x", true).hits
      : 0;
    openTagComposer({
      rowId: cellEl.getAttribute("data-id"),
      field: cellEl.getAttribute("data-field"),
      quotedText: tagQuoted,
      occurrenceIndex: tagOccurrenceIndex
    });
    return;
  }
  if (cmd === "image") {
    document.getElementById("comment-image-input").click();
    return;
  }
  if (cmd === "video") {
    var vpopover = wrap.querySelector(".video-popover");
    if (vpopover) {
      vpopover.hidden = false;
      var vinput = vpopover.querySelector("input");
      vinput.value = "";
      vinput.focus();
    }
    return;
  }
  document.execCommand(cmd);
  syncFieldFromDom(cellEl);
  updateToolbarState(cellEl);
}

/* extractContents() on a range that leaves the cell rips content out of two
   rows at once and loses it, so refuse anything not fully contained */
function rangeInside(range, el) {
  if (!range || !el) return false;
  return el.contains(range.startContainer) && el.contains(range.endContainer) &&
         el.contains(range.commonAncestorContainer);
}

function wrapRangeInLink(range, url) {
  var frag = range.extractContents();
  var a = document.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener");
  a.appendChild(frag);
  range.insertNode(a);
  return a;
}

export function confirmLink(wrap) {
  if (!wrap) return;
  var popover = wrap.querySelector(".link-popover");
  var input = popover.querySelector("input");
  var url = (input.value || "").trim();
  var owner = wrap.querySelector(".cell-editable");
  /* the saved Range must still belong to THIS field and still be in the document */
  if (!url || !S.savedRange || !S.savedRangeCell || S.savedRangeCell !== owner ||
      !document.contains(S.savedRangeCell)) {
    popover.hidden = true;
    S.savedRange = null; S.savedRangeCell = null;
    return;
  }
  if (!/^https?:\/\//i.test(url) && url.indexOf("mailto:") !== 0) url = "https://" + url;
  var cellEl = S.savedRangeCell;
  cellEl.focus();
  var sel = window.getSelection();
  sel.removeAllRanges();
  try {
    var a = wrapRangeInLink(S.savedRange, url);
    var afterRange = document.createRange();
    afterRange.setStartAfter(a);
    afterRange.collapse(true);
    sel.addRange(afterRange);
  } catch (e) {
    sel.addRange(S.savedRange);
    document.execCommand("createLink", false, url);
    var links = cellEl.querySelectorAll("a:not([target])");
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute("target", "_blank");
      links[i].setAttribute("rel", "noopener");
    }
  }
  popover.hidden = true;
  S.savedRange = null; S.savedRangeCell = null;
  syncFieldFromDom(cellEl);
}

export function cancelLink(wrap) {
  if (!wrap) return;
  wrap.querySelector(".link-popover").hidden = true;
  S.savedRange = null; S.savedRangeCell = null;
}

function wrapRangeInComment(range, cmtId) {
  var frag = range.extractContents();
  var span = document.createElement("span");
  span.className = "cmt-anchor";
  span.setAttribute("data-cmt", cmtId);
  span.appendChild(frag);
  range.insertNode(span);
  return span;
}

export function confirmVideo(wrap) {
  if (!wrap) return;
  var popover = wrap.querySelector(".video-popover");
  var input = popover.querySelector("input");
  var url = (input.value || "").trim();
  popover.hidden = true;
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  var cellEl = wrap.querySelector(".cell-editable");
  cellEl.focus();
  cellEl.appendChild(document.createElement("br"));
  cellEl.appendChild(buildVideoCardEl(url));
  cellEl.appendChild(document.createElement("br"));
  syncFieldFromDom(cellEl);
}

export function cancelVideo(wrap) {
  if (!wrap) return;
  wrap.querySelector(".video-popover").hidden = true;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* tests/67-render-perf.txt reads how much rendering a gesture cost: full
     renders, rows and fields actually repainted, production-index
     derivations and the idle refreshes they happened in
     (07-production-tags.js). */
  window.__renderTest = {
    counts: function () {
      var p = productionIndexStats();
      return { render: renderCalls, rowsPainted: rowsPainted, cellsPainted: cellsPainted,
               productionDerived: p.derived, idleFlushes: p.flushes };
    },
    reset: function () {
      renderCalls = 0;
      rowsPainted = 0;
      cellsPainted = 0;
      resetProductionIndexStats();
    }
  };
}
