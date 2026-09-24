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
import { escapeHtml, makeId } from "./02-state.js";
import { blobImgHtml } from "./02c-blobs.js";
import { rowSlots, videoLinkKey, videoLinkLabel } from "./02d-gallery.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { buildVideoCardEl, cssAttr, ensureTrailingCaretSpot, safeHref, sanitizeHtml, storedHtmlFromDom } from "./04-richtext.js";
import {
  breakLine,
  cellLength,
  fromHtml,
  insertText,
  markThroughout,
  setMark,
  toHtml,
  toggleMark,
  typingMarks
} from "./04c-doc-model.js";
import { cellSelection, editCell } from "./05b-cell-edit.js";
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

/* The script's format toolbar is icons (#169): 32px buttons on the raised
   floating layer, the four letter formats as the letters themselves, the
   rest as the sprite's strokes — every one named for a screen reader. */
function tbIcon(id) { return '<svg class="tb-icon" aria-hidden="true"><use href="#' + id + '"/></svg>'; }

var COMMENT_BUTTON_HTML = '<button type="button" data-cmd="comment" title="Comment on selected text" aria-label="Comment">' + tbIcon("i-comment") + '</button>';

var CELL_TOOLBARS = {
  script: {
    label: "Text formatting",
    buttons:
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
        tbIcon("i-tag") + '<svg class="tb-chevron" aria-hidden="true"><use href="#i-chevron-down"/></svg></button>'
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

/* The gutter (#169): the scene number and where it starts in the
   programme, then its status as a labelled lamp — nothing else at rest.
   The drag grip and a "⋯" menu (Move up, Move down, Insert scene, Delete)
   come up on the row's hover or focus (app.css), where the four buttons
   that used to sit on every scene now live: the same buttons, the same
   data-actions and the same handlers (onRootClick, 21-events.js), one
   click further in. Alt+Up / Alt+Down and Ctrl+Enter still do the same
   from the keyboard without opening anything.

   The start time and the rail's read time are left empty here and filled
   in by paintRowTimes() below: typing in one scene moves the start of
   every scene after it, and that must not cost a repaint of every gutter.

   Reordering, status, insert/delete and the image controls are all
   document writes the server would refuse from a review session — so
   they are not rendered at all rather than rendered and then refused.
   The scene number, its times and its status still show: this is a
   reader's view of the script, not a stripped-down one. */
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
            escapeHtml(String(row.updatedBy).split(/\s+/)[0]) + '<br>' + formatTimestamp(row.updatedAt) + '</div>'
        : '') +
    '</div>'
  );
}

/* Each scene's start in the programme (the gutter) and its read time (the
   rail), for every scene on screen, from the same rowSeconds() the header
   total and the rundown strip read. Text only, and only where it changed:
   no part is repainted and no signature moves, which is what lets it run
   from the idle refresh while someone is typing (updateScriptStats,
   01-scene-status.js) — tests/67-render-perf.txt still sees no row
   painted. */
export function paintRowTimes() {
  var rowsEl = document.getElementById("rows");
  if (!rowsEl || !S.state) return;
  var byId = {};
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

/* The rail's Read time (#179) is a button: a click sets the scene's length
   by hand (05r-read-time.js). A set length is drawn as a chip, and turns
   the Audio amber when the words now read longer than it; an estimate is
   plain figures. Written only where something changed, like the text. */
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
  /* aria-disabled rather than disabled: a disabled button shows no
     tooltip, and a reviewer should still be able to read "Set by hand" */
  var ro = review ? "true" : "false";
  if (btn.getAttribute("aria-disabled") !== ro) btn.setAttribute("aria-disabled", ro);
}

function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/* The row menu's Delete asks twice (armDelete, 06-rows.js): armed, it says
   what the second click does; disarmed — the timer ran out, a render came
   through, another scene's Delete was armed — it says Delete again. Only
   the label changes: the icon is its sibling and stays put. */
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

/* The picture is either a legacy inline data: URI, shown as it always was,
   or an imageRef (#82), shown through blobImgHtml: src when this page
   already holds the bytes, otherwise data-blob alone for the hydrator
   (02c-blobs.js) to fill in after ensureBytes. The src is part of the
   string, so the part repaints once the bytes are here — the signature
   stays the markup, and render() stays synchronous. */
/* ---- the scene gallery in the cell (#135) ----

   The Image section is a gallery (02d-gallery.js), drawn as a capped
   mosaic: one item is the picture as it always was; two to four are a
   cover spanning three rows on the left with the rest stacked on the
   right; five or more show the cover, items 2 and 3, and a "+N" tile —
   the 4th item's picture under a tint — that opens the gallery's dialog
   (05e-gallery-overlay.js), as a click on any tile does. A slot whose
   link is its `poster` is a video's tile: a play badge, and its length on
   the cover when known. Under the mosaic, one line per video link, at
   most three, then "+N more videos". Everything here is .scene-gallery*;
   its styles are one block of app.css. */
var GALLERY_CELL_MAX = 4;
var GALLERY_CAPTION_MAX = 3;

/* The link a slot's picture is the thumbnail of, or null. */
export function slotPoster(slot) {
  return slot.links.filter(function (l) { return l.poster; })[0] || null;
}

export function formatVideoLength(sec) {
  if (!(sec > 0)) return "";
  var s = Math.round(sec);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + (m < 10 ? "0" : "") + m : m) + ":" + (r < 10 ? "0" : "") + r;
}

/* A slot's picture as tile content: the picture, or the video placeholder. */
export function gallerySlotPictureHtml(slot) {
  if (slot.ref) return blobImgHtml(slot.ref);
  if (slot.dataUrl) return '<img src="' + escapeHtml(slot.dataUrl) + '" alt="">';
  return '<span class="scene-gallery-placeholder" aria-hidden="true"></span>';
}

/* The play badge on a video's tile; `big` on the cover. */
export function galleryBadgeHtml(big) {
  return '<span class="scene-gallery-play' + (big ? ' is-big' : '') + '" aria-hidden="true"></span>';
}

/* A host's short name for a caption line: a known video site, or the
   address's own host; a file is a file. */
export function videoHostLabel(l) {
  if (!l.href) return "File";
  var host;
  try { host = new URL(l.href).hostname.replace(/^www\./i, "").toLowerCase(); } catch (e) { return "Link"; }
  var known = { "youtube.com": "YouTube", "youtu.be": "YouTube", "youtube-nocookie.com": "YouTube", "vimeo.com": "Vimeo",
    "player.vimeo.com": "Vimeo", "loom.com": "Loom", "dailymotion.com": "Dailymotion", "dai.ly": "Dailymotion",
    "twitch.tv": "Twitch", "tiktok.com": "TikTok", "wistia.com": "Wistia", "frame.io": "Frame.io", "vidyard.com": "Vidyard",
    "streamable.com": "Streamable" };
  return known[host] || host;
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

/* Every video link in the gallery, in slot order, with its slot. */
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
    /* The empty slot (#169): nothing at rest — it used to be a "📎 Image"
       label on every scene — and a dashed "Add picture" when the row is
       pointed at or has focus (app.css). Dropping a file anywhere on the
       Visual column still adds one without it (imageDropTarget). */
    imageBlock =
      '<button type="button" class="image-clip" data-action="image-add" data-id="' + row.id +
        '" title="Add a picture — or drag one anywhere onto this scene’s visual column">' +
        '<svg class="clip-icon" aria-hidden="true"><use href="#i-image"/></svg>Add picture</button>';
  }
  return '<div class="visual-media' + (img ? '' : ' is-empty') + '" data-id="' +
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

/* The picture sits under the Visual words (#169), where it used to sit
   over them; the parts are found by class, not position (rowPartEl), so
   the order is free. The rail is the fourth column: the scene's read time,
   right-aligned — filled in by paintRowTimes(), so it is not a part and
   never needs repainting. */
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
     field-wrap — a replaced part took its mark with it. So do the times
     paintRowTimes() writes into a gutter: a new one comes up empty. */
  if (touched) paintPresence();
  if (touched) paintRowTimes();
  /* a scene gallery's dialog shows this row's pictures (#135) */
  if (touched) refreshGalleryOverlay();
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
  document.querySelectorAll("#rows .gutter-btn.danger.armed").forEach(disarmDeleteButton);
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
  /* A document the undo stack has not seen (just opened, restored or
     replaced) is copied before it can be edited (12a-undo.js). */
  trackDocument();
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
  /* An open scene gallery dialog draws from state too (#135) */
  refreshGalleryOverlay();
  /* A link popover's saved selection is only good while its cell is still
     in the page — a reused field keeps it, a repainted one does not. */
  if (S.savedRangeCell && !S.savedRangeCell.isConnected) {
    S.savedRange = null;
    S.savedRangeCell = null;
  }
}

/* ================= field sync ================= */

export function syncFieldFromDom(cellEl) {
  /* A cell a repaint has already replaced holds what the document USED to
     say — reading it back would put that over whatever replaced it. This is
     how an undo's repaint (12a-undo.js) was being reverted by the focusout
     of the very cell it repainted. And nothing is read back while an undo
     or a redo is being put on screen, or while editCell repaints the cell
     it has just written (the one being replaced is still connected when
     the browser tells it it lost focus). */
  if (!cellEl.isConnected || S.undoApplying || S.cellRepainting) return;
  var id = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  var idx = findRowIndex(id);
  if (idx !== -1) {
    /* Strips the zero-width caret spot ensureTrailingCaretSpot() may have
       appended after a trailing tag/b-roll span — it exists only to give
       the DOM a place to put the caret and must never reach stored text. */
    var html = cellEl.innerHTML.indexOf("\u200B") === -1 ? cellEl.innerHTML : cellEl.innerHTML.replace(/\u200B/g, "");
    /* ...and so is the src the hydrator (02c-blobs.js) gave every
       <img data-blob> on screen: state names a picture by its sha only (#82). */
    html = storedHtmlFromDom(html);
    /* Into state in the document model's one form (#85): read through the
       model and written back out, so what a keystroke stores is already
       sanitised and canonical — not the raw DOM the sanitiser used to catch
       up with only on blur — and a re-serialisation is never a change the
       undo stack or a merge can see. The live DOM is left exactly as it is;
       noteFieldPainted below records that it shows this content. A cell
       still holding a picture or a video card (pasted in before design D7
       kept them out of script text) keeps the sanitiser's form, since the
       model has no place for either. */
    html = /<img|video-embed-card/.test(html) ? sanitizeHtml(html) : toHtml(fromHtml(html));
    if (S.state.rows[idx][field] !== html) {
      S.state.rows[idx][field] = html;
      stampRow(S.state.rows[idx]);
      markDirty();
    }
    noteFieldPainted(cellEl, field, S.state.rows[idx]);
  }
}

/* ================= rich text commands =================

   Every one of these is an edit through the document model (#85, design
   §5), never execCommand: its output differed by browser (<b>, <span
   style="font-weight: bold">), and its toggle decision read the live DOM
   rather than the text. The toggle is decided by what the model says the
   selection holds, and the result is written as canonical HTML.

   In a script cell — a row field in #rows, a writer paragraph — the edit
   is editCell's (05b-cell-edit.js): written into state, one entry on the
   document's undo stack. In a comment composer or a reply box, which is not
   a document cell, it is editDraft's (05d-draft-edit.js): the same model
   with the box's pictures and video cards lifted out and put back, and one
   entry on that box's own undo history, which is what Ctrl+Z there
   answers from. */

/* A row field, in the split view or the writer — the writer's paragraphs
   carry the same data-id/data-field and the same row behind them. The
   comment composer and every reply box reuse .cell-editable too, and the
   shared input handlers (21-events.js) gate everything that only makes
   sense in the script on this. */
export function isScriptCell(cellEl) {
  return !!(cellEl && cellEl.closest("#rows, #writer-doc") && cellEl.getAttribute("data-field"));
}

/* The toolbar's and the keyboard's command names, as model marks. */
var FORMAT_MARKS = { bold: "b", italic: "i", underline: "u", strikeThrough: "s", highlight: "hl" };

/* The edit through the model: editCell for a script cell, editDraft for a
   comment or reply box. fn(cell, sel, media) as editCell takes it; media
   is the draft's placeholder table (05d-draft-edit.js) and undefined in a
   script cell. Null when this cell is not one either edits (a script cell
   holding a picture, which none does since design D7), and nothing is
   done; otherwise the cell element to carry on with — a repaint in #rows
   replaces it — whether or not fn changed anything. */
function throughModel(cellEl, fn) {
  var ran = false;
  function run(cell, sel, media) {
    ran = true;
    return fn(cell, sel, media);
  }
  var fresh = isScriptCell(cellEl) ? editCell(cellEl, run) : isDraftBox(cellEl) ? editDraft(cellEl, run) : null;
  return ran ? (fresh || cellEl) : null;
}

/* ---- pending marks: B/I/U with nothing selected ----

   With a caret and no selection, Ctrl+B means "what I type next is bold".
   The browser's execCommand kept that as a hidden typing style; here it is
   this note of
   which marks to turn on or off, good for one cell and one caret position.
   The next character typed there (typePendingMarks, from beforeinput) goes
   in through the model with them, and the browser's own typing carries on
   inside the formatting that character now sits in. Moving the caret
   anywhere else forgets it (forgetStalePendingMarks, on selectionchange),
   as the browser's typing style did. */
var pendingMarks = null;          /* {cell, pos, marks: {b: true|false, ...}} */

function pendingAt(cellEl, pos) {
  return pendingMarks && pendingMarks.cell === cellEl && pendingMarks.pos === pos ? pendingMarks.marks : null;
}

/* What a character typed at pos would carry: the model's typing marks with
   any pending toggles over them. */
function marksForTyping(cellEl, cell, pos) {
  var m = typingMarks(cell, pos);
  var p = pendingAt(cellEl, pos);
  if (p) Object.keys(p).forEach(function (k) { if (p[k]) m[k] = true; else delete m[k]; });
  return m;
}

function togglePendingMark(cellEl, cell, pos, mark) {
  var p = pendingAt(cellEl, pos) || {};
  var on = !marksForTyping(cellEl, cell, pos)[mark];
  /* toggled back to what typing there gives anyway: nothing pending */
  if (on === !!typingMarks(cell, pos)[mark]) delete p[mark]; else p[mark] = on;
  pendingMarks = Object.keys(p).length ? { cell: cellEl, pos: pos, marks: p } : null;
}

export function forgetStalePendingMarks() {
  if (!pendingMarks) return;
  var c = pendingMarks.cell;
  var sel = c.isConnected && document.activeElement === c ? cellSelection(c) : null;
  if (!sel || sel.from !== sel.to || sel.from !== pendingMarks.pos) pendingMarks = null;
}

/* beforeinput's insertText, when marks are pending at the caret: the text
   goes in through the model carrying them, instead of the browser typing
   it. Returns the cell element to carry on with, or null to let the
   browser type as usual. */
export function typePendingMarks(cellEl, text) {
  if (!pendingMarks || pendingMarks.cell !== cellEl || !text) return null;
  var typed = false;
  var fresh = throughModel(cellEl, function (cell, sel) {
    if (!sel || sel.from !== sel.to || !pendingAt(cellEl, sel.from)) return null;
    var next = insertText(cell, sel.from, text, marksForTyping(cellEl, cell, sel.from));
    var at = sel.from + cellLength(next) - cellLength(cell);
    typed = true;
    return { cell: next, sel: { from: at, to: at } };
  });
  pendingMarks = null;
  return typed ? fresh : null;
}

/* ---- B, I, U, S and highlight ---- */

/* Toggle one format over the selection in a script cell or a draft box:
   every character of it already has it -> off, else on (toggleMark; a
   draft's pictures do not count). With nothing selected, a pending mark
   for what is typed next. Returns the cell to carry on with, or null when
   nothing was done (see throughModel). */
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

/* Which formats the selection in a script cell or a draft box has, keyed
   by command name (bold, italic, underline, strikeThrough, highlight) —
   what the toolbars light up. Read from the model, so it is the toggle's
   own answer: "on" exactly when pressing the button would take it off.
   Read off the cell on screen rather than state, which a keystroke may not
   have reached yet. Null for a cell the model does not edit: nothing lit. */
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
  return out;
}

/* A line break inside a cell, the way the browser's own Enter does it, as
   an edit of the model (breakLine, 04c-doc-model.js), with the caret just
   after the break. At the very end of a cell a second, sentinel break goes
   in with it: a <br> at the very END of a block renders no line at all, so
   a break typed at the end would otherwise look like nothing happened and
   the next character would land before it, on the same line. The browser's
   insertLineBreak did the same, and this was that until the comment and
   reply boxes came through the model too. Returns the cell element to
   carry on with — a repaint in #rows replaces it. */
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
  /* from the model, in a script cell and a comment or reply box alike */
  var model = toolbar.querySelector('[data-cmd="bold"]') ? cellFormatState(cellEl) : null;
  ["bold", "italic", "underline", "strikeThrough"].forEach(function (cmd) {
    var btn = toolbar.querySelector('[data-cmd="' + cmd + '"]');
    if (btn) btn.classList.toggle("is-active", !!(model && model[cmd]));
  });
  var hiBtn = toolbar.querySelector('[data-cmd="highlight"]');
  if (hiBtn) hiBtn.classList.toggle("is-active", !!(model && model.highlight));
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
}

/* extractContents() on a range that leaves the cell rips content out of two
   rows at once and loses it, so refuse anything not fully contained */
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
  /* the saved Range must still belong to THIS field and still be in the document */
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
  /* The link is an href mark over the saved selection (safeHref, through
     the model, is the last word on what may be one) — in a script cell or
     a comment or reply box alike — and the caret goes just past the linked
     words. */
  sel.addRange(saved);
  var linked = throughModel(cellEl, function (cell, s) {
    if (!s || s.from === s.to) return null;
    return { cell: setMark(cell, s.from, s.to, "href", url), sel: { from: s.to, to: s.to } };
  });
  if (linked) caretOutOfLinkEnd(linked);
}

/* The model puts a caret at the end of the linked words inside the <a>
   (posToDom lands in the text it ends), where the next thing typed would
   join the link. Just past the <a> is where the old wrap-and-insert left
   it, and where typing is ordinary text again. */
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
  /* the card on a line of its own at the end, as one edit of the draft
     (05d-draft-edit.js) — the only box with a Video button is the comment
     composer */
  var card = sanitizeHtml(buildVideoCardEl(url).outerHTML);
  if (card) appendDraftMedia(wrap.querySelector(".cell-editable"), card);
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
    /* render() itself, for a suite that has changed state by hand — the
       image rows 65-blobs.txt gives an imageRef, say. */
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
}
