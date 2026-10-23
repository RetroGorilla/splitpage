import { S } from "./_state.js";
import { prompterIsOpen } from "../application/prompter-state.ts";
import { appActions } from "../legacy/app-actions.ts";
import { PREF_EVENT, preferences, viewFlags } from "../legacy/preferences-bridge.ts";

export var SCRIPT_SCALE_MIN = 0.7;
export var SCRIPT_SCALE_MAX = 2;
var KEY_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

var scale = 1;
var target = 1;
var frame = 0;
var anchor = null;
var readoutTimer = 0;
let storing = false;

export function clampScriptScale(v) {
  v = Number(v);
  if (!isFinite(v) || v <= 0) return 1;
  return Math.min(SCRIPT_SCALE_MAX, Math.max(SCRIPT_SCALE_MIN, v));
}

export function scriptScale() { return scale; }

function paintScale(v) {
  var root = document.getElementById("root");
  if (root) root.style.setProperty("--script-scale", String(Math.round(v * 1000) / 1000));
}

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
  else { storeScale(); settleAnchor(); }
}

function storeScale() {
  storing = true;
  try {
    if (Math.abs(scale - 1) < 0.005) preferences().clearScriptScale();
    else preferences().setScriptScale(scale);
  }
  finally { storing = false; }
}

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
    if (!opts.noStore) storeScale();
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

export function scriptViewActive() {
  return !!S.state && !prompterIsOpen() && !viewFlags().writerOpen() &&
    !document.documentElement.classList.contains("is-newtab-open");
}

function onWheel(e) {
  if (!e.ctrlKey || !scriptViewActive()) return;
  e.preventDefault();
  var dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 33;
  else if (e.deltaMode === 2) dy *= 600;
  dy = Math.max(-300, Math.min(300, dy));
  noteAnchor(e.clientY, e.target);
  setScriptScale(target * Math.exp(-dy * 0.001));
}

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
  if (!z) return;
  var id = z === 2 ? "script-zoom-reset" : z > 0 ? "script-zoom-in" : "script-zoom-out";
  if (appActions.invoke(id, "shortcut").kind === "ran") e.preventDefault();
}

export function __init() {
  scale = target = preferences().scriptScale();
  paintScale(scale);
  var rowsEl = document.getElementById("rows");
  if (rowsEl) rowsEl.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener(PREF_EVENT, function (e) {
    if (storing) return;
    var d = e && e.detail;
    if (!d || preferences().nameOf(d.key) !== "scriptScale") return;
    var v = d.value == null ? preferences().scriptScale() : clampScriptScale(parseFloat(d.value));
    anchorAtCaretOrMiddle();
    setScriptScale(v, { now: true, quiet: true, noStore: true });
  });
  window.addEventListener("storage", function (e) {
    if (preferences().nameOf(e.key) !== "scriptScale") return;
    anchorAtCaretOrMiddle();
    setScriptScale(preferences().scriptScale(), { now: true, quiet: true, noStore: true });
  });
}
