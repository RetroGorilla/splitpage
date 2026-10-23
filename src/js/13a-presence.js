import { homeConn, serverHomeId, serverStatus } from "../legacy/location-bridge.ts";
import { cssAttr } from "./04-richtext.js";
import { PRESENCE_MAX_SHOWN } from "../application/collaboration/presence.ts";
import { presence } from "../legacy/presence-bridge.ts";
import { getSavedAuthorName } from "./10-comments.js";
import {
  apiUrl,
  notePresenceRev,
  onServerDoc,
  serverTransport
} from "./13-hosted.js";
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import { codePointPrefix, escapeHtml } from "../core/document/text-policy.ts";
import { preferences } from "../legacy/preferences-bridge.ts";

var presenceLastActive;

var PRESENCE_BEAT_MS = 2000;
var PRESENCE_IDLE_MS = 4 * 60 * 1000;
var PRESENCE_BACKOFF_MS = 30000;
var PRESENCE_SOON_MS = 300;
var PRESENCE_ID_KEY = "splitpage-presence-id";

var presenceSelf = "";
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

export function presenceInitials(name) {
  var words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return codePointPrefix(words[0], 2).toUpperCase();
  return (codePointPrefix(words[0], 1) + codePointPrefix(words[words.length - 1], 1)).toUpperCase();
}

function presenceWanted() {
  if (!onServerDoc() || !serverStatus().mode().available || serverStatus().sessionExpired() || serverStatus().linkTurnedOff()) return false;
  if (document.hidden) return false;
  return (Date.now() - presenceLastActive) <= PRESENCE_IDLE_MS;
}

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
    color: preferences().myColor(),
    rowId: presenceWhere.rowId || "",
    field: presenceWhere.field || "",
    gone: !!gone
  };
}

function clearPresence() {
  if (!presence().here().length) { paintPresence(); return; }
  presence().apply([]);
}

async function presenceTick() {
  var next = PRESENCE_BEAT_MS;
  var ctx = null;
  try {
    if (!presenceWanted()) { clearPresence(); return; }
    presenceSends++;
    ctx = captureOperation();
    var body = await serverTransport(ctx.connection).request("api/presence", { method: "POST", body: presencePayload(false) });
    if (!stillOwns(ctx)) { next = PRESENCE_SOON_MS; return; }
    presenceFailures = 0;
    presenceAnnounced = true;
    presence().apply((body && body.here) || []);
    notePresenceRev(body);
  } catch (e) {
    if (ctx && !stillOwns(ctx)) { next = PRESENCE_SOON_MS; return; }
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
  schedulePresence(PRESENCE_SOON_MS);
}

var paintListeners = [];

export function onPresencePaint(listener) {
  paintListeners.push(listener);
  return function () {
    var at = paintListeners.indexOf(listener);
    if (at !== -1) paintListeners.splice(at, 1);
  };
}

export function paintPresence() {
  var bar = document.getElementById("presence-bar");
  var list = presence().here().slice(0, PRESENCE_MAX_SHOWN);
  var mine = presenceLocation();
  if (bar) fitPresenceBar(bar);
  paintListeners.slice().forEach(function (listener) { listener(); });
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
    mark.style.setProperty("--presence", presence().colorOf(p));
    mark.title = presence().nameOf(p) + (sameField ? " is in this field" : " is in this scene");
    mark.textContent = presenceInitials(presence().nameOf(p));
    target.appendChild(mark);
  });
}

function presenceBarHtml(shown) {
  var html = presence().here().slice(0, shown).map(function (p) {
    var name = presence().nameOf(p);
    return '<span class="presence-chip" style="--presence:' + presence().colorOf(p) +
      '" title="' + escapeHtml(name) + ' is in this document">' +
      escapeHtml(presenceInitials(name)) + '</span>';
  }).join("");
  var rest = presence().here().slice(shown);
  if (rest.length) {
    var names = rest.map(presence().nameOf).join(", ");
    html += '<span class="presence-more" title="' + escapeHtml(names) +
      (rest.length === 1 ? " is" : " are") + ' in this document">+' + rest.length + '</span>';
  }
  return html;
}

function fitPresenceBar(bar) {
  var shown = Math.min(presence().here().length, PRESENCE_MAX_SHOWN);
  bar.innerHTML = presenceBarHtml(shown);
  bar.hidden = !presence().here().length;
  var left = bar.closest(".topbar-left");
  if (!left || bar.hidden) return;
  while (shown > 0 && left.scrollWidth > left.clientWidth + 1) {
    shown--;
    bar.innerHTML = presenceBarHtml(shown);
  }
}

var presenceFitFrame = 0;
function refitPresenceBar() {
  if (presenceFitFrame || !presence().here().length) return;
  presenceFitFrame = requestAnimationFrame(function () {
    presenceFitFrame = 0;
    var bar = document.getElementById("presence-bar");
    if (bar) fitPresenceBar(bar);
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
    apply: function (here) { presenceFailures = 0; presence().apply(here || []); },
    payload: presencePayload,
    wanted: presenceWanted,
    beat: presenceTick,
    sends: function () { return presenceSends; },
    where: presenceLocation,
    setWhere: function (w) { presenceWhere = w || { rowId: null, field: null }; paintPresence(); },
    goIdle: function () { presenceLastActive = 0; },
    color: function (p) { return presence().colorOf(p); },
    id: presenceSelfId
  };
}
