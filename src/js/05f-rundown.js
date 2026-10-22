import { ROW_STATUSES, rowStatus } from "../core/production/looks.ts";
import { revealRow } from "./01b-hide-shot.js";
import { rowIndexOf } from "../core/document/rows.ts";
import { currentDocument, readSession } from "../legacy/session-bridge.ts";
import { cssAttr } from "./04-richtext.js";
import { clearDropMarkers } from "./06-rows.js";
import { contentMemo } from "../core/document/memo.ts";
import { escapeHtml, unitSafePrefix } from "../core/document/text-policy.ts";
import { pad2, formatDuration, rowSeconds } from "../core/production/timing.ts";
import { toPlainText } from "../core/text/projections.ts";
import { appActions } from "../legacy/app-actions.ts";
import { cacheSeal } from "../legacy/cache-freeze.ts";
import { cellOf } from "../legacy/richtext.ts";
import { cellEditing, rowDrag } from "../legacy/editor-bridge.ts";
import { brollCountIn } from "../core/production/broll.ts";
import { PREF_EVENT, preferences } from "../legacy/preferences-bridge.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { reviewMode } from "../legacy/location-bridge.ts";

export var RUNDOWN_TAIL_SECONDS = 10;
var BLOCK_GAP_PX = 2;
var BLOCK_MIN_PX = 2;
var LABEL_NUMBER_PX = 28;
var LABEL_LENGTH_PX = 66;
var LABEL_LENGTH_SHOT_PX = 80;

export function rundownSpan(totalSeconds, extraSeconds) {
  return Math.max(totalSeconds || 0, extraSeconds || 0, 0) + RUNDOWN_TAIL_SECONDS;
}

export function rundownScale(totalSeconds, extraSeconds, widthPx) {
  return widthPx > 0 ? widthPx / rundownSpan(totalSeconds, extraSeconds) : 0;
}

function tenth(v) { return Math.round(v * 10) / 10; }

export function rundownBlocks(scenes, pxPerSecond) {
  var t = 0;
  return scenes.map(function (sc, i) {
    var secs = Math.max(0, sc.seconds || 0);
    var width = Math.max(BLOCK_MIN_PX, tenth(secs * pxPerSecond - BLOCK_GAP_PX));
    var shot = sc.status === "shot";
    var block = {
      index: i,
      start: t,
      seconds: secs,
      left: tenth(t * pxPerSecond),
      width: width,
      showNumber: width >= LABEL_NUMBER_PX,
      showLength: width >= (shot ? LABEL_LENGTH_SHOT_PX : LABEL_LENGTH_PX)
    };
    t += secs;
    return block;
  });
}

export var REST_MIN_PX = 5;
var REST_FLOOR_SHARE = 0.8;

export function rundownRestLayout(scenes, totalSeconds, extraSeconds, widthPx, floorPx) {
  scenes = scenes || [];
  var n = scenes.length;
  var secs = scenes.map(function (sc) { return Math.max(0, (sc && sc.seconds) || 0); });
  var total = Number(totalSeconds);
  if (!(total >= 0)) total = secs.reduce(function (a, b) { return a + b; }, 0);
  var W = widthPx > 0 ? widthPx : 0;
  var pps = rundownScale(total, extraSeconds, W);
  var sceneW = total * pps;
  var floor = floorPx == null ? REST_MIN_PX : Number(floorPx) || 0;
  var slotFloor = floor > BLOCK_MIN_PX && n && sceneW > 0 ? Math.min(floor + BLOCK_GAP_PX, sceneW / n * REST_FLOOR_SHARE) : 0;
  var raw = secs.map(function (s) { return s * pps; });
  var w = raw.slice();
  if (slotFloor > 0) {
    var held = raw.map(function () { return false; });
    for (var it = 0; it <= n; it++) {
      var heldW = 0, freeRaw = 0, i;
      for (i = 0; i < n; i++) { if (held[i]) heldW += slotFloor; else freeRaw += raw[i]; }
      var f = freeRaw > 0 ? (sceneW - heldW) / freeRaw : 0;
      var changed = false;
      for (i = 0; i < n; i++) {
        if (held[i]) { w[i] = slotFloor; continue; }
        w[i] = raw[i] * f;
        if (w[i] < slotFloor) { held[i] = true; changed = true; }
      }
      if (!changed) break;
    }
  }
  var X = [0];
  var blocks = [];
  var t = 0;
  for (var j = 0; j < n; j++) {
    var width = Math.max(BLOCK_MIN_PX, tenth(w[j] - BLOCK_GAP_PX));
    var shot = scenes[j] && scenes[j].status === "shot";
    blocks.push({
      index: j,
      start: t,
      seconds: secs[j],
      left: tenth(X[j]),
      width: width,
      showNumber: width >= LABEL_NUMBER_PX,
      showLength: width >= (shot ? LABEL_LENGTH_SHOT_PX : LABEL_LENGTH_PX)
    });
    t += secs[j];
    X.push(X[j] + w[j]);
  }
  X[n] = Math.min(sceneW, W);
  X.push(W);
  return {
    pxPerSecond: pps,
    spanSeconds: rundownSpan(total, extraSeconds),
    totalSeconds: total,
    width: W,
    blocks: blocks,
    knots: X,
    x: function (seconds) {
      var s = Number(seconds) || 0;
      if (s <= 0) return s * pps;
      if (s >= total) return X[n] + (s - total) * pps;
      var lo = 0, hi = n - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (blocks[mid].start <= s) lo = mid; else hi = mid - 1;
      }
      var b = blocks[lo];
      return b.seconds > 0 ? X[lo] + (s - b.start) / b.seconds * (X[lo + 1] - X[lo]) : X[lo + 1];
    }
  };
}

var TICK_STEPS = [[5, 15], [10, 30], [15, 60], [30, 120], [60, 300], [120, 600], [300, 1800], [600, 3600]];
var LABEL_MIN_GAP_PX = 56;
var TICK_MIN_GAP_PX = 6;
var LABEL_ROOM_PX = 34;

export function rundownTicks(spanSeconds, pxPerSecond, widthPx, timeX) {
  if (!(pxPerSecond > 0)) return [];
  var step = TICK_STEPS[TICK_STEPS.length - 1];
  for (var i = 0; i < TICK_STEPS.length; i++) {
    if (TICK_STEPS[i][1] * pxPerSecond >= LABEL_MIN_GAP_PX && TICK_STEPS[i][0] * pxPerSecond >= TICK_MIN_GAP_PX) {
      step = TICK_STEPS[i];
      break;
    }
  }
  var out = [];
  var lastLabel = -Infinity;
  for (var s = 0; s <= spanSeconds; s += step[0]) {
    var x = typeof timeX === "function" ? tenth(timeX(s)) : Math.round(s * pxPerSecond);
    var major = s % step[1] === 0;
    var label = major && x + LABEL_ROOM_PX <= widthPx && x - lastLabel >= LABEL_MIN_GAP_PX ? formatDuration(s) : "";
    if (label) lastLabel = x;
    out.push({ seconds: s, x: x, major: major, label: label });
  }
  return out;
}

export var LENGTH_GAP_PX = 6;
var LENGTH_MAX_SHARE = 0.25;

export function rundownLengthPlace(totalSeconds, extraSeconds, widthPx, widths) {
  var none = { width: widthPx, left: null, fit: -1, pinned: false };
  if (!(widthPx > 0) || !widths || !widths.length) return none;
  var end = tenth((totalSeconds || 0) * rundownScale(totalSeconds, extraSeconds, widthPx));
  for (var i = 0; i < widths.length; i++) {
    if (end + LENGTH_GAP_PX + widths[i] <= widthPx) return { width: widthPx, left: end + LENGTH_GAP_PX, fit: i, pinned: false };
    if (widths[i] + LENGTH_GAP_PX <= LENGTH_MAX_SHARE * widthPx) {
      return { width: tenth(widthPx - widths[i] - LENGTH_GAP_PX), left: tenth(widthPx - widths[i]), fit: i, pinned: true };
    }
  }
  return none;
}

export var LENS_MIN_PX = 96;
export var LENS_REACH_SCENES = 3;
export var LENS_RECENTER_MS = 400;
export var LENS_SLOW_PX_MS = 0.12;
export var LENS_FAST_PX_MS = 0.6;
var LENS_GLIDE_MS = 60;
var LENS_EASE_MS = 90;
var LENS_EASE_FLOOR = 0.08;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function rundownLens(slots, focus, anchor, opts) {
  opts = opts || {};
  var minW = opts.minWidth > 0 ? opts.minWidth : LENS_MIN_PX;
  var R = opts.reach >= 0 ? opts.reach : LENS_REACH_SCENES;
  var m = slots.length - 1;
  var W = slots[m];
  if (!(W > 0) || m < 2) return slots.slice();
  var p = clamp(Number(focus) || 0, 0, W);
  var jp = 0;
  while (jp < m - 1 && slots[jp + 1] <= p) jp++;
  var wf = slots[jp + 1] - slots[jp];
  var phi = wf > 0 ? (p - slots[jp]) / wf : 0.5;
  var q = jp + phi;
  var L = [0];
  var nw = [];
  for (var j = 0; j < m; j++) {
    var w = slots[j + 1] - slots[j];
    if (j < m - 1) {
      var d = Math.abs(j + 0.5 - q);
      if (d < R + 0.5) w = Math.max(w, minW * 0.5 * (1 + Math.cos(Math.PI * d / (R + 0.5))));
    }
    nw.push(w);
    L.push(L[j] + w);
  }
  var a = Number(anchor);
  if (!isFinite(a)) a = p;
  var o = clamp(a - (L[jp] + phi * nw[jp]), W - L[m], 0);
  return L.map(function (v) { return v + o; });
}

function anchorFor(slots, focus, u, x, opts) {
  var W = slots[slots.length - 1];
  var lo = -W, hi = 2 * W;
  for (var i = 0; i < 24; i++) {
    var mid = (lo + hi) / 2;
    if (knotMap(slots, rundownLens(slots, focus, mid, opts), u) < x) lo = mid; else hi = mid;
  }
  return knotMap(slots, rundownLens(slots, focus, (lo + hi) / 2, opts), focus);
}

export var LENS_SPEED_MAG_MAX = 64;

function lensSpeedScale(slots, focus, opts) {
  var minW = opts && opts.minWidth > 0 ? opts.minWidth : LENS_MIN_PX;
  var j = 0;
  while (j < slots.length - 2 && slots[j + 1] <= focus) j++;
  var ws = Math.max(0.5, slots[j + 1] - slots[j]);
  return Math.sqrt(clamp(minW / ws, 1, LENS_SPEED_MAG_MAX));
}

export function rundownLensFollow(slots, knots, shown, focus, anchor, x, dx, dtMs, opts) {
  if (!dx) return { focus: focus, anchor: anchor };
  var speed = dtMs > 0 ? Math.abs(dx) / dtMs : Infinity;
  var k = lensSpeedScale(slots, focus, opts);
  var g = clamp((speed - LENS_SLOW_PX_MS * k) / ((LENS_FAST_PX_MS - LENS_SLOW_PX_MS) * k), 0, 1);
  var slowAnchor = anchor;
  if (g < 1) slowAnchor = anchorFor(slots, focus, knotMap(shown, slots, x), x, opts);
  var natural = knotMap(knots, slots, x);
  return {
    focus: focus + (natural - focus) * g,
    anchor: slowAnchor + (x - slowAnchor) * g
  };
}

export function rundownLensRecenter(slots, shown, focus, anchor, x, dtMs, opts) {
  if (!(dtMs > 0) || x == null) return { focus: focus, anchor: anchor };
  var u = knotMap(shown, slots, x);
  var tau = opts && opts.recenterMs > 0 ? opts.recenterMs : LENS_RECENTER_MS;
  var f = focus + (u - focus) * (1 - Math.exp(-dtMs / tau));
  return { focus: f, anchor: anchorFor(slots, f, u, x, opts) };
}

export function knotMap(from, to, x) {
  var n = from.length - 1;
  if (!(n >= 1)) return x;
  if (x <= from[0]) return to[0];
  if (x >= from[n]) return to[n];
  var lo = 0, hi = n;
  while (hi - lo > 1) {
    var mid = (lo + hi) >> 1;
    if (from[mid] <= x) lo = mid; else hi = mid;
  }
  var w = from[lo + 1] - from[lo];
  return w > 0 ? to[lo] + (x - from[lo]) / w * (to[lo + 1] - to[lo]) : to[lo];
}

var KEEP_NUMBER_PX = 18;
var KEEP_NUMBER_3_PX = 25;
var KEEP_LENGTH_PX = 56;
var KEEP_LENGTH_SHOT_PX = 70;

export function rundownKeepLabels(rest, width, shot) {
  var numberPx = rest.index + 1 >= 100 ? KEEP_NUMBER_3_PX : KEEP_NUMBER_PX;
  return {
    number: !!rest.showNumber && width >= numberPx,
    length: !!rest.showLength && width >= (shot ? KEEP_LENGTH_SHOT_PX : KEEP_LENGTH_PX)
  };
}

export function knotBlocks(knots) {
  var out = [];
  for (var i = 0; i < knots.length - 2; i++) {
    out.push({ left: tenth(knots[i]), width: Math.max(BLOCK_MIN_PX, tenth(knots[i + 1] - knots[i] - BLOCK_GAP_PX)) });
  }
  return out;
}

export function rundownDropGap(knots, x, from, hitPx) {
  var n = knots.length - 2;
  if (n < 1) return -1;
  var best = -1, bestD = Infinity;
  for (var g = 0; g <= n; g++) {
    var gx = g === 0 ? knots[0] : knots[g] - BLOCK_GAP_PX / 2;
    var d = Math.abs(x - gx);
    if (d < bestD) { bestD = d; best = g; }
  }
  if (bestD > hitPx) return -1;
  if (best === from || best === from + 1) return -1;
  return best;
}

function gapX(knots, g) {
  return g === 0 ? knots[0] : knots[g] - BLOCK_GAP_PX / 2;
}

var extraSeconds = 0;
var currentRowId = null;
var lastBlocksHtml = "";
var lastRulerHtml = "";
var lastLayout = { pxPerSecond: 0, spanSeconds: 0, totalSeconds: 0, width: 0, x: function () { return 0; } };
var lastKnotsKey = "";
var paintListeners = [];
var minimized = false;
var base = { blocks: [], X: null, n: 0, W: 0, pps: 0, els: [], lefts: [], widths: [], keep: [], shot: [], current: -1 };

export function setRundownExtraSeconds(seconds) {
  var next = Math.max(0, Number(seconds) || 0);
  if (next === extraSeconds) return;
  extraSeconds = next;
  renderRundown();
}

export function rundownX(seconds) {
  var px = lastLayout.x(seconds || 0);
  if (lens.Z && base.X && lens.Z.length === base.X.length) return tenth(knotMap(base.X, lens.Z, px));
  return tenth(px);
}

export function onRundownPaint(fn) {
  if (typeof fn === "function") paintListeners.push(fn);
}

export function rundownLayout() {
  return {
    pxPerSecond: lastLayout.pxPerSecond,
    spanSeconds: lastLayout.spanSeconds,
    totalSeconds: lastLayout.totalSeconds,
    width: lastLayout.width,
    x: lastLayout.x
  };
}

export function rundownEdge() {
  return base.W;
}

var CHECK_SVG = '<svg class="rd-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

var snippetOf = null;

function sceneSnippet(row) {
  if (!snippetOf) {
    snippetOf = contentMemo(function (html) {
      var text = toPlainText(cellOf(html)).replace(/\s+/g, " ").trim();
      return unitSafePrefix(text, 90);
    }, cacheSeal);
  }
  return snippetOf(row.audioText || "") || snippetOf(row.visualText || "");
}

function brollTicksHtml(row) {
  var n = brollCountIn(row, productionReaders);
  var out = "";
  for (var i = 0; i < n; i++) {
    out += '<span class="rd-broll" style="left:calc(' + tenth((i + 1) / (n + 1) * 100) + '% - 1px)"></span>';
  }
  return out;
}

function blockHtml(row, b, isCurrent, focusable) {
  var st = rowStatus(row.status) || ROW_STATUSES[0];
  var num = pad2(b.index + 1);
  var len = formatDuration(b.seconds);
  var label = "Scene " + num + ", " + len + ", " + st.label.toLowerCase() + (isCurrent ? " — current scene" : "");
  var snip = sceneSnippet(row);
  return '<button type="button" class="rd-block is-' + escapeHtml(st.id) + (isCurrent ? ' is-current' : '') +
    '" data-row="' + escapeHtml(row.id) + '" data-i="' + b.index + '" tabindex="' + (focusable ? '0' : '-1') + '"' +
    (isCurrent ? ' aria-current="true"' : '') +
    ' style="left:' + b.left + 'px;width:' + b.width + 'px" aria-label="' + escapeHtml(label) +
    '" title="Scene ' + num + ' · ' + len + ' · ' + escapeHtml(st.label) + '">' +
    '<span class="rd-in"><span class="rd-num">' + num + '</span>' +
    (st.id === "shot" ? CHECK_SVG : '') +
    '<span class="rd-len">' + len + '</span>' +
    '<span class="rd-stat">' + escapeHtml(st.label) + '</span>' +
    (snip ? '<span class="rd-snip">' + escapeHtml(snip) + '</span>' : '') +
    '</span>' + brollTicksHtml(row) +
    '</button>';
}

var lengthAt = { left: null, width: 0, fit: -1 };

function placeLength(strip, total, trackWidth) {
  var el = strip.querySelector(".rd-length");
  lengthAt = { left: null, width: 0, fit: -1 };
  if (!el) return trackWidth;
  var all = el.offsetWidth;
  if (!all) return trackWidth;
  var totalEl = el.querySelector(".rd-length-total");
  var slotEl = el.querySelector(".rd-length-slot");
  var tw = totalEl ? totalEl.offsetWidth : 0;
  var sw = slotEl && slotEl.textContent ? slotEl.offsetWidth : 0;
  var pad = all - tw - (el.classList.contains("is-short") ? 0 : sw);
  var widths = sw ? [pad + tw + sw, pad + tw] : [pad + tw];
  var p = rundownLengthPlace(total, extraSeconds, trackWidth, widths);
  el.classList.toggle("is-short", p.fit === 1);
  el.classList.toggle("is-none", p.fit === -1);
  el.classList.remove("is-covered");
  if (p.left !== null) el.style.left = p.left + "px";
  strip.classList.toggle("has-length-delta", p.fit === 0 && sw > 0);
  lengthAt = { left: p.left, width: p.fit === -1 ? 0 : widths[p.fit], fit: p.fit, pinned: p.pinned };
  return p.width;
}

function lengthCovered(Z) {
  if (lengthAt.left === null || lengthAt.pinned) return;
  var strip = stripEl();
  var el = strip && strip.querySelector(".rd-length");
  if (el) el.classList.toggle("is-covered", !!Z && Z[base.n] + 1 > lengthAt.left);
}

function overLength(x) {
  return lengthAt.left !== null && x >= lengthAt.left - 2 && x <= lengthAt.left + lengthAt.width + 2;
}

function segmentHtml(row, b, isCurrent) {
  var st = rowStatus(row.status) || ROW_STATUSES[0];
  return '<span class="rd-seg is-' + escapeHtml(st.id) + (isCurrent ? ' is-current' : '') +
    '" style="left:' + b.left + 'px;width:' + b.width + 'px"></span>';
}

export function renderRundown() {
  var strip = document.getElementById("rundown");
  if (!strip) return;
  var rows = currentDocument()?.rows ?? [];
  strip.hidden = !rows.length;
  if (!rows.length) { lensReset(); return; }
  var track = strip.querySelector(".rundown-track");
  var blocksEl = strip.querySelector(".rundown-blocks");
  var rulerEl = strip.querySelector(".rundown-ruler");
  var playhead = strip.querySelector(".rundown-playhead");
  if (!track || !blocksEl || !rulerEl) return;
  var trackWidth = track.clientWidth;
  if (!trackWidth) return;

  var doc = currentDocument();
  var scenes = rows.map(function (r) { return { seconds: rowSeconds(r, doc, productionReaders), status: r.status }; });
  var total = scenes.reduce(function (n, sc) { return n + sc.seconds; }, 0);
  var width = placeLength(strip, total, trackWidth);
  var lay = rundownRestLayout(scenes, total, extraSeconds, width, REST_MIN_PX);
  var span = lay.spanSeconds;
  var s = lay.pxPerSecond;
  var blocks = lay.blocks;
  var right = Math.max(0, tenth(trackWidth - width)) + "px";
  if (blocksEl.style.right !== right) blocksEl.style.right = right;

  var current = currentRowId && rows.some(function (r) { return r.id === currentRowId; }) ? currentRowId : null;
  var tabRow = current || rows[0].id;
  var html = "";
  blocks.forEach(function (b, i) {
    html += minimized
      ? segmentHtml(rows[i], b, rows[i].id === current)
      : blockHtml(rows[i], b, rows[i].id === current, rows[i].id === tabRow);
  });
  var rewritten = false;
  if (html !== lastBlocksHtml) {
    var hadFocus = blocksEl.contains(document.activeElement) ? document.activeElement.getAttribute("data-row") : null;
    blocksEl.innerHTML = html;
    lastBlocksHtml = html;
    rewritten = true;
    if (hadFocus) {
      var again = blocksEl.querySelector('.rd-block[data-row="' + cssAttr(hadFocus) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }

  if (!minimized) {
    var ruler = rundownTicks(span, s, width, lay.x).map(function (t) {
      return '<span class="rd-tick' + (t.major ? ' is-major' : '') + '" style="left:' + t.x + 'px"></span>' +
        (t.label ? '<span class="rd-label" style="left:' + (t.x + 4) + 'px">' + t.label + '</span>' : '');
    }).join("");
    if (ruler !== lastRulerHtml) {
      rulerEl.innerHTML = ruler;
      lastRulerHtml = ruler;
    }
  }

  var at = -1;
  for (var j = 0; j < rows.length; j++) if (rows[j].id === current) at = j;

  var countChanged = rows.length !== base.n;
  base.blocks = blocks;
  base.n = rows.length;
  base.W = width;
  base.pps = s;
  base.X = lay.knots;
  base.current = at;
  if (rewritten || countChanged) {
    base.els = minimized ? [] : Array.prototype.slice.call(blocksEl.querySelectorAll(".rd-block"));
    base.lefts = blocks.map(function (b) { return b.left; });
    base.widths = blocks.map(function (b) { return b.width; });
    base.keep = [];
  }
  base.shot = rows.map(function (r) { var st = rowStatus(r.status); return !!st && st.id === "shot"; });

  if (playhead) {
    playhead.hidden = at === -1;
    if (at !== -1) playhead.style.left = tenth(blocks[at].left - 1) + "px";
  }

  if (minimized) lensReset();
  else if (lens.Z) lensRepainted(countChanged);

  var knotsKey = base.X.join(",");
  var moved = s !== lastLayout.pxPerSecond || width !== lastLayout.width || knotsKey !== lastKnotsKey;
  lastKnotsKey = knotsKey;
  lastLayout = { pxPerSecond: s, spanSeconds: span, totalSeconds: total, width: width, x: lay.x };
  if (moved) paintListeners.forEach(function (fn) { try { fn(rundownLayout()); } catch (e) { } });
}

var DROP_HIT_PX = 20;
var lens = {
  on: false,
  src: null,
  p: 0,
  a: 0,
  x: null,
  t: 0,
  Z: null,
  raf: 0,
  last: 0,
  hold: false,
  holdAt: -1,
  holdTimer: 0,
  easeAt: -1,
  easeNext: false
};
var noHover = false;

export var LENS_HOLD_MS = 950;
export var LENS_HOLD_PX = 240;

function lensOpts() {
  return lens.hold ? { minWidth: LENS_HOLD_PX } : undefined;
}

function holdClear() {
  if (lens.holdTimer) { clearTimeout(lens.holdTimer); lens.holdTimer = 0; }
  lens.holdAt = -1;
  if (lens.hold) {
    lens.hold = false;
    var strip = stripEl();
    if (strip) strip.classList.remove("is-held");
  }
}

function holdTrack(i) {
  if (i === lens.holdAt) return;
  holdClear();
  if (i < 0) return;
  lens.holdAt = i;
  lens.holdTimer = setTimeout(function () {
    lens.holdTimer = 0;
    if (!lens.on || lens.src !== "pointer" || lens.holdAt !== i) return;
    lens.hold = true;
    var strip = stripEl();
    if (strip) strip.classList.add("is-held");
    lensKick();
  }, LENS_HOLD_MS);
}

function sceneAt(Z, x) {
  for (var i = 0; i < base.n; i++) if (x >= Z[i] && x < Z[i + 1]) return i;
  return -1;
}
var drop = { x: null, gap: -1 };

function prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
}

function stripEl() { return document.getElementById("rundown"); }

function lensAllowed() {
  var strip = stripEl();
  return !minimized && !!strip && !strip.hidden && base.n > 0 && base.W > 0 && !!base.X;
}

function slots() {
  return base.X;
}

function lensTarget() {
  return lens.on ? rundownLens(slots(), lens.p, lens.a, lensOpts()) : base.X;
}

function applyKnots(Z) {
  var els = base.els;
  for (var i = 0; i < base.n && i < els.length; i++) {
    var left = tenth(Z[i]);
    var width = Math.max(BLOCK_MIN_PX, tenth(Z[i + 1] - Z[i] - BLOCK_GAP_PX));
    if (left !== base.lefts[i]) { els[i].style.left = left + "px"; base.lefts[i] = left; }
    if (width !== base.widths[i]) { els[i].style.width = width + "px"; base.widths[i] = width; }
    var rest = base.blocks[i];
    if (rest) {
      var k = rundownKeepLabels(rest, width, base.shot && base.shot[i]);
      var key = (k.number ? "n" : "") + (k.length ? "l" : "");
      if (key !== base.keep[i]) {
        els[i].classList.toggle("keep-num", k.number);
        els[i].classList.toggle("keep-len", k.length);
        base.keep[i] = key;
      }
    }
  }
  var strip = stripEl();
  var playhead = strip && strip.querySelector(".rundown-playhead");
  if (playhead && base.current !== -1) {
    var ph = tenth(Z[base.current] - 1);
    playhead.style.left = ph + "px";
    playhead.hidden = ph < -1 || ph > base.W;
  }
  var blocksEl = strip && strip.querySelector(".rundown-blocks");
  if (blocksEl) {
    blocksEl.classList.toggle("over-l", Z[0] < -0.5);
    blocksEl.classList.toggle("over-r", Z[Z.length - 1] > base.W + 0.5);
  }
  if (drop.x !== null) showDrop(drop.x);
  lengthCovered(Z);
}

function lensFrame(now) {
  lens.raf = 0;
  if (!lens.Z || !base.X || lens.Z.length !== base.X.length) { lensSettle(); return; }
  var dt = lens.last ? Math.min(64, Math.max(1, now - lens.last)) : 16;
  lens.last = now;
  var recentring = false;
  if (lens.on && lens.x !== null && (lens.src === "pointer" || lens.src === "drag")) {
    var next = rundownLensRecenter(slots(), lens.Z, lens.p, lens.a, lens.x, dt, lensOpts());
    recentring = Math.abs(next.focus - lens.p) > 0.002 || Math.abs(next.anchor - lens.a) > 0.02;
    lens.p = next.focus;
    lens.a = next.anchor;
  }
  var T = lensTarget();
  if (lens.easeNext) { lens.easeAt = now; lens.easeNext = false; }
  var alpha = 1 - Math.exp(-dt / LENS_GLIDE_MS);
  if (prefersReducedMotion()) alpha = 1;
  else if (lens.easeAt >= 0) {
    var u = (now - lens.easeAt) / LENS_EASE_MS;
    if (u >= 1) lens.easeAt = -1;
    else alpha *= Math.max(LENS_EASE_FLOOR, u * u * (3 - 2 * u));
  }
  var moving = false;
  for (var i = 0; i < T.length; i++) {
    var d = T[i] - lens.Z[i];
    if (Math.abs(d) > 0.05) { lens.Z[i] += d * alpha; moving = true; }
    else lens.Z[i] = T[i];
  }
  applyKnots(lens.Z);
  if (!moving && !recentring) {
    lens.last = 0;
    if (!lens.on) lensSettle();
    return;
  }
  lens.raf = requestAnimationFrame(lensFrame);
}

function lensKick() {
  if (!lens.raf) lens.raf = requestAnimationFrame(lensFrame);
}

function lensStart() {
  if (!lens.Z) {
    lens.Z = base.X.slice();
    lens.last = 0;
    lens.easeNext = true;
  }
  var strip = stripEl();
  if (strip) strip.classList.add("is-lensed");
}

function lensSettle() {
  if (lens.raf) { cancelAnimationFrame(lens.raf); lens.raf = 0; }
  var had = !!lens.Z;
  lens.Z = null;
  lens.last = 0;
  var strip = stripEl();
  if (!strip) return;
  if (had) {
    for (var i = 0; i < base.els.length && i < base.blocks.length; i++) {
      var b = base.blocks[i];
      base.els[i].style.left = b.left + "px";
      base.els[i].style.width = b.width + "px";
      base.lefts[i] = b.left;
      base.widths[i] = b.width;
    }
    var playhead = strip.querySelector(".rundown-playhead");
    if (playhead && base.current !== -1 && base.blocks[base.current]) {
      playhead.style.left = tenth(base.blocks[base.current].left - 1) + "px";
      playhead.hidden = false;
    }
    lengthCovered(null);
  }
  var blocksEl = strip.querySelector(".rundown-blocks");
  if (blocksEl) blocksEl.classList.remove("over-l", "over-r");
  if (strip.classList.contains("is-lensed")) {
    strip.classList.remove("is-lensed");
    if (!prefersReducedMotion()) {
      [".rundown-ruler", ".rundown-overlay"].forEach(function (sel) {
        var el = strip.querySelector(sel);
        if (el && el.animate) {
          try { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "cubic-bezier(0.2, 0, 0, 1)" }); } catch (e) {}
        }
      });
    }
  }
}

function lensReset() {
  holdClear();
  lens.on = false;
  lens.src = null;
  lens.x = null;
  lensSettle();
}

function lensRepainted(countChanged) {
  if (!lensAllowed()) { lensReset(); return; }
  if (countChanged || lens.Z.length !== base.X.length) {
    holdClear();
    lens.Z = base.X.slice();
    if (lens.x !== null) { lens.p = knotMap(lens.Z, slots(), lens.x); lens.a = lens.x; }
    else if (lens.src === "focus") lensOff();
  }
  applyKnots(lens.Z);
  lensKick();
}

function lensAt(x, src, t) {
  if (!lensAllowed()) return;
  x = clamp(x, 0, base.W);
  lensStart();
  var U = slots();
  if (!lens.on || lens.x === null || (lens.src !== src && lens.src !== "focus")) {
    lens.p = knotMap(lens.Z, U, x);
    lens.a = x;
  } else if (x !== lens.x) {
    var next = rundownLensFollow(U, base.X, lens.Z, lens.p, lens.a, x, x - lens.x, t - lens.t, lensOpts());
    lens.p = next.focus;
    lens.a = next.anchor;
  }
  lens.on = true;
  lens.src = src;
  lens.x = x;
  lens.t = t;
  if (src === "pointer") holdTrack(sceneAt(lens.Z, x)); else holdClear();
  lensKick();
}

function lensFocus(i) {
  if (!lensAllowed() || noHover || i < 0 || i >= base.n) return;
  if (lens.on && (lens.src === "pointer" || lens.src === "drag")) return;
  lensStart();
  var U = slots();
  lens.on = true;
  lens.src = "focus";
  lens.x = null;
  lens.p = (U[i] + U[i + 1]) / 2;
  lens.a = clamp((lens.Z[i] + lens.Z[i + 1]) / 2, 0, base.W);
  lensKick();
}

function lensOff(src) {
  if (src && lens.src !== src) return;
  holdClear();
  lens.on = false;
  lens.src = null;
  lens.x = null;
  if (lens.Z) { lens.easeNext = true; lensKick(); }
}

function updateRundownMinControls() {
  var item = document.getElementById("menu-rundown-min");
  if (item) item.setAttribute("aria-checked", minimized ? "true" : "false");
  var strip = stripEl();
  if (!strip) return;
  strip.classList.toggle("is-min", minimized);
  var toggle = strip.querySelector(".rundown-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", minimized ? "false" : "true");
    var words = minimized ? "Show the rundown" : "Minimise the rundown";
    toggle.setAttribute("aria-label", words);
    toggle.title = words;
  }
}

function setRundownMinimized(on, persist) {
  on = !!on;
  if (persist !== false) preferences().setRundownMin(on);
  if (on === minimized) { updateRundownMinControls(); return; }
  minimized = on;
  lensReset();
  hideDrop();
  updateRundownMinControls();
  renderRundown();
}

export function isRundownMinimized() { return minimized; }

export function toggleRundownMinimized() {
  setRundownMinimized(!minimized);
}

function dragIndex() {
  var id = rowDrag().dragging();
  return id ? readSession(function (doc) { return rowIndexOf(doc, id); }) : -1;
}

function dropAllowed() {
  return !!rowDrag().dragging() && !minimized && !reviewMode() && base.n > 0 && !!base.X && !!currentDocument();
}

function ensureDropEls(track) {
  var marker = track.querySelector(".rundown-drop");
  if (!marker) {
    marker = document.createElement("div");
    marker.className = "rundown-drop";
    marker.setAttribute("aria-hidden", "true");
    marker.hidden = true;
    track.appendChild(marker);
  }
  var label = track.querySelector(".rundown-drop-label");
  if (!label) {
    label = document.createElement("div");
    label.className = "rundown-drop-label";
    label.setAttribute("role", "status");
    label.hidden = true;
    track.appendChild(label);
  }
  return { marker: marker, label: label };
}

function showDrop(x) {
  var strip = stripEl();
  var track = strip && strip.querySelector(".rundown-track");
  if (!track || !dropAllowed()) { hideDrop(); return; }
  drop.x = x;
  var K = lens.Z && lens.Z.length === base.X.length ? lens.Z : base.X;
  var g = rundownDropGap(K, x, dragIndex(), DROP_HIT_PX);
  if (g !== -1 && (gapX(K, g) < -0.5 || gapX(K, g) > base.W + 0.5)) g = -1;
  drop.gap = g;
  var els = ensureDropEls(track);
  if (g === -1) {
    els.marker.hidden = true;
    els.label.hidden = true;
    return;
  }
  var gx = tenth(gapX(K, g));
  els.marker.hidden = false;
  els.marker.style.left = gx + "px";
  var words = g === 0 ? "Move to the start" : "Move to after scene " + pad2(g);
  if (els.label.textContent !== words) els.label.textContent = words;
  els.label.hidden = false;
  var half = (els.label.offsetWidth || 0) / 2;
  els.label.style.left = tenth(clamp(gx, half, Math.max(half, base.W - half))) + "px";
}

function hideDrop() {
  drop.x = null;
  drop.gap = -1;
  var strip = stripEl();
  if (!strip) return;
  var marker = strip.querySelector(".rundown-drop");
  var label = strip.querySelector(".rundown-drop-label");
  if (marker) marker.hidden = true;
  if (label) label.hidden = true;
}

function endDragOver() {
  if (drop.x !== null) hideDrop();
  lensOff("drag");
}

function followMovedScene(rowId) {
  revealRow(rowId);
  var rowEl = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"]');
  if (!rowEl) return;
  var rect = rowEl.getBoundingClientRect();
  var shift = 0;
  try {
    var tf = getComputedStyle(rowEl).transform;
    if (tf && tf !== "none" && typeof DOMMatrixReadOnly === "function") shift = new DOMMatrixReadOnly(tf).m42 || 0;
  } catch (e) {}
  var top = rect.top - shift;
  var topbar = document.querySelector(".topbar");
  var headerBottom = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
  var room = window.innerHeight - headerBottom;
  var y = (window.scrollY || 0) + top - headerBottom - Math.max(0, (room - rect.height) / 2);
  window.scrollTo({ top: Math.max(0, y), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  rowEl.classList.remove("just-merged");
  void rowEl.offsetWidth;
  rowEl.classList.add("just-merged");
  var cell = rowEl.querySelector(".audio-cell .cell-editable");
  if (cell) cell.focus({ preventScroll: true });
}

function trackX(e) {
  var strip = stripEl();
  var track = strip && strip.querySelector(".rundown-track");
  if (!track) return 0;
  return e.clientX - track.getBoundingClientRect().left;
}

function onStripDragOver(e) {
  if (!dropAllowed()) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = "move"; } catch (err) {}
  var x = trackX(e);
  lensAt(x, "drag", e.timeStamp);
  showDrop(x);
}

function onStripDrop(e) {
  var id = rowDrag().dragging();
  if (!id) return;
  e.preventDefault();
  var allowed = dropAllowed();
  if (allowed) showDrop(trackX(e));
  var g = allowed ? drop.gap : -1;
  rowDrag().end();
  clearDropMarkers();
  hideDrop();
  lensOff();
  var doc = currentDocument();
  if (g < 0 || !doc) return;
  var rows = doc.rows;
  if (g === 0) cellEditing().moveRow(id, rows[0].id, false);
  else cellEditing().moveRow(id, rows[g - 1].id, true);
  followMovedScene(id);
}

export function goToScene(rowId) {
  revealRow(rowId);
  var rowEl = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"]');
  if (!rowEl) return;
  rowEl.scrollIntoView({ block: "center" });
  var cell = rowEl.querySelector(".audio-cell .cell-editable");
  if (cell) cell.focus({ preventScroll: true });
}

function noteCurrentRow(el) {
  var rowEl = el && el.closest ? el.closest("#rows .row") : null;
  var id = rowEl ? rowEl.getAttribute("data-id") : null;
  if (!id || id === currentRowId) return;
  currentRowId = id;
  renderRundown();
}

function ensureToggle(strip) {
  var toggle = strip.querySelector(".rundown-toggle");
  if (toggle) return toggle;
  toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "rundown-toggle";
  toggle.setAttribute("aria-controls", "rundown");
  toggle.innerHTML = '<svg aria-hidden="true" focusable="false"><use href="#i-chevron-down"/></svg>';
  strip.appendChild(toggle);
  return toggle;
}

function lensDebug() {
  return {
    on: lens.on, src: lens.src, p: lens.p, a: lens.a, hold: lens.hold, holdAt: lens.holdAt,
    Z: lens.Z ? lens.Z.slice() : null, X: base.X ? base.X.slice() : null,
    starts: base.blocks.map(function (b) { return b.start; }),
    dropGap: drop.gap, minimized: minimized,
    W: base.W, length: { left: lengthAt.left, width: lengthAt.width, fit: lengthAt.fit, pinned: !!lengthAt.pinned }
  };
}

export function __init() {
  var strip = document.getElementById("rundown");
  var rowsEl = document.getElementById("rows");
  if (!strip) return;
  try { noHover = !!(window.matchMedia && window.matchMedia("(hover: none)").matches); } catch (e) {}
  minimized = preferences().rundownMin();
  var toggle = ensureToggle(strip);
  updateRundownMinControls();
  toggle.addEventListener("click", function () { appActions.invoke("toggle-rundown-min", "button"); });
  document.addEventListener(PREF_EVENT, function (e) {
    var d = e && e.detail;
    if (!d || preferences().nameOf(d.key) !== "rundownMin") return;
    var v = d.value;
    var on = v === true || v === "1" || v === 1 ? true : v === false || v === "0" || v === 0 ? false : preferences().rundownMin();
    setRundownMinimized(on, false);
  });

  if (rowsEl) rowsEl.addEventListener("focusin", function (e) { noteCurrentRow(e.target); });
  document.addEventListener("selectionchange", function () { noteCurrentRow(document.activeElement); });
  strip.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".rd-block") : null;
    if (b) goToScene(b.getAttribute("data-row"));
  });
  strip.addEventListener("keydown", function (e) {
    var b = e.target.closest ? e.target.closest(".rd-block") : null;
    if (!b) return;
    var next;
    if (e.key === "ArrowRight") next = b.nextElementSibling;
    else if (e.key === "ArrowLeft") next = b.previousElementSibling;
    else if (e.key === "Home") next = b.parentNode.querySelector(".rd-block");
    else if (e.key === "End") { var all = b.parentNode.querySelectorAll(".rd-block"); next = all[all.length - 1]; }
    else return;
    e.preventDefault();
    if (next && next.classList.contains("rd-block")) {
      b.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
  });

  var track = strip.querySelector(".rundown-track");
  if (track) {
    track.addEventListener("pointermove", function (e) {
      if (e.pointerType === "touch" || rowDrag().dragging()) return;
      var x = trackX(e);
      if (overLength(x)) { lensOff("pointer"); return; }
      lensAt(x, "pointer", e.timeStamp);
    });
    track.addEventListener("pointerleave", function () { lensOff("pointer"); });
  }
  strip.addEventListener("focusin", function (e) {
    var b = e.target.closest ? e.target.closest(".rd-block") : null;
    if (!b) return;
    var visible = false;
    try { visible = b.matches(":focus-visible"); } catch (err) {}
    if (visible) lensFocus(Number(b.getAttribute("data-i")));
  });
  strip.addEventListener("focusout", function (e) {
    if (e.relatedTarget && strip.contains(e.relatedTarget)) return;
    lensOff("focus");
  });

  strip.addEventListener("dragover", onStripDragOver);
  strip.addEventListener("drop", onStripDrop);
  document.addEventListener("dragover", function (e) {
    if (drop.x === null && lens.src !== "drag") return;
    if (e.target && e.target.closest && e.target.closest("#rundown")) return;
    endDragOver();
  });
  document.addEventListener("dragend", endDragOver);
  document.addEventListener("drop", function (e) {
    if (e.target && e.target.closest && e.target.closest("#rundown")) return;
    endDragOver();
  });

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () { renderRundown(); }).observe(strip);
  }
  window.__rundownTest = { lens: lensDebug, setMinimized: setRundownMinimized, x: rundownX };
}
