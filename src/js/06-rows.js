import { S } from "./_state.js";
import { internDataUrl, persist } from "./02c-blobs.js";
import { findRowIndex, getEditorName } from "./03-sync.js";
import { safeHref, safeId, storedHtmlFromDom } from "./04-richtext.js";
import { syncCommentAnchors } from "./04c-doc-model.js";
import { armDeleteButton, disarmDeleteButton, render, syncFieldFromDom } from "./05-render.js";
import { galleryEdit } from "./05e-gallery-overlay.js";
import { isBlankScene } from "./05g-scene-clip.js";
import { cellSelection, setCellSelection } from "./05b-cell-edit.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { breakUndoCoalescing } from "./12a-undo.js";
import { queueAutoSave } from "./14-export.js";
import { placeCaretAtTextOffset } from "./19-writer.js";
import { makeId, nowIso } from "../adapters/identity/ids.ts";
import { splitSceneCommand, textCut } from "../application/commands/split-join.ts";
import { onDocumentReplaced, runCommand, sessionTextPorts } from "../legacy/session-bridge.ts";
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import {
  addGalleryPicture, normalizeVideoLink, removeGalleryLink, removeGallerySlot, replaceGalleryPicture, rowSlots, videoLinkKey
} from "../core/document/gallery.ts";

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

export function splitRowFieldCore(cellEl) {
  var id = cellEl.getAttribute("data-id");
  var field = cellEl.getAttribute("data-field");
  if (findRowIndex(id) === -1 || (field !== "visualText" && field !== "audioText")) return null;
  syncFieldFromDom(cellEl);
  var sel = cellSelection(cellEl);
  if (!sel) return null;
  breakUndoCoalescing();
  var createdId = makeId();
  var outcome = runCommand(splitSceneCommand(id, field, textCut(sel.from, sel.to), createdId, sessionTextPorts));
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed" ? { id: createdId, field: field } : null;
}

export function splitCellField(cellEl) {
  var res = splitRowFieldCore(cellEl);
  if (!res) return;
  render();
  focusRowField(res.id, res.field, 0);
}

export function focusRowField(rowId, field, offset) {
  var cell = document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") +
    '"] .cell-editable[data-field="' + (field === "visualText" ? "visualText" : "audioText") + '"]');
  if (!cell) return;
  cell.focus();
  placeCaretAtTextOffset(cell, offset || 0);
  cell.scrollIntoView({ behavior: "smooth", block: "center" });
}

S.dragRowId = null;

export function clearDropMarkers() {
  document.querySelectorAll("#rows .row").forEach(function (r) {
    r.classList.remove("drop-before", "drop-after", "is-dragging");
    r.removeAttribute("draggable");
  });
  document.querySelectorAll("#rows .visual-cell.drag-over").forEach(function (c) {
    c.classList.remove("drag-over");
  });
  stopDragScroll();
}

export function setDropMarkerForRow(row, clientY) {
  var box = row.getBoundingClientRect();
  var after = (clientY - box.top) > box.height / 2;
  document.querySelectorAll("#rows .row").forEach(function (r) {
    if (r !== row) r.classList.remove("drop-before", "drop-after");
  });
  row.classList.toggle("drop-before", !after);
  row.classList.toggle("drop-after", after);
}

var DRAG_SCROLL_ZONE = 120;
var DRAG_SCROLL_MIN_SPEED = 6;
var DRAG_SCROLL_MAX_SPEED = 28;
var dragScroll = null;

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

export function stopDragScroll() {
  if (!dragScroll) return;
  cancelAnimationFrame(dragScroll.raf);
  dragScroll = null;
}

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
  syncCommentAnchors(S.state);
  markDirty();
  render();
}

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
  var idx = findRowIndex(id);
  var rowEl = document.querySelector('#rows .row[data-id="' + safeId(id) + '"]');
  if (rowEl) rowEl.querySelectorAll(".cell-editable").forEach(syncFieldFromDom);
  if (idx !== -1 && isBlankScene(S.state, S.state.rows[idx])) {
    clearTimeout(S.deleteArmTimer);
    S.deleteArmId = null;
    deleteRow(id);
    return;
  }
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
  menu.classList.remove("opens-up");
  var r = menu.getBoundingClientRect();
  var phoneBar = document.getElementById("phone-bar");
  var floor = window.innerHeight - 8 - (phoneBar ? phoneBar.offsetHeight : 0);
  if (r.bottom > floor && r.top - r.height - btn.offsetHeight > 8) menu.classList.add("opens-up");
  if (focusFirst) {
    var first = menu.querySelector(".row-menu-item");
    if (first) first.focus();
  }
}

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

export function capturePastePlace(cellEl) {
  return { html: storedHtmlFromDom(cellEl.innerHTML), sel: cellSelection(cellEl) };
}

export function restorePastePlace(cellEl, place) {
  var unchanged = place.sel && storedHtmlFromDom(cellEl.innerHTML) === place.html;
  setCellSelection(cellEl, unchanged ? place.sel.from : Infinity, unchanged ? place.sel.to : Infinity);
}

export function showPictureNotAdded() {
  showToast("The picture finished loading after the script changed, so it was not added.", "warn");
}

export function handleImageFile(rowId, file, slot) {
  var ctx = captureOperation();
  compressImageFile(file, 1000, 0.78).then(function (dataUrl) {
    if (!stillOwns(ctx)) { showPictureNotAdded(); return; }
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

export function removeImage(rowId, slot) {
  galleryEdit(rowId, "Picture removed", function (row) {
    return removeGallerySlot(row, slot || 0);
  });
}

export function removeImageLink(rowId, slot, key) {
  galleryEdit(rowId, "Video link removed", function (row) { return removeGalleryLink(row, slot, key); });
}

var videoFileTokens = {};
var sessionVideoFiles = {};
var sessionVideoUrls = {};

export function grantVideoFile(file, link) {
  var key = videoLinkKey(normalizeVideoLink(link) || link);
  if (file && typeof file.size === "number") {
    if (sessionVideoUrls[key] && sessionVideoFiles[key] !== file) {
      try { URL.revokeObjectURL(sessionVideoUrls[key]); } catch (e) { }
      delete sessionVideoUrls[key];
    }
    sessionVideoFiles[key] = file;
  }
  if (!S.DESKTOP || typeof S.DESKTOP.grantVideoFile !== "function") return;
  Promise.resolve(S.DESKTOP.grantVideoFile(file)).then(function (token) {
    if (typeof token === "string" && token) videoFileTokens[key] = token;
  }, function () {});
}

export function hasSessionVideo(link) {
  return !!(link && !link.href && sessionVideoFiles[videoLinkKey(link)]);
}

export function sessionVideoUrl(link) {
  if (!hasSessionVideo(link)) return null;
  var key = videoLinkKey(link);
  if (!sessionVideoUrls[key]) {
    try { sessionVideoUrls[key] = URL.createObjectURL(sessionVideoFiles[key]); } catch (e) { return null; }
  }
  return sessionVideoUrls[key];
}

export function releaseSessionVideoUrls() {
  Object.keys(sessionVideoUrls).forEach(function (key) {
    try { URL.revokeObjectURL(sessionVideoUrls[key]); } catch (e) { }
    delete sessionVideoUrls[key];
  });
}

onDocumentReplaced(releaseSessionVideoUrls);

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

export function __init() {}
