import { S } from "./_state.js";
import { makeId } from "./02-state.js";
import { internDataUrl, persist } from "./02c-blobs.js";
import {
  addGalleryPicture, normalizeVideoLink, removeGalleryLink, removeGallerySlot, replaceGalleryPicture, rowSlots, videoLinkKey
} from "./02d-gallery.js";
import { findRowIndex, getEditorName, stampRow } from "./03-sync.js";
import { safeHref, safeId, sanitizeHtml } from "./04-richtext.js";
import { deleteRange, fromHtml, splitCell, syncCommentAnchors, toHtml } from "./04c-doc-model.js";
import { armDeleteButton, disarmDeleteButton, render, syncFieldFromDom } from "./05-render.js";
import { galleryEdit } from "./05e-gallery-overlay.js";
import { cellSelection } from "./05b-cell-edit.js";
import { nowIso } from "./10-comments.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { breakUndoCoalescing } from "./12a-undo.js";
import { queueAutoSave } from "./14-export.js";
import { placeCaretAtTextOffset } from "./19-writer.js";

/* ================= row actions ================= */

export function addRow(afterId) {
  var row = { id: makeId(), visualText: "", imageRef: null, audioText: "",
              status: "todo", updatedAt: nowIso(), updatedBy: getEditorName() };
  if (afterId) {
    var idx = findRowIndex(afterId);
    S.state.rows.splice(idx + 1, 0, row);
  } else {
    S.state.rows.push(row);
  }
  markDirty();
  render();
}

/* Ctrl/Cmd+Enter while writing: open the next scene and land in the same
   column you were already in, so a run of scenes can be typed without
   reaching for the mouse. The new cell only exists once render() has
   reconciled #rows, so it is looked up afterwards rather than held across
   the call. */
export function addRowAndFocus(afterId, field) {
  addRow(afterId);
  var idx = findRowIndex(afterId);
  var created = S.state.rows[idx + 1];
  if (!created) return;
  var cell = document.querySelector('#rows .row[data-id="' + safeId(created.id, "r") +
    '"] .cell-editable[data-field="' + (field === "visualText" ? "visualText" : "audioText") + '"]');
  if (!cell) return;
  cell.focus();
  var range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* Splits ONE field's content at the caret into a new row directly below —
   the shared core behind both the writer's plain Enter (splitWriterRow)
   and the split view's Alt+Enter (splitCellField). Everything from the
   caret to the end of the field moves to the new row's same field; the
   row's OTHER field — the column that was not being written in — is left
   completely alone, still whole, still on the original row. Returns
   {idx, created, field}, or null if the caret was not actually in a field
   of a live row (the caller does nothing in that case).

   Through the model (#85, design §3.2): the cell is read from state as
   runs, a selection is deleted first, and splitCell cuts it at the caret —
   so every mark goes with its words, and a comment whose phrase the caret
   was inside is marked in both halves. Its rowId/field then follow the
   marks (syncCommentAnchors). The caller's one markDirty() makes all of
   it — both cells, the new row, the comment — one undo entry. */
export function splitRowFieldCore(cellEl) {
  var idx = findRowIndex(cellEl.getAttribute("data-id"));
  var field = cellEl.getAttribute("data-field");
  if (idx === -1 || (field !== "visualText" && field !== "audioText")) return null;
  /* What was typed a moment ago goes into state first, and into the undo
     stack as its own entry, so Ctrl+Z after Enter takes back the split and
     leaves the typing. */
  syncFieldFromDom(cellEl);
  var sel = cellSelection(cellEl);
  if (!sel) return null;
  breakUndoCoalescing();
  var row = S.state.rows[idx];
  var html = row[field] || "";
  var halves = /<img|video-embed-card/.test(html)
    ? splitMediaCellInDom(cellEl)
    : splitCell(deleteRange(fromHtml(html), sel.from, sel.to), sel.from).map(function (c) { return toHtml(c); });

  row[field] = halves[0];
  stampRow(row);
  var created = { id: makeId(), visualText: "", imageRef: null, audioText: "",
                   status: "todo", updatedAt: nowIso(), updatedBy: getEditorName() };
  created[field] = halves[1];
  S.state.rows.splice(idx + 1, 0, created);
  syncCommentAnchors(S.state);
  return { idx: idx, created: created, field: field };
}

/* A cell still holding a picture or a video card (pasted before design D7
   kept them out of script text; migrateRows moves them out on load) is one
   the model has no place for, so it is cut the way it always was: by a DOM
   range from the caret to the end. Returns the two halves' HTML. */
function splitMediaCellInDom(cellEl) {
  var range = window.getSelection().getRangeAt(0);
  if (!range.collapsed) range.deleteContents();
  var tail = document.createRange();
  tail.setStart(range.startContainer, range.startOffset);
  tail.setEnd(cellEl, cellEl.childNodes.length);
  var holder = document.createElement("div");
  holder.appendChild(tail.extractContents());
  return [sanitizeHtml(cellEl.innerHTML), sanitizeHtml(holder.innerHTML)];
}

export function splitCellField(cellEl) {
  var res = splitRowFieldCore(cellEl);
  if (!res) return;
  markDirty();
  render();
  focusRowField(res.created.id, res.field, 0);
}

/* Land the caret at a plain-text offset inside a specific field of a
   specific row — addRowAndFocus's caret placement, generalised to any
   offset rather than always the start. */
export function focusRowField(rowId, field, offset) {
  var cell = document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") +
    '"] .cell-editable[data-field="' + (field === "visualText" ? "visualText" : "audioText") + '"]');
  if (!cell) return;
  cell.focus();
  placeCaretAtTextOffset(cell, offset || 0);
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---- drag to reorder ----

   Only the row number is a grip. Rows are full of contenteditable text, and
   making the whole row draggable would break selecting that text with the
   mouse — so draggable is switched on only while the grip is held, and off
   again the moment the drag ends. */
S.dragRowId = null;

export function clearDropMarkers() {
  document.querySelectorAll("#rows .row").forEach(function (r) {
    r.classList.remove("drop-before", "drop-after", "is-dragging");
    r.removeAttribute("draggable");
  });
  /* a file drag that ends outside the window never fires drop, so the
     highlight has to be cleared here too or it sticks */
  document.querySelectorAll("#rows .visual-cell.drag-over").forEach(function (c) {
    c.classList.remove("drag-over");
  });
  /* every way a row drag can end — drop, dragend, or the native dragend
     Escape produces — funnels through here, so this is the one place that
     has to guarantee no scroll loop is left running. */
  stopDragScroll();
}

/* Puts the drop-before/drop-after marker on `row`, matching whichever half
   of it `clientY` falls in. Shared by onRootDragOver (pointer is moving,
   e.target already IS the hit target) and the auto-scroll loop below
   (pointer may be still, so the hit target has to be re-derived). */
export function setDropMarkerForRow(row, clientY) {
  var box = row.getBoundingClientRect();
  var after = (clientY - box.top) > box.height / 2;
  document.querySelectorAll("#rows .row").forEach(function (r) {
    if (r !== row) r.classList.remove("drop-before", "drop-after");
  });
  row.classList.toggle("drop-before", !after);
  row.classList.toggle("drop-after", after);
}

/* ---- auto-scroll while a scene is dragged to the edge of the window ----

   There is no inner scroll container (see 20i-topbar.js), so this scrolls
   the window itself. The hot zone is measured from the viewport edges, not
   #rows's own box, because the sticky header sits on top of #rows and a
   pointer resting on the header never reaches a listener on #rows at all —
   hence the dragover listener driving this is on window, not #rows.

   `dragover` only fires while the pointer actually moves in most engines,
   so a pointer held still inside the zone has to be kept scrolling by its
   own requestAnimationFrame loop rather than by further events. Each frame
   re-derives whatever row is now under the pointer's last known viewport
   position with elementFromPoint — which is what keeps the drop marker
   tracking as the page moves beneath a motionless pointer, including
   across the header's condense breakpoint (20i-topbar.js), where the
   header's own height changes and shifts #rows under a pointer that never
   moved. */
var DRAG_SCROLL_ZONE = 120; /* roughly a scene's height */
var DRAG_SCROLL_MIN_SPEED = 6; /* px/frame just inside the zone */
var DRAG_SCROLL_MAX_SPEED = 28; /* px/frame right at the window edge */
var dragScroll = null; /* { dir: -1|1, speed, x, y, raf } while running, else null */

function dragScrollSpeedFor(depthIntoZone) {
  var t = Math.max(0, Math.min(1, depthIntoZone / DRAG_SCROLL_ZONE));
  return DRAG_SCROLL_MIN_SPEED + t * (DRAG_SCROLL_MAX_SPEED - DRAG_SCROLL_MIN_SPEED);
}

function updateDropMarkersAtPoint(clientX, clientY) {
  var el = document.elementFromPoint(clientX, clientY);
  var row = el && el.closest && el.closest(".row");
  if (!row || row.getAttribute("data-id") === S.dragRowId) return;
  setDropMarkerForRow(row, clientY);
}

function dragScrollStep() {
  if (!dragScroll) return;
  window.scrollBy(0, dragScroll.dir * dragScroll.speed);
  updateDropMarkersAtPoint(dragScroll.x, dragScroll.y);
  dragScroll.raf = requestAnimationFrame(dragScrollStep);
}

function stopDragScroll() {
  if (!dragScroll) return;
  cancelAnimationFrame(dragScroll.raf);
  dragScroll = null;
}

/* Called from every dragover while a row is armed for dragging (see
   onRootMouseDown / dragRowId), with the pointer's current viewport
   coordinates. Starts, updates, or stops the scroll loop for the zone the
   pointer is in right now. */
export function updateDragScroll(clientX, clientY) {
  var vh = window.innerHeight;
  var dir = 0, speed = 0;
  if (clientY < DRAG_SCROLL_ZONE) {
    dir = -1;
    speed = dragScrollSpeedFor(DRAG_SCROLL_ZONE - clientY);
  } else if (clientY > vh - DRAG_SCROLL_ZONE) {
    dir = 1;
    speed = dragScrollSpeedFor(clientY - (vh - DRAG_SCROLL_ZONE));
  }
  if (dir === 0) { stopDragScroll(); return; }
  if (!dragScroll) {
    dragScroll = { dir: dir, speed: speed, x: clientX, y: clientY, raf: null };
    dragScroll.raf = requestAnimationFrame(dragScrollStep);
  } else {
    dragScroll.dir = dir;
    dragScroll.speed = speed;
    dragScroll.x = clientX;
    dragScroll.y = clientY;
  }
}

export function moveRowTo(id, targetId, after) {
  var from = findRowIndex(id);
  var to = findRowIndex(targetId);
  if (from === -1 || to === -1 || from === to) return;
  var row = S.state.rows.splice(from, 1)[0];
  /* recompute after the splice: removing the dragged row shifts everything
     below it up by one, so the index captured before is off by one there */
  var dest = findRowIndex(targetId);
  S.state.rows.splice(after ? dest + 1 : dest, 0, row);
  markDirty();
  render();
  queueAutoSave();
}

function deleteRow(id) {
  var idx = findRowIndex(id);
  if (idx === -1) return;
  S.state.rows.splice(idx, 1);
  markDirty();
  render();
}

/* The one place state.rows actually swaps two adjacent scenes for a
   single-step move — shared by the gutter's ↑/↓ buttons (moveRow, via
   click) and Alt+Up/Alt+Down (via onRootKeydown, both #rows and the
   writer). Syncs exactly the way dragging a row does (moveRowTo just
   above: one markDirty(), one queueAutoSave()) — which is also what makes
   it one undo entry (12a-undo.js) — but does not render: callers differ on
   whether the split view, the writer, or both need repainting afterward,
   and on how precisely the caret has to land, so that is left to them.
   Returns false at either end (no wrap) or if the row is gone. */
export function swapAdjacentRows(id, dir) {
  var idx = findRowIndex(id);
  var j = idx + dir;
  if (idx === -1 || j < 0 || j >= S.state.rows.length) return false;
  var tmp = S.state.rows[idx];
  S.state.rows[idx] = S.state.rows[j];
  S.state.rows[j] = tmp;
  markDirty();
  queueAutoSave();
  return true;
}

export function moveRow(id, dir) {
  if (!swapAdjacentRows(id, dir)) return;
  render();
}

export function armDelete(btn, id) {
  if (S.deleteArmId === id) {
    clearTimeout(S.deleteArmTimer);
    S.deleteArmId = null;
    deleteRow(id);
    return;
  }
  document.querySelectorAll(".gutter-btn.danger.armed").forEach(disarmDeleteButton);
  S.deleteArmId = id;
  armDeleteButton(btn);
  clearTimeout(S.deleteArmTimer);
  S.deleteArmTimer = setTimeout(function () {
    S.deleteArmId = null;
    disarmDeleteButton(btn);
  }, 2800);
}

/* ---- a scene's "⋯" menu (#169) ----

   Move up, Move down, Insert scene and Delete used to be four buttons drawn
   on every scene. They are the same four buttons now, inside a menu in the
   gutter (rowGutterHtml, 05-render.js), and a click on one still goes
   through onRootClick exactly as it did. This is only the menu around
   them: one open at a time, closed by a click anywhere else, Escape or Tab,
   and walked with the arrow keys. A render that repaints the gutter takes
   an open menu with it — moving the scene, say — which is closing it. */
export function closeRowMenus(except) {
  document.querySelectorAll("#rows .row-menu:not([hidden])").forEach(function (menu) {
    if (menu === except) return;
    menu.hidden = true;
    var btn = menu.parentNode.querySelector(".row-more");
    if (btn) btn.setAttribute("aria-expanded", "false");
    var row = menu.closest(".row");
    if (row) row.classList.remove("has-menu-open");
  });
}

/* `focusFirst` when it was opened from the keyboard, so the arrow keys
   have somewhere to start; a pointer leaves focus on the button. */
export function toggleRowMenu(btn, focusFirst) {
  var menu = btn.parentNode.querySelector(".row-menu");
  if (!menu) return;
  var opening = menu.hidden;
  closeRowMenus(opening ? menu : null);
  menu.hidden = !opening;
  btn.setAttribute("aria-expanded", opening ? "true" : "false");
  var row = btn.closest(".row");
  if (row) row.classList.toggle("has-menu-open", opening);
  if (!opening) return;
  /* Up rather than down when the window has no room under it — the last
     scene on screen. */
  menu.classList.remove("opens-up");
  var r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 8 && r.top - r.height - btn.offsetHeight > 8) menu.classList.add("opens-up");
  if (focusFirst) {
    var first = menu.querySelector(".row-menu-item");
    if (first) first.focus();
  }
}

/* The keyboard inside an open menu, and ArrowDown on its button. Returns
   true when the key was the menu's. */
export function rowMenuKeydown(e) {
  var t = e.target;
  if (!t || !t.closest) return false;
  if (t.classList.contains("row-more") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    var m = t.parentNode.querySelector(".row-menu");
    if (m && m.hidden) toggleRowMenu(t, true);
    return true;
  }
  var menu = t.closest(".row-menu");
  if (!menu || menu.hidden) return false;
  var items = Array.prototype.slice.call(menu.querySelectorAll(".row-menu-item"));
  var i = items.indexOf(t);
  var btn = menu.parentNode.querySelector(".row-more");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    var step = e.key === "ArrowDown" ? 1 : -1;
    items[(i + step + items.length) % items.length].focus();
    return true;
  }
  if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    items[e.key === "Home" ? 0 : items.length - 1].focus();
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeRowMenus();
    if (btn) btn.focus();
    return true;
  }
  if (e.key === "Tab") {
    closeRowMenus();
    return false;
  }
  return false;
}

/* ================= images ================= */

/* Formats that commonly carry a real alpha channel — a screenshot/cutout/
   logo attached in one of these keeps its transparency by staying PNG;
   anything else (photos: JPEG, HEIC-via-browser-decode, etc.) still goes
   through the smaller lossy JPEG path, since those never have alpha to
   begin with. */
var ALPHA_CAPABLE_TYPE = /^image\/(png|gif|webp)$/;

export function compressImageFile(file, maxDim, quality) {
  return new Promise(function (resolve, reject) {
    if (!file || file.type.indexOf("image/") !== 0) { reject(new Error("not an image")); return; }
    var keepAlpha = ALPHA_CAPABLE_TYPE.test(file.type);
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error("read failed")); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error("decode failed")); };
      img.onload = function () {
        /* A canvas format without alpha support (JPEG) composites every
           transparent pixel onto solid black before encoding, per the
           canvas spec — permanently destroying a PNG/GIF/WebP's
           transparency with no error or warning. Runs inside a try/catch
           too: this callback fires asynchronously, after the Promise
           executor has already returned, so a synchronous throw in here
           (e.g. a SecurityError from a tainted canvas — a cross-origin
           reference inside an SVG, say) would otherwise never resolve OR
           reject the promise, leaving the upload hanging forever with no
           toast and nothing but a console error to show for it. */
        try {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxDim / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality));
        } catch (e) { reject(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* The picture goes into the image registry (02c-blobs.js, #82) and the
   row names it by its record: state holds a few dozen bytes per image, not
   the image. Storing the bytes durably starts at once; nothing waits on
   it — the writers that must not name an unstored blob persist first.

   Since #135 the Image section is a gallery (02d-gallery.js). `slot`:
   a number replaces that slot's picture (Replace), keeping its caption;
   absent, the picture is added — into an empty first slot, or after the
   others (the paperclip, Add, and a file dropped on the visual column).
   The gallery then shows the picture just placed. */
export function handleImageFile(rowId, file, slot) {
  compressImageFile(file, 1000, 0.78).then(function (dataUrl) {
    var idx = findRowIndex(rowId);
    if (idx === -1) return;
    var rec = internDataUrl(dataUrl);
    if (!rec) throw new Error("not a picture the registry takes");
    persist([rec.sha256]);
    var replacing = typeof slot === "number";
    galleryEdit(rowId, "Picture " + (replacing ? "replaced in" : "added to") + " scene " + (idx + 1), function (row) {
      if (replacing && !replaceGalleryPicture(row, slot, rec, file.name)) return false;
      if (!replacing) addGalleryPicture(row, rec, file.name);
      return true;
    });
  }).catch(function () { showToast("Could not use that image.", "error"); });
}

/* Takes one slot of the gallery away — its picture and its caption. */
export function removeImage(rowId, slot) {
  galleryEdit(rowId, "Picture removed", function (row) {
    return removeGallerySlot(row, slot || 0);
  });
}

/* Takes one video link off a slot's caption (the × beside it). */
export function removeImageLink(rowId, slot, key) {
  galleryEdit(rowId, "Video link removed", function (row) { return removeGalleryLink(row, slot, key); });
}

/* ---- video files in a scene's gallery (#135) ----

   A video file dropped or pasted into a scene is named in its caption,
   never carried: its bytes are far too big to be the document's, and
   where it sits on this computer is nobody else's business. So the
   document keeps {name, size}, and THIS SESSION keeps the rest: on the
   desktop, the bridge's grantVideoFile(file) asks main to remember the
   file's path (main reads it off the File itself, through
   webUtils.getPathForFile, so a page cannot name a path of its choosing)
   and answers a token; the caption's link opens the file with its own app
   through openVideoFile(token), which main honours only for a path it was
   given that way. The browser has no path to keep. */
var videoFileTokens = {};

export function grantVideoFile(file, link) {
  if (!S.DESKTOP || typeof S.DESKTOP.grantVideoFile !== "function") return;
  /* keyed as the caption will hold it: its name made safe */
  var key = videoLinkKey(normalizeVideoLink(link) || link);
  Promise.resolve(S.DESKTOP.grantVideoFile(file)).then(function (token) {
    if (typeof token === "string" && token) videoFileTokens[key] = token;
  }, function () {});
}

export function openVideoFile(link) {
  var name = link.name || "that video";
  if (!S.DESKTOP || typeof S.DESKTOP.openVideoFile !== "function") {
    showToast("“" + name + "” is a video file on the computer it was added from — only its name is kept here. " +
      "Open it from there, or in the Splitpage desktop app.", "warn", true);
    return;
  }
  var token = videoFileTokens[videoLinkKey(link)];
  if (!token) {
    showToast("Splitpage only opens a video file you dropped or pasted in since it started — " +
      "drop “" + name + "” onto this scene again to open it from here.", "warn", true);
    return;
  }
  Promise.resolve(S.DESKTOP.openVideoFile(token)).then(function (res) {
    if (res && res.ok) return;
    showToast("Could not open “" + name + "”" + (res && res.code === "GONE" ? " — it is no longer where it was." : "."), "error");
  }, function () { showToast("Could not open “" + name + "”.", "error"); });
}

/* A caption's video, opened: a web address in the browser — the desktop
   app hands it to the system's (the bridge's openExternal, which takes
   http(s) only) — and a video file from this session's drop or paste
   through the desktop bridge, which opens it with its own app only if
   main granted it (openVideoFile). Everything goes through safeHref. */
export function openGalleryLink(rowId, slot, key) {
  var idx = findRowIndex(rowId);
  if (idx === -1) return;
  var s = rowSlots(S.state.rows[idx])[slot];
  var link = s && s.links.filter(function (l) { return videoLinkKey(l) === key; })[0];
  if (!link) return;
  if (link.href) {
    var href = safeHref(link.href);
    if (!href || !/^https?:\/\//i.test(href)) return;
    if (S.DESKTOP && S.DESKTOP.openExternal) { S.DESKTOP.openExternal(href); return; }
    var win = window.open(href, "_blank", "noopener");
    if (win) win.opener = null;
    return;
  }
  openVideoFile(link);
}

/* A video file's first frame, as a JPEG data: URI no bigger than a scene
   picture, and its length in seconds: {dataUrl, duration}, or null when
   this browser cannot decode it (the gallery shows a placeholder then).
   Read through a blob: URL in a <video> — the page's
   policy allows media from blob: and nothing else (build.mjs's CSP) — and
   given up on after a few seconds. */
export function videoFirstFrame(file) {
  return new Promise(function (resolve) {
    var url, v, timer, settled = false;
    function done(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { v.removeAttribute("src"); v.load(); } catch (e) {}
      try { URL.revokeObjectURL(url); } catch (e) {}
      resolve(result);
    }
    try {
      url = URL.createObjectURL(file);
      v = document.createElement("video");
    } catch (e) { resolve(null); return; }
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    timer = setTimeout(function () { done(null); }, 4000);
    v.onerror = function () { done(null); };
    v.onloadeddata = function () {
      /* a moment in: the very first frame of a clip is often black */
      var t = isFinite(v.duration) && v.duration > 0 ? Math.min(0.5, v.duration / 3) : 0;
      if (t > 0 && Math.abs(v.currentTime - t) > 0.01) { v.onseeked = grab; v.currentTime = t; }
      else grab();
    };
    function grab() {
      try {
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) { done(null); return; }
        var scale = Math.min(1, 1000 / Math.max(w, h));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
        done({ dataUrl: canvas.toDataURL("image/jpeg", 0.78), duration: isFinite(v.duration) && v.duration > 0 ? v.duration : 0 });
      } catch (e) { done(null); }
    }
    v.src = url;
  });
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
