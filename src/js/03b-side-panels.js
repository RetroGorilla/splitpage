import { closeHistoryPanel, syncPanelClass } from "./03-sync.js";
import { closeGearPanel, closeProductionPanel } from "./08-production-panels.js";
import { closeBrollPanel } from "./08d-broll-panel.js";
import { closeCommentsPanel } from "./10-comments.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
export var SIDE_PANEL_IDS;

/* ================= side panel resizing ================= */

/* Every panel in SIDE_PANEL_IDS — Comments, Production, Gear, B-roll,
   History — gets its own drag-to-resize left edge and
   remembers its own width. This generalises what used to be just the
   comments panel's own feature (see the removed initCommentsPanelResize()
   that lived in 10-comments.js), so it belongs here instead of in any one
   panel's file.

   Widths live in a single JSON map in localStorage, keyed by panel id,
   rather than one storage key per panel — one read and one write, and a
   single corrupt entry falls back to that panel's default instead of
   throwing (and without discarding whatever the other panels had). */
var SIDE_PANEL_WIDTHS_KEY = "splitpage-panel-widths";
/* Before every panel had its own width, the comments panel alone stored
   one under this key. An existing value there is honoured as the comments
   panel's initial width the first time readSidePanelWidth() runs for it —
   see below — and from then on its width lives in the map like every
   other panel's. */
var LEGACY_COMMENTS_PANEL_WIDTH_KEY = "splitpage-comments-panel-width";
var SIDE_PANEL_WIDTH_MIN = 280;
var SIDE_PANEL_WIDTH_MAX = 720;
/* Every panel starts at 488px, the width all five B boards draw them at
   (#169, Adam's call): Production's labelled columns, B-roll's open shot
   and Comments' filter row on one line are all laid out for it. Each is
   still dragged wider or narrower and remembered on its own. */
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

/* Sets the panel's own width (its --panel-width, which .comments-panel in
   app.css reads for its own `width`) and mirrors it onto body's
   --open-panel-width. The mirror matters because the panels sit outside
   #root in the DOM (siblings, not descendants) — a custom property set on
   the panel itself would never reach a var() lookup on #root, since custom
   properties only inherit down to descendants. #root's padding-right
   (app.css, body.panel-open #root) reads --open-panel-width instead, and
   since only one panel is ever open at a time, "the open panel's width"
   is unambiguous. */
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
    /* Panel is anchored to the right edge, so dragging left (negative dx)
       widens it. */
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
    /* #root's padding-right follows the open panel's width with a
       transition (app.css), so the document travels with the panel instead
       of snapping while it slides. During a drag that transition is
       exactly wrong — the width is rewritten on every mousemove, and the
       document would trail the edge under the pointer by a fifth of a
       second. The class is on the body because #root is the thing being
       transitioned, and it is cleared in onUp(). */
    document.body.classList.add("is-panel-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
    /* Never let the drag start a text selection in the document, or (since
       the handle sits right at the panel's edge, over the script area)
       a scene drag underneath it. */
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

/* ================= keeping your place as a panel opens or closes =================

   From 1100px a panel makes room for itself (body.panel-open #root in
   app.css): the script narrows, every row rewraps taller, and the browser's
   own scroll anchoring does not step in for a padding change, so the scene
   you were reading slid a screen or more down the page (at 1440px with 60
   scenes, from the top of the view to 1700px below it). The script zoom
   (05s-script-zoom.js) had already solved the same problem: note the row at
   the point that must stay put and where in it that point is, as a fraction
   of its height, then scroll by however far it moved. Here the point is the
   first line of the scene at the top of the view (below), and the hold
   runs every frame until #root's padding transition has finished, so the
   scene stays put through the slide rather than jumping back at the end.

   Opening one panel while another is open can change the width too (each
   panel keeps its own), so openSidePanel() notes the place before it sets
   the new width; syncPanelClass() calls this again as the class flips,
   which keeps the place already noted. Scrolling yourself during the slide
   lets go of it. */
var placeHold = null;   /* {el, y, frac, until, frames} */
var placeFrame = 0;

function scriptTopY() {
  var bar = document.querySelector(".topbar");
  var y = bar ? bar.getBoundingClientRect().bottom : 0;
  return Math.max(0, y) + 1;
}

export function holdScriptPlace() {
  if (placeHold) { placeHold.until = performance.now() + 1000; return; }
  /* At the very top there is nothing to keep: stay at the top. */
  if (window.scrollY <= 0) return;
  var y = scriptTopY();
  var rows = document.querySelectorAll("#rows > .row");
  var el = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getBoundingClientRect().bottom > y) { el = rows[i]; break; }
  }
  if (!el) return;
  var rect = el.getBoundingClientRect();
  /* The scene that starts in the top third of the view is the one being
     read, so its first line is what stays put, and the one cut off above it
     grows out of sight. Only in a scene taller than that is it a point
     part-way down. */
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
  /* Done once #root and the header row have stopped moving — a couple of
     frames past that, as the zoom does, for the header condensing if the
     scroll crossed its line (20i-topbar.js) — or after a second whatever
     happens. */
  var root = document.getElementById("root");
  var row = document.querySelector(".topbar-row");
  var moving = (root && root.getAnimations().length) || (row && row.getAnimations().length);
  if (moving) h.frames = Math.min(h.frames, 1);
  if ((h.frames > 3 && !moving) || performance.now() > h.until) { placeHold = null; return; }
  placeFrame = requestAnimationFrame(stepScriptPlace);
}

function letGoOfScriptPlace() { placeHold = null; }

/* Called by syncPanelClass() just before body.panel-open is set or cleared.
   The page's scroll bar goes while a panel is open (#187, app.css), which
   would widen the page by the bar's width: the toolbar stepped sideways
   under the pointer and, below 1100px, the whole script rewrapped. So the
   bar's width is measured here, while it is still there, and app.css
   hands exactly that much back as padding (--page-gutter). A phone's
   overlay bars, or a page too short to scroll, measure 0. */
export function sidePanelOpening(open) {
  var html = document.documentElement;
  if (open) html.style.setProperty("--page-gutter", Math.max(0, window.innerWidth - html.clientWidth) + "px");
  holdScriptPlace();
}

/* ================= closing every side panel =================

   Anything that opens over the whole screen closes the side panels first
   (HANDOFF invariant #16): Present, the Writer, Help and the full-page
   shot list all come through here, so a panel added to SIDE_PANEL_IDS is
   closed by every one of them without anyone remembering to (#163).

   Each open panel is closed by its own close function, which may do more
   than hide it (the b-roll panel drops an open menu); a panel without one
   is just hidden. syncPanelClass() then runs once more at the end so
   body.panel-open, #root's padding and the header toggles are right
   however many panels there were. Nothing is remembered: leaving the mode
   does not bring a panel back. */
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

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* The one list of side panels, and it is the defaults map's own keys so a
     panel cannot be added to one and forgotten in the other. It used to be
     written out three times under three names — SIDE_PANEL_IDS in
     03-sync.js, HELP_SIDE_PANEL_IDS in 20c-help.js and these keys (#59).
     The fragments share one scope, so 03-sync.js and 20c-help.js read this
     binding directly; every use is inside a function that runs long after
     all the fragments have. */
  SIDE_PANEL_IDS = Object.keys(SIDE_PANEL_WIDTH_DEFAULTS);
  window.addEventListener("wheel", letGoOfScriptPlace, { passive: true });
  window.addEventListener("touchmove", letGoOfScriptPlace, { passive: true });
  window.addEventListener("keydown", letGoOfScriptPlace, true);
}
