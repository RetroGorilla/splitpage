import { S } from "./_state.js";
import { writerOpen } from "./19-writer.js";

export var SCRIPT_SCALE_KEY = "splitpage-script-scale";
export var SCRIPT_SCALE_MIN = 0.7;
export var SCRIPT_SCALE_MAX = 2;
var KEY_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

var scale = 1;
var target = 1;
var frame = 0;
var anchor = null;
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
  } catch (e) { }
}

function paintScale(v) {
  var root = document.getElementById("root");
  if (root) root.style.setProperty("--script-scale", String(Math.round(v * 1000) / 1000));
}

// Anchor by fraction of height; words reflow, pixels would drift
function noteAnchor(y, el) {
  var hold = el && el.closest && (el.closest("#rows .cell-editable") || el.closest("#rows .row"));
  if (!hold) {
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

function step() {
  frame = 0;
  var diff = target - scale;
  scale = Math.abs(diff) < 0.004 ? target : scale + diff * 0.35;
  paintScale(scale);
  holdAnchor();
  if (scale !== target) frame = requestAnimationFrame(step);
  else { store(scale); settleAnchor(); }
}

// Header condensing a frame later shifts content; hold place again
function settleAnchor() {
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { if (!frame) holdAnchor(); });
  });
}

function scheduleStep() {
  if (!frame) frame = requestAnimationFrame(step);
}

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

function scriptViewActive() {
  return !!S.state && !S.prompterOpen && !writerOpen &&
    !document.documentElement.classList.contains("is-newtab-open");
}

function onWheel(e) {
  if (!e.ctrlKey || !scriptViewActive()) return;
  // Wheel listener must be non-passive or this is ignored
  e.preventDefault();
  var dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 33;
  else if (e.deltaMode === 2) dy *= 600;
  dy = Math.max(-300, Math.min(300, dy));
  noteAnchor(e.clientY, e.target);
  setScriptScale(target * Math.exp(-dy * 0.001));
}

// Ctrl +/-/0 zoom the script, not the page
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
  document.addEventListener("splitpage:pref", function (e) {
    var d = e && e.detail;
    if (!d || d.key !== SCRIPT_SCALE_KEY) return;
    var v = d.value == null ? readStored() : clampScriptScale(parseFloat(d.value));
    anchorAtCaretOrMiddle();
    setScriptScale(v, { now: true, quiet: true, noStore: true });
  });
  window.addEventListener("storage", function (e) {
    if (e.key !== SCRIPT_SCALE_KEY) return;
    anchorAtCaretOrMiddle();
    setScriptScale(readStored(), { now: true, quiet: true, noStore: true });
  });
}
