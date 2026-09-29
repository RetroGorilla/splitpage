import { S } from "./_state.js";
import { pad2 } from "./05-render.js";
import { goToScene, rundownEdge } from "./05f-rundown.js";
import { presenceShown } from "./13a-presence.js";

export var RUNDOWN_IDLE_MS = 60 * 1000;
var DOT_PX = 10;
var DOT_STEP_PX = 7;
var MIN_DOT_PX = 7;
var MIN_DOT_STEP_PX = 5;

function rowSig(row) {
  if (!row) return "";
  return String(row.audioText || "") + "\u0001" + String(row.visualText || "") + "\u0001" + String(row.status || "");
}

export function rundownPresenceActivity(prev, people, rowsById, mineRowId, now) {
  var next = {};
  (people || []).forEach(function (p) {
    if (!p || !p.id) return;
    var where = String(p.rowId || "") + "/" + String(p.field || "");
    var row = p.rowId && rowsById ? rowsById[p.rowId] : null;
    var sig = rowSig(row);
    var was = prev && prev[p.id];
    var at = now;
    if (was) {
      at = was.at;
      if (was.where !== where) at = now;
      else if (was.sig !== sig && !(mineRowId && mineRowId === p.rowId)) at = now;
    }
    next[p.id] = { where: where, sig: sig, at: at };
  });
  return next;
}

export function rundownPresenceGroups(people, rowIds, activity, now, idleMs) {
  var at = {};
  (rowIds || []).forEach(function (id, i) { at[id] = i; });
  var byRow = {};
  var out = [];
  (people || []).forEach(function (p) {
    if (!p || !p.rowId || !Object.prototype.hasOwnProperty.call(at, p.rowId)) return;
    var seen = activity && p.id ? activity[p.id] : null;
    var idle = !!seen && now - seen.at >= idleMs;
    var g = byRow[p.rowId];
    if (!g) { g = byRow[p.rowId] = { rowId: p.rowId, index: at[p.rowId], people: [] }; out.push(g); }
    g.people.push({ id: p.id, name: p.name, color: p.color, idle: idle });
  });
  out.sort(function (a, b) { return a.index - b.index; });
  return out;
}

export function rundownDotXs(center, n, trackW, dot, step) {
  if (!(n > 0)) return [];
  var span = (n - 1) * step;
  var first = center - span / 2;
  var lo = dot / 2;
  var hi = trackW - dot / 2 - span;
  if (hi >= lo) first = Math.min(Math.max(first, lo), hi);
  var out = [];
  for (var i = 0; i < n; i++) out.push(Math.round((first + i * step) * 10) / 10);
  return out;
}

var activity = {};
var lastKey = "";
var groups = [];

function stripEl() { return document.getElementById("rundown"); }

function layerEl() {
  var strip = stripEl();
  var track = strip && strip.querySelector(".rundown-track");
  if (!track) return null;
  var layer = track.querySelector(".rundown-presence");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "rundown-presence";
    layer.setAttribute("aria-hidden", "true");
    var overlay = track.querySelector(".rundown-overlay");
    if (overlay && overlay.nextSibling) track.insertBefore(layer, overlay.nextSibling);
    else track.appendChild(layer);
  }
  return layer;
}

function mineRowId() {
  var el = document.activeElement;
  var row = el && el.closest ? el.closest("#rows .row[data-id]") : null;
  return row ? row.getAttribute("data-id") : null;
}

function whoTitle(person, index) {
  return person.name + " is in scene " + pad2(index + 1) + (person.idle ? " (idle)" : "");
}

function placeRundownPresence() {
  var layer = layerEl();
  var strip = stripEl();
  if (!layer || !strip || !groups.length) return;
  var blocksEl = strip.querySelector(".rundown-blocks");
  var kids = blocksEl ? blocksEl.children : [];
  var min = strip.classList.contains("is-min");
  var trackW = layer.clientWidth || (blocksEl ? blocksEl.clientWidth : 0);
  // Dot hides when lens slides its block off-track
  var edge = rundownEdge() || trackW;
  var dots = layer.children;
  var k = 0;
  groups.forEach(function (g) {
    var el = kids[g.index];
    var left = el ? parseFloat(el.style.left) : NaN;
    var width = el ? parseFloat(el.style.width) : NaN;
    var ok = isFinite(left) && isFinite(width) && left + width / 2 >= 0 && left + width / 2 <= edge;
    var xs = ok ? rundownDotXs(left + width / 2, g.people.length, trackW, min ? MIN_DOT_PX : DOT_PX, min ? MIN_DOT_STEP_PX : DOT_STEP_PX) : [];
    for (var i = 0; i < g.people.length; i++, k++) {
      var dot = dots[k];
      if (!dot) continue;
      dot.hidden = !ok;
      if (ok) {
        var v = xs[i] + "px";
        if (dot.style.left !== v) dot.style.left = v;
      }
    }
  });
}

export function paintRundownPresence(seen) {
  var layer = layerEl();
  if (!layer) return;
  var people = presenceShown();
  var rows = S.state && S.state.rows ? S.state.rows : [];
  if (!people.length || !rows.length) {
    activity = {};
    groups = [];
    if (lastKey !== "") { layer.innerHTML = ""; lastKey = ""; }
    return;
  }
  var now = Date.now();
  if (seen !== false) {
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    activity = rundownPresenceActivity(activity, people, byId, mineRowId(), now);
  }
  groups = rundownPresenceGroups(people, rows.map(function (r) { return r.id; }), activity, now, RUNDOWN_IDLE_MS);
  var key = JSON.stringify(groups);
  if (key !== lastKey) {
    lastKey = key;
    layer.textContent = "";
    groups.forEach(function (g) {
      g.people.forEach(function (p, i) {
        var dot = document.createElement("button");
        dot.type = "button";
        dot.tabIndex = -1;
        dot.className = "rd-who" + (p.idle ? " is-idle" : "");
        dot.setAttribute("data-row", g.rowId);
        dot.setAttribute("data-person", p.id);
        dot.style.setProperty("--who", p.color);
        dot.style.zIndex = String(i + 1);
        dot.title = whoTitle(p, g.index);
        layer.appendChild(dot);
      });
    });
  }
  placeRundownPresence();
}

export function __init() {
  var strip = stripEl();
  var blocksEl = strip && strip.querySelector(".rundown-blocks");
  var layer = layerEl();
  if (!strip || !blocksEl || !layer) return;
  layer.addEventListener("click", function (e) {
    var dot = e.target.closest ? e.target.closest(".rd-who") : null;
    if (!dot) return;
    e.preventDefault();
    goToScene(dot.getAttribute("data-row"));
  });
  if (typeof MutationObserver === "function") {
    new MutationObserver(function (list) {
      if (!groups.length && !lastKey) return;
      var rebuilt = list.some(function (m) { return m.type === "childList"; });
      if (rebuilt) paintRundownPresence(false);
      else placeRundownPresence();
    }).observe(blocksEl, { childList: true, attributes: true, attributeFilter: ["style"], subtree: true });
  }

  window.__rundownPresenceTest = {
    age: function (ms) {
      Object.keys(activity).forEach(function (id) { activity[id].at -= ms; });
      paintRundownPresence(false);
    },
    activity: function () { return JSON.parse(JSON.stringify(activity)); },
    idleMs: RUNDOWN_IDLE_MS
  };
}
