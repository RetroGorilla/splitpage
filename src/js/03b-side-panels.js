import { closeHistoryPanel, syncPanelClass } from "./03-sync.js";
import { closeGearPanel, closeProductionPanel } from "./08-production-panels.js";
import { closeBrollPanel } from "./08d-broll-panel.js";
import { closeCommentsPanel } from "./10-comments.js";

export var SIDE_PANEL_IDS;

var SIDE_PANEL_WIDTHS_KEY = "splitpage-panel-widths";
var LEGACY_COMMENTS_PANEL_WIDTH_KEY = "splitpage-comments-panel-width";
var SIDE_PANEL_WIDTH_MIN = 280;
var SIDE_PANEL_WIDTH_MAX = 720;
var SIDE_PANEL_WIDTH_DEFAULTS = {
  "comments-panel": 488,
  "production-panel": 488,
  "gear-panel": 488,
  "broll-panel": 488,
  "history-panel": 488
};

function sidePanelWidthDefault(id) {
  return SIDE_PANEL_WIDTH_DEFAULTS[id] || 488;
}
function clampSidePanelWidth(w, id) {
  if (!isFinite(w)) return sidePanelWidthDefault(id);
  return Math.max(SIDE_PANEL_WIDTH_MIN, Math.min(SIDE_PANEL_WIDTH_MAX, Math.round(w)));
}
function readSidePanelWidthMap() {
  try {
    var raw = localStorage.getItem(SIDE_PANEL_WIDTHS_KEY);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch (e) { return {}; }
}
function writeSidePanelWidthMap(map) {
  try { localStorage.setItem(SIDE_PANEL_WIDTHS_KEY, JSON.stringify(map)); } catch (e) {}
}
export function readSidePanelWidth(id) {
  var map = readSidePanelWidthMap();
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    var w = parseFloat(map[id]);
    return isFinite(w) ? clampSidePanelWidth(w, id) : sidePanelWidthDefault(id);
  }
  if (id === "comments-panel") {
    try {
      var legacy = parseFloat(localStorage.getItem(LEGACY_COMMENTS_PANEL_WIDTH_KEY));
      if (isFinite(legacy)) return clampSidePanelWidth(legacy, id);
    } catch (e) {}
  }
  return sidePanelWidthDefault(id);
}
function saveSidePanelWidth(id, w) {
  var map = readSidePanelWidthMap();
  map[id] = clampSidePanelWidth(w, id);
  writeSidePanelWidthMap(map);
}

export function applySidePanelWidth(id, w) {
  var panel = document.getElementById(id);
  if (!panel) return;
  panel.style.setProperty("--panel-width", w + "px");
  document.body.style.setProperty("--open-panel-width", w + "px");
}

function initSidePanelResize(id) {
  var panel = document.getElementById(id);
  var handle = document.getElementById(id + "-resize-handle");
  if (!panel || !handle) return;
  applySidePanelWidth(id, readSidePanelWidth(id));

  var dragging = false;
  var startX = 0;
  var startWidth = sidePanelWidthDefault(id);

  function onMove(e) {
    if (!dragging) return;
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var w = clampSidePanelWidth(startWidth + (startX - clientX), id);
    applySidePanelWidth(id, w);
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("is-dragging");
    document.body.classList.remove("is-panel-resizing");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onUp);
    var current = parseFloat(getComputedStyle(panel).getPropertyValue("--panel-width")) || sidePanelWidthDefault(id);
    saveSidePanelWidth(id, clampSidePanelWidth(current, id));
  }
  function onDown(e) {
    dragging = true;
    startX = e.touches ? e.touches[0].clientX : e.clientX;
    startWidth = readSidePanelWidth(id);
    handle.classList.add("is-dragging");
    document.body.classList.add("is-panel-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
    e.preventDefault();
  }
  handle.addEventListener("mousedown", onDown);
  handle.addEventListener("touchstart", onDown, { passive: false });
  handle.addEventListener("dblclick", function () {
    var def = sidePanelWidthDefault(id);
    applySidePanelWidth(id, def);
    saveSidePanelWidth(id, def);
  });
}

export function initSidePanelResizeHandles() {
  SIDE_PANEL_IDS.forEach(initSidePanelResize);
}

var placeHold = null;
var placeFrame = 0;

function scriptTopY() {
  var bar = document.querySelector(".topbar");
  var y = bar ? bar.getBoundingClientRect().bottom : 0;
  return Math.max(0, y) + 1;
}

export function holdScriptPlace() {
  if (placeHold) { placeHold.until = performance.now() + 1000; return; }
  if (window.scrollY <= 0) return;
  var y = scriptTopY();
  var rows = document.querySelectorAll("#rows > .row");
  var el = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getBoundingClientRect().bottom > y) { el = rows[i]; break; }
  }
  if (!el) return;
  var rect = el.getBoundingClientRect();
  var next = el.nextElementSibling;
  if (rect.top < y && next && next.classList.contains("row")) {
    var nextTop = next.getBoundingClientRect().top;
    if (nextTop < y + (window.innerHeight - y) / 3) { el = next; y = nextTop; rect = next.getBoundingClientRect(); }
  }
  placeHold = {
    el: el, y: y,
    frac: rect.height ? (y - rect.top) / rect.height : 0,
    until: performance.now() + 1000,
    frames: 0
  };
  if (!placeFrame) placeFrame = requestAnimationFrame(stepScriptPlace);
}

function stepScriptPlace() {
  placeFrame = 0;
  var h = placeHold;
  if (!h || !h.el.isConnected) { placeHold = null; return; }
  var rect = h.el.getBoundingClientRect();
  var dy = rect.top + h.frac * rect.height - h.y;
  if (Math.abs(dy) >= 0.5) window.scrollBy(0, dy);
  h.frames++;
  var root = document.getElementById("root");
  var row = document.querySelector(".topbar-row");
  var moving = (root && root.getAnimations().length) || (row && row.getAnimations().length);
  if (moving) h.frames = Math.min(h.frames, 1);
  if ((h.frames > 3 && !moving) || performance.now() > h.until) { placeHold = null; return; }
  placeFrame = requestAnimationFrame(stepScriptPlace);
}

function letGoOfScriptPlace() { placeHold = null; }

export function sidePanelOpening(open) {
  var html = document.documentElement;
  if (open) html.style.setProperty("--page-gutter", Math.max(0, window.innerWidth - html.clientWidth) + "px");
  holdScriptPlace();
}

var SIDE_PANEL_CLOSERS = {
  "comments-panel": closeCommentsPanel,
  "production-panel": closeProductionPanel,
  "gear-panel": closeGearPanel,
  "broll-panel": closeBrollPanel,
  "history-panel": closeHistoryPanel
};

export function closeAllSidePanels() {
  SIDE_PANEL_IDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el || el.hidden) return;
    var close = SIDE_PANEL_CLOSERS[id];
    if (typeof close === "function") close();
    el.hidden = true;
  });
  syncPanelClass();
}

export function __init() {
  SIDE_PANEL_IDS = Object.keys(SIDE_PANEL_WIDTH_DEFAULTS);
  window.addEventListener("wheel", letGoOfScriptPlace, { passive: true });
  window.addEventListener("touchmove", letGoOfScriptPlace, { passive: true });
  window.addEventListener("keydown", letGoOfScriptPlace, true);
}
