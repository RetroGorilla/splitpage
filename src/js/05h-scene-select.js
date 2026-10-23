import { S } from "./_state.js";
import { ensureBytes } from "../adapters/storage/02c-blobs.js";
import { refsIn } from "../../shared/blob-policy.js";
import { stampRow } from "./03-sync.js";
import { cssAttr } from "./04-richtext.js";
import { isScriptCell } from "../features/editing/cell-page.ts";
import {
  SCENES_MIME, buildScenePayload, parseScenePayload, scenePaste, scenesOnClipboard, setLiveCut
} from "./05g-scene-clip.js";
import { closeRowMenus } from "./06-rows.js";
import { scheduleProductionRefresh } from "./07-production-tags.js";
import { breakUndoCoalescing, flushEdits, lastUndoEntry, undo } from "./12a-undo.js";
import { onServerDoc } from "./13-hosted.js";
import { autoSavePolicy } from "../legacy/save-bridge.ts";
import { startNewScript } from "./18b-file-menu.js";
import { randomHexBytes } from "../adapters/identity/ids.ts";
import { addHeldCommentsCommand, pasteScenesCommand, removeScenesCommand } from "../application/commands/scenes.ts";
import { cappedLongText } from "../core/document/text-policy.ts";
import { REVIEW_ONLY, runCommand } from "../legacy/session-bridge.ts";
import { VIEWING_ONLY } from "../legacy/review-wording.ts";
import { cellEditing, rowDrag } from "../legacy/editor-bridge.ts";
import { showActionToast, showToast } from "../legacy/effects-bridge.ts";
import { viewFlags } from "../legacy/preferences-bridge.ts";
import { reviewMode } from "../legacy/location-bridge.ts";

var TOLERANCE = 4;
var SCROLL_ZONE = 120;
var SCROLL_MIN = 6;
var SCROLL_MAX = 28;

var track = null;
var sel = null;
var scroll = null;
var styleEl = null;
var menuEl = null;
var pendingCut = false;
var clipWritten = null;

export function hasSceneSelection() {
  if (sel && sel.doc !== S.state) clearSceneSelection();
  return !!sel;
}

export function selectedSceneIds() {
  if (!hasSceneSelection()) return [];
  var rows = S.state.rows;
  var a = -1, b = -1;
  rows.forEach(function (r, i) {
    if (r.id === sel.anchor) a = i;
    if (r.id === sel.focus) b = i;
  });
  if (a === -1 && b === -1) return [];
  if (a === -1) a = b;
  if (b === -1) b = a;
  var ids = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(function (r) { return r.id; });
  if (document.querySelector("#rows .hidden-shot-strip")) {
    ids = ids.filter(function (id) { return !!document.querySelector('#rows .row[data-id="' + cssAttr(id) + '"]'); });
  }
  return ids;
}

export function selectScenes(anchorId, focusId) {
  sel = { anchor: anchorId, focus: focusId || anchorId, doc: S.state };
  paint();
}

export function clearSceneSelection() {
  if (!sel && !track) return;
  sel = null;
  if (track && track.scene) endTrack();
  paint();
  closeSceneMenu();
}

function paint() {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "scene-selection-style";
    document.head.appendChild(styleEl);
  }
  var ids = sel ? selectedSceneIds() : [];
  document.body.classList.toggle("has-scene-selection", ids.length > 0);
  if (!ids.length) { styleEl.textContent = ""; return; }
  var of = function (id) { return '#rows .row[data-id="' + cssAttr(id) + '"]'; };
  var bar = "inset 3px 0 0 var(--focus-ring)";
  styleEl.textContent =
    ids.map(of).join(",") + "{background:var(--selection);box-shadow:" + bar + ";}" +
    of(ids[0]) + "{box-shadow:" + bar + ",inset 0 2px 0 var(--focus-ring);}" +
    of(ids[ids.length - 1]) + "{box-shadow:" + bar + (ids.length === 1 ? ",inset 0 2px 0 var(--focus-ring)" : "") +
      ",inset 0 -2px 0 var(--focus-ring);}";
}

function rowEls() {
  return document.querySelectorAll("#rows .row[data-id]");
}

function rowIdAtY(y) {
  var els = rowEls();
  if (!els.length) return null;
  for (var i = 0; i < els.length; i++) {
    if (y <= els[i].getBoundingClientRect().bottom) return els[i].getAttribute("data-id");
  }
  return els[els.length - 1].getAttribute("data-id");
}

function onRowsMouseDown(e) {
  if (e.button !== 0 || rowDrag().dragging()) return;
  var cell = e.target.closest && e.target.closest(".cell-editable");
  if (!cell || !isScriptCell(cell) || !cell.closest("#rows")) return;
  track = { cell: cell, rowId: cell.getAttribute("data-id"), x: e.clientX, y: e.clientY, scene: false };
}

function onMouseMove(e) {
  if (!track) return;
  if (!(e.buttons & 1)) { endTrack(); return; }
  track.x = e.clientX;
  track.y = e.clientY;
  if (!track.scene) {
    var r = track.cell.getBoundingClientRect();
    if (e.clientY >= r.top - TOLERANCE && e.clientY <= r.bottom + TOLERANCE) return;
    startScenes();
  }
  e.preventDefault();
  followPointer();
  updateScroll();
}

function startScenes() {
  track.scene = true;
  sel = { anchor: track.rowId, focus: track.rowId, doc: S.state };
  document.body.classList.add("is-scene-selecting");
  var s = window.getSelection();
  if (s) s.removeAllRanges();
  if (document.activeElement === track.cell) track.cell.blur();
  closeRowMenus();
  paint();
}

function followPointer() {
  if (!track || !sel) return;
  var id = rowIdAtY(track.y);
  if (id && id !== sel.focus) {
    sel.focus = id;
    paint();
  }
}

function endTrack() {
  var was = track;
  track = null;
  stopScroll();
  document.body.classList.remove("is-scene-selecting");
  if (was && was.scene && sel) prefetchPictures();
}

function onMouseUp() {
  if (track) endTrack();
}

function onDragStart() {
  if (track && !track.scene) track = null;
}

function onSelectionChange() {
  if (!track || !track.scene) return;
  var s = window.getSelection();
  if (s && s.rangeCount && !s.isCollapsed) s.removeAllRanges();
}

function updateScroll() {
  var vh = window.innerHeight;
  var y = track.y, dir = 0, depth = 0;
  if (y < SCROLL_ZONE) { dir = -1; depth = SCROLL_ZONE - y; }
  else if (y > vh - SCROLL_ZONE) { dir = 1; depth = y - (vh - SCROLL_ZONE); }
  if (!dir) { stopScroll(); return; }
  var speed = SCROLL_MIN + Math.max(0, Math.min(1, depth / SCROLL_ZONE)) * (SCROLL_MAX - SCROLL_MIN);
  if (scroll) { scroll.dir = dir; scroll.speed = speed; return; }
  scroll = { dir: dir, speed: speed, raf: requestAnimationFrame(scrollStep) };
}

function scrollStep() {
  if (!scroll || !track) { scroll = null; return; }
  window.scrollBy(0, scroll.dir * scroll.speed);
  followPointer();
  scroll.raf = requestAnimationFrame(scrollStep);
}

function stopScroll() {
  if (!scroll) return;
  cancelAnimationFrame(scroll.raf);
  scroll = null;
}

function prefetchPictures() {
  var ids = selectedSceneIds();
  if (!ids.length) return;
  var want = Object.create(null);
  ids.forEach(function (id) { want[id] = true; });
  var rows = S.state.rows.filter(function (r) { return want[r.id]; });
  var comments = (S.state.comments || []).filter(function (c) { return c && want[c.rowId]; });
  var shas = refsIn({ rows: rows, comments: comments });
  if (shas.length) ensureBytes(shas);
}

function count(n) { return n === 1 ? "1 scene" : n + " scenes"; }

function refused(what) {
  if (!reviewMode()) return false;
  showToast("This is a review copy — scenes can be copied from it, not " + what + ".", "warn");
  return true;
}

function writeScenes(cd, cut) {
  var ids = selectedSceneIds();
  var nonce = cut ? randomHexBytes(16) : null;
  var out = buildScenePayload(S.state, ids, { cut: nonce });
  try { cd.setData(SCENES_MIME, out.json); } catch (e) { }
  cd.setData("text/html", out.html);
  cd.setData("text/plain", out.text);
  return { ids: ids, nonce: nonce, out: out };
}

function onBeforeCopy(e) {
  if (hasSceneSelection() && !inEditable()) e.preventDefault();
}

function inEditable() {
  var a = document.activeElement;
  return !!(a && a !== document.body && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
}

function onCopyEvent(e) {
  if (!hasSceneSelection() || inEditable() || !e.clipboardData) return;
  var cut = e.type === "cut" || pendingCut;
  pendingCut = false;
  e.preventDefault();
  e.stopImmediatePropagation();
  var readOnly = reviewMode();
  var w = writeScenes(e.clipboardData, cut && !readOnly);
  clipWritten = w;
  if (cut && !readOnly) {
    afterCut(w);
    return;
  }
  var msg = count(w.ids.length) + " copied";
  if (cut && readOnly) msg = "This is a review copy — " + count(w.ids.length) + " copied, not cut";
  announceLeftOut(msg, w.out.leftOut, readOnly && cut ? "warn" : "ok");
}

function announceLeftOut(msg, leftOut, kind) {
  if (leftOut.length) {
    showToast(msg + ". " + (leftOut.length === 1 ? "One picture" : leftOut.length + " pictures") +
      " didn't fit on the clipboard: " + (leftOut.length === 1 ? "it pastes" : "they paste") +
      " only where Splitpage already has " + (leftOut.length === 1 ? "it" : "them") + ".", "warn");
  } else {
    showToast(msg + ".", kind || "ok");
  }
}

function execCopy() {
  try { return document.execCommand("copy"); } catch (e) { return false; }
}

function runClipboardCommand(cut) {
  pendingCut = cut;
  clipWritten = null;
  var ok = execCopy();
  pendingCut = false;
  if (ok && clipWritten) return;
  var ids = selectedSceneIds();
  if (!ids.length || !navigator.clipboard) { showToast("Could not reach the clipboard.", "warn"); return; }
  if (cut && refused("cut")) cut = false;
  var nonce = cut ? randomHexBytes(16) : null;
  var out = buildScenePayload(S.state, ids, { cut: nonce });
  var write = typeof ClipboardItem === "function" && navigator.clipboard.write
    ? navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([out.html], { type: "text/html" }),
        "text/plain": new Blob([out.text], { type: "text/plain" })
      })])
    : navigator.clipboard.writeText(out.text);
  write.then(function () {
    if (cut) afterCut({ ids: ids, nonce: nonce, out: out });
    else announceLeftOut(count(ids.length) + " copied", out.leftOut);
  }, function () { showToast("Could not reach the clipboard.", "warn"); });
}

function afterCut(w) {
  setLiveCut(w.nonce, S.state.docId);
  var entry = takeOut(w.ids);
  var msg = count(w.ids.length) + " cut — paste them with Ctrl+V";
  if (w.out.leftOut.length) announceLeftOut(msg, w.out.leftOut);
  else offerUndo(msg, entry);
}

function runSceneCommand(command) {
  var outcome = runCommand(command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected" && outcome.reason === REVIEW_ONLY) showToast(VIEWING_ONLY, "warn");
  return outcome.kind === "applied" || outcome.kind === "committed";
}

function takeOut(ids) {
  breakUndoCoalescing();
  var before = lastUndoEntry();
  var done = runSceneCommand(removeScenesCommand(ids));
  sel = null;
  paint();
  flushEdits();
  breakUndoCoalescing();
  if (done) scheduleProductionRefresh();
  var entry = lastUndoEntry();
  return entry === before ? null : entry;
}

export function deleteSelectedScenes() {
  var ids = selectedSceneIds();
  if (!ids.length || refused("deleted")) return;
  closeSceneMenu();
  offerUndo(count(ids.length) + " deleted", takeOut(ids));
}

function offerUndo(msg, entry) {
  if (!entry) { showToast(msg + ".", "ok"); return; }
  showActionToast(msg + ".", "ok", "Undo", function () {
    if (lastUndoEntry() === entry) undo();
    else showToast("Something else has changed since — Ctrl+Z undoes one step at a time.", "warn");
  });
}

function pasteClip(clip, afterRowId, opts) {
  opts = opts || {};
  breakUndoCoalescing();
  var before = lastUndoEntry();
  var hold = onServerDoc();
  var paste = scenePaste(clip, { afterRowId: afterRowId, holdComments: hold, title: opts.title, stamp: stampRow });
  if (!runSceneCommand(pasteScenesCommand(paste))) return null;
  var res = paste.result();
  flushEdits();
  if (res.held.length) {
    runSceneCommand(addHeldCommentsCommand(res.held));
    flushEdits();
  } else if (hold) {
    autoSavePolicy().dueNow();
  }
  breakUndoCoalescing();
  scheduleProductionRefresh();
  if (!viewFlags().writerOpen() && res.rowIds.length) {
    selectScenes(res.rowIds[0], res.rowIds[res.rowIds.length - 1]);
    var first = document.querySelector('#rows .row[data-id="' + cssAttr(res.rowIds[0]) + '"]');
    if (first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  var entry = lastUndoEntry();
  var msg = opts.message || count(res.rowIds.length) + " pasted";
  offerUndo(msg, entry === before ? null : entry);
  var want = clip.refs.filter(function (sha) { return clip.carried.indexOf(sha) === -1; });
  if (want.length) {
    ensureBytes(want).then(function (missing) {
      if (!missing.length) return;
      showToast((missing.length === 1 ? "A picture" : missing.length + " pictures") +
        " in the pasted scenes could not be found here — the scenes show where each one was.", "warn");
    });
  }
  return res;
}

export function pasteScenesAt(cd, cellEl) {
  if (!cd || !S.state) return false;
  var clip = scenesOnClipboard(function (t) { return cd.getData(t); });
  if (!clip) return false;
  if (refused("pasted into")) return true;
  cellEditing().sync(cellEl);
  pasteClip(clip, cellEl.getAttribute("data-id"));
  return true;
}

function onPasteEvent(e) {
  if (!hasSceneSelection() || inEditable() || !e.clipboardData) return;
  var clip = scenesOnClipboard(function (t) { return e.clipboardData.getData(t); });
  if (!clip) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (refused("pasted into")) return;
  var ids = selectedSceneIds();
  pasteClip(clip, ids[ids.length - 1]);
}

export function newScriptFromSelection() {
  var ids = selectedSceneIds();
  if (!ids.length) return;
  closeSceneMenu();
  if (reviewMode()) {
    showToast("This is a review copy — copy the scenes, then paste them into a new script.", "warn");
    return;
  }
  var title = S.state.title || "Untitled Script";
  var clip = parseScenePayload(buildScenePayload(S.state, ids).json);
  if (!clip || !startNewScript()) return;
  var first = S.state.rows[0];
  pasteClip(clip, first ? first.id : null, {
    title: cappedLongText(title + " — " + count(ids.length), 300),
    message: "New script with " + count(ids.length) + " — the one before is in Version history"
  });
}

function onKeyDown(e) {
  if (!hasSceneSelection() || e.isComposing) return;
  if (menuEl && !menuEl.hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeSceneMenu(); return; }
    if (menuEl.contains(e.target)) return;
  }
  if (inEditable()) { clearSceneSelection(); return; }
  var mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  var k = String(e.key || "").toLowerCase();
  if (e.key === "Escape") { e.preventDefault(); clearSceneSelection(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && !mod) { e.preventDefault(); deleteSelectedScenes(); return; }
  if (mod && !e.shiftKey && (k === "c" || k === "x")) {
    e.preventDefault();
    runClipboardCommand(k === "x");
    return;
  }
  if (mod && k === "v") return;
  if (/^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return;
  clearSceneSelection();
}

function menuItem(action, icon, label, keys, danger) {
  return '<button class="gutter-btn row-menu-item' + (danger ? " danger" : "") + '" type="button" role="menuitem" data-scene-action="' +
    action + '"><svg class="mi-icon" aria-hidden="true"><use href="#' + icon + '"/></svg>' +
    '<span class="row-menu-label">' + label + "</span>" + (keys ? '<span class="scene-menu-keys">' + keys + "</span>" : "") + "</button>";
}

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement("div");
  menuEl.id = "scene-menu";
  menuEl.className = "row-menu scene-menu";
  menuEl.setAttribute("role", "menu");
  menuEl.hidden = true;
  menuEl.innerHTML =
    menuItem("copy", "i-copy", "Copy scenes", "Ctrl+C") +
    menuItem("cut", "i-clipboard", "Cut scenes", "Ctrl+X") +
    menuItem("delete", "i-trash", "Delete scenes", "Del", true) +
    menuItem("new", "i-file-plus", "New script from these scenes", "");
  menuEl.addEventListener("mousedown", function (e) { e.preventDefault(); });
  menuEl.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-scene-action]");
    if (!btn || btn.disabled) return;
    var action = btn.getAttribute("data-scene-action");
    closeSceneMenu();
    if (action === "copy") runClipboardCommand(false);
    else if (action === "cut") runClipboardCommand(true);
    else if (action === "delete") deleteSelectedScenes();
    else if (action === "new") newScriptFromSelection();
  });
  document.body.appendChild(menuEl);
  return menuEl;
}

export function openSceneMenu(x, y) {
  var ids = selectedSceneIds();
  if (!ids.length) return;
  var menu = ensureMenu();
  var review = reviewMode();
  menu.setAttribute("aria-label", count(ids.length) + " selected");
  Array.prototype.forEach.call(menu.querySelectorAll("[data-scene-action]"), function (b) {
    var a = b.getAttribute("data-scene-action");
    var off = review && a !== "copy";
    b.disabled = off;
    b.title = off ? "A review copy can only copy scenes" : "";
  });
  menu.hidden = false;
  var w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}

export function closeSceneMenu() {
  if (menuEl) menuEl.hidden = true;
}

function onContextMenu(e) {
  if (!hasSceneSelection()) return;
  var row = e.target.closest && e.target.closest("#rows .row[data-id]");
  if (row && selectedSceneIds().indexOf(row.getAttribute("data-id")) !== -1) {
    e.preventDefault();
    openSceneMenu(e.clientX, e.clientY);
    return;
  }
  clearSceneSelection();
}

function onDocMouseDown(e) {
  if (menuEl && menuEl.contains(e.target)) return;
  if (e.button === 2 && hasSceneSelection()) {
    var row = e.target.closest && e.target.closest("#rows .row[data-id]");
    if (row && selectedSceneIds().indexOf(row.getAttribute("data-id")) !== -1) { e.preventDefault(); return; }
  }
  closeSceneMenu();
  if (sel) clearSceneSelection();
}

export function __init() {
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("mousedown", onRowsMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("beforecopy", onBeforeCopy, true);
  document.addEventListener("beforecut", onBeforeCopy, true);
  document.addEventListener("copy", onCopyEvent, true);
  document.addEventListener("cut", onCopyEvent, true);
  document.addEventListener("paste", onPasteEvent, true);
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("resize", closeSceneMenu);
  window.addEventListener("scroll", closeSceneMenu, true);
  window.__sceneSelectTest = {
    select: selectScenes,
    clear: clearSceneSelection,
    ids: selectedSceneIds,
    openMenu: openSceneMenu,
    tracking: function () { return track ? { rowId: track.rowId, scene: track.scene } : null; }
  };
}
