import type { SceneSelectPorts } from "./ports.ts";
import type { DocumentView, Command } from "../../application/session/document-session.ts";
import { refsIn } from "../../../shared/blob-policy.js";
import { exposeTestHook } from "../common/test-hooks.ts";
import { cssAttr } from "../common/dom.ts";
import {
  SCENES_MIME, buildScenePayload, parseScenePayload, scenePaste, scenesOnClipboard, setLiveCut
} from "./scene-clip.ts";
import { pasteScenesCommand, removeScenesCommand } from "../../application/commands/scenes.ts";
import { cappedLongText } from "../../core/document/text-policy.ts";

const TOLERANCE = 4;
const SCROLL_ZONE = 120;
const SCROLL_MIN = 6;
const SCROLL_MAX = 28;

let ports: SceneSelectPorts | null = null;
let track: { cell: HTMLElement; rowId: string | null; x: number; y: number; scene: boolean } | null = null;
let sel: { anchor: string | null | undefined; focus: string | null | undefined; doc: DocumentView | null } | null = null;
let scroll: { dir: number; speed: number; raf: number } | null = null;
let styleEl: HTMLStyleElement | null = null;
let menuEl: HTMLDivElement | null = null;
let pendingCut = false;
let clipWritten: ReturnType<typeof writeScenes> | null = null;

function hasSceneSelection() {
  if (sel && sel.doc !== (ports as SceneSelectPorts).document.current()) clearSceneSelection();
  return !!sel;
}

function selectedSceneIds() {
  if (!hasSceneSelection()) return [];
  const rows = ((ports as SceneSelectPorts).document.current() as DocumentView).rows;
  let a = -1, b = -1;
  rows.forEach(function (r, i) {
    if (r.id === (sel as NonNullable<typeof sel>).anchor) a = i;
    if (r.id === (sel as NonNullable<typeof sel>).focus) b = i;
  });
  if (a === -1 && b === -1) return [];
  if (a === -1) a = b;
  if (b === -1) b = a;
  let ids = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(function (r) { return r.id; });
  if (document.querySelector("#rows .hidden-shot-strip")) {
    ids = ids.filter(function (id) { return !!document.querySelector('#rows .row[data-id="' + cssAttr(id) + '"]'); });
  }
  return ids;
}

export function selectScenes(anchorId: string | null | undefined, focusId?: string | null | undefined) {
  sel = { anchor: anchorId, focus: focusId || anchorId, doc: (ports as SceneSelectPorts).document.current() };
  paint();
}

function clearSceneSelection() {
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
  const ids = sel ? selectedSceneIds() : [];
  document.body.classList.toggle("has-scene-selection", ids.length > 0);
  if (!ids.length) { styleEl.textContent = ""; return; }
  const of = function (id: string) { return '#rows .row[data-id="' + cssAttr(id) + '"]'; };
  const bar = "inset 3px 0 0 var(--focus-ring)";
  styleEl.textContent =
    ids.map(of).join(",") + "{background:var(--selection);box-shadow:" + bar + ";}" +
    of(ids[0] as string) + "{box-shadow:" + bar + ",inset 0 2px 0 var(--focus-ring);}" +
    of(ids[ids.length - 1] as string) + "{box-shadow:" + bar + (ids.length === 1 ? ",inset 0 2px 0 var(--focus-ring)" : "") +
      ",inset 0 -2px 0 var(--focus-ring);}";
}

function rowEls() {
  return document.querySelectorAll("#rows .row[data-id]");
}

function rowIdAtY(y: number) {
  const els = rowEls();
  if (!els.length) return null;
  for (let i = 0; i < els.length; i++) {
    if (y <= (els[i] as Element).getBoundingClientRect().bottom) return (els[i] as Element).getAttribute("data-id");
  }
  return (els[els.length - 1] as Element).getAttribute("data-id");
}

function onRowsMouseDown(e: MouseEvent) {
  if (e.button !== 0 || (ports as SceneSelectPorts).rowDrag.dragging()) return;
  const cell = (e.target as Element).closest && (e.target as Element).closest<HTMLElement>(".cell-editable");
  if (!cell || !(ports as SceneSelectPorts).scriptCell(cell) || !cell.closest("#rows")) return;
  track = { cell: cell, rowId: cell.getAttribute("data-id"), x: e.clientX, y: e.clientY, scene: false };
}

function onMouseMove(e: MouseEvent) {
  if (!track) return;
  if (!(e.buttons & 1)) { endTrack(); return; }
  track.x = e.clientX;
  track.y = e.clientY;
  if (!track.scene) {
    const r = track.cell.getBoundingClientRect();
    if (e.clientY >= r.top - TOLERANCE && e.clientY <= r.bottom + TOLERANCE) return;
    startScenes();
  }
  e.preventDefault();
  followPointer();
  updateScroll();
}

function startScenes() {
  (track as NonNullable<typeof track>).scene = true;
  sel = { anchor: (track as NonNullable<typeof track>).rowId, focus: (track as NonNullable<typeof track>).rowId, doc: (ports as SceneSelectPorts).document.current() };
  document.body.classList.add("is-scene-selecting");
  const s = window.getSelection();
  if (s) s.removeAllRanges();
  if (document.activeElement === (track as NonNullable<typeof track>).cell) (track as NonNullable<typeof track>).cell.blur();
  (ports as SceneSelectPorts).rows.closeMenus();
  paint();
}

function followPointer() {
  if (!track || !sel) return;
  const id = rowIdAtY(track.y);
  if (id && id !== sel.focus) {
    sel.focus = id;
    paint();
  }
}

function endTrack() {
  const was = track;
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
  const s = window.getSelection();
  if (s && s.rangeCount && !s.isCollapsed) s.removeAllRanges();
}

function updateScroll() {
  const vh = window.innerHeight;
  const y = (track as NonNullable<typeof track>).y; let dir = 0, depth = 0;
  if (y < SCROLL_ZONE) { dir = -1; depth = SCROLL_ZONE - y; }
  else if (y > vh - SCROLL_ZONE) { dir = 1; depth = y - (vh - SCROLL_ZONE); }
  if (!dir) { stopScroll(); return; }
  const speed = SCROLL_MIN + Math.max(0, Math.min(1, depth / SCROLL_ZONE)) * (SCROLL_MAX - SCROLL_MIN);
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
  const ids = selectedSceneIds();
  if (!ids.length) return;
  const want = Object.create(null);
  ids.forEach(function (id) { want[id] = true; });
  const doc = (ports as SceneSelectPorts).document.current() as DocumentView;
  const rows = doc.rows.filter(function (r) { return want[r.id]; });
  const comments = (doc.comments || []).filter(function (c) { return c && want[c.rowId as string]; });
  const shas = refsIn({ rows: rows, comments: comments });
  if (shas.length) (ports as SceneSelectPorts).pictures.ensureBytes(shas);
}

function count(n: number) { return n === 1 ? "1 scene" : n + " scenes"; }

function writeScenes(cd: DataTransfer, cut: boolean) {
  const ids = selectedSceneIds();
  const nonce = cut ? (ports as SceneSelectPorts).nonce() : null;
  const out = buildScenePayload((ports as SceneSelectPorts).document.current(), ids, { cut: nonce });
  try { cd.setData(SCENES_MIME, out.json); } catch (e) { }
  cd.setData("text/html", out.html);
  cd.setData("text/plain", out.text);
  return { ids: ids, nonce: nonce, out: out };
}

function onBeforeCopy(e: Event) {
  if (hasSceneSelection() && !inEditable()) e.preventDefault();
}

function inEditable() {
  const a = document.activeElement;
  return !!(a && a !== document.body && ((a as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
}

function onCopyEvent(e: ClipboardEvent) {
  if (!hasSceneSelection() || inEditable() || !e.clipboardData) return;
  const cut = e.type === "cut" || pendingCut;
  pendingCut = false;
  e.preventDefault();
  e.stopImmediatePropagation();
  const w = writeScenes(e.clipboardData, cut);
  clipWritten = w;
  if (cut) {
    afterCut(w);
    return;
  }
  announceLeftOut(count(w.ids.length) + " copied", w.out.leftOut, "ok");
}

function announceLeftOut(msg: string, leftOut: string[], kind?: "ok" | "warn") {
  if (leftOut.length) {
    (ports as SceneSelectPorts).notices.show(msg + ". " + (leftOut.length === 1 ? "One picture" : leftOut.length + " pictures") +
      " didn't fit on the clipboard: " + (leftOut.length === 1 ? "it pastes" : "they paste") +
      " only where Splitpage already has " + (leftOut.length === 1 ? "it" : "them") + ".", "warn");
  } else {
    (ports as SceneSelectPorts).notices.show(msg + ".", kind || "ok");
  }
}

function execCopy() {
  try { return document.execCommand("copy"); } catch (e) { return false; }
}

function runClipboardCommand(cut: boolean) {
  pendingCut = cut;
  clipWritten = null;
  const ok = execCopy();
  pendingCut = false;
  if (ok && clipWritten) return;
  const ids = selectedSceneIds();
  if (!ids.length || !navigator.clipboard) { (ports as SceneSelectPorts).notices.show("Could not reach the clipboard.", "warn"); return; }
  const nonce = cut ? (ports as SceneSelectPorts).nonce() : null;
  const out = buildScenePayload((ports as SceneSelectPorts).document.current(), ids, { cut: nonce });
  const write = typeof ClipboardItem === "function" && navigator.clipboard.write
    ? navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([out.html], { type: "text/html" }),
        "text/plain": new Blob([out.text], { type: "text/plain" })
      })])
    : navigator.clipboard.writeText(out.text);
  write.then(function () {
    if (cut) afterCut({ ids: ids, nonce: nonce, out: out });
    else announceLeftOut(count(ids.length) + " copied", out.leftOut);
  }, function () { (ports as SceneSelectPorts).notices.show("Could not reach the clipboard.", "warn"); });
}

function afterCut(w: ReturnType<typeof writeScenes>) {
  setLiveCut(w.nonce, ((ports as SceneSelectPorts).document.current() as DocumentView).docId);
  const entry = takeOut(w.ids);
  const msg = count(w.ids.length) + " cut — paste them with Ctrl+V";
  if (w.out.leftOut.length) announceLeftOut(msg, w.out.leftOut);
  else offerUndo(msg, entry);
}

function runSceneCommand(command: Command) {
  const outcome = (ports as SceneSelectPorts).edits.run(command);
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed";
}

function takeOut(ids: string[]) {
  (ports as SceneSelectPorts).undo.breakCoalescing();
  const before = (ports as SceneSelectPorts).undo.last();
  const done = runSceneCommand(removeScenesCommand(ids));
  sel = null;
  paint();
  (ports as SceneSelectPorts).undo.flush();
  (ports as SceneSelectPorts).undo.breakCoalescing();
  if (done) (ports as SceneSelectPorts).production.scheduleRefresh();
  const entry = (ports as SceneSelectPorts).undo.last();
  return entry === before ? null : entry;
}

export function deleteSelectedScenes() {
  const ids = selectedSceneIds();
  if (!ids.length) return;
  closeSceneMenu();
  offerUndo(count(ids.length) + " deleted", takeOut(ids));
}

function offerUndo(msg: string, entry: ReturnType<SceneSelectPorts["undo"]["last"]>) {
  if (!entry) { (ports as SceneSelectPorts).notices.show(msg + ".", "ok"); return; }
  (ports as SceneSelectPorts).notices.showAction(msg + ".", "ok", "Undo", function () {
    if ((ports as SceneSelectPorts).undo.last() === entry) (ports as SceneSelectPorts).undo.undo();
    else (ports as SceneSelectPorts).notices.show("Something else has changed since — Ctrl+Z undoes one step at a time.", "warn");
  });
}

function pasteClip(clip: NonNullable<ReturnType<typeof parseScenePayload>>, afterRowId: string | null | undefined, opts?: Pick<NonNullable<Parameters<typeof scenePaste>[1]>, "title"> & { message?: string }) {
  opts = opts || {};
  (ports as SceneSelectPorts).undo.breakCoalescing();
  const before = (ports as SceneSelectPorts).undo.last();
  const paste = scenePaste(clip, { afterRowId: afterRowId, title: opts.title, stamp: (ports as SceneSelectPorts).stampRow });
  if (!runSceneCommand(pasteScenesCommand(paste))) return null;
  const res = paste.result();
  (ports as SceneSelectPorts).undo.flush();
  (ports as SceneSelectPorts).undo.breakCoalescing();
  (ports as SceneSelectPorts).production.scheduleRefresh();
  if (!(ports as SceneSelectPorts).writerOpen() && (res as NonNullable<typeof res>).rowIds.length) {
    selectScenes((res as NonNullable<typeof res>).rowIds[0], (res as NonNullable<typeof res>).rowIds[(res as NonNullable<typeof res>).rowIds.length - 1]);
    const first = document.querySelector('#rows .row[data-id="' + cssAttr((res as NonNullable<typeof res>).rowIds[0]) + '"]');
    if (first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const entry = (ports as SceneSelectPorts).undo.last();
  const msg = opts.message || count((res as NonNullable<typeof res>).rowIds.length) + " pasted";
  offerUndo(msg, entry === before ? null : entry);
  const want = clip.refs.filter(function (sha: string) { return clip.carried.indexOf(sha) === -1; });
  if (want.length) {
    (ports as SceneSelectPorts).pictures.ensureBytes(want).then(function (missing) {
      if (!missing.length) return;
      (ports as SceneSelectPorts).notices.show((missing.length === 1 ? "A picture" : missing.length + " pictures") +
        " in the pasted scenes could not be found here — the scenes show where each one was.", "warn");
    });
  }
  return res;
}

export function pasteScenesAt(cd: DataTransfer | null, cellEl: Element) {
  if (!cd || !(ports as SceneSelectPorts).document.current()) return false;
  const clip = scenesOnClipboard(function (t: string) { return cd.getData(t); });
  if (!clip) return false;
  (ports as SceneSelectPorts).cells.sync(cellEl);
  pasteClip(clip, cellEl.getAttribute("data-id"));
  return true;
}

function onPasteEvent(e: ClipboardEvent) {
  if (!hasSceneSelection() || inEditable() || !e.clipboardData) return;
  const clip = scenesOnClipboard(function (t: string) { return (e.clipboardData as DataTransfer).getData(t); });
  if (!clip) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const ids = selectedSceneIds();
  pasteClip(clip, ids[ids.length - 1]);
}

export function newScriptFromSelection() {
  const ids = selectedSceneIds();
  if (!ids.length) return;
  closeSceneMenu();
  const source = (ports as SceneSelectPorts).document.current() as DocumentView;
  const title = source.title || "Untitled Script";
  const clip = parseScenePayload(buildScenePayload(source, ids).json);
  if (!clip || !(ports as SceneSelectPorts).startNewScript()) return;
  const first = ((ports as SceneSelectPorts).document.current() as DocumentView).rows[0];
  pasteClip(clip, first ? first.id : null, {
    title: cappedLongText(title + " — " + count(ids.length), 300),
    message: "New script with " + count(ids.length) + " — the one before is in Version history"
  });
}

function onKeyDown(e: KeyboardEvent) {
  if (!hasSceneSelection() || e.isComposing) return;
  if (menuEl && !menuEl.hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeSceneMenu(); return; }
    if (menuEl.contains(e.target as Node | null)) return;
  }
  if (inEditable()) { clearSceneSelection(); return; }
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  const k = String(e.key || "").toLowerCase();
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

function menuItem(action: string, icon: string, label: string, keys: string, danger?: boolean) {
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
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-scene-action]");
    if (!btn || btn.disabled) return;
    const action = btn.getAttribute("data-scene-action");
    closeSceneMenu();
    if (action === "copy") runClipboardCommand(false);
    else if (action === "cut") runClipboardCommand(true);
    else if (action === "delete") deleteSelectedScenes();
    else if (action === "new") newScriptFromSelection();
  });
  document.body.appendChild(menuEl);
  return menuEl;
}

function openSceneMenu(x: number, y: number) {
  const ids = selectedSceneIds();
  if (!ids.length) return;
  const menu = ensureMenu();
  menu.setAttribute("aria-label", count(ids.length) + " selected");
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}

function closeSceneMenu() {
  if (menuEl) menuEl.hidden = true;
}

function onContextMenu(e: MouseEvent) {
  if (!hasSceneSelection()) return;
  const row = (e.target as Element).closest && (e.target as Element).closest("#rows .row[data-id]");
  if (row && (selectedSceneIds().indexOf as (id: string | null) => number)(row.getAttribute("data-id")) !== -1) {
    e.preventDefault();
    openSceneMenu(e.clientX, e.clientY);
    return;
  }
  clearSceneSelection();
}

function onDocMouseDown(e: MouseEvent) {
  if (menuEl && menuEl.contains(e.target as Node | null)) return;
  if (e.button === 2 && hasSceneSelection()) {
    const row = (e.target as Element).closest && (e.target as Element).closest("#rows .row[data-id]");
    if (row && (selectedSceneIds().indexOf as (id: string | null) => number)(row.getAttribute("data-id")) !== -1) { e.preventDefault(); return; }
  }
  closeSceneMenu();
  if (sel) clearSceneSelection();
}

export function startSceneSelect(given: SceneSelectPorts) {
  ports = given;
  track = null;
  sel = null;
  scroll = null;
  pendingCut = false;
  clipWritten = null;
  const offs: (() => void)[] = [];
  function listen(target: EventTarget, type: string, fn: EventListener, opts?: boolean) {
    target.addEventListener(type, fn, opts);
    offs.push(function () { target.removeEventListener(type, fn, opts); });
  }
  listen(document, "mousedown", onDocMouseDown as EventListener, true);
  listen(document, "mousedown", onRowsMouseDown as EventListener);
  listen(document, "mousemove", onMouseMove as EventListener);
  listen(document, "mouseup", onMouseUp);
  listen(document, "dragstart", onDragStart, true);
  listen(document, "selectionchange", onSelectionChange);
  listen(document, "beforecopy", onBeforeCopy, true);
  listen(document, "beforecut", onBeforeCopy, true);
  listen(document, "copy", onCopyEvent as EventListener, true);
  listen(document, "cut", onCopyEvent as EventListener, true);
  listen(document, "paste", onPasteEvent as EventListener, true);
  listen(window, "keydown", onKeyDown as EventListener, true);
  listen(document, "contextmenu", onContextMenu as EventListener);
  listen(window, "resize", closeSceneMenu);
  listen(window, "scroll", closeSceneMenu, true);
  exposeTestHook("__sceneSelectTest", function () { return {
    select: selectScenes,
    clear: clearSceneSelection,
    ids: selectedSceneIds,
    openMenu: openSceneMenu,
    tracking: function () { return track ? { rowId: track.rowId, scene: track.scene } : null; }
  }; }, function (withdraw) { offs.push(withdraw); });
  let disposed = false;
  return { dispose: function () {
    if (disposed) return;
    disposed = true;
    while (offs.length) (offs.pop() as () => void)();
    stopScroll();
    track = null;
    sel = null;
    document.body.classList.remove("has-scene-selection", "is-scene-selecting");
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    styleEl = null;
    menuEl = null;
  } };
}
