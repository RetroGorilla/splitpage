import { SIDE_PANEL_IDS } from "../application/preferences/panel-widths.ts";
import { mountPanels } from "../features/panels/mount.ts";
import { panelWidths } from "../legacy/preferences-bridge.ts";
import { closeHistoryPanel, syncPanelClass } from "./03-sync.js";
import { closeGearPanel, closeProductionPanel } from "./08-production-panels.js";
import { closeBrollPanel } from "./08d-broll-panel.js";
import { closeCommentsPanel } from "./10-comments.js";

function readSidePanelWidth(id) {
  return panelWidths().read(id);
}
function saveSidePanelWidth(id, w) {
  panelWidths().save(id, w);
}
function sidePanelWidthDefault(id) {
  return panelWidths().defaultWidth(id);
}
function clampSidePanelWidth(w, id) {
  return panelWidths().clamp(w, id);
}

export function applySidePanelWidth(id, w) {
  var panel = document.getElementById(id);
  if (!panel) return;
  panel.style.setProperty("--panel-width", w + "px");
  document.body.style.setProperty("--open-panel-width", w + "px");
}

export function initSidePanelResizeHandles() {
  return mountPanels({ window: window, ports: {
    ids: SIDE_PANEL_IDS,
    readWidth: readSidePanelWidth,
    defaultWidth: sidePanelWidthDefault,
    clampWidth: clampSidePanelWidth,
    applyWidth: applySidePanelWidth,
    saveWidth: saveSidePanelWidth
  } }).dispose;
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
  window.addEventListener("wheel", letGoOfScriptPlace, { passive: true });
  window.addEventListener("touchmove", letGoOfScriptPlace, { passive: true });
  window.addEventListener("keydown", letGoOfScriptPlace, true);
}
