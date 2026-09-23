import { S } from "./_state.js";
import { makeId } from "./02-state.js";
import { internDataUrl, persist } from "./02c-blobs.js";
import { findRowIndex, getEditorName, stampRow } from "./03-sync.js";
import { safeId, sanitizeHtml } from "./04-richtext.js";
import { render } from "./05-render.js";
import { nowIso } from "./10-comments.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { queueAutoSave } from "./14-export.js";
import { placeCaretAtTextOffset, repointCommentsForRows } from "./19-writer.js";

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
   of a live row (the caller does nothing in that case). */
export function splitRowFieldCore(cellEl) {
  var idx = findRowIndex(cellEl.getAttribute("data-id"));
  var field = cellEl.getAttribute("data-field");
  if (idx === -1 || !field) return null;
  var sel = window.getSelection();
  if (!sel.rangeCount) return null;
  var range = sel.getRangeAt(0);
  if (!cellEl.contains(range.startContainer)) return null;
  /* captured before any mutation below — the field's whole content as it
     stood the instant the split was requested */
  var originalHtml = sanitizeHtml(cellEl.innerHTML);
  var rowId = S.state.rows[idx].id;
  if (!range.collapsed) range.deleteContents();

  var tail = document.createRange();
  tail.setStart(range.startContainer, range.startOffset);
  tail.setEnd(cellEl, cellEl.childNodes.length);
  var holder = document.createElement("div");
  holder.appendChild(tail.extractContents());

  S.state.rows[idx][field] = sanitizeHtml(cellEl.innerHTML);
  stampRow(S.state.rows[idx]);

  var created = { id: makeId(), visualText: "", imageRef: null, audioText: "",
                   status: "todo", updatedAt: nowIso(), updatedBy: getEditorName() };
  created[field] = sanitizeHtml(holder.innerHTML);
  S.state.rows.splice(idx + 1, 0, created);
  /* half the field's text just moved to a new row — any comment anchored
     in that half has to move with it */
  repointCommentsForRows([S.state.rows[idx], created]);
  return { idx: idx, created: created, field: field, rowId: rowId, originalHtml: originalHtml };
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
  document.querySelectorAll(".gutter-btn.danger.armed").forEach(function (b) { b.classList.remove("armed"); b.textContent = "×"; });
  S.deleteArmId = id;
  btn.classList.add("armed");
  btn.textContent = "✓";
  clearTimeout(S.deleteArmTimer);
  S.deleteArmTimer = setTimeout(function () {
    S.deleteArmId = null;
    btn.classList.remove("armed");
    btn.textContent = "×";
  }, 2800);
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
   it — the writers that must not name an unstored blob persist first. */
export function handleImageFile(rowId, file) {
  compressImageFile(file, 1000, 0.78).then(function (dataUrl) {
    var idx = findRowIndex(rowId);
    if (idx === -1) return;
    var rec = internDataUrl(dataUrl);
    if (!rec) throw new Error("not a picture the registry takes");
    persist([rec.sha256]);
    delete S.state.rows[idx].visualImage;
    S.state.rows[idx].imageRef = rec;
    stampRow(S.state.rows[idx]);
    markDirty();
    render();
  }).catch(function () { showToast("Could not use that image.", "error"); });
}

export function removeImage(rowId) {
  var idx = findRowIndex(rowId);
  if (idx === -1) return;
  delete S.state.rows[idx].visualImage;
  S.state.rows[idx].imageRef = null;
  stampRow(S.state.rows[idx]);
  markDirty();
  render();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
