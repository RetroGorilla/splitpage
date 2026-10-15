import { S } from "./_state.js";
import {
  ROW_STATUSES,
  estimatedSeconds,
  formatDuration,
  formatTimecode,
  hasSetLength,
  rowSeconds,
  rowStatus,
  updateScriptStats
} from "./01-scene-status.js";
import { hiddenShotStripHtml, rowGroupItems } from "./01b-hide-shot.js";
import { blobImgHtml } from "./02c-blobs.js";
import { rowSlots, videoLinkKey, videoLinkLabel } from "./02d-gallery.js";
import { findRowIndex } from "./03-sync.js";
import { buildVideoCardEl, cssAttr, ensureTrailingCaretSpot, safeHref, sanitizeHtml, storedHtmlFromDom } from "./04-richtext.js";
import { cellSelection, editCell, notePaintedEpoch, placeEditorSelection, rememberCellSelection } from "./05b-cell-edit.js";
import { refreshGalleryOverlay } from "./05e-gallery-overlay.js";
import { appendDraftMedia, draftModel, editDraft, isDraftBox } from "./05d-draft-edit.js";
import { trackDocument } from "./12a-undo.js";
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
import { showActionToast, showToast } from "./12-dirty-toast.js";
import { reviewMode } from "./13-hosted.js";
import { paintPresence, personColor } from "./13a-presence.js";
import { drawWriter, paintWriterDraw, writerOpen } from "./19-writer.js";
import { videoHostLabel } from "../adapters/formats/video-host.ts";
import { makeId } from "../adapters/identity/ids.ts";
import { idMap } from "../core/document/id-map.ts";
import { escapeHtml } from "../core/document/text-policy.ts";
import { pad2 } from "../core/production/timing.ts";
import { cueShortcut } from "../core/text/cues.ts";
import { directionRangeAt, directionShortcut, directionToggleRange, toggleDirection } from "../core/text/directions.ts";
import {
  breakLine,
  clamp,
  insertText,
  insideDirection,
  markThroughout,
  setMark,
  toggleMark,
  typingMarks
} from "../core/text/edits.ts";
import { cellLength, projection } from "../core/text/runs.ts";
import { cellRuns, cellTextCommand } from "../application/commands/cell-text.ts";
import { fromHtml } from "../legacy/richtext.ts";
import { createPaintGuard } from "../application/editing/paint-guard.ts";
import { runCommand, sessionTextPorts } from "../legacy/session-bridge.ts";

export { notePaintedEpoch, placeEditorSelection, rememberCellSelection };
export { pad2 };

var LINK_POPOVER_HTML =
  '<div class="link-popover" hidden>' +
    '<input type="url" aria-label="Link address" placeholder="https://example.com" data-role="link-input">' +
    '<button type="button" data-action="link-confirm">Add</button>' +
    '<button type="button" data-action="link-cancel">Cancel</button>' +
  '</div>';

function tbIcon(id) { return '<svg class="tb-icon" aria-hidden="true"><use href="#' + id + '"/></svg>'; }

var COMMENT_BUTTON_HTML = '<button type="button" data-cmd="comment" title="Comment on selected text" aria-label="Comment">' + tbIcon("i-comment") + '</button>';

var SCRIPT_TOOLBAR_BUTTONS =
  '<button type="button" data-cmd="bold" title="Bold (Ctrl+B)" aria-label="Bold"><span class="tb-letter tb-b">B</span></button>' +
  '<button type="button" data-cmd="italic" title="Italic (Ctrl+I)" aria-label="Italic"><span class="tb-letter tb-i">I</span></button>' +
  '<button type="button" data-cmd="underline" title="Underline (Ctrl+U)" aria-label="Underline"><span class="tb-letter tb-u">U</span></button>' +
  '<button type="button" data-cmd="strikeThrough" title="Strikethrough" aria-label="Strikethrough"><span class="tb-letter tb-s">S</span></button>' +
  '<span class="tb-sep"></span>' +
  '<button type="button" data-cmd="highlight" title="Highlight" aria-label="Highlight">' + tbIcon("i-highlight") + '</button>' +
  '<button type="button" data-cmd="link" title="Add link" aria-label="Link">' + tbIcon("i-link") + '</button>' +
  COMMENT_BUTTON_HTML +
  '<span class="tb-sep"></span>' +
  '<button type="button" data-cmd="tag" class="tb-tag" title="Label as a prop, location, cast member or effect" aria-label="Tag as…">' +
    tbIcon("i-tag") + '<svg class="tb-chevron" aria-hidden="true"><use href="#i-chevron-down"/></svg></button>';

export var DIRECTION_BUTTON_TITLE = "Stage direction — shown in the teleprompter, not read aloud. Or type ((…))";
var DIRECTION_BUTTON_HTML = '<button type="button" data-cmd="direction" title="' + DIRECTION_BUTTON_TITLE +
  '" aria-label="Stage direction"><span class="tb-letter tb-dir">( )</span></button>';

var CELL_TOOLBARS = {
  script: { label: "Text formatting", buttons: SCRIPT_TOOLBAR_BUTTONS },
  scriptAudio: { label: "Text formatting", buttons: SCRIPT_TOOLBAR_BUTTONS + DIRECTION_BUTTON_HTML },
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
    toolbar: review ? "review" : field === "audioText" ? "scriptAudio" : "script"
  });
}

var STATUS_CHECK_SVG =
  '<svg class="status-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function rowMenuItemHtml(row, action, icon, label, title, danger) {
  return '<button class="gutter-btn row-menu-item' + (danger ? ' danger' : '') + '" type="button" role="menuitem" data-action="' +
    action + '" data-id="' + row.id + '" title="' + title + '">' +
    '<svg class="mi-icon" aria-hidden="true"><use href="#' + icon + '"/></svg>' +
    '<span class="row-menu-label">' + label + '</span></button>';
}

function rowGutterHtml(row, index, review) {
  var st = rowStatus(row.status) || ROW_STATUSES[0];
  var num = pad2(index + 1);
  var lamp = '<span class="status-dot ' + st.cls + '" aria-hidden="true">' +
    (st.id === "shot" ? STATUS_CHECK_SVG : '') + '</span><span class="status-word">' + escapeHtml(st.label) + '</span>';
  var head = review
    ? '<div class="row-head"><span class="row-num">' + num + '</span><span class="row-start"></span></div>'
    : '<div class="row-head" data-action="drag-grip" data-id="' + row.id + '" title="Drag to reorder">' +
        '<span class="row-num">' + num + '</span><span class="row-start"></span>' +
      '</div>';
  var controls = review
    ? '<span class="status-btn is-static" title="' + escapeHtml(st.label) +
        '" aria-label="Scene status: ' + escapeHtml(st.label) + '">' + lamp + '</span>'
    : '<button class="status-btn" type="button" data-action="cycle-status" data-id="' + row.id +
        '" title="' + escapeHtml(st.label) + ' — click to change" aria-label="Scene ' + num + ' status: ' +
        escapeHtml(st.label) + '. Change status">' + lamp + '</button>' +
      '<div class="row-tools">' +
        '<span class="row-grip" data-action="drag-grip" data-id="' + row.id + '" title="Drag to move this scene" aria-hidden="true">' +
          '<svg aria-hidden="true"><use href="#i-grip"/></svg></span>' +
        '<div class="row-menu-wrap">' +
          '<button class="row-more" type="button" data-action="row-menu" data-id="' + row.id +
            '" aria-haspopup="menu" aria-expanded="false" aria-label="Scene ' + num + ' actions" title="Move, insert or delete this scene">' +
            '<svg aria-hidden="true"><use href="#i-more"/></svg></button>' +
          '<div class="row-menu" role="menu" aria-label="Scene ' + num + '" hidden>' +
            rowMenuItemHtml(row, "move-up", "i-arrow-up", "Move up", "Move this scene up (Alt+Up)") +
            rowMenuItemHtml(row, "move-down", "i-arrow-down", "Move down", "Move this scene down (Alt+Down)") +
            rowMenuItemHtml(row, "insert-below", "i-plus", "Insert scene", "Insert an empty scene below this one") +
            rowMenuItemHtml(row, "delete-row", "i-trash", "Delete", "Delete this scene", true) +
          '</div>' +
        '</div>' +
      '</div>';
  return (
    '<div class="gutter">' +
      head +
      '<div class="row-controls">' + controls + '</div>' +
      (row.updatedBy
        ? '<div class="row-meta" title="Last edited by ' + escapeHtml(row.updatedBy) + '">' +
            '<span class="row-meta-who"><span class="person-dot" style="--person:' + personColor(row.updatedBy) +
              '" aria-hidden="true"></span>' + escapeHtml(String(row.updatedBy).split(/\s+/)[0]) + '</span><br>' +
            formatTimestamp(row.updatedAt) + '</div>'
        : '') +
    '</div>'
  );
}

export function paintRowTimes() {
  var rowsEl = document.getElementById("rows");
  if (!rowsEl || !S.state) return;
  var byId = idMap();
  for (var c = rowsEl.firstElementChild; c; c = c.nextElementSibling) {
    if (c.classList.contains("row")) byId[c.getAttribute("data-id")] = c;
  }
  var t = 0;
  var review = reviewMode();
  S.state.rows.forEach(function (row) {
    var secs = rowSeconds(row);
    var el = byId[row.id];
    if (el) {
      setTextIfChanged(el.querySelector(".row-start"), formatTimecode(t));
      paintReadTime(el.querySelector(".row-read"), row, secs, review);
    }
    t += secs;
  });
}

function paintReadTime(btn, row, secs, review) {
  if (!btn) return;
  var set = hasSetLength(row);
  var est = set ? estimatedSeconds(row) : secs;
  var over = set && Math.round(est) > Math.round(secs);
  setTextIfChanged(btn, set || secs >= 0.5 ? formatDuration(secs) : "");
  btn.classList.toggle("is-set", set);
  btn.classList.toggle("is-over", over);
  var title = set
    ? "Set by hand · estimate " + formatDuration(est) +
      (over ? " — the Audio now reads longer than this" : "") +
      (review ? "" : ". Click to change; clear it to use the estimate")
    : (review ? "Estimated read time" : "Estimated read time — click to set this scene’s length");
  if (btn.title !== title) btn.title = title;
  var ro = review ? "true" : "false";
  if (btn.getAttribute("aria-disabled") !== ro) btn.setAttribute("aria-disabled", ro);
}

function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

export function armDeleteButton(btn) {
  btn.classList.add("armed");
  var label = btn.querySelector(".row-menu-label");
  if (label) label.textContent = "Click again to delete";
}

export function disarmDeleteButton(btn) {
  btn.classList.remove("armed");
  var label = btn.querySelector(".row-menu-label");
  if (label) label.textContent = "Delete";
}

var GALLERY_CELL_MAX = 4;
var GALLERY_CAPTION_MAX = 3;

export function slotPoster(slot) {
  return slot.links.filter(function (l) { return l.poster; })[0] || null;
}

export function formatVideoLength(sec) {
  if (!(sec > 0)) return "";
  var s = Math.round(sec);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + (m < 10 ? "0" : "") + m : m) + ":" + (r < 10 ? "0" : "") + r;
}

export function gallerySlotPictureHtml(slot) {
  if (slot.ref) return blobImgHtml(slot.ref);
  if (slot.dataUrl) return '<img src="' + escapeHtml(slot.dataUrl) + '" alt="">';
  return '<span class="scene-gallery-placeholder" aria-hidden="true"></span>';
}

export function galleryBadgeHtml(big) {
  return '<span class="scene-gallery-play' + (big ? ' is-big' : '') + '" aria-hidden="true"></span>';
}

function galleryTileHtml(row, slots, i, kind) {
  var slot = slots[i];
  var poster = slotPoster(slot);
  var n = slots.length;
  var inner = gallerySlotPictureHtml(slot);
  if (kind === "more") {
    var rest = n - (GALLERY_CELL_MAX - 1);
    return '<button type="button" class="scene-gallery-tile is-more" data-action="gallery-open" data-id="' + row.id +
      '" data-slot="' + i + '" aria-label="Show all ' + n + ' pictures and videos">' + inner +
      (poster ? galleryBadgeHtml(false) : '') + '<span class="scene-gallery-more-count">+' + rest + '</span></button>';
  }
  var what = (poster ? "Video " : "Picture ") + (i + 1) + " of " + n +
    (poster ? ": " + videoLinkLabel(poster) : slot.name ? ": " + slot.name : "");
  var cover = kind === "cover";
  var length = cover && poster ? formatVideoLength(poster.duration) : "";
  return '<button type="button" class="scene-gallery-tile' + (cover ? ' is-cover' : '') + (poster ? ' is-video' : '') +
    '" data-action="gallery-open" data-id="' + row.id + '" data-slot="' + i + '" aria-label="' + escapeHtml(what) + '">' +
    inner + (poster ? galleryBadgeHtml(cover) : '') +
    (length ? '<span class="scene-gallery-length">' + length + '</span>' : '') + '</button>';
}

function galleryLinkHtml(row, slotIdx, l) {
  var key = escapeHtml(videoLinkKey(l));
  var label = escapeHtml(videoLinkLabel(l));
  var full = escapeHtml(l.href ? l.href : l.name);
  var attrs = ' data-action="gallery-link" data-id="' + row.id + '" data-slot="' + slotIdx + '" data-key="' + key + '" title="' + full + '"';
  var href = l.href ? safeHref(l.href) : null;
  var link = href
    ? '<a class="scene-gallery-link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"' + attrs + '>' + label + '</a>'
    : '<button type="button" class="scene-gallery-link is-file"' + attrs + '>' + label + '</button>';
  return '<div class="scene-gallery-line"><span class="scene-gallery-host">' + escapeHtml(videoHostLabel(l)) + '</span>' + link +
    (reviewMode() ? '' :
      '<button type="button" class="scene-gallery-link-remove" data-action="gallery-link-remove" data-id="' + row.id +
        '" data-slot="' + slotIdx + '" data-key="' + key + '" title="Take this link off" aria-label="Take ' + label + ' off">×</button>') +
    '</div>';
}

export function galleryVideoLinks(slots) {
  var out = [];
  slots.forEach(function (s, i) { s.links.forEach(function (l) { out.push({ slot: i, link: l }); }); });
  return out;
}

function rowGalleryHtml(row, slots, review) {
  var n = slots.length;
  var tiles = galleryTileHtml(row, slots, 0, "cover");
  for (var i = 1; i < Math.min(n, GALLERY_CELL_MAX); i++) {
    tiles += galleryTileHtml(row, slots, i, n > GALLERY_CELL_MAX && i === GALLERY_CELL_MAX - 1 ? "more" : "small");
  }
  var videos = galleryVideoLinks(slots);
  var caption = videos.slice(0, GALLERY_CAPTION_MAX).map(function (v) { return galleryLinkHtml(row, v.slot, v.link); }).join("");
  if (videos.length > GALLERY_CAPTION_MAX) {
    var more = videos.length - GALLERY_CAPTION_MAX;
    caption += '<button type="button" class="scene-gallery-more-videos" data-action="gallery-open-videos" data-id="' + row.id + '">+' +
      more + ' more video' + (more === 1 ? '' : 's') + '</button>';
  }
  var single = n === 1;
  return '<div class="image-thumb-wrap scene-gallery ' + (single ? 'is-single' : 'is-mosaic') + '" data-id="' + row.id + '" data-count="' + n + '">' +
      tiles +
      (review ? '' :
        '<div class="image-thumb-actions">' +
          '<button type="button" data-action="image-add-more" data-id="' + row.id + '" title="Add another picture to this scene">Add</button>' +
          (single
            ? '<button type="button" data-action="image-replace" data-id="' + row.id + '" data-slot="0">Replace</button>' +
              '<button type="button" data-action="image-remove" data-id="' + row.id + '" data-slot="0">Remove</button>'
            : '') +
        '</div>') +
    '</div>' +
    (caption ? '<div class="scene-gallery-caption">' + caption + '</div>' : '');
}

function rowMediaHtml(row, review) {
  var imageBlock;
  var slots = rowSlots(row);
  var img = slots.length ? slots[0] : null;
  if (img) {
    imageBlock = rowGalleryHtml(row, slots, review);
  } else if (review) {
    imageBlock = "";
  } else {
    imageBlock =
      '<button type="button" class="image-clip" data-action="image-add" data-id="' + row.id +
        '" title="Add a picture — or drag one anywhere onto this scene’s visual column">' +
        '<svg class="clip-icon" aria-hidden="true"><use href="#i-image"/></svg>Add picture</button>';
  }
  return '<div class="visual-media' + (img ? '' : ' is-empty') + '" data-id="' +
    row.id + '">' + imageBlock + '</div>';
}

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
      '<div class="cell visual-cell">' + p.visualText + p.media + '</div>' +
      '<div class="cell audio-cell">' + p.audioText + '</div>' +
      '<div class="row-rail"><button type="button" class="row-read" data-id="' + row.id + '"></button></div>' +
    '</div>'
  );
}

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
  return el;
}

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

function planRowPatch(rowEl, row, index) {
  var sig = rowEl[ROW_SIG];
  if (!sig) return null;
  var p = rowParts(row, index);
  var parts = [];
  for (var i = 0; i < PATCHED_PARTS.length; i++) {
    var k = PATCHED_PARTS[i];
    if (sig[k] === p[k]) continue;
    var old = rowPartEl(rowEl, k);
    if (!old) return null;
    var fresh = nodeFromHtml(p[k]);
    if (k === "visualText" || k === "audioText") ensureTrailingCaretSpot(fresh.querySelector(".cell-editable"));
    parts.push({ key: k, el: old, fresh: fresh });
  }
  return { p: p, parts: parts };
}

function commitRowPatch(rowEl, patch) {
  resetRowShell(rowEl, patch.p.cls);
  patch.parts.forEach(function (part) {
    var active = document.activeElement;
    var action = active && active !== part.el && part.el.contains(active) &&
      active.getAttribute && active.getAttribute("data-action");
    part.el.parentNode.replaceChild(part.fresh, part.el);
    if (part.key === "visualText" || part.key === "audioText") {
      cellsPainted++;
    } else if (action && !writerOpen) {
      var again = part.fresh.querySelector('[data-action="' + cssAttr(action) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  });
  rowEl[ROW_SIG] = patch.p;
  if (patch.parts.length) rowsPainted++;
  return patch.parts.length > 0;
}

var paintGuard = createPaintGuard();

export var whilePainting = paintGuard.whilePainting;

export var afterThisPaint = paintGuard.afterThisPaint;

export function renderRow(rowId) {
  return whilePainting(function () { return paintOneRow(rowId); });
}

function paintOneRow(rowId) {
  if (!S.state) return false;
  var idx = findRowIndex(rowId);
  var rowsEl = document.getElementById("rows");
  if (idx === -1 || !rowsEl) return false;
  var rowEl = rowsEl.querySelector(':scope > .row[data-id="' + cssAttr(rowId) + '"]');
  if (!rowEl) return false;
  var patch = planRowPatch(rowEl, S.state.rows[idx], idx);
  var whole = patch ? null : newRowEl(S.state.rows[idx], idx);
  var active = document.activeElement;
  var heldCell = active && active.classList && active.classList.contains("cell-editable") && rowEl.contains(active) &&
    rememberCellSelection(active) ? active : null;
  var touched = true;
  if (patch) touched = commitRowPatch(rowEl, patch);
  else {
    rowsEl.replaceChild(whole, rowEl);
    rowsPainted++;
    cellsPainted += 2;
  }
  if (heldCell && !heldCell.isConnected) placeEditorSelection(rowsEl);
  if (touched) paintPresence();
  if (touched) paintRowTimes();
  if (touched) refreshGalleryOverlay();
  return true;
}

function noteFieldPainted(cellEl, field, row) {
  var rowEl = cellEl.closest(".row");
  if (!rowEl || !rowEl[ROW_SIG] || !rowEl.parentNode || rowEl.parentNode.id !== "rows") return;
  if (rowEl.getAttribute("data-id") !== row.id) return;
  rowEl[ROW_SIG][field] = rowFieldHtml(row, field, reviewMode());
}

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

function planRows(rowsEl) {
  if (!S.state.rows.length) return { empty: true };
  var existing = new Map();
  var drop = [];
  Array.prototype.slice.call(rowsEl.children).forEach(function (el) {
    var key = rowMotionKey(el);
    var reusable = key && !existing.has(key) && (key.indexOf("strip:") === 0 || el[ROW_SIG]);
    if (reusable) existing.set(key, el);
    else drop.push(el);
  });

  var steps = rowGroupItems(S.state.rows).map(function (item) {
    var key = item.strip ? "strip:" + item.strip.join(",") : "row:" + item.row.id;
    var el = existing.get(key);
    if (el) {
      existing.delete(key);
      if (item.strip) return { node: el };
      var patch = planRowPatch(el, item.row, item.index);
      if (patch) return { node: el, patch: patch };
      drop.push(el);
    }
    if (item.strip) return { node: nodeFromHtml(hiddenShotStripHtml(item.strip)) };
    return { node: newRowEl(item.row, item.index), added: true };
  });
  existing.forEach(function (el) { drop.push(el); });
  return { steps: steps, drop: drop };
}

function commitRows(rowsEl, plan, pinned) {
  if (plan.empty) {
    rowsEl.innerHTML = EMPTY_ROWS_HTML;
    return;
  }
  plan.drop.forEach(function (el) { if (el.parentNode === rowsEl) rowsEl.removeChild(el); });
  var nodes = plan.steps.map(function (step) {
    if (step.patch) commitRowPatch(step.node, step.patch);
    if (step.added) {
      rowsPainted++;
      cellsPainted += 2;
    }
    return step.node;
  });

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

  var inOrder = rowsEl.children.length === nodes.length;
  for (var j = 0; inOrder && j < nodes.length; j++) inOrder = rowsEl.children[j] === nodes[j];
  if (!inOrder) nodes.forEach(function (n) { rowsEl.appendChild(n); });

  rowsEl.querySelectorAll(".cell-editable").forEach(ensureTrailingCaretSpot);
}

function captureRenderFocus(rowsEl) {
  var active = document.activeElement;
  if (!active || !active.classList || !rowsEl || !rowsEl.contains(active)) return null;
  var out = { cell: null, id: null, field: null, rowEl: null, sel: null };
  if (active.classList.contains("cell-editable")) {
    out.cell = active;
    out.id = active.getAttribute("data-id");
    out.field = active.getAttribute("data-field");
  }
  var rowEl = active.closest(".row");
  if (rowEl && rowEl.parentNode === rowsEl) out.rowEl = rowEl;
  var sel = window.getSelection();
  if (out.cell && sel && sel.rangeCount) {
    var r = sel.getRangeAt(0);
    if (active.contains(r.startContainer) && active.contains(r.endContainer)) {
      out.sel = { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset };
    }
  }
  return (out.cell || out.rowEl) ? out : null;
}

function restoreRenderFocus(rowsEl, f) {
  if (!f || !f.cell) return;
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
  placeEditorSelection(rowsEl);
}

function resetTransientUiState() {
  clearTimeout(S.deleteArmTimer);
  S.deleteArmId = null;
  document.querySelectorAll("#rows .gutter-btn.danger.armed").forEach(disarmDeleteButton);
  clearTimeout(deleteCommentArmTimer);
  S.deleteCommentArmId = null;
  clearTimeout(S.tagDeleteArmTimer);
  S.tagDeleteArmId = null;
  S.tagAddingPersonFor = null;
}

var renderCalls = 0;
var rowsPainted = 0;
var cellsPainted = 0;

export function syncPageTitle() {
  var name = ((S.state && S.state.title) || "").trim();
  document.title = !name || name === "Untitled Script" ? "Splitpage" : name + " — Splitpage";
}

export function render() {
  whilePainting(paintAll);
}

export function paintingScreen() {
  return paintGuard.painting();
}

function paintAll() {
  trackDocument();
  if (!S.state) return;
  renderCalls++;
  var rowsEl = document.getElementById("rows");
  var plan = planRows(rowsEl);
  var title = S.state.title || "";
  var writerDraw = writerOpen ? drawWriter() : null;

  resetTransientUiState();
  var focus = captureRenderFocus(rowsEl);
  if (focus && focus.cell) rememberCellSelection(focus.cell);
  withRowMotion(rowsEl, function () {
    commitRows(rowsEl, plan, focus && focus.rowEl);
  });
  notePaintedEpoch(rowsEl);
  if (!writerOpen) restoreRenderFocus(rowsEl, focus);

  var titleInput = document.getElementById("doc-title");
  if (document.activeElement !== titleInput) titleInput.value = title;
  if (writerDraw) paintWriterDraw(writerDraw);
  syncPageTitle();
  syncAnchorResolvedClasses();
  updateScriptStats();
  updateCommentsCount();
  healTagRegistry();
  updateTagBadges();
  scheduleBrollRefresh();
  renderProduction();
  captureReplyDrafts();
  renderComments();
  scheduleUntaggedScan();
  paintPresence();
  refreshGalleryOverlay();
  if (S.savedRangeCell && !S.savedRangeCell.isConnected) {
    S.savedRange = null;
    S.savedRangeCell = null;
  }
}

var REDRAW_FAILED = "Could not redraw the script after the update. Nothing was lost — press Redraw before you keep editing.";
var FIRST_DRAW_FAILED = "Could not draw the script. Nothing was lost — press Redraw before you start editing.";
var redrawToast = null;
var screenStale = false;
var staleFocus = null;
var STALE_PARTS = "#rows, .add-row-bar, #doc-title, #writer-title, #writer-doc, #writer .wr-fmt, " +
  "#replace-input, #find-replace, #find-replace-all, #find-tag-go, #tag-ghost, #tag-suggest";
var STALE_EVENTS = ["keydown", "beforeinput", "input", "paste", "cut", "drop", "dragstart",
  "compositionstart", "pointerdown", "mousedown", "click"];

function offerRedraw(failed) {
  if (redrawToast && redrawToast.isConnected && !redrawToast.classList.contains("is-leaving")) return;
  redrawToast = showActionToast(failed, "error", "Redraw", function () { absorbRender(failed); }, true);
  redrawToast.removeEventListener("click", redrawToast.dismiss);
  redrawToast.removeAttribute("title");
  redrawToast.classList.add("is-held");
  redrawToast.setAttribute("role", "alert");
}

function focusPlace(el) {
  var cellEl = el.closest(".cell-editable[data-id][data-field]");
  if (!cellEl) return el.id ? { id: el.id } : null;
  return { row: cellEl.getAttribute("data-id"), field: cellEl.getAttribute("data-field") };
}

function markStaleParts(on) {
  document.querySelectorAll(STALE_PARTS).forEach(function (el) {
    el.toggleAttribute("inert", on);
    el.classList.toggle("is-stale-part", on);
  });
}

function holdStaleScreen(failed) {
  var active = document.activeElement;
  var inPart = !!(active && active.closest && active.closest(STALE_PARTS));
  var onRedraw = !!(redrawToast && active && redrawToast.contains(active));
  if (!screenStale && inPart) staleFocus = focusPlace(active);
  screenStale = true;
  document.body.classList.add("is-stale-screen");
  markStaleParts(true);
  offerRedraw(failed);
  if (inPart || onRedraw) redrawToast.querySelector(".toast-action").focus();
}

function releaseStaleScreen() {
  if (!screenStale) return;
  screenStale = false;
  document.body.classList.remove("is-stale-screen");
  markStaleParts(false);
  var place = staleFocus;
  staleFocus = null;
  var active = document.activeElement;
  if (!place || (active && active !== document.body && !(redrawToast && redrawToast.contains(active)))) return;
  var target = place.id ? document.getElementById(place.id) : document.querySelector(
    '#rows .cell-editable[data-id="' + cssAttr(place.row) + '"][data-field="' + cssAttr(place.field) + '"]');
  if (!target) return;
  target.focus();
  if (place.id || document.activeElement !== target) return;
  var end = window.getSelection();
  var caret = document.createRange();
  caret.selectNodeContents(target);
  caret.collapse(false);
  end.removeAllRanges();
  end.addRange(caret);
}

function refuseOnStaleScreen(e) {
  if (!screenStale) return;
  var t = e.target;
  if (!(t && t.closest && t.closest(STALE_PARTS))) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

export function screenIsStale() {
  return screenStale;
}

function absorbRender(failed) {
  try {
    render();
    releaseStaleScreen();
    if (redrawToast && redrawToast.isConnected) redrawToast.dismiss();
    return true;
  } catch (e) {
    if (window.console) console.error(e);
    holdStaleScreen(failed);
    return false;
  }
}

export function renderAbsorbed() {
  return absorbRender(REDRAW_FAILED);
}

export function renderFirstDraw() {
  return absorbRender(FIRST_DRAW_FAILED);
}

var SCRIPT_CELL = Object.freeze({ media: true });

export function syncFieldFromDom(cellEl) {
  if (!cellEl.isConnected || S.undoApplying || screenStale) return;
  var id = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var idx = findRowIndex(id);
  if (idx !== -1) {
    var html = cellEl.innerHTML.indexOf("\u200B") === -1 ? cellEl.innerHTML : cellEl.innerHTML.replace(/\u200B/g, "");
    html = storedHtmlFromDom(html);
    var outcome = runCommand(cellTextCommand(id, field, cellRuns(fromHtml(html, SCRIPT_CELL)), sessionTextPorts));
    if (outcome.kind === "failed") throw outcome.error;
    noteFieldPainted(cellEl, field, S.state.rows[idx]);
  }
}

export function isScriptCell(cellEl) {
  return !!(cellEl && cellEl.closest("#rows, #writer-doc") && cellEl.getAttribute("data-field"));
}

var FORMAT_MARKS = { bold: "b", italic: "i", underline: "u", strikeThrough: "s", highlight: "hl" };

function throughModel(cellEl, fn) {
  var ran = false;
  function run(cell, sel, media) {
    ran = true;
    return fn(cell, sel, media);
  }
  var fresh = isScriptCell(cellEl) ? editCell(cellEl, run) : isDraftBox(cellEl) ? editDraft(cellEl, run) : null;
  return ran ? (fresh || cellEl) : null;
}

var pendingMarks = null;

function pendingAt(cellEl, pos) {
  return pendingMarks && pendingMarks.cell === cellEl && pendingMarks.pos === pos ? pendingMarks.marks : null;
}

function marksForTyping(cellEl, cell, pos) {
  var m = typingMarks(cell, pos);
  var p = pendingAt(cellEl, pos);
  if (p) Object.keys(p).forEach(function (k) { if (p[k]) m[k] = true; else delete m[k]; });
  return m;
}

function togglePendingMark(cellEl, cell, pos, mark) {
  var p = pendingAt(cellEl, pos) || {};
  var on = !marksForTyping(cellEl, cell, pos)[mark];
  if (on === !!typingMarks(cell, pos)[mark]) delete p[mark]; else p[mark] = on;
  pendingMarks = Object.keys(p).length ? { cell: cellEl, pos: pos, marks: p } : null;
}

export function forgetStalePendingMarks() {
  if (!pendingMarks) return;
  var c = pendingMarks.cell;
  var sel = c.isConnected && document.activeElement === c ? cellSelection(c) : null;
  if (!sel || sel.from !== sel.to || sel.from !== pendingMarks.pos) pendingMarks = null;
}

export function typePendingMarks(cellEl, text) {
  if (!pendingMarks || pendingMarks.cell !== cellEl || !text) return null;
  var typed = false;
  var fresh = throughModel(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to || !pendingAt(cellEl, sel.from)) return null;
    var from = clamp(cell, sel.from);
    var after = projection(cell).charAt(from);
    var t = / $/.test(text) && (after === "" || after === "\n") ? text.slice(0, -1) + " " : text;
    var next = insertText(cell, from, t, marksForTyping(cellEl, cell, from));
    var at = from + cellLength(next) - cellLength(cell);
    typed = true;
    return { cell: next, sel: { from: at, to: at } };
  });
  pendingMarks = null;
  return typed ? fresh : null;
}

export function toggleCellFormat(cellEl, cmd) {
  var mark = FORMAT_MARKS[cmd];
  if (!mark) return null;
  return throughModel(cellEl, function (cell, sel, media) {
    if (!sel) return null;
    if (sel.from === sel.to) {
      togglePendingMark(cellEl, cell, sel.from, mark);
      return null;
    }
    pendingMarks = null;
    var next = media ? media.toggleMark(cell, sel.from, sel.to, mark) : toggleMark(cell, sel.from, sel.to, mark);
    return { cell: next, sel: sel };
  });
}

export function isDirectionCell(cellEl) {
  return isScriptCell(cellEl) && cellEl.getAttribute("data-field") === "audioText";
}

export function toggleCellDirection(cellEl) {
  if (!isDirectionCell(cellEl)) return null;
  var said = false;
  var fresh = throughModel(cellEl, function (cell, sel) {
    if (!sel) return null;
    if (sel.from === sel.to) {
      var r = directionRangeAt(cell, sel.from);
      if (!r) { said = true; return null; }
      return { cell: setMark(cell, r.from, r.to, "dir", false), sel: sel };
    }
    pendingMarks = null;
    var span = directionToggleRange(cell, sel.from, sel.to);
    return { cell: toggleDirection(cell, sel.from, sel.to), sel: span.off || span.from === span.to ? sel : span };
  });
  if (said || !fresh) {
    showToast("Select the words of a stage direction first — or type ((like this)).", "warn");
    return null;
  }
  return fresh;
}

export function maybeDirectionShortcut(e, cellEl) {
  if (e.inputType !== "insertText" || !e.data || e.data.charAt(e.data.length - 1) !== ")") return;
  if (!isDirectionCell(cellEl)) return;
  var s = window.getSelection();
  if (!s || !s.rangeCount || !s.isCollapsed) return;
  var r = s.getRangeAt(0);
  var node = r.startContainer, offset = r.startOffset;
  if (node.nodeType !== 3 || offset < 2 || node.data.slice(offset - 2, offset) !== "))") return;
  if (cellEl.textContent.indexOf("((") === -1) return;
  editCell(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to) return null;
    var got = directionShortcut(cell, sel.from);
    return got ? { cell: got.cell, sel: { from: got.end, to: got.end } } : null;
  });
}

var CUE_HINT_RE = /(sfx|music)[ \t\u00a0]*:$/i;

export function maybeCueShortcut(e, cellEl) {
  if (e.inputType !== "insertText" || !e.data || e.data.charAt(e.data.length - 1) !== ":") return;
  if (!isDirectionCell(cellEl)) return;
  var s = window.getSelection();
  if (!s || !s.rangeCount || !s.isCollapsed) return;
  var r = s.getRangeAt(0);
  var node = r.startContainer, offset = r.startOffset;
  if (node.nodeType !== 3 || !CUE_HINT_RE.test(node.data.slice(0, offset).replace(/\u200B/g, ""))) return;
  editCell(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to) return null;
    var next = cueShortcut(cell, sel.from);
    return next ? { cell: next, sel: sel } : null;
  });
}

function holdsDirection(n) {
  return !!(n && n.nodeType === 1 && (n.classList.contains("stage-dir") || n.querySelector(".stage-dir")));
}

export function typeAtDirectionEdge(cellEl, text) {
  if (!text || !isDirectionCell(cellEl)) return null;
  var s = window.getSelection();
  if (!s || !s.rangeCount || !s.isCollapsed) return null;
  var range = s.getRangeAt(0);
  var node = range.startContainer, offset = range.startOffset;
  if (!cellEl.contains(node)) return null;
  var el = node.nodeType === 3 ? node.parentNode : node;
  var inSpan = !!(el && el.closest && el.closest(".stage-dir"));
  var between = node.nodeType === 1 && (holdsDirection(node.childNodes[offset - 1]) || holdsDirection(node.childNodes[offset]));
  if (!inSpan && !between) return null;
  var at0 = cellSelection(cellEl);
  if (!at0 || at0.from !== at0.to || insideDirection(fromHtml(storedHtmlFromDom(cellEl.innerHTML)), at0.from)) return null;
  var typed = false;
  var fresh = throughModel(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to || insideDirection(cell, sel.from)) return null;
    var from = clamp(cell, sel.from);
    var after = projection(cell).charAt(from);
    var t = / $/.test(text) && (after === "" || after === "\n") ? text.slice(0, -1) + " " : text;
    var next = insertText(cell, from, t, marksForTyping(cellEl, cell, from));
    var at = from + cellLength(next) - cellLength(cell);
    typed = true;
    return { cell: next, sel: { from: at, to: at } };
  });
  pendingMarks = null;
  return typed ? fresh : null;
}

export function cellFormatState(cellEl) {
  var read;
  if (isScriptCell(cellEl)) {
    var html = storedHtmlFromDom(cellEl.innerHTML);
    if (/<img|video-embed-card/.test(html)) return null;
    read = function () { return { cell: fromHtml(html), media: null }; };
  } else if (isDraftBox(cellEl)) {
    read = function () { return draftModel(cellEl); };
  } else {
    return null;
  }
  var out = {};
  var sel = cellSelection(cellEl);
  if (!sel) return out;
  var m = read();
  var typing = sel.from === sel.to ? marksForTyping(cellEl, m.cell, sel.from) : null;
  Object.keys(FORMAT_MARKS).forEach(function (cmd) {
    var k = FORMAT_MARKS[cmd];
    if (typing) out[cmd] = !!typing[k];
    else out[cmd] = m.media ? m.media.markThroughout(m.cell, sel.from, sel.to, k) : markThroughout(m.cell, sel.from, sel.to, k);
  });
  if (!m.media) {
    out.direction = sel.from === sel.to ? !!directionRangeAt(m.cell, sel.from)
      : markThroughout(m.cell, sel.from, sel.to, "dir");
  }
  return out;
}

export function insertLineBreak(cellEl) {
  return throughModel(cellEl, function (cell, sel) {
    if (!sel) return null;
    var b = breakLine(cell, sel.from, sel.to);
    return { cell: b.cell, sel: { from: b.pos, to: b.pos } };
  }) || cellEl;
}

export function updateToolbarState(cellEl) {
  var wrap = cellEl.closest(".field-wrap");
  if (!wrap) return;
  var toolbar = wrap.querySelector(".mini-toolbar");
  if (!toolbar) return;
  var model = toolbar.querySelector('[data-cmd="bold"]') ? cellFormatState(cellEl) : null;
  ["bold", "italic", "underline", "strikeThrough"].forEach(function (cmd) {
    var btn = toolbar.querySelector('[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("is-active", !!(model && model[cmd]));
  });
  var hiBtn = toolbar.querySelector('[data-cmd="highlight"]');
  if (hiBtn) hiBtn.classList.toggle("is-active", !!(model && model.highlight));
  var dirBtn = toolbar.querySelector('[data-cmd="direction"]');
  if (dirBtn) dirBtn.classList.toggle("is-active", !!(model && model.direction));
}

export function handleToolbarCmd(btn) {
  var wrap = btn.closest(".field-wrap");
  var cellEl = wrap.querySelector(".cell-editable");
  var cmd = btn.getAttribute("data-cmd");
  cellEl.focus();
  if (FORMAT_MARKS[cmd]) {
    updateToolbarState(toggleCellFormat(cellEl, cmd) || cellEl);
    return;
  }
  if (cmd === "direction") {
    updateToolbarState(toggleCellDirection(cellEl) || cellEl);
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
}

function rangeInside(range, el) {
  if (!range || !el) return false;
  return el.contains(range.startContainer) && el.contains(range.endContainer) &&
         el.contains(range.commonAncestorContainer);
}

export function confirmLink(wrap) {
  if (!wrap) return;
  var popover = wrap.querySelector(".link-popover");
  var input = popover.querySelector("input");
  var url = (input.value || "").trim();
  var owner = wrap.querySelector(".cell-editable");
  if (!url || !S.savedRange || !S.savedRangeCell || S.savedRangeCell !== owner ||
      !document.contains(S.savedRangeCell)) {
    popover.hidden = true;
    S.savedRange = null; S.savedRangeCell = null;
    return;
  }
  if (!/^https?:\/\//i.test(url) && url.indexOf("mailto:") !== 0) url = "https://" + url;
  var cellEl = S.savedRangeCell;
  var saved = S.savedRange;
  popover.hidden = true;
  S.savedRange = null; S.savedRangeCell = null;
  cellEl.focus();
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(saved);
  var linked = throughModel(cellEl, function (cell, s) {
    if (!s || s.from === s.to) return null;
    return { cell: setMark(cell, s.from, s.to, "href", url), sel: { from: s.to, to: s.to } };
  });
  if (linked) caretOutOfLinkEnd(linked);
}

function caretOutOfLinkEnd(cellEl) {
  var sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  var r = sel.getRangeAt(0);
  var node = r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer;
  var a = node && node.closest ? node.closest("a") : null;
  if (!a || !cellEl.contains(a)) return;
  var rest = document.createRange();
  rest.selectNodeContents(a);
  rest.setStart(r.startContainer, r.startOffset);
  if (rest.toString().replace(/\u200B/g, "")) return;
  var after = document.createRange();
  after.setStartAfter(a);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
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
  var card = sanitizeHtml(buildVideoCardEl(url).outerHTML);
  if (card) appendDraftMedia(wrap.querySelector(".cell-editable"), card);
}

export function cancelVideo(wrap) {
  if (!wrap) return;
  wrap.querySelector(".video-popover").hidden = true;
}

export function __init() {
  window.__renderTest = {
    render: render,
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
  STALE_EVENTS.forEach(function (type) { window.addEventListener(type, refuseOnStaleScreen, true); });
}
