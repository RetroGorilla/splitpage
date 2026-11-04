import type { BeatSelectPorts } from "./ports.ts";
import type { DocumentView, Command } from "../../application/session/document-session.ts";
import { refsIn } from "../../../shared/blob-policy.ts";
import { exposeTestHook } from "../common/test-hooks.ts";
import { cssAttr } from "../common/dom.ts";
import {
  BEATS_MIME, buildBeatPayload, parseBeatPayload, beatPaste, beatsOnClipboard, setLiveCut
} from "./beat-clip.ts";
import { pasteBeatsCommand, removeBeatsCommand } from "../../application/commands/beats.ts";
import { cappedLongText } from "../../core/document/text-policy.ts";
import { EVERY_OVERLAY, inFront } from "../../application/screen.ts";
import { IS_MAC } from "../common/key-chips.ts";
import { linkOpenedBy } from "../common/link-press.ts";

const TOLERANCE = 4;
const SCROLL_ZONE = 120;
const SCROLL_MIN = 6;
const SCROLL_MAX = 28;
const NOT_A_BEAT_CLICK = "a[href], button, input, textarea, select, summary, label, .row-menu, .link-popover, .video-popover, .mini-toolbar";
const BEAT_PICTURE = ".scene-gallery-tile";
const HIDES_BEATS = '#rows .hidden-shot-strip, #rows .section-fold[aria-expanded="false"]';

let ports: BeatSelectPorts | null = null;
let track: { cell: HTMLElement; rowId: string | null; x: number; y: number; beat: boolean } | null = null;
let sel: { anchor: string | null | undefined; focus: string | null | undefined; ids: Set<string>; doc: DocumentView | null } | null = null;
let lastClicked: { id: string; doc: DocumentView | null } | null = null;
let swallowClick = false;
let scroll: { dir: number; speed: number; raf: number } | null = null;
let styleEl: HTMLStyleElement | null = null;
let menuEl: HTMLDivElement | null = null;
let pendingCut = false;
let clipWritten: ReturnType<typeof writeBeats> | null = null;

function hasBeatSelection() {
  if (sel && sel.doc !== (ports as BeatSelectPorts).document.current()) clearBeatSelection();
  return !!sel;
}

function selectedBeatIds() {
  if (!hasBeatSelection()) return [];
  const rows = ((ports as BeatSelectPorts).document.current() as DocumentView).rows;
  const chosen = (sel as NonNullable<typeof sel>).ids;
  const ids = rows.filter(function (r) { return chosen.has(r.id); }).map(function (r) { return r.id; });
  if (!document.querySelector(HIDES_BEATS)) return ids;
  const shown = new Set(Array.from(rowEls(), function (el) { return el.getAttribute("data-id"); }));
  return ids.filter(function (id) { return shown.has(id); });
}

function beatsBetween(anchorId: string | null | undefined, focusId: string | null | undefined) {
  const rows = ((ports as BeatSelectPorts).document.current() as DocumentView).rows;
  let a = -1, b = -1;
  rows.forEach(function (r, i) {
    if (r.id === anchorId) a = i;
    if (r.id === focusId) b = i;
  });
  if (a === -1 && b === -1) return new Set<string>();
  if (a === -1) a = b;
  if (b === -1) b = a;
  return new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(function (r) { return r.id; }));
}

export function selectBeats(anchorId: string | null | undefined, focusId?: string | null | undefined) {
  const focus = focusId || anchorId;
  sel = { anchor: anchorId, focus: focus, ids: beatsBetween(anchorId, focus), doc: (ports as BeatSelectPorts).document.current() };
  paint();
}

function overlayInFront() {
  return !!inFront(["loading", ...EVERY_OVERLAY], (ports as BeatSelectPorts).screen());
}

function leaveText() {
  const s = window.getSelection();
  if (s) s.removeAllRanges();
  if (inEditable()) (document.activeElement as HTMLElement).blur();
  (ports as BeatSelectPorts).rows.closeMenus();
}

function selectAllBeats() {
  const doc = (ports as BeatSelectPorts).document.current();
  if (!doc || inEditable() || overlayInFront()) return false;
  closeBeatMenu();
  if (!doc.rows.length) return true;
  const ids = new Set(doc.rows.map(function (r) { return r.id; }));
  const first = (doc.rows[0] as NonNullable<typeof doc.rows[number]>).id;
  sel = { anchor: first, focus: first, ids: ids, doc: doc };
  leaveText();
  paint();
  prefetchPictures();
  return true;
}

function beatUnder(target: Element) {
  if (!target.closest || (!target.closest(BEAT_PICTURE) && target.closest(NOT_A_BEAT_CLICK))) return null;
  const cell = target.closest(".cell-editable");
  if (cell && !(ports as BeatSelectPorts).scriptCell(cell)) return null;
  const row = target.closest("#rows .row[data-id]");
  return row ? row.getAttribute("data-id") : null;
}

function cursorBeat() {
  const a = document.activeElement;
  return a && a.classList.contains("cell-editable") && a.closest("#rows") && (ports as BeatSelectPorts).scriptCell(a) ? a.getAttribute("data-id") : null;
}

function rangeStart() {
  const doc = (ports as BeatSelectPorts).document.current();
  const id = cursorBeat() || (lastClicked && lastClicked.doc === doc ? lastClicked.id : null);
  return id && doc && doc.rows.some(function (r) { return r.id === id; }) ? id : null;
}

function extendTo(id: string) {
  const anchor = hasBeatSelection() ? (sel as NonNullable<typeof sel>).anchor : rangeStart();
  if (!sel && (!anchor || anchor === id)) return false;
  const doc = (ports as BeatSelectPorts).document.current();
  sel = { anchor: anchor, focus: id, ids: beatsBetween(anchor, id), doc: doc };
  return true;
}

function toggleBeat(id: string) {
  const doc = (ports as BeatSelectPorts).document.current();
  const ids = hasBeatSelection() ? (sel as NonNullable<typeof sel>).ids : new Set<string>();
  if (ids.has(id)) ids.delete(id); else ids.add(id);
  sel = ids.size ? { anchor: id, focus: id, ids: ids, doc: doc } : null;
}

function selectionClick(e: MouseEvent) {
  const toggle = (IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey;
  const extend = e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (e.button !== 0 || (!toggle && !extend) || (ports as BeatSelectPorts).rowDrag.dragging() || overlayInFront()) return false;
  const id = beatUnder(e.target as Element);
  if (!id) return false;
  if (toggle) toggleBeat(id);
  else if (!extendTo(id)) return false;
  lastClicked = { id: id, doc: (ports as BeatSelectPorts).document.current() };
  e.preventDefault();
  e.stopPropagation();
  swallowClick = true;
  leaveText();
  paint();
  if (sel) prefetchPictures();
  return true;
}

function noteClickedBeat(e: MouseEvent) {
  if (e.button !== 0) return;
  const row = (e.target as Element).closest && (e.target as Element).closest("#rows .row[data-id]");
  const id = row ? row.getAttribute("data-id") : null;
  if (id) lastClicked = { id: id, doc: (ports as BeatSelectPorts).document.current() };
}

function onDocClick(e: MouseEvent) {
  if (!swallowClick) return;
  swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}

function clearBeatSelection() {
  if (!sel && !track) return;
  sel = null;
  if (track && track.beat) endTrack();
  paint();
  closeBeatMenu();
}

function paint() {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "scene-selection-style";
    document.head.appendChild(styleEl);
  }
  const ids = sel ? selectedBeatIds() : [];
  document.body.classList.toggle("has-scene-selection", ids.length > 0);
  if (!ids.length) { styleEl.textContent = ""; return; }
  const of = function (id: string) { return '#rows .row[data-id="' + cssAttr(id) + '"]'; };
  const bar = "inset 3px 0 0 var(--focus-ring)";
  const top = ",inset 0 2px 0 var(--focus-ring)";
  const bottom = ",inset 0 -2px 0 var(--focus-ring)";
  const place = new Map(((ports as BeatSelectPorts).document.current() as DocumentView).rows.map(function (r, i) { return [r.id, i] as const; }));
  const follows = function (a: string | undefined, b: string | undefined) {
    return a !== undefined && b !== undefined && (place.get(a) as number) + 1 === place.get(b);
  };
  const tops: string[] = [], bottoms: string[] = [], both: string[] = [];
  ids.forEach(function (id, i) {
    const opens = !follows(ids[i - 1], id), closes = !follows(id, ids[i + 1]);
    if (opens && closes) both.push(of(id));
    else if (opens) tops.push(of(id));
    else if (closes) bottoms.push(of(id));
  });
  const edge = function (list: string[], shadow: string) { return list.length ? list.join(",") + "{box-shadow:" + bar + shadow + ";}" : ""; };
  styleEl.textContent =
    ids.map(of).join(",") + "{background:var(--selection);box-shadow:" + bar + ";}" +
    edge(tops, top) + edge(bottoms, bottom) + edge(both, top + bottom);
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
  if (e.button !== 0 || (ports as BeatSelectPorts).rowDrag.dragging()) return;
  const cell = (e.target as Element).closest && (e.target as Element).closest<HTMLElement>(".cell-editable");
  if (!cell || !(ports as BeatSelectPorts).scriptCell(cell) || !cell.closest("#rows")) return;
  track = { cell: cell, rowId: cell.getAttribute("data-id"), x: e.clientX, y: e.clientY, beat: false };
}

function onMouseMove(e: MouseEvent) {
  if (!track) return;
  if (!(e.buttons & 1)) { endTrack(); return; }
  track.x = e.clientX;
  track.y = e.clientY;
  if (!track.beat) {
    const r = track.cell.getBoundingClientRect();
    if (e.clientY >= r.top - TOLERANCE && e.clientY <= r.bottom + TOLERANCE) return;
    startBeats();
  }
  e.preventDefault();
  followPointer();
  updateScroll();
}

function startBeats() {
  (track as NonNullable<typeof track>).beat = true;
  selectBeats((track as NonNullable<typeof track>).rowId);
  document.body.classList.add("is-scene-selecting");
  const s = window.getSelection();
  if (s) s.removeAllRanges();
  if (document.activeElement === (track as NonNullable<typeof track>).cell) (track as NonNullable<typeof track>).cell.blur();
  (ports as BeatSelectPorts).rows.closeMenus();
}

function followPointer() {
  if (!track || !sel) return;
  const id = rowIdAtY(track.y);
  if (id && id !== sel.focus) selectBeats(sel.anchor, id);
}

function endTrack() {
  const was = track;
  track = null;
  stopScroll();
  document.body.classList.remove("is-scene-selecting");
  if (was && was.beat && sel) prefetchPictures();
}

function onMouseUp() {
  if (track) endTrack();
}

function onDragStart() {
  if (track && !track.beat) track = null;
}

function onSelectionChange() {
  if (!track || !track.beat) return;
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
  const ids = selectedBeatIds();
  if (!ids.length) return;
  const want = Object.create(null);
  ids.forEach(function (id) { want[id] = true; });
  const doc = (ports as BeatSelectPorts).document.current();
  const rows = (doc as DocumentView).rows.filter(function (r) { return want[r.id]; });
  const comments = ((doc as DocumentView).comments || []).filter(function (c) { return c && want[c.rowId as string]; });
  const shas = refsIn({ rows: rows, comments: comments });
  if (shas.length) (ports as BeatSelectPorts).pictures.ensureBytes(shas);
}

function count(n: number) { return n === 1 ? "1 beat" : n + " beats"; }

function writeBeats(cd: DataTransfer, cut: boolean) {
  const ids = selectedBeatIds();
  const nonce = cut ? (ports as BeatSelectPorts).nonce() : null;
  const out = buildBeatPayload((ports as BeatSelectPorts).document.current(), ids, { cut: nonce });
  try { cd.setData(BEATS_MIME, out.json); } catch (e) { }
  cd.setData("text/html", out.html);
  cd.setData("text/plain", out.text);
  return { ids: ids, nonce: nonce, out: out };
}

function onBeforeCopy(e: Event) {
  if (hasBeatSelection() && !inEditable()) e.preventDefault();
}

function inEditable() {
  const a = document.activeElement;
  return !!(a && a !== document.body && ((a as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
}

function onCopyEvent(e: ClipboardEvent) {
  if (!hasBeatSelection() || inEditable() || !e.clipboardData) return;
  const cut = e.type === "cut" || pendingCut;
  pendingCut = false;
  e.preventDefault();
  e.stopImmediatePropagation();
  const w = writeBeats(e.clipboardData, cut);
  clipWritten = w;
  if (cut) {
    afterCut(w);
    return;
  }
  announceLeftOut(count(w.ids.length) + " copied", w.out.leftOut, "ok");
}

function announceLeftOut(msg: string, leftOut: string[], kind?: "ok" | "warn") {
  if (leftOut.length) {
    (ports as BeatSelectPorts).notices.show(msg + ". " + (leftOut.length === 1 ? "One picture" : leftOut.length + " pictures") +
      " didn't fit on the clipboard: " + (leftOut.length === 1 ? "it pastes" : "they paste") +
      " only where Splitpage already has " + (leftOut.length === 1 ? "it" : "them") + ".", "warn");
  } else {
    (ports as BeatSelectPorts).notices.show(msg + ".", kind || "ok");
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
  const ids = selectedBeatIds();
  if (!ids.length || !navigator.clipboard) { (ports as BeatSelectPorts).notices.show("Could not reach the clipboard.", "warn"); return; }
  const nonce = cut ? (ports as BeatSelectPorts).nonce() : null;
  const out = buildBeatPayload((ports as BeatSelectPorts).document.current(), ids, { cut: nonce });
  const write = typeof ClipboardItem === "function" && navigator.clipboard.write
    ? navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([out.html], { type: "text/html" }),
        "text/plain": new Blob([out.text], { type: "text/plain" })
      })])
    : navigator.clipboard.writeText(out.text);
  write.then(function () {
    if (cut) afterCut({ ids: ids, nonce: nonce, out: out });
    else announceLeftOut(count(ids.length) + " copied", out.leftOut);
  }, function () { (ports as BeatSelectPorts).notices.show("Could not reach the clipboard.", "warn"); });
}

function afterCut(w: ReturnType<typeof writeBeats>) {
  setLiveCut(w.nonce, ((ports as BeatSelectPorts).document.current() as DocumentView).docId);
  const entry = takeOut(w.ids);
  const msg = count(w.ids.length) + " cut — paste them with Ctrl+V";
  if (w.out.leftOut.length) announceLeftOut(msg, w.out.leftOut);
  else offerUndo(msg, entry);
}

function runBeatCommand(command: Command) {
  const outcome = (ports as BeatSelectPorts).edits.run(command);
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "applied" || outcome.kind === "committed";
}

function takeOut(ids: string[]) {
  (ports as BeatSelectPorts).undo.breakCoalescing();
  const before = (ports as BeatSelectPorts).undo.last();
  const done = runBeatCommand(removeBeatsCommand(ids));
  sel = null;
  paint();
  (ports as BeatSelectPorts).undo.flush();
  (ports as BeatSelectPorts).undo.breakCoalescing();
  if (done) (ports as BeatSelectPorts).production.scheduleRefresh();
  const entry = (ports as BeatSelectPorts).undo.last();
  return entry === before ? null : entry;
}

export function deleteSelectedBeats() {
  const ids = selectedBeatIds();
  if (!ids.length) return;
  closeBeatMenu();
  offerUndo(count(ids.length) + " deleted", takeOut(ids));
}

function offerUndo(msg: string, entry: ReturnType<BeatSelectPorts["undo"]["last"]>) {
  if (!entry) { (ports as BeatSelectPorts).notices.show(msg + ".", "ok"); return; }
  (ports as BeatSelectPorts).notices.showAction(msg + ".", "ok", "Undo", function () {
    if ((ports as BeatSelectPorts).undo.last() === entry) (ports as BeatSelectPorts).undo.undo();
    else (ports as BeatSelectPorts).notices.show("Something else has changed since — Ctrl+Z undoes one step at a time.", "warn");
  });
}

function pasteClip(clip: NonNullable<ReturnType<typeof parseBeatPayload>>, afterRowId: string | null | undefined, opts?: Pick<NonNullable<Parameters<typeof beatPaste>[1]>, "title"> & { message?: string }) {
  opts = opts || {};
  (ports as BeatSelectPorts).undo.breakCoalescing();
  const before = (ports as BeatSelectPorts).undo.last();
  const paste = beatPaste(clip, { afterRowId: afterRowId, title: opts.title, stamp: (ports as BeatSelectPorts).stampRow });
  if (!runBeatCommand(pasteBeatsCommand(paste))) return null;
  const res = paste.result();
  (ports as BeatSelectPorts).undo.flush();
  (ports as BeatSelectPorts).undo.breakCoalescing();
  (ports as BeatSelectPorts).production.scheduleRefresh();
  if (!(ports as BeatSelectPorts).writerOpen() && (res as NonNullable<typeof res>).rowIds.length) {
    selectBeats((res as NonNullable<typeof res>).rowIds[0], (res as NonNullable<typeof res>).rowIds[(res as NonNullable<typeof res>).rowIds.length - 1]);
    const first = document.querySelector('#rows .row[data-id="' + cssAttr((res as NonNullable<typeof res>).rowIds[0]) + '"]');
    if (first) first.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const entry = (ports as BeatSelectPorts).undo.last();
  const msg = opts.message || count((res as NonNullable<typeof res>).rowIds.length) + " pasted";
  offerUndo(msg, entry === before ? null : entry);
  const want = clip.refs.filter(function (sha: string) { return clip.carried.indexOf(sha) === -1; });
  if (want.length) {
    (ports as BeatSelectPorts).pictures.ensureBytes(want).then(function (missing) {
      if (!missing.length) return;
      (ports as BeatSelectPorts).notices.show((missing.length === 1 ? "A picture" : missing.length + " pictures") +
        " in the pasted beats could not be found here — the beats show where each one was.", "warn");
    });
  }
  return res;
}

export function pasteBeatsAt(cd: DataTransfer | null, cellEl: Element) {
  if (!cd || !(ports as BeatSelectPorts).document.current()) return false;
  const clip = beatsOnClipboard(function (t: string) { return cd.getData(t); });
  if (!clip) return false;
  (ports as BeatSelectPorts).cells.sync(cellEl);
  pasteClip(clip, cellEl.getAttribute("data-id"));
  return true;
}

function onPasteEvent(e: ClipboardEvent) {
  if (!hasBeatSelection() || inEditable() || !e.clipboardData) return;
  const clip = beatsOnClipboard(function (t: string) { return (e.clipboardData as DataTransfer).getData(t); });
  if (!clip) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const ids = selectedBeatIds();
  pasteClip(clip, ids[ids.length - 1]);
}

export function newScriptFromSelection() {
  const ids = selectedBeatIds();
  if (!ids.length) return;
  closeBeatMenu();
  const source = (ports as BeatSelectPorts).document.current();
  const title = (source as DocumentView).title || "Untitled Script";
  const clip = parseBeatPayload(buildBeatPayload(source, ids).json);
  if (!clip || !(ports as BeatSelectPorts).startNewScript()) return;
  const first = ((ports as BeatSelectPorts).document.current() as DocumentView).rows[0];
  pasteClip(clip, first ? first.id : null, {
    title: cappedLongText(title + " — " + count(ids.length), 300),
    message: "New script with " + count(ids.length) + " — the one before is in Version history"
  });
}

function onKeyDown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "a" && selectAllBeats()) { e.preventDefault(); return; }
  if (!hasBeatSelection()) return;
  if (menuEl && !menuEl.hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeBeatMenu(); return; }
    if (menuEl.contains(e.target as Node | null)) return;
  }
  if (inEditable()) { clearBeatSelection(); return; }
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  const k = String(e.key || "").toLowerCase();
  if (e.key === "Escape") { e.preventDefault(); clearBeatSelection(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && !mod) { e.preventDefault(); deleteSelectedBeats(); return; }
  if (mod && !e.shiftKey && (k === "c" || k === "x")) {
    e.preventDefault();
    runClipboardCommand(k === "x");
    return;
  }
  if (mod && k === "v") return;
  if (/^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return;
  clearBeatSelection();
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
    menuItem("copy", "i-copy", "Copy beats", "Ctrl+C") +
    menuItem("cut", "i-clipboard", "Cut beats", "Ctrl+X") +
    menuItem("delete", "i-trash", "Delete beats", "Del", true) +
    menuItem("new", "i-file-plus", "New script from these beats", "");
  menuEl.addEventListener("mousedown", function (e) { e.preventDefault(); });
  menuEl.addEventListener("click", function (e) {
    const btn = (e.target as Element).closest<HTMLButtonElement>("[data-scene-action]");
    if (!btn || btn.disabled) return;
    const action = btn.getAttribute("data-scene-action");
    closeBeatMenu();
    if (action === "copy") runClipboardCommand(false);
    else if (action === "cut") runClipboardCommand(true);
    else if (action === "delete") deleteSelectedBeats();
    else if (action === "new") newScriptFromSelection();
  });
  document.body.appendChild(menuEl);
  return menuEl;
}

function openBeatMenu(x: number, y: number) {
  const ids = selectedBeatIds();
  if (!ids.length) return;
  const menu = ensureMenu();
  menu.setAttribute("aria-label", count(ids.length) + " selected");
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}

function closeBeatMenu() {
  if (menuEl) menuEl.hidden = true;
}

function onContextMenu(e: MouseEvent) {
  if (!hasBeatSelection()) return;
  const row = (e.target as Element).closest && (e.target as Element).closest("#rows .row[data-id]");
  if (row && (selectedBeatIds().indexOf as (id: string | null) => number)(row.getAttribute("data-id")) !== -1) {
    e.preventDefault();
    openBeatMenu(e.clientX, e.clientY);
    return;
  }
  clearBeatSelection();
}

function onDocMouseDown(e: MouseEvent) {
  if (menuEl && menuEl.contains(e.target as Node | null)) return;
  if (e.button === 2 && hasBeatSelection()) {
    const row = (e.target as Element).closest && (e.target as Element).closest("#rows .row[data-id]");
    if (row && (selectedBeatIds().indexOf as (id: string | null) => number)(row.getAttribute("data-id")) !== -1) { e.preventDefault(); return; }
  }
  closeBeatMenu();
  swallowClick = false;
  if (selectionClick(e)) return;
  if (linkOpenedBy(e, IS_MAC, (ports as BeatSelectPorts).scriptCell)) return;
  if (sel) clearBeatSelection();
  noteClickedBeat(e);
}

export function startBeatSelect(given: BeatSelectPorts) {
  ports = given;
  track = null;
  sel = null;
  lastClicked = null;
  swallowClick = false;
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
  listen(document, "click", onDocClick as EventListener, true);
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
  listen(window, "resize", closeBeatMenu);
  listen(window, "scroll", closeBeatMenu, true);
  exposeTestHook("__sceneSelectTest", function () { return {
    select: selectBeats,
    clear: clearBeatSelection,
    ids: selectedBeatIds,
    openMenu: openBeatMenu,
    tracking: function () { return track ? { rowId: track.rowId, scene: track.beat } : null; }
  }; }, function (withdraw) { offs.push(withdraw); });
  let disposed = false;
  return { dispose: function () {
    if (disposed) return;
    disposed = true;
    while (offs.length) (offs.pop() as () => void)();
    stopScroll();
    track = null;
    sel = null;
    lastClicked = null;
    document.body.classList.remove("has-scene-selection", "is-scene-selecting");
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    styleEl = null;
    menuEl = null;
  } };
}
