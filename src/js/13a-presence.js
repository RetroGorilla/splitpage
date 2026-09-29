import { S } from "./_state.js";
import { homeConn, serverHomeId } from "./_home.js";
import {
  normalizePersonColors,
  paletteColor,
  personKey,
  readMyColor,
  resolvePersonColor
} from "./00p-prefs.js";
import { escapeHtml } from "./02-state.js";
import { cssAttr } from "./04-richtext.js";
import { render } from "./05-render.js";
import { paintRundownPresence } from "./05p-rundown-presence.js";
import { getSavedAuthorName } from "./10-comments.js";
import {
  apiFetch,
  apiUrl,
  linkTurnedOff,
  notePresenceRev,
  onServerDoc,
  serverSessionExpired
} from "./13-hosted.js";

var presenceLastActive;

var PRESENCE_BEAT_MS = 2000;
// Idle tab stops beating; server TTL drops it
var PRESENCE_IDLE_MS = 4 * 60 * 1000;
var PRESENCE_BACKOFF_MS = 30000;
var PRESENCE_MAX_SHOWN = 8;
// sessionStorage so reload isn't a second ghost
var PRESENCE_ID_KEY = "splitpage-presence-id";

var presenceSelf = "";
var presenceHere = [];
var presenceWhere = { rowId: null, field: null };
var presenceTimer = null;
var presenceFailures = 0;
var presenceSends = 0;
var presenceAnnounced = false;

function presenceSelfId() {
  if (presenceSelf) return presenceSelf;
  try { presenceSelf = sessionStorage.getItem(PRESENCE_ID_KEY) || ""; } catch (e) {}
  if (!presenceSelf) {
    presenceSelf = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { sessionStorage.setItem(PRESENCE_ID_KEY, presenceSelf); } catch (e) { }
  }
  return presenceSelf;
}

// Colour seed: name if present, else client id
function presenceName(p) {
  return (p && p.name) || "Guest";
}

function presenceSeed(p) {
  return (p && p.name) || (p && p.id) || "";
}

function presenceColor(p) {
  return paletteColor(p && p.color) || personColor(presenceSeed(p));
}

var presenceLiveColors = {};

function noteLiveColors(list) {
  var next = {};
  (list || []).forEach(function (p) {
    var color = paletteColor(p && p.color);
    var key = personKey(p && p.name);
    if (color && key) next[key] = color;
  });
  var changed = JSON.stringify(next) !== JSON.stringify(presenceLiveColors);
  presenceLiveColors = next;
  return changed;
}

export function personColor(seed) {
  return resolvePersonColor(seed, {
    self: getSavedAuthorName(),
    selfColor: readMyColor(),
    live: presenceLiveColors,
    doc: S.state && S.state.personColors
  });
}

export function recordMyColor(state) {
  if (!state) return false;
  var name = getSavedAuthorName().trim();
  var color = readMyColor();
  if (!name || !color) return false;
  var map = state.personColors && typeof state.personColors === "object" ? state.personColors : null;
  var have = "";
  if (map) {
    Object.keys(map).forEach(function (k) { if (personKey(k) === personKey(name)) have = k; });
    if (have && map[have] === color) return false;
  }
  var next = {};
  if (map) Object.keys(map).forEach(function (k) { if (k !== have) next[k] = map[k]; });
  next[name.slice(0, 80)] = color;
  state.personColors = normalizePersonColors(next);
  return true;
}

function presenceInitials(name) {
  var words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

function presenceWanted() {
  if (!onServerDoc() || !S.serverMode.available || serverSessionExpired || linkTurnedOff) return false;
  if (document.hidden) return false;
  return (Date.now() - presenceLastActive) <= PRESENCE_IDLE_MS;
}

// Read from DOM: focus() without window focus fires no focusin
function presenceLocation() {
  var el = document.activeElement;
  var cell = el && el.closest ? el.closest("#rows .cell-editable[data-id]") : null;
  if (cell) {
    presenceWhere = { rowId: cell.getAttribute("data-id"), field: cell.getAttribute("data-field") };
  } else if (el && el.id === "doc-title") {
    presenceWhere = { rowId: null, field: "title" };
  }
  return presenceWhere;
}

function presenceWhereKey() {
  var where = presenceLocation();
  return String(where.rowId) + "/" + String(where.field);
}

function presencePayload(gone) {
  presenceLocation();
  return {
    docId: serverHomeId(),
    id: presenceSelfId(),
    name: getSavedAuthorName() || "",
    color: readMyColor(),
    rowId: presenceWhere.rowId || "",
    field: presenceWhere.field || "",
    gone: !!gone
  };
}

function clearPresence() {
  if (!presenceHere.length) { paintPresence(); return; }
  setPresenceHere([]);
}

function setPresenceHere(list) {
  presenceHere = list || [];
  var recolored = noteLiveColors(presenceHere);
  paintPresence();
  if (recolored && S.state) render();
}

async function presenceTick() {
  var next = PRESENCE_BEAT_MS;
  try {
    if (!presenceWanted()) { clearPresence(); return; }
    presenceSends++;
    var body = await apiFetch("api/presence", { method: "POST", body: presencePayload(false) });
    presenceFailures = 0;
    presenceAnnounced = true;
    setPresenceHere((body && body.here) || []);
    // Not awaited: merge is slower than the next beat
    notePresenceRev(body);
  } catch (e) {
    presenceFailures++;
    if (presenceFailures >= 3) { clearPresence(); next = PRESENCE_BACKOFF_MS; }
  } finally {
    schedulePresence(next);
  }
}

function schedulePresence(ms) {
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = setTimeout(presenceTick, ms);
}

function presenceBeatSoon() {
  if (!presenceWanted()) return;
  schedulePresence(300);
}

export function paintPresence() {
  var bar = document.getElementById("presence-bar");
  var list = presenceHere.slice(0, PRESENCE_MAX_SHOWN);
  var mine = presenceLocation();
  if (bar) fitPresenceBar(bar);
  paintRundownPresence();
  document.querySelectorAll(".presence-mark").forEach(function (el) { el.remove(); });
  if (!list.length) return;
  list.forEach(function (p) {
    if (!p.rowId) return;
    var sameField = !!(p.field && p.field === mine.field && p.rowId === mine.rowId);
    var target = null;
    if (sameField) {
      var cell = document.querySelector('#rows .cell-editable[data-id="' + cssAttr(p.rowId) +
        '"][data-field="' + cssAttr(p.field) + '"]');
      target = cell ? cell.closest(".field-wrap") : null;
    }
    if (!target) {
      target = document.querySelector('#rows .row[data-id="' + cssAttr(p.rowId) + '"] .gutter');
    }
    if (!target) return;
    var mark = document.createElement("span");
    mark.className = "presence-mark" + (sameField ? " is-field" : "");
    mark.style.setProperty("--presence", presenceColor(p));
    mark.title = presenceName(p) + (sameField ? " is in this field" : " is in this scene");
    mark.textContent = presenceInitials(presenceName(p));
    target.appendChild(mark);
  });
}

function presenceBarHtml(shown) {
  var html = presenceHere.slice(0, shown).map(function (p) {
    var name = presenceName(p);
    return '<span class="presence-chip" style="--presence:' + presenceColor(p) +
      '" title="' + escapeHtml(name) + ' is in this document">' +
      escapeHtml(presenceInitials(name)) + '</span>';
  }).join("");
  var rest = presenceHere.slice(shown);
  if (rest.length) {
    var names = rest.map(presenceName).join(", ");
    html += '<span class="presence-more" title="' + escapeHtml(names) +
      (rest.length === 1 ? " is" : " are") + ' in this document">+' + rest.length + '</span>';
  }
  return html;
}

function fitPresenceBar(bar) {
  var shown = Math.min(presenceHere.length, PRESENCE_MAX_SHOWN);
  bar.innerHTML = presenceBarHtml(shown);
  bar.hidden = !presenceHere.length;
  var left = bar.closest(".topbar-left");
  if (!left || bar.hidden) return;
  while (shown > 0 && left.scrollWidth > left.clientWidth + 1) {
    shown--;
    bar.innerHTML = presenceBarHtml(shown);
  }
}

var presenceFitFrame = 0;
function refitPresenceBar() {
  if (presenceFitFrame || !presenceHere.length) return;
  presenceFitFrame = requestAnimationFrame(function () {
    presenceFitFrame = 0;
    var bar = document.getElementById("presence-bar");
    if (bar) fitPresenceBar(bar);
  });
}

export function presenceShown() {
  return presenceHere.slice(0, PRESENCE_MAX_SHOWN).map(function (p) {
    return {
      id: String((p && p.id) || presenceSeed(p)),
      name: presenceName(p),
      color: presenceColor(p),
      rowId: (p && p.rowId) || "",
      field: (p && p.field) || ""
    };
  });
}

function notePresenceActivity() {
  presenceLastActive = Date.now();
  var was = String(presenceWhere.rowId) + "/" + String(presenceWhere.field);
  if (presenceWhereKey() === was) return;
  paintPresence();
  presenceBeatSoon();
}

export function __init() {
  presenceLastActive = Date.now();

  (function wirePresence() {
    window.addEventListener("keydown", notePresenceActivity, true);
    window.addEventListener("pointerup", notePresenceActivity, true);
    window.addEventListener("focusin", notePresenceActivity, true);
    document.addEventListener("selectionchange", notePresenceActivity);
    window.addEventListener("resize", refitPresenceBar);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "hidden") { notePresenceActivity(); presenceBeatSoon(); }
    });
    window.addEventListener("pagehide", function () {
      if (!presenceAnnounced || !presenceWanted()) return;
      var payload = presencePayload(true);
      var c = homeConn();
      if (c && c.token) payload.token = c.token;
      var url = apiUrl("api/presence");
      var text = JSON.stringify(payload);
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([text], { type: "text/plain;charset=UTF-8" }));
          return;
        }
        fetch(url, {
          method: "POST",
          body: text,
          keepalive: true,
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          credentials: c && c.serverUrl ? "omit" : "same-origin"
        });
      } catch (e) { }
    });
    schedulePresence(PRESENCE_BEAT_MS);
  })();

  window.__presenceTest = {
    apply: function (here) { presenceFailures = 0; setPresenceHere(here || []); },
    payload: presencePayload,
    wanted: presenceWanted,
    beat: presenceTick,
    sends: function () { return presenceSends; },
    where: presenceLocation,
    setWhere: function (w) { presenceWhere = w || { rowId: null, field: null }; paintPresence(); },
    goIdle: function () { presenceLastActive = 0; },
    color: presenceColor,
    id: presenceSelfId
  };
}
