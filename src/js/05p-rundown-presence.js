import { S } from "./_state.js";
import { pad2 } from "./05-render.js";
import { goToScene } from "./05f-rundown.js";
import { presenceShown } from "./13a-presence.js";

/* ================= who is where, on the rundown (#202) =================

   A dot on the rundown strip for each other person in a hosted document,
   on the block of the scene their caret is in: their colour (personColor,
   the header avatar's and the gutter dot's), their name on hover ("Sam is
   in scene 12"), and a click on it goes to that scene the way a click on
   the block does. Two people on one block overlap a little, side by side.
   Someone whose place has not changed for RUNDOWN_IDLE_MS is drawn as an
   empty ring in their colour, and filled again once it does.

   IT READS WHAT PRESENCE ALREADY HAS. The scene is the `rowId` every beat
   of /api/presence carries (13a-presence.js, presenceShown()); nothing new
   is sent or asked for, and with no hosted document or nobody else in it
   the list is empty and nothing is drawn.

   IDLE IS WORKED OUT HERE. A beat carries no "last typed" of its own, so a
   person counts as active while something about them moves: the scene or
   field they report, or the words of the scene they are in (a merge
   bringing their typing in) — unless your own caret is in that scene, when
   the words changing may well be yours. That is the whole of it, and it is
   rundownPresenceActivity() below, unit-tested in
   src/test/rundown-presence.test.mjs with rundownPresenceGroups() and
   rundownDotXs().

   NEVER IN THE DOCUMENT, AND NEVER REPAINTED BY THE STRIP. The dots live
   on a layer of their own in the track (.rundown-presence, made here),
   not on #rundown-overlay — which fades out while the lens is on — and not
   inside the blocks, which clip. They are placed from the blocks' own
   left and width as 05f-rundown.js writes them, so they follow a block
   when the lens moves it. What tells this file that the blocks moved is a
   MutationObserver on .rundown-blocks: a paint that rewrites it (the words
   changed, a scene moved, the window resized, minimized) and every lens
   frame's style writes. Its callback runs before the frame is drawn, so a
   dot never lags its block. The one thing this needs from 05f-rundown.js
   is goToScene, exported for it. */

/* A minute with nothing about them changing and a person is idle. */
export var RUNDOWN_IDLE_MS = 60 * 1000;
/* The dot and how far along the next one on the same block sits (a few
   pixels of overlap, like the header's avatars). The thin bar's are
   smaller; CSS draws the sizes, these only space them. */
var DOT_PX = 10;
var DOT_STEP_PX = 7;
var MIN_DOT_PX = 7;
var MIN_DOT_STEP_PX = 5;

/* ---- the pure half ---- */

/* What a scene's words are, for noticing that they changed. */
function rowSig(row) {
  if (!row) return "";
  return String(row.audioText || "") + "\u0001" + String(row.visualText || "") + "\u0001" + String(row.status || "");
}

/* Who has done something lately. `prev` is the last answer (id → {where,
   sig, at}), `people` everyone shown now ({id, rowId, field}), `rowsById`
   the document's rows by id, `mineRowId` the scene your own caret is in.
   Someone new starts active; a changed scene or field, or changed words in
   their scene while you are not in it, is activity; anyone not in `people`
   is gone from the answer. */
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

/* The dots, grouped by the block they go on, in script order: one group
   per scene someone is in — {rowId, index, people: [{id, name, color,
   idle}]} — with the people in the order presence listed them. Someone in
   no scene (the title, nowhere yet) or in a scene this copy does not have
   is left out. */
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

/* Where `n` dots on one block go: centred on the block's middle `center`,
   `step` apart, the whole row kept inside a track `trackW` wide (a dot
   `dot` across, so half of one may reach each end). The x of each dot's
   centre, left to right. */
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

/* ---- the DOM half ---- */

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
    /* the header's avatars say who is here to a screen reader; these repeat
       the block's own click, for the mouse */
    layer.setAttribute("aria-hidden", "true");
    var overlay = track.querySelector(".rundown-overlay");
    if (overlay && overlay.nextSibling) track.insertBefore(layer, overlay.nextSibling);
    else track.appendChild(layer);
  }
  return layer;
}

/* The scene your own caret is in, read off the page. */
function mineRowId() {
  var el = document.activeElement;
  var row = el && el.closest ? el.closest("#rows .row[data-id]") : null;
  return row ? row.getAttribute("data-id") : null;
}

function whoTitle(person, index) {
  return person.name + " is in scene " + pad2(index + 1) + (person.idle ? " (idle)" : "");
}

/* Each group's dots put over its block, as the block is drawn right now. */
function placeRundownPresence() {
  var layer = layerEl();
  var strip = stripEl();
  if (!layer || !strip || !groups.length) return;
  var blocksEl = strip.querySelector(".rundown-blocks");
  var kids = blocksEl ? blocksEl.children : [];
  var min = strip.classList.contains("is-min");
  var trackW = layer.clientWidth || (blocksEl ? blocksEl.clientWidth : 0);
  var dots = layer.children;
  var k = 0;
  groups.forEach(function (g) {
    var el = kids[g.index];
    var left = el ? parseFloat(el.style.left) : NaN;
    var width = el ? parseFloat(el.style.width) : NaN;
    var ok = isFinite(left) && isFinite(width);
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

/* Who is where, rebuilt when that changed, then placed. `seen` true when
   this is presence reporting (a beat, a location change), which is when
   activity is taken; a repaint of the strip only re-reads the rows. */
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
        /* the later ones over the earlier, the way the header stacks them */
        dot.style.zIndex = String(i + 1);
        dot.title = whoTitle(p, g.index);
        layer.appendChild(dot);
      });
    });
  }
  placeRundownPresence();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
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
      /* new blocks (or segments) are a new layout, and maybe a new order;
         a style write is a block moving */
      var rebuilt = list.some(function (m) { return m.type === "childList"; });
      if (rebuilt) paintRundownPresence(false);
      else placeRundownPresence();
    }).observe(blocksEl, { childList: true, attributes: true, attributeFilter: ["style"], subtree: true });
  }

  /* For the browser suites: age everyone's last activity by `ms` and
     repaint, rather than waiting a minute. */
  window.__rundownPresenceTest = {
    age: function (ms) {
      Object.keys(activity).forEach(function (id) { activity[id].at -= ms; });
      paintRundownPresence(false);
    },
    activity: function () { return JSON.parse(JSON.stringify(activity)); },
    idleMs: RUNDOWN_IDLE_MS
  };
}
