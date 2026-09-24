import { S } from "./_state.js";
import { writerOpen } from "./19-writer.js";

/* ================= script zoom (#191) =================

   Ctrl + mouse wheel over the script — and a trackpad pinch, which the
   browser delivers as a wheel event with ctrlKey set — makes the script
   bigger or smaller, 70 % to 200 %, and nothing else: the header, the
   rundown strip, the panels and the dialogs keep their size. The line
   under the pointer stays under the pointer.

   One number, --script-scale on #root, and app.css does the rest: the two
   columns' type, the scene number, the times, the row's padding and the
   gutter and rail widths are calc()s of it. On a touch device the fields
   never go under 16px however small the script is set (#162: iOS zooms the
   page into a smaller field) — that floor is app.css's too.

   Smooth: the wheel moves a target, and the scale eases toward it one step
   per animation frame, so a flick of the wheel is a short glide and a
   pinch is continuous — and the reflow of every row happens at most once a
   frame however fast the events come.

   Remembered per person, in localStorage (`splitpage-script-scale`, a
   number, 1 = 100 %), never in the document. The Settings dialog writes the
   same key and says so with a `splitpage:pref` event on document, which is
   applied here. */

export var SCRIPT_SCALE_KEY = "splitpage-script-scale";
export var SCRIPT_SCALE_MIN = 0.7;
export var SCRIPT_SCALE_MAX = 2;
/* Ctrl + / Ctrl − step through these, the way a browser's zoom does */
var KEY_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

var scale = 1;       /* what is on screen */
var target = 1;      /* what the wheel has asked for */
var frame = 0;
var anchor = null;   /* {el, frac, y}: the point that must not move */
var readoutTimer = 0;

export function clampScriptScale(v) {
  v = Number(v);
  if (!isFinite(v) || v <= 0) return 1;
  return Math.min(SCRIPT_SCALE_MAX, Math.max(SCRIPT_SCALE_MIN, v));
}

export function scriptScale() { return scale; }

function readStored() {
  try {
    var raw = localStorage.getItem(SCRIPT_SCALE_KEY);
    return raw == null ? 1 : clampScriptScale(parseFloat(raw));
  } catch (e) { return 1; }
}

function store(v) {
  try {
    if (Math.abs(v - 1) < 0.005) localStorage.removeItem(SCRIPT_SCALE_KEY);
    else localStorage.setItem(SCRIPT_SCALE_KEY, String(Math.round(v * 100) / 100));
  } catch (e) { /* private mode: it still works, it just is not kept */ }
}

function paintScale(v) {
  var root = document.getElementById("root");
  if (root) root.style.setProperty("--script-scale", String(Math.round(v * 1000) / 1000));
}

/* ---- keeping the reader's place ----

   Before a change, note the element under the point that must stay put and
   where in it that point is (as a fraction of its height — the words
   reflow, so a pixel offset would drift); after it, scroll by however far
   that spot moved. The element is the script cell under the pointer, or
   its row, or for the keyboard the cell with the caret. */
function noteAnchor(y, el) {
  var hold = el && el.closest && (el.closest("#rows .cell-editable") || el.closest("#rows .row"));
  if (!hold) {
    /* between rows, or over the gutter: the row nearest that height */
    var rows = document.querySelectorAll("#rows > .row");
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      if (r.bottom >= y) { hold = rows[i]; break; }
    }
  }
  if (!hold) { anchor = null; return; }
  var rect = hold.getBoundingClientRect();
  anchor = { el: hold, y: y, frac: rect.height ? (y - rect.top) / rect.height : 0 };
}

function holdAnchor() {
  if (!anchor || !anchor.el.isConnected) return;
  var rect = anchor.el.getBoundingClientRect();
  var now = rect.top + anchor.frac * rect.height;
  var dy = now - anchor.y;
  if (Math.abs(dy) >= 0.5) window.scrollBy(0, dy);
}

/* ---- applying ---- */

function step() {
  frame = 0;
  var diff = target - scale;
  /* ease: a third of the way each frame, then land exactly */
  scale = Math.abs(diff) < 0.004 ? target : scale + diff * 0.35;
  paintScale(scale);
  holdAnchor();
  if (scale !== target) frame = requestAnimationFrame(step);
  else { store(scale); settleAnchor(); }
}

/* The scroll a zoom makes can cross the header's condense line
   (20i-topbar.js), which a frame later sheds the rundown's ruler and moves
   everything under the header up by that much. Hold the place once more
   after that has had its frame. */
function settleAnchor() {
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { if (!frame) holdAnchor(); });
  });
}

function scheduleStep() {
  if (!frame) frame = requestAnimationFrame(step);
}

/* Set the scale. `opts.now` skips the glide (a reset, a stored value);
   `opts.quiet` shows no readout. */
export function setScriptScale(v, opts) {
  opts = opts || {};
  target = clampScriptScale(v);
  if (opts.now) {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    scale = target;
    paintScale(scale);
    holdAnchor();
    settleAnchor();
    if (!opts.noStore) store(scale);
  } else {
    scheduleStep();
  }
  if (!opts.quiet) showReadout(target);
}

export function stepScriptScale(dir) {
  var from = target, next = from;
  if (dir > 0) {
    for (var i = 0; i < KEY_STEPS.length; i++) if (KEY_STEPS[i] > from + 0.001) { next = KEY_STEPS[i]; break; }
  } else {
    for (var j = KEY_STEPS.length - 1; j >= 0; j--) if (KEY_STEPS[j] < from - 0.001) { next = KEY_STEPS[j]; break; }
  }
  anchorAtCaretOrMiddle();
  setScriptScale(next);
}

export function resetScriptScale() {
  anchorAtCaretOrMiddle();
  setScriptScale(1, { now: true });
}

function anchorAtCaretOrMiddle() {
  var active = document.activeElement;
  var cell = active && active.closest && active.closest("#rows .cell-editable");
  if (cell) {
    var r = cell.getBoundingClientRect();
    if (r.bottom > 0 && r.top < window.innerHeight) {
      var sel = window.getSelection();
      var y = r.top + r.height / 2;
      if (sel && sel.rangeCount) {
        var cr = sel.getRangeAt(0).getBoundingClientRect();
        if (cr && (cr.top || cr.bottom)) y = (cr.top + cr.bottom) / 2;
      }
      noteAnchor(y, cell);
      return;
    }
  }
  var mid = window.innerHeight / 2;
  noteAnchor(mid, document.elementFromPoint(window.innerWidth / 2, mid));
}

/* ---- the readout: "Script 125 %", and a click is back to 100 % ---- */

function readoutEl() {
  var el = document.getElementById("script-zoom-readout");
  if (el) return el;
  el = document.createElement("button");
  el.type = "button";
  el.id = "script-zoom-readout";
  el.className = "script-zoom-readout";
  el.hidden = true;
  el.title = "Script size — click to go back to 100 %";
  el.setAttribute("aria-live", "polite");
  el.addEventListener("click", function () { resetScriptScale(); });
  el.addEventListener("mouseenter", function () { clearTimeout(readoutTimer); });
  el.addEventListener("mouseleave", function () { hideReadoutSoon(); });
  document.body.appendChild(el);
  return el;
}

function showReadout(v) {
  var el = readoutEl();
  el.textContent = "Script " + Math.round(v * 100) + " %";
  el.hidden = false;
  el.classList.remove("is-leaving");
  hideReadoutSoon();
}

function hideReadoutSoon() {
  clearTimeout(readoutTimer);
  readoutTimer = setTimeout(function () {
    var el = document.getElementById("script-zoom-readout");
    if (el) el.hidden = true;
  }, 1800);
}

/* ---- where the zoom applies ----

   The main editor view only: Present and the Writer have their own size
   controls and keep the browser's zoom, and so does the New Tab page. */
function scriptViewActive() {
  return !!S.state && !S.prompterOpen && !writerOpen &&
    !document.documentElement.classList.contains("is-newtab-open");
}

function onWheel(e) {
  if (!e.ctrlKey || !scriptViewActive()) return;
  /* not the page's zoom as well — non-passive, or this is ignored */
  e.preventDefault();
  var dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 33;        /* lines */
  else if (e.deltaMode === 2) dy *= 600;  /* pages */
  /* A wheel notch is ~100 and comes as one event: about 10 %. A pinch
     comes as many small ones and adds up the same way. */
  dy = Math.max(-300, Math.min(300, dy));
  noteAnchor(e.clientY, e.target);
  setScriptScale(target * Math.exp(-dy * 0.001));
}

/* Ctrl + "+" / "−" / "0" — Adam's call (#191): in the main editor view
   these are the script's zoom, not the browser's page zoom, everywhere in
   that view (not only over the script); Present and the Writer keep the
   browser's. The desktop app's View ▸ Zoom In / Zoom Out / Actual Size come
   here too, through runDesktopMenuCommand (20f-desktop.js). */
function zoomKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return 0;
  var k = e.key, c = e.code;
  if (k === "+" || k === "=" || c === "NumpadAdd" || c === "Equal") return 1;
  if (k === "-" || k === "_" || k === "−" || c === "NumpadSubtract" || c === "Minus") return -1;
  if (k === "0" || c === "Numpad0" || c === "Digit0") return 2;
  return 0;
}

function onKeydown(e) {
  var z = zoomKey(e);
  if (!z || !scriptViewActive()) return;
  e.preventDefault();
  if (z === 2) resetScriptScale();
  else stepScriptScale(z);
}

export function runScriptZoomCommand(cmd) {
  if (cmd === "script-zoom-in") stepScriptScale(1);
  else if (cmd === "script-zoom-out") stepScriptScale(-1);
  else if (cmd === "script-zoom-reset") resetScriptScale();
  else return false;
  return true;
}

export function __init() {
  scale = target = readStored();
  paintScale(scale);
  var rowsEl = document.getElementById("rows");
  if (rowsEl) rowsEl.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("keydown", onKeydown, true);
  /* The Settings dialog (and anything else) changing the stored value */
  document.addEventListener("splitpage:pref", function (e) {
    var d = e && e.detail;
    if (!d || d.key !== SCRIPT_SCALE_KEY) return;
    var v = d.value == null ? readStored() : clampScriptScale(parseFloat(d.value));
    anchorAtCaretOrMiddle();
    setScriptScale(v, { now: true, quiet: true, noStore: true });
  });
  /* another window of this app changing it */
  window.addEventListener("storage", function (e) {
    if (e.key !== SCRIPT_SCALE_KEY) return;
    anchorAtCaretOrMiddle();
    setScriptScale(readStored(), { now: true, quiet: true, noStore: true });
  });
}
