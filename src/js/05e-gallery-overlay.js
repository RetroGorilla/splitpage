import { S } from "./_state.js";
import {
  annotateGallerySlot,
  moveGallerySlot,
  removeGallerySlot,
  rowSlots,
  setVideoThumbnail,
  videoLinkKey,
  videoLinkLabel
} from "../adapters/storage/02d-gallery.js";
import { rowIndexOf } from "../core/document/rows.ts";
import { readSession } from "../legacy/session-bridge.ts";
import { cssAttr } from "./04-richtext.js";
import {
  galleryBadgeHtml,
  gallerySlotPictureHtml,
  slotPoster
} from "./05-render.js";
import { embedRefusal, fetchThumbnailRecord, playerSrc, thumbnailsAllowed } from "./05v-video.js";
import { hasSessionVideo, sessionVideoUrl } from "./06-rows.js";
import { appActions } from "../legacy/app-actions.ts";
import { breakUndoCoalescing, lastUndoEntry, undo } from "./12a-undo.js";
import { videoHostLabel } from "../adapters/formats/video-host.ts";
import { escapeHtml } from "../core/document/text-policy.ts";
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import { cellEditing, pickPictureFor } from "../legacy/editor-bridge.ts";
import { showActionToast, showToast } from "../legacy/effects-bridge.ts";
import { formatVideoLength } from "../../shared/text.js";
import { embeddableVideo } from "../../shared/video-embed.js";
import { runningOnDesktop } from "../application/desktop-presence.ts";
import { PREF_EVENT, preferences } from "../legacy/preferences-bridge.ts";
import { reviewMode } from "../legacy/location-bridge.ts";

var view = null;
var returnFocus = null;
var dragFrom = -1;

function modal() { return document.getElementById("gallery-modal"); }

function rowOf(rowId) {
  var idx = readSession(function (doc) { return rowIndexOf(doc, rowId); });
  return idx === -1 ? null : { row: S.state.rows[idx], index: idx };
}

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
  view = { rowId: rowId, sel: slot || 0, videos: !!videosOnly, playing: null, refused: null };
  var slots = rowSlots(got.row);
  var shown = shownSlots(slots);
  if (shown.indexOf(view.sel) === -1) view.sel = shown.length ? shown[0] : 0;
  document.getElementById("gallery-body").innerHTML = "";
  modal().hidden = false;
  paint();
  var picked = modal().querySelector(".scene-gallery-grid-tile.is-selected");
  if (picked) picked.focus({ preventScroll: true });
}

export function closeGalleryOverlay() {
  if (!view) return;
  closeZoom(true);
  var rowId = view.rowId;
  view = null;
  modal().hidden = true;
  document.getElementById("gallery-body").innerHTML = "";
  var back = returnFocus && returnFocus.isConnected && returnFocus !== document.body ? returnFocus
    : document.querySelector('#rows .scene-gallery[data-id="' + cssAttr(rowId) + '"] .scene-gallery-tile');
  if (back) back.focus({ preventScroll: true });
  returnFocus = null;
}

export function refreshGalleryOverlay() {
  if (!view) return;
  var got = rowOf(view.rowId);
  if (!got || !rowSlots(got.row).length) { closeGalleryOverlay(); return; }
  var hadFocus = modal().contains(document.activeElement);
  paint();
  if (zoom) {
    if (zoomSlots().indexOf(view.sel) === -1) closeZoom();
    else paintZoom();
    return;
  }
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
  var still = !!(slot.ref || slot.dataUrl);
  var pos = shown.indexOf(sel);
  var length = poster ? formatVideoLength(poster.duration) : "";
  var openLink = poster || slot.links[0] || null;
  var play = playState(poster);
  var playKey = play && play.can ? videoLinkKey(poster) : null;
  if (view.playing && view.playing !== playKey) view.playing = null;
  var playing = !!(playKey && view.playing === playKey);
  var stillKind = poster && poster.href ? "thumbnail" : "first frame";
  var about = (poster ? "Video " : "Picture ") + (sel + 1) + " of " + n +
    (poster ? ": " + videoLinkLabel(poster) + (length ? ", " + length : "") +
      (still ? ". " + stillKind.charAt(0).toUpperCase() + stillKind.slice(1) + " shown; " : ". No picture of it; ") +
      (play && play.can ? "Play plays it here; " : "") +
      (poster.href ? "Open link opens it in your browser" : "Open file plays it in your video player")
      : slot.name ? ": " + slot.name : "");
  var inner;
  if (playing) {
    inner = playerHtml(poster, play);
  } else {
    inner = gallerySlotPictureHtml(slot) +
      (poster && !still && !(play && (play.note || play.can)) ? '<svg class="scene-gallery-preview-none" aria-hidden="true"><use href="#i-camera"/></svg>' : '') +
      '<span class="scene-gallery-position">' + (pos + 1) + ' / ' + shown.length + '</span>' +
      (poster ? '<span class="scene-gallery-kind"><svg aria-hidden="true"><use href="#i-play"/></svg>' +
        (still ? 'Video · ' + stillKind : 'Video') + '</span>' : '') +
      (length ? '<span class="scene-gallery-length">' + length + '</span>' : '') +
      (play && play.can ? playButtonHtml(poster, play) : '') +
      (play && play.note ? noteHtml(poster, play.note) : '');
  }
  var group = playing || (play && (play.can || play.note));
  var zoomable = !poster && still;
  var picHtml =
      '<div class="scene-gallery-preview-pic' + (poster ? ' is-video' : '') + (playing ? ' is-playing' : '') +
        (play && play.note ? ' has-note' : '') + (zoomable ? ' is-zoomable' : '') + '"' +
        (playing ? ' data-play="' + escapeHtml(playKey) + '"' : '') +
        (zoomable
          ? ' data-gact="zoom" role="button" tabindex="0" title="Show at full size" aria-label="' +
            escapeHtml(about + ". Shows it at full size") + '">'
          : ' role="' + (group ? 'group' : 'img') + '" aria-label="' + escapeHtml(about) + '">') +
        inner +
      '</div>';
  var preview =
    '<div class="scene-gallery-preview">' +
      '<button type="button" class="scene-gallery-step" data-gact="prev" aria-label="Previous"' + (shown.length < 2 ? ' disabled' : '') + '>' +
        '<svg class="is-flipped" aria-hidden="true"><use href="#i-chevron"/></svg></button>' +
      picHtml +
      '<button type="button" class="scene-gallery-step" data-gact="next" aria-label="Next"' + (shown.length < 2 ? ' disabled' : '') + '>' +
        '<svg aria-hidden="true"><use href="#i-chevron"/></svg></button>' +
    '</div>';

  var caption = slot.links.length
    ? slot.links.map(function (l) {
        return '<div class="scene-gallery-line"><span class="scene-gallery-host">' + escapeHtml(videoHostLabel(l)) + '</span>' +
          '<button type="button" class="scene-gallery-link' + (l.href ? '' : ' is-file') + '" data-gact="link" data-key="' +
          escapeHtml(videoLinkKey(l)) + '" title="' + escapeHtml(l.href || l.name) + '">' + escapeHtml(videoLinkLabel(l)) + '</button></div>';
      }).join("")
    : '<div class="scene-gallery-line is-name">' + escapeHtml(slot.name || (poster ? "" : "Picture " + (sel + 1))) + '</div>';
  var retry = !review && poster && !still && embeddableVideo(poster) && thumbnailsAllowed()
    ? '<button type="button" class="btn-outline" data-gact="retry-thumb" data-key="' + escapeHtml(videoLinkKey(poster)) + '"' +
      (view.fetching === videoLinkKey(poster) ? ' disabled aria-busy="true"' : '') + '>Retry thumbnail</button>'
    : '';
  var annotate = review || poster || !slot.ref ? '' :
    '<button type="button" class="btn-outline" data-gact="annotate">' + PEN_ICON +
      (slot.annotation ? 'Edit annotations' : 'Annotate') + '</button>' +
    (slot.annotation ? '<button type="button" class="btn-outline" data-gact="unannotate" title="Go back to the picture as it was">Remove annotations</button>' : '');
  var buttons =
    (openLink ? openButtonHtml(openLink) : '') + retry + annotate +
    (review ? '' :
      '<button type="button" class="btn-outline" data-gact="cover"' + (sel === 0 ? ' disabled' : '') + '>' + COVER_ICON + 'Make cover</button>' +
      '<button type="button" class="scene-gallery-remove" data-gact="remove">Remove</button>');
  var hint = review || shown.length < 2 ? '' :
    '<p class="scene-gallery-hint"><svg aria-hidden="true"><use href="#i-grip"/></svg>Drag to reorder</p>';
  var actions = hint || buttons
    ? '<div class="scene-gallery-actions">' + hint + '<div class="scene-gallery-buttons">' + buttons + '</div></div>'
    : '';

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
      grid += '<li class="scene-gallery-divider" aria-hidden="true"><span>behind</span> ' +
        '<span class="scene-gallery-divider-count">+' + (n - 3) + '</span></li>';
    }
  });
  if (!review && !view.videos) {
    grid += '<li><button type="button" class="scene-gallery-grid-tile is-add" data-gact="add" aria-label="Add a picture">' +
      '<svg aria-hidden="true"><use href="#i-plus"/></svg></button></li>';
  }
  grid += '</ol>';
  var before = modal().querySelector(".scene-gallery-grid");
  var scrolled = before ? before.scrollTop : 0;
  var body = document.getElementById("gallery-body");
  var rest = '<div class="scene-gallery-preview-caption">' + caption + '</div>' + actions + grid;
  var livePic = playing ? body.querySelector(".scene-gallery-preview-pic.is-playing") : null;
  var livePreview = livePic && livePic.getAttribute("data-play") === playKey ? livePic.parentNode : null;
  if (livePreview && livePreview.parentNode === body) {
    while (livePreview.previousSibling) body.removeChild(livePreview.previousSibling);
    while (livePreview.nextSibling) body.removeChild(livePreview.nextSibling);
    livePreview.insertAdjacentHTML("afterend", rest);
    Array.prototype.forEach.call(livePreview.querySelectorAll(".scene-gallery-step"), function (b) { b.disabled = shown.length < 2; });
    livePic.setAttribute("aria-label", about);
  } else {
    body.innerHTML = preview + rest;
  }
  var after = modal().querySelector(".scene-gallery-grid");
  after.scrollTop = scrolled;
  revealPicked(after);
}

var OPEN_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5L11 13M17.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8.5A1.5 1.5 0 0 1 6 7h4.5"/></svg>';
var COVER_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="5" width="10" height="14" rx="1.5"/>' +
  '<rect x="16" y="5" width="4.5" height="6" rx="1"/><rect x="16" y="13" width="4.5" height="6" rx="1"/></svg>';
var PEN_ICON = '<svg aria-hidden="true"><use href="#i-pen"/></svg>';

function openButtonHtml(l) {
  var title = l.href
    ? "Opens " + videoLinkLabel(l) + (runningOnDesktop() ? " in your web browser" : " in a new tab")
    : "Plays " + l.name + " in your computer’s video player (desktop app)";
  return '<button type="button" class="btn-outline" data-gact="open" data-key="' + escapeHtml(videoLinkKey(l)) +
    '" title="' + escapeHtml(title) + '">' + OPEN_ICON + (l.href ? "Open link" : "Open file") + '</button>';
}

function playState(poster) {
  if (!poster) return null;
  var key = videoLinkKey(poster);
  if (poster.href) {
    var v = embeddableVideo(poster);
    if (!v) return null;
    var why = view.refused === key ? "The player couldn’t load here." : embedRefusal(v);
    return why ? { note: why } : { can: true, embed: v };
  }
  if (hasSessionVideo(poster)) return { can: true, file: true };
  return { note: "Only this video’s name is kept, so it can’t play here. Drop the file on this scene again to play it." };
}

function hostName(play) {
  return play.embed && play.embed.host === "vimeo" ? "Vimeo" : "YouTube";
}

function playButtonHtml(poster, play) {
  var label = videoLinkLabel(poster);
  var title = play.file ? "Play it here"
    : "Play it here. This loads " + hostName(play) + "’s player — nothing is asked of " + hostName(play) + " before you press play.";
  return '<button type="button" class="scene-gallery-playbtn" data-gact="play" aria-label="' + escapeHtml("Play " + label + " here") +
    '" title="' + escapeHtml(title) + '"><span aria-hidden="true"></span></button>';
}

function playerHtml(poster, play) {
  if (play.file) {
    var url = sessionVideoUrl(poster);
    return url ? '<video class="scene-gallery-player" src="' + escapeHtml(url) + '" controls autoplay playsinline></video>'
      : noteHtml(poster, "This video couldn’t be read here.");
  }
  var p = playerSrc(play.embed);
  if (!p) return noteHtml(poster, "The player couldn’t load here.");
  return '<iframe class="scene-gallery-player" src="' + escapeHtml(p.src) + '" data-src="' + escapeHtml(p.real) + '"' +
    ' title="' + escapeHtml(hostName(play) + " player: " + videoLinkLabel(poster)) + '"' +
    ' allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin"' +
    ' sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"></iframe>';
}

function noteHtml(poster, text) {
  return '<div class="scene-gallery-note"><p>' + escapeHtml(text) + '</p>' +
    '<button type="button" class="btn-outline is-small" data-gact="open" data-key="' + escapeHtml(videoLinkKey(poster)) + '">' +
    OPEN_ICON + (poster.href ? "Open link" : "Open file") + '</button></div>';
}

function startPlaying() {
  var slot = rowSlots(rowOf(view.rowId).row)[view.sel];
  var poster = slot && slotPoster(slot);
  var play = playState(poster);
  if (!play || !play.can) return;
  view.playing = videoLinkKey(poster);
  paint();
  var player = modal().querySelector(".scene-gallery-player");
  if (player) { try { player.focus({ preventScroll: true }); } catch (e) { } }
}

function retryThumbnail() {
  var rowId = view.rowId;
  var slot = rowSlots(rowOf(rowId).row)[view.sel];
  var poster = slot && slotPoster(slot);
  if (!poster || !poster.href || reviewMode()) return;
  var key = videoLinkKey(poster);
  var ctx = captureOperation();
  view.fetching = key;
  paint();
  fetchThumbnailRecord(poster.href).then(function (rec) {
    if (view && view.fetching === key) view.fetching = null;
    if (!stillOwns(ctx)) {
      if (view) refreshGalleryOverlay();
      return;
    }
    var done = rec && rowOf(rowId) && cellEditing().editGallery(rowId, "Thumbnail added", function (row) { return setVideoThumbnail(row, key, rec); });
    if (!done) showToast("Could not get this video’s thumbnail — you may be offline, or the video is private or gone.", "warn");
    if (view && view.rowId === rowId) refreshGalleryOverlay();
  });
}

function revealPicked(grid) {
  var tile = grid && grid.querySelector(".scene-gallery-grid-tile.is-selected");
  if (!tile) return;
  var g = grid.getBoundingClientRect();
  var t = tile.getBoundingClientRect();
  var room = 4;
  if (t.top - room < g.top) grid.scrollTop -= g.top - t.top + room;
  else if (t.bottom + room > g.bottom) grid.scrollTop += t.bottom - g.bottom + room;
}

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
  if (cellEditing().editGallery(rowId, "Moved to " + (to + 1), function (row) { return moveGallerySlot(row, from, to); })) {
    view.sel = to;
    refreshGalleryOverlay();
  }
}

function makeCover() {
  if (reviewMode() || !view.sel) return;
  var from = view.sel;
  var rowId = view.rowId;
  if (cellEditing().editGallery(rowId, "Made the cover", function (row) { return moveGallerySlot(row, from, 0); })) {
    view.sel = 0;
    refreshGalleryOverlay();
  }
}

function removeSelected() {
  if (reviewMode()) return;
  var at = view.sel;
  var rowId = view.rowId;
  var slot = rowSlots(rowOf(rowId).row)[at];
  var what = slotPoster(slot) ? "Video" : "Picture";
  cellEditing().editGallery(rowId, what + " removed", function (row) { return removeGallerySlot(row, at); });
  if (view) {
    view.sel = Math.max(0, at - 1);
    refreshGalleryOverlay();
  }
}

function removeAnnotations() {
  if (reviewMode()) return;
  var at = view.sel;
  var slot = rowSlots(rowOf(view.rowId).row)[at];
  if (!slot || !slot.annotation) return;
  var original = slot.annotation.imageRef;
  if (!cellEditing().editGallery(view.rowId, "Annotations removed", function (row) { return annotateGallerySlot(row, at, null, original, []); })) {
    showToast("Could not go back to the original — the gallery already shows that picture.", "warn");
    return;
  }
  var btn = modal().querySelector('[data-gact="annotate"]');
  if (btn) btn.focus({ preventScroll: true });
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
  else if (act === "annotate") appActions.invoke("annotate-picture", "button", { rowId: view.rowId, slot: view.sel });
  else if (act === "unannotate") removeAnnotations();
  else if (act === "all") { view.videos = false; paint(); }
  else if (act === "play") startPlaying();
  else if (act === "zoom") openZoom();
  else if (act === "retry-thumb") retryThumbnail();
  else if (act === "open" || act === "link") appActions.invoke("open-picture-link", "button", { rowId: view.rowId, slot: view.sel, key: el.getAttribute("data-key") });
  else if (act === "add") pickPictureFor(view.rowId);
}

function onKeydown(e) {
  if (!view) return;
  if (zoom) { onZoomKeydown(e); return; }
  if ((e.key === "Enter" || e.key === " ") && e.target && e.target.classList &&
      e.target.classList.contains("is-zoomable") && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    openZoom();
    return;
  }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeGalleryOverlay(); return; }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target && e.target.classList && e.target.classList.contains("scene-gallery-player")) return;
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

var zoom = null;
var ZOOM_PAD = 48;

function zoomEl() { return document.getElementById("gallery-zoom"); }
function zoomStage() { return document.getElementById("gallery-zoom-stage"); }

function zoomSlots() {
  if (!view) return [];
  var got = rowOf(view.rowId);
  if (!got) return [];
  var slots = rowSlots(got.row);
  return shownSlots(slots).filter(function (i) {
    var s = slots[i];
    return !slotPoster(s) && !!(s.ref || s.dataUrl);
  });
}

function openZoom() {
  if (!view || zoomSlots().indexOf(view.sel) === -1) return;
  zoom = { w: 0, h: 0, s: 1, x: 0, y: 0, full: false, pan: null, moved: false };
  zoomEl().hidden = false;
  paintZoom();
  zoomEl().focus({ preventScroll: true });
}

function closeZoom(quiet) {
  if (!zoom) return;
  zoom = null;
  zoomEl().hidden = true;
  zoomStage().innerHTML = "";
  if (quiet) return;
  var pic = modal().querySelector(".scene-gallery-preview-pic.is-zoomable");
  if (pic) pic.focus({ preventScroll: true });
}

function paintZoom() {
  var slots = rowSlots(rowOf(view.rowId).row);
  var slot = slots[view.sel];
  var stage = zoomStage();
  stage.innerHTML = gallerySlotPictureHtml(slot);
  var img = stage.querySelector("img");
  img.className = "scene-gallery-zoom-img";
  img.draggable = false;
  img.alt = slot.name || "Picture " + (view.sel + 1);
  zoom.full = false;
  zoom.w = slot.ref ? slot.ref.width | 0 : 0;
  zoom.h = slot.ref ? slot.ref.height | 0 : 0;
  var measure = function () {
    if (!zoom || img !== zoomStage().querySelector("img")) return;
    if (img.naturalWidth) { zoom.w = img.naturalWidth; zoom.h = img.naturalHeight; }
    layoutZoom();
  };
  if (img.complete && img.naturalWidth) measure();
  else { img.addEventListener("load", measure); if (zoom.w) layoutZoom(); }
}

function clampAxis(pos, size, room) {
  return size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, pos));
}

function fitScale() {
  var W = window.innerWidth, H = window.innerHeight;
  var pad = W < 600 ? 16 : ZOOM_PAD;
  return Math.min(1, (W - 2 * pad) / zoom.w, (H - 2 * pad) / zoom.h);
}

function layoutZoom(keep) {
  if (!zoom || !zoom.w || !zoom.h) return;
  var fit = fitScale();
  var big = fit < 1;
  if (!big) zoom.full = false;
  var s = zoom.full ? 1 : fit;
  if (!keep) { zoom.x = (window.innerWidth - zoom.w * s) / 2; zoom.y = (window.innerHeight - zoom.h * s) / 2; }
  zoom.s = s;
  zoom.x = clampAxis(zoom.x, zoom.w * s, window.innerWidth);
  zoom.y = clampAxis(zoom.y, zoom.h * s, window.innerHeight);
  var img = zoomStage().querySelector("img");
  if (img) {
    img.style.width = zoom.w + "px";
    img.style.height = zoom.h + "px";
    img.style.transform = "translate(" + zoom.x + "px, " + zoom.y + "px) scale(" + s + ")";
  }
  var stage = zoomStage();
  stage.classList.toggle("can-zoom-in", big && !zoom.full);
  stage.classList.toggle("can-zoom-out", big && zoom.full);
  zoomInfo();
}

function zoomInfo() {
  var slots = rowSlots(rowOf(view.rowId).row);
  var slot = slots[view.sel];
  var pics = zoomSlots();
  var parts = [];
  if (zoom.w) parts.push('<span class="scene-gallery-zoom-dims">' + zoom.w + ' × ' + zoom.h + '</span>');
  if (slot.name) parts.push('<span class="scene-gallery-zoom-name">' + escapeHtml(slot.name) + '</span>');
  if (zoom.w) parts.push('<span>' + Math.round(zoom.s * 100) + '%</span>');
  if (pics.length > 1) parts.push('<span>' + (pics.indexOf(view.sel) + 1) + ' / ' + pics.length + '</span>');
  document.getElementById("gallery-zoom-info").innerHTML = parts.join('<span aria-hidden="true">·</span>');
}

function zoomTo(full, px, py) {
  if (!zoom || !zoom.w || fitScale() >= 1 || zoom.full === full) return;
  var s1 = full ? 1 : fitScale();
  var u = (px - zoom.x) / zoom.s, v = (py - zoom.y) / zoom.s;
  zoom.full = full;
  zoom.x = px - u * s1;
  zoom.y = py - v * s1;
  var stage = zoomStage();
  stage.classList.add("is-animating");
  clearTimeout(zoomTo.t);
  zoomTo.t = setTimeout(function () { stage.classList.remove("is-animating"); }, 260);
  layoutZoom(true);
}

function zoomStep(by) {
  var pics = zoomSlots();
  if (pics.length < 2) return;
  var k = pics.indexOf(view.sel);
  view.sel = pics[(k + by + pics.length) % pics.length];
  paint();
  paintZoom();
}

function onZoomKeydown(e) {
  var k = e.key;
  if (k === "Escape") { e.preventDefault(); e.stopPropagation(); closeZoom(); return; }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (k === "ArrowLeft" || k === "ArrowRight") {
    e.preventDefault();
    zoomStep(k === "ArrowRight" ? 1 : -1);
  } else if ((k === "Enter" || k === " ") && e.target === zoomEl()) {
    e.preventDefault();
    zoomTo(!zoom.full, window.innerWidth / 2, window.innerHeight / 2);
  } else if (k === "Tab") {
    e.preventDefault();
    var close = document.getElementById("gallery-zoom-close");
    (document.activeElement === close ? zoomEl() : close).focus({ preventScroll: true });
  }
}

function onZoomClick(e) {
  e.stopPropagation();
  if (!zoom) return;
  if (zoom.moved) { zoom.moved = false; return; }
  if (e.target.closest("#gallery-zoom-close")) { closeZoom(); return; }
  if (e.target.classList.contains("scene-gallery-zoom-img") && fitScale() < 1) {
    zoomTo(!zoom.full, e.clientX, e.clientY);
    return;
  }
  if (e.target.classList.contains("scene-gallery-zoom-img")) return;
  closeZoom();
}

function onZoomWheel(e) {
  if (!zoom) return;
  e.preventDefault();
  if (e.deltaY < 0) zoomTo(true, e.clientX, e.clientY);
  else if (e.deltaY > 0) zoomTo(false, e.clientX, e.clientY);
}

function onZoomPointerDown(e) {
  if (!zoom || !zoom.full || e.button !== 0 || !e.target.classList.contains("scene-gallery-zoom-img")) return;
  e.preventDefault();
  zoom.pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: zoom.x, y: zoom.y };
  zoomStage().classList.remove("is-animating");
  zoom.moved = false;
}

function onZoomPointerMove(e) {
  if (!zoom || !zoom.pan || e.pointerId !== zoom.pan.id) return;
  var dx = e.clientX - zoom.pan.sx, dy = e.clientY - zoom.pan.sy;
  if (!zoom.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  if (!zoom.moved) {
    try { zoomStage().setPointerCapture(e.pointerId); } catch (err) {}
  }
  zoom.moved = true;
  zoomStage().classList.add("is-dragging");
  zoom.x = zoom.pan.x + dx;
  zoom.y = zoom.pan.y + dy;
  layoutZoom(true);
}

function onZoomPointerUp(e) {
  if (!zoom || !zoom.pan || e.pointerId !== zoom.pan.id) return;
  zoom.pan = null;
  zoomStage().classList.remove("is-dragging");
}

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
  var z = zoomEl();
  if (z) {
    z.addEventListener("click", onZoomClick);
    z.addEventListener("wheel", onZoomWheel, { passive: false });
    z.addEventListener("pointerdown", onZoomPointerDown);
    z.addEventListener("pointermove", onZoomPointerMove);
    z.addEventListener("pointerup", onZoomPointerUp);
    z.addEventListener("pointercancel", onZoomPointerUp);
    window.addEventListener("resize", function () { if (zoom) layoutZoom(true); });
  }
  document.addEventListener("securitypolicyviolation", function (e) {
    if (!view || !view.playing) return;
    if (!/^(frame-src|child-src|default-src)/.test(e.effectiveDirective || e.violatedDirective || "")) return;
    view.refused = view.playing;
    view.playing = null;
    paint();
  });
  document.addEventListener(PREF_EVENT, function (e) {
    if (e.detail && preferences().nameOf(e.detail.key) === "videoThumbs") refreshGalleryOverlay();
  });
}
