import { S } from "./_state.js";
import { escapeHtml } from "./02-state.js";
import { moveGallerySlot, removeGallerySlot, rowSlots, videoLinkKey, videoLinkLabel } from "./02d-gallery.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { cssAttr } from "./04-richtext.js";
import {
  formatVideoLength,
  galleryBadgeHtml,
  gallerySlotPictureHtml,
  render,
  setGalleryIndex,
  slotPoster,
  videoHostLabel
} from "./05-render.js";
import { openGalleryLink } from "./06-rows.js";
import { markDirty, showActionToast, showToast } from "./12-dirty-toast.js";
import { breakUndoCoalescing, lastUndoEntry, undo } from "./12a-undo.js";
import { reviewMode } from "./13-hosted.js";

/* ================= a scene's gallery, all of it (#135) =================

   The dialog a click on any tile of a scene's Image section opens (or the
   "+N" tile, or "+N more videos", which shows only the videos): "Scene N
   · Visual", how many pictures and videos, a large preview of the picked
   item with ‹ › and "3 / 10", its caption (its file name, or its video
   links) and Open / Make cover / Remove; then every item as a numbered
   grid, a dashed "behind +N" line after item 3 when the cell shows only
   three, and a "+" tile to add a picture.

   Reordering: drag a tile onto another, or Shift+← / Shift+→ on the picked
   one. ← / → pick, Delete removes, Esc closes. Make cover, Remove, a move
   and an add are each one undo step (the document's own undo, 12a-undo.js)
   with a toast that offers it. The dialog always draws from state, so an
   undo from anywhere repaints it (refreshGalleryOverlay, called by
   render/renderRow). All of it is .scene-gallery*; the markup lives in
   page.html as #gallery-modal. */

var view = null;          /* {rowId, sel, videos} while open */
var returnFocus = null;
var dragFrom = -1;

function modal() { return document.getElementById("gallery-modal"); }

function rowOf(rowId) {
  var idx = findRowIndex(rowId);
  return idx === -1 ? null : { row: S.state.rows[idx], index: idx };
}

/* The items the dialog shows, as slot indexes: all, or those with videos. */
function shownSlots(slots) {
  var out = [];
  slots.forEach(function (s, i) { if (!view.videos || s.links.length) out.push(i); });
  return out;
}

export function galleryOverlayOpen() { return !!view; }

export function openGalleryOverlay(rowId, slot, videosOnly) {
  var got = rowOf(rowId);
  if (!got || !rowSlots(got.row).length) return;
  returnFocus = document.activeElement;
  view = { rowId: rowId, sel: slot || 0, videos: !!videosOnly };
  var slots = rowSlots(got.row);
  var shown = shownSlots(slots);
  if (shown.indexOf(view.sel) === -1) view.sel = shown.length ? shown[0] : 0;
  modal().hidden = false;
  paint();
  var picked = modal().querySelector(".scene-gallery-grid-tile.is-selected");
  if (picked) picked.focus({ preventScroll: true });
}

export function closeGalleryOverlay() {
  if (!view) return;
  var rowId = view.rowId;
  view = null;
  modal().hidden = true;
  /* back where it was opened from — or, when an edit repainted that tile,
     the scene's cover */
  var back = returnFocus && returnFocus.isConnected && returnFocus !== document.body ? returnFocus
    : document.querySelector('#rows .scene-gallery[data-id="' + cssAttr(rowId) + '"] .scene-gallery-tile');
  if (back) back.focus({ preventScroll: true });
  returnFocus = null;
}

/* Repaints the open dialog from state — after an undo, a merge, anything
   render() or renderRow() ran for. Closes it when its scene or its last
   picture is gone. */
export function refreshGalleryOverlay() {
  if (!view) return;
  var got = rowOf(view.rowId);
  if (!got || !rowSlots(got.row).length) { closeGalleryOverlay(); return; }
  var hadFocus = modal().contains(document.activeElement);
  paint();
  if (hadFocus && !modal().contains(document.activeElement)) {
    var picked = modal().querySelector(".scene-gallery-grid-tile.is-selected");
    if (picked) picked.focus({ preventScroll: true });
  }
}

function plural(n, one) { return n + " " + one + (n === 1 ? "" : "s"); }

function paint() {
  var got = rowOf(view.rowId);
  var slots = rowSlots(got.row);
  var shown = shownSlots(slots);
  if (!shown.length) { view.videos = false; shown = shownSlots(slots); }
  if (shown.indexOf(view.sel) === -1) view.sel = shown[Math.min(shown.length - 1, Math.max(0, view.sel))] || 0;
  if (view.sel >= slots.length) view.sel = slots.length - 1;
  var review = reviewMode();
  var n = slots.length;
  var pictures = slots.filter(function (s) { return (s.ref || s.dataUrl) && !slotPoster(s); }).length;
  var videos = 0;
  slots.forEach(function (s) { videos += s.links.length; });

  document.getElementById("gallery-title").textContent = "Scene " + (got.index + 1) + " · Visual";
  var summary = [];
  if (pictures) summary.push(plural(pictures, "picture"));
  if (videos) summary.push(plural(videos, "video"));
  document.getElementById("gallery-summary").innerHTML = escapeHtml(summary.join(" · ")) +
    (view.videos ? ' — videos only <button type="button" class="scene-gallery-show-all" data-gact="all">Show all</button>' : '');

  var sel = view.sel;
  var slot = slots[sel];
  var poster = slotPoster(slot);
  var pos = shown.indexOf(sel);
  var length = poster ? formatVideoLength(poster.duration) : "";
  var preview =
    '<div class="scene-gallery-preview">' +
      '<button type="button" class="scene-gallery-step" data-gact="prev" aria-label="Previous"' + (shown.length < 2 ? ' disabled' : '') + '>‹</button>' +
      '<div class="scene-gallery-preview-pic' + (poster ? ' is-video' : '') + '">' + gallerySlotPictureHtml(slot) +
        (poster ? galleryBadgeHtml(true) : '') + (length ? '<span class="scene-gallery-length">' + length + '</span>' : '') +
        '<span class="scene-gallery-position">' + (pos + 1) + ' / ' + shown.length + '</span>' +
      '</div>' +
      '<button type="button" class="scene-gallery-step" data-gact="next" aria-label="Next"' + (shown.length < 2 ? ' disabled' : '') + '>›</button>' +
    '</div>';

  var caption = slot.links.length
    ? slot.links.map(function (l) {
        return '<div class="scene-gallery-line"><span class="scene-gallery-host">' + escapeHtml(videoHostLabel(l)) + '</span>' +
          '<button type="button" class="scene-gallery-link' + (l.href ? '' : ' is-file') + '" data-gact="link" data-key="' +
          escapeHtml(videoLinkKey(l)) + '" title="' + escapeHtml(l.href || l.name) + '">' + escapeHtml(videoLinkLabel(l)) + '</button></div>';
      }).join("")
    : '<div class="scene-gallery-line is-name">' + escapeHtml(slot.name || (poster ? "" : "Picture " + (sel + 1))) + '</div>';
  var openLink = poster || slot.links[0] || null;
  var actions =
    '<div class="scene-gallery-actions">' +
      (openLink ? '<button type="button" class="btn" data-gact="open" data-key="' + escapeHtml(videoLinkKey(openLink)) + '">Open</button>' : '') +
      (review ? '' :
        '<button type="button" class="btn" data-gact="cover"' + (sel === 0 ? ' disabled' : '') + '>Make cover</button>' +
        '<button type="button" class="btn" data-gact="remove">Remove</button>') +
    '</div>';

  var grid = '<ol class="scene-gallery-grid" aria-label="All pictures and videos">';
  shown.forEach(function (i, k) {
    var s = slots[i];
    var p = slotPoster(s);
    grid += '<li><button type="button" class="scene-gallery-grid-tile' + (i === sel ? ' is-selected' : '') + (p ? ' is-video' : '') +
      '" data-gact="pick" data-slot="' + i + '"' + (review ? '' : ' draggable="true"') +
      ' aria-label="' + escapeHtml((p ? "Video " : "Picture ") + (i + 1) + (p ? ": " + videoLinkLabel(p) : s.name ? ": " + s.name : "")) + '"' +
      (i === sel ? ' aria-current="true"' : '') + '>' +
      gallerySlotPictureHtml(s) + (p ? galleryBadgeHtml(false) : '') + '<span class="scene-gallery-num">' + (i + 1) + '</span></button></li>';
    if (!view.videos && n > 4 && k === 2) {
      grid += '<li class="scene-gallery-divider" aria-hidden="true"><span>behind +' + (n - 3) + '</span></li>';
    }
  });
  if (!review && !view.videos) {
    grid += '<li><button type="button" class="scene-gallery-grid-tile is-add" data-gact="add" aria-label="Add a picture">+</button></li>';
  }
  grid += '</ol>';
  document.getElementById("gallery-body").innerHTML = preview +
    '<div class="scene-gallery-preview-caption">' + caption + '</div>' + actions + grid;
}

/* One edit of the scene's gallery: its own undo entry, the cell and the
   dialog repainted, and a toast whose Undo takes it back while it is still
   the last thing done. fn(row) changes the row and says whether it did. */
export function galleryEdit(rowId, msg, fn) {
  var got = rowOf(rowId);
  if (!got) return false;
  var before = lastUndoEntry();
  breakUndoCoalescing();
  if (!fn(got.row)) return false;
  stampRow(got.row);
  markDirty();
  render();
  announceGalleryEdit(msg, before);
  return true;
}

/* The toast after a gallery edit (here, and a picture added through the
   file picker, 06-rows.js): Undo, while that edit is still the last. */
export function announceGalleryEdit(msg, before) {
  var entry = lastUndoEntry();
  breakUndoCoalescing();
  if (!entry || entry === before) { showToast(msg, "ok"); return; }
  showActionToast(msg, "ok", "Undo", function () {
    if (lastUndoEntry() === entry) undo();
    else showToast("Something else has changed since — Ctrl+Z undoes one step at a time.", "warn");
  });
}

function pick(i) {
  view.sel = i;
  setGalleryIndex(view.rowId, i);
  paint();
  var picked = modal().querySelector(".scene-gallery-grid-tile.is-selected");
  if (picked) picked.focus({ preventScroll: true });
}

function step(by) {
  var slots = rowSlots(rowOf(view.rowId).row);
  var shown = shownSlots(slots);
  var k = shown.indexOf(view.sel);
  pick(shown[(k + by + shown.length) % shown.length]);
}

function moveTo(from, to) {
  if (reviewMode() || from === to) return;
  var rowId = view.rowId;
  if (galleryEdit(rowId, "Moved to " + (to + 1), function (row) { return moveGallerySlot(row, from, to); })) {
    view.sel = to;
    setGalleryIndex(rowId, to);
    refreshGalleryOverlay();
  }
}

function makeCover() {
  if (reviewMode() || !view.sel) return;
  var from = view.sel;
  var rowId = view.rowId;
  if (galleryEdit(rowId, "Made the cover", function (row) { return moveGallerySlot(row, from, 0); })) {
    view.sel = 0;
    setGalleryIndex(rowId, 0);
    refreshGalleryOverlay();
  }
}

function removeSelected() {
  if (reviewMode()) return;
  var at = view.sel;
  var rowId = view.rowId;
  var slot = rowSlots(rowOf(rowId).row)[at];
  var what = slotPoster(slot) ? "Video" : "Picture";
  galleryEdit(rowId, what + " removed", function (row) { return removeGallerySlot(row, at); });
  if (view) {
    view.sel = Math.max(0, at - 1);
    setGalleryIndex(rowId, view.sel);
    refreshGalleryOverlay();
  }
}

function onClick(e) {
  if (e.target === modal()) { closeGalleryOverlay(); return; }
  var el = e.target.closest("[data-gact]");
  if (!el || !view || el.disabled) return;
  var act = el.getAttribute("data-gact");
  if (act === "prev") step(-1);
  else if (act === "next") step(1);
  else if (act === "pick") pick(Number(el.getAttribute("data-slot")));
  else if (act === "cover") makeCover();
  else if (act === "remove") removeSelected();
  else if (act === "all") { view.videos = false; paint(); }
  else if (act === "open" || act === "link") openGalleryLink(view.rowId, view.sel, el.getAttribute("data-key"));
  else if (act === "add") {
    S.pendingImageRowId = view.rowId;
    document.getElementById("file-input").click();
  }
}

function onKeydown(e) {
  if (!view) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeGalleryOverlay(); return; }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    var by = e.key === "ArrowRight" ? 1 : -1;
    if (e.shiftKey && !view.videos) {
      var n = rowSlots(rowOf(view.rowId).row).length;
      var to = view.sel + by;
      if (to >= 0 && to < n) moveTo(view.sel, to);
    } else if (!e.shiftKey) {
      step(by);
    }
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !reviewMode()) {
    e.preventDefault();
    removeSelected();
  }
}

/* Drag a grid tile onto another to put it there. */
function onDragStart(e) {
  var tile = e.target.closest && e.target.closest('.scene-gallery-grid-tile[data-gact="pick"]');
  if (!tile || !view || reviewMode()) return;
  dragFrom = Number(tile.getAttribute("data-slot"));
  try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ""); } catch (err) {}
}

function onDragOver(e) {
  if (dragFrom === -1) return;
  var tile = e.target.closest && e.target.closest('.scene-gallery-grid-tile[data-gact="pick"]');
  if (!tile) return;
  e.preventDefault();
  e.stopPropagation();
  try { e.dataTransfer.dropEffect = "move"; } catch (err) {}
}

function onDrop(e) {
  if (dragFrom === -1) return;
  e.preventDefault();
  e.stopPropagation();
  var tile = e.target.closest && e.target.closest('.scene-gallery-grid-tile[data-gact="pick"]');
  var from = dragFrom;
  dragFrom = -1;
  if (tile && view) moveTo(from, Number(tile.getAttribute("data-slot")));
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  var m = modal();
  if (!m) return;
  m.addEventListener("click", onClick);
  m.addEventListener("keydown", onKeydown);
  m.addEventListener("dragstart", onDragStart);
  m.addEventListener("dragover", onDragOver);
  m.addEventListener("drop", onDrop);
  m.addEventListener("dragend", function () { dragFrom = -1; });
  document.getElementById("gallery-close").addEventListener("click", closeGalleryOverlay);
}
