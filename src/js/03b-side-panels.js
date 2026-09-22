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
/* Production and B-roll hold tables — item names, owners, scene lists,
   notes — that are cramped at 400px, so they start wider. Comments, Gear
   and History are comfortable narrow. */
var SIDE_PANEL_WIDTH_DEFAULTS = {
  "comments-panel": 400,
  "production-panel": 520,
  "gear-panel": 400,
  "broll-panel": 520,
  "history-panel": 400
};

function sidePanelWidthDefault(id) {
  return SIDE_PANEL_WIDTH_DEFAULTS[id] || 400;
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
}
