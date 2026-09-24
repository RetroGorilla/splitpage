import { S } from "./_state.js";
import { PREF_EVENT, VIDEO_THUMBS_KEY } from "./00p-prefs.js";
import { escapeHtml } from "./02-state.js";
import { moveGallerySlot, removeGallerySlot, rowSlots, setVideoThumbnail, videoLinkKey, videoLinkLabel } from "./02d-gallery.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { cssAttr } from "./04-richtext.js";
import {
  formatVideoLength,
  galleryBadgeHtml,
  gallerySlotPictureHtml,
  render,
  slotPoster,
  videoHostLabel
} from "./05-render.js";
import { embeddableVideo, embedRefusal, fetchThumbnailRecord, playerSrc, thumbnailsAllowed } from "./05v-video.js";
import { hasSessionVideo, openGalleryLink, sessionVideoUrl } from "./06-rows.js";
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

   Drawn as Direction B's B-GalleryDialog (#169). The preview is a still —
   a picture, a video file's first frame, a web video's fetched thumbnail
   (#141) — on a dark monitor. A small pill says what the still is ("▶
   Video · first frame", "▶ Video · thumbnail"), and the length sits
   opposite.

   Some videos PLAY there (#168), and only there — never in the script's
   own tiles, so scrolling a script never contacts anyone: a YouTube or
   Vimeo link (05v-video.js: YouTube's no-cookie embed, Vimeo's player
   with dnt=1), and a video file dropped or pasted in since this page
   opened (a blob: URL made from the File this page still holds,
   06-rows.js). Click to play: the still carries a play button, and
   nothing is asked of YouTube or Vimeo until it is pressed. The player
   then takes the still's place; picking another item, closing the
   dialog, or anything that repaints it for another item removes it, and
   with it the playback. A repaint for the same item (an undo, a merge,
   the grid) leaves a playing player where it is. What cannot play here
   says so on the still and offers the way it opens instead: a file this
   page no longer holds (only its name is in the document), YouTube in a
   copy opened from disk, a player the page's policy refused.

   The button that opens a video says how ("Open file" plays it in the
   computer's own player, through the desktop app; "Open link" opens the
   address in the browser), and its title says where. A web video with no
   picture offers "Retry thumbnail" while Settings lets thumbnails be
   fetched.

   Reordering: drag a tile onto another, or Shift+← / Shift+→ on the picked
   one. ← / → pick, Delete removes, Esc closes. Make cover, Remove, a move
   and an add are each one undo step (the document's own undo, 12a-undo.js)
   with a toast that offers it. The dialog always draws from state, so an
   undo from anywhere repaints it (refreshGalleryOverlay, called by
   render/renderRow). All of it is .scene-gallery*; the markup lives in
   page.html as #gallery-modal. */

var view = null;          /* {rowId, sel, videos, playing, refused} while open:
                             playing is the videoLinkKey of the video whose
                             player is up, refused the one whose player the
                             page's policy turned away */
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
  view = { rowId: rowId, sel: slot || 0, videos: !!videosOnly, playing: null, refused: null };
  var slots = rowSlots(got.row);
  var shown = shownSlots(slots);
  if (shown.indexOf(view.sel) === -1) view.sel = shown.length ? shown[0] : 0;
  /* the last scene's grid goes, so its scroll is not carried over (paint) */
  document.getElementById("gallery-body").innerHTML = "";
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
  /* a player goes with the dialog, and its playback with it */
  document.getElementById("gallery-body").innerHTML = "";
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
  var still = !!(slot.ref || slot.dataUrl);
  var pos = shown.indexOf(sel);
  var length = poster ? formatVideoLength(poster.duration) : "";
  var openLink = poster || slot.links[0] || null;
  var play = playState(poster);
  var playKey = play && play.can ? videoLinkKey(poster) : null;
  if (view.playing && view.playing !== playKey) view.playing = null;
  var playing = !!(playKey && view.playing === playKey);
  /* A web video's still is its fetched thumbnail (#141); a file's, its
     first frame. */
  var stillKind = poster && poster.href ? "thumbnail" : "first frame";
  /* What the still is, for a screen reader: the monitor is one image, its
     pills part of it — or, when it holds a play button or a note, a group
     named the same way. */
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
  var picHtml =
      '<div class="scene-gallery-preview-pic' + (poster ? ' is-video' : '') + (playing ? ' is-playing' : '') +
        (play && play.note ? ' has-note' : '') + '"' +
        (playing ? ' data-play="' + escapeHtml(playKey) + '"' : '') +
        ' role="' + (group ? 'group' : 'img') + '" aria-label="' + escapeHtml(about) + '">' +
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
  /* a YouTube or Vimeo link with no picture: ask the site again (#141) */
  var retry = !review && poster && !still && embeddableVideo(poster) && thumbnailsAllowed()
    ? '<button type="button" class="btn-outline" data-gact="retry-thumb" data-key="' + escapeHtml(videoLinkKey(poster)) + '"' +
      (view.fetching === videoLinkKey(poster) ? ' disabled aria-busy="true"' : '') + '>Retry thumbnail</button>'
    : '';
  var buttons =
    (openLink ? openButtonHtml(openLink) : '') + retry +
    (review ? '' :
      '<button type="button" class="btn-outline" data-gact="cover"' + (sel === 0 ? ' disabled' : '') + '>' + COVER_ICON + 'Make cover</button>' +
      '<button type="button" class="scene-gallery-remove" data-gact="remove">Remove</button>');
  /* the hint only where a drag does something: not in review, and not
     when the grid holds one tile */
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
      /* the word over the count, a dashed rule above and below (app.css) */
      grid += '<li class="scene-gallery-divider" aria-hidden="true"><span>behind</span> ' +
        '<span class="scene-gallery-divider-count">+' + (n - 3) + '</span></li>';
    }
  });
  if (!review && !view.videos) {
    grid += '<li><button type="button" class="scene-gallery-grid-tile is-add" data-gact="add" aria-label="Add a picture">' +
      '<svg aria-hidden="true"><use href="#i-plus"/></svg></button></li>';
  }
  grid += '</ol>';
  /* the grid scrolls past two rows (app.css): keep where it was across a
     repaint, and bring the picked tile into it */
  var before = modal().querySelector(".scene-gallery-grid");
  var scrolled = before ? before.scrollTop : 0;
  var body = document.getElementById("gallery-body");
  var rest = '<div class="scene-gallery-preview-caption">' + caption + '</div>' + actions + grid;
  /* A player already up for this same video stays exactly where it is —
     a frame taken out of the page and put back would start again — and
     everything round it is drawn afresh. */
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

/* B-GalleryDialog's two glyphs that are not in the sprite (#169): "open
   elsewhere" (a box with an arrow leaving it) and "make cover" (a large
   frame beside two small ones, the cell's mosaic). */
var OPEN_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5L11 13M17.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8.5A1.5 1.5 0 0 1 6 7h4.5"/></svg>';
var COVER_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="5" width="10" height="14" rx="1.5"/>' +
  '<rect x="16" y="5" width="4.5" height="6" rx="1"/><rect x="16" y="13" width="4.5" height="6" rx="1"/></svg>';

/* The button that opens a video, saying how: a file plays in the
   computer's own player (the desktop app hands it over — openVideoFile,
   06-rows.js — and says so in a toast anywhere else); an address opens in
   the browser. Its title says where. */
function openButtonHtml(l) {
  var title = l.href
    ? "Opens " + videoLinkLabel(l) + (S.DESKTOP ? " in your web browser" : " in a new tab")
    : "Plays " + l.name + " in your computer’s video player (desktop app)";
  return '<button type="button" class="btn-outline" data-gact="open" data-key="' + escapeHtml(videoLinkKey(l)) +
    '" title="' + escapeHtml(title) + '">' + OPEN_ICON + (l.href ? "Open link" : "Open file") + '</button>';
}

/* ---- playing it here (#168) ----

   What the preview can do with the picked item's video: {can: true,
   embed} for a YouTube or Vimeo link, {can: true, file: true} for a file
   this page still holds, {note} for one it cannot play — and why, in
   words — or null for a picture or another site's link, which stay as
   they were. */
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

/* The big ▶ over the still. For a web video its title says what pressing
   it does: it is the first time the site is asked for anything. */
function playButtonHtml(poster, play) {
  var label = videoLinkLabel(poster);
  var title = play.file ? "Play it here"
    : "Play it here. This loads " + hostName(play) + "’s player — nothing is asked of " + hostName(play) + " before you press play.";
  return '<button type="button" class="scene-gallery-playbtn" data-gact="play" aria-label="' + escapeHtml("Play " + label + " here") +
    '" title="' + escapeHtml(title) + '"><span aria-hidden="true"></span></button>';
}

/* The player in the still's place: a <video> over the file's blob: URL, or
   the site's player in a frame that may run the player's own scripts and
   open its own links in a new window, and nothing else — no navigating
   this page, no forms. */
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

/* Why it cannot play here, on the still, with the way it does open. */
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
  if (player) { try { player.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ } }
}

/* "Retry thumbnail": the picked web video's thumbnail, asked for again —
   one gallery edit when it comes, a word when it does not. */
function retryThumbnail() {
  var rowId = view.rowId;
  var slot = rowSlots(rowOf(rowId).row)[view.sel];
  var poster = slot && slotPoster(slot);
  if (!poster || !poster.href || reviewMode()) return;
  var key = videoLinkKey(poster);
  view.fetching = key;
  paint();
  fetchThumbnailRecord(poster.href).then(function (rec) {
    if (view && view.fetching === key) view.fetching = null;
    var done = rec && rowOf(rowId) && galleryEdit(rowId, "Thumbnail added", function (row) { return setVideoThumbnail(row, key, rec); });
    if (!done) showToast("Couldn’t get this video’s thumbnail — you may be offline, or the video is private or gone.", "warn");
    if (view && view.rowId === rowId) refreshGalleryOverlay();
  });
}

/* Scrolls the grid, and only the grid, so the picked tile and its outline
   are in view — focus() is called with preventScroll, which would
   otherwise leave it hidden below the second row. */
function revealPicked(grid) {
  var tile = grid && grid.querySelector(".scene-gallery-grid-tile.is-selected");
  if (!tile) return;
  var g = grid.getBoundingClientRect();
  var t = tile.getBoundingClientRect();
  var room = 4;   /* the selected outline: 2px, 2px out */
  if (t.top - room < g.top) grid.scrollTop -= g.top - t.top + room;
  else if (t.bottom + room > g.bottom) grid.scrollTop += t.bottom - g.bottom + room;
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
    refreshGalleryOverlay();
  }
}

function makeCover() {
  if (reviewMode() || !view.sel) return;
  var from = view.sel;
  var rowId = view.rowId;
  if (galleryEdit(rowId, "Made the cover", function (row) { return moveGallerySlot(row, from, 0); })) {
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
  galleryEdit(rowId, what + " removed", function (row) { return removeGallerySlot(row, at); });
  if (view) {
    view.sel = Math.max(0, at - 1);
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
  else if (act === "play") startPlaying();
  else if (act === "retry-thumb") retryThumbnail();
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
  /* a playing <video>'s own keys: ← → seek it, rather than pick */
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
  /* A player the page's policy turned away would be an empty frame: say
     so instead, and offer the link (#168). */
  document.addEventListener("securitypolicyviolation", function (e) {
    if (!view || !view.playing) return;
    if (!/^(frame-src|child-src|default-src)/.test(e.effectiveDirective || e.violatedDirective || "")) return;
    view.refused = view.playing;
    view.playing = null;
    paint();
  });
  /* Settings ▸ Fetch video thumbnails decides whether Retry is offered */
  document.addEventListener(PREF_EVENT, function (e) {
    if (e.detail && e.detail.key === VIDEO_THUMBS_KEY) refreshGalleryOverlay();
  });
}
