import { S } from "./_state.js";
import { ROW_STATUSES, formatDuration, rowSeconds, rowStatus } from "./01-scene-status.js";
import { revealRow } from "./01b-hide-shot.js";
import { escapeHtml } from "./02-state.js";
import { cssAttr } from "./04-richtext.js";
import { pad2 } from "./05-render.js";
import { brollCountInRow } from "./08c-broll.js";

/* ================= the rundown strip (#169) =================

   Direction B's "program rundown": the script under the header as blocks
   sized by read time on a time ruler, so its shape can be seen at a
   glance — what is long, what is shot (a lit block), what is ready (amber),
   what is still to do (an outline), where the b-roll falls, and where the
   caret is (the playhead, and an outline on that scene's block). A click
   on a block goes to its scene.

   It reads state.rows through rowSeconds(), the function the rail and the
   header total read, and it is painted from updateScriptStats()
   (01-scene-status.js) — render() and the idle refresh while typing — so it
   moves with the words and never asks for a render of its own. Painting is
   string-built and skipped when the string has not changed.

   The layout is the three pure functions just below (rundownSpan,
   rundownScale, rundownBlocks, rundownTicks — unit-tested in
   src/test/rundown.test.mjs); everything after them is DOM.

   ---- hooks for a target length (#170) ----

   A per-script target length is its own issue, built beside this one. It
   needs three things from the strip, and they are here:
   - the scale: setRundownExtraSeconds(seconds) makes the strip span the
     target as well as the script (rundownScale's second argument), and
     repaints;
   - a layer to draw on: #rundown-overlay, over the blocks, which a paint
     never touches, with rundownX(seconds) for where a time falls on it and
     onRundownPaint(fn) to be told whenever the scale may have moved;
   - a place for the readout: #program-clock-slot, after the clock's total
     (page.html). */

/* The seconds of air the strip leaves after the script (or the target):
   the end of the last block never sits on the edge. */
export var RUNDOWN_TAIL_SECONDS = 10;
/* Between neighbouring blocks, and the narrowest a block is ever drawn. */
var BLOCK_GAP_PX = 2;
var BLOCK_MIN_PX = 2;
/* A label shows only where it fits: the number from this wide, and the
   read time after it from the second (the check a shot block carries
   needs a little more). */
var LABEL_NUMBER_PX = 28;
var LABEL_LENGTH_PX = 66;
var LABEL_LENGTH_SHOT_PX = 80;

/* The seconds the strip shows, 0 to the end: the script, or something
   longer that must fit too (a target, #170), plus the tail. */
export function rundownSpan(totalSeconds, extraSeconds) {
  return Math.max(totalSeconds || 0, extraSeconds || 0, 0) + RUNDOWN_TAIL_SECONDS;
}

/* Pixels per second for a strip `widthPx` wide. */
export function rundownScale(totalSeconds, extraSeconds, widthPx) {
  return widthPx > 0 ? widthPx / rundownSpan(totalSeconds, extraSeconds) : 0;
}

function tenth(v) { return Math.round(v * 10) / 10; }

/* Where each scene's block goes. `scenes` is [{seconds, status}] in script
   order; the answer is one block per scene: its start and length in
   seconds, its left and width in pixels, and which of its two labels fit.
   A scene with no words still gets a sliver, so it can be seen and
   clicked. */
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

/* The ruler: a minor tick and a major one with a label, their spacing
   chosen so the labels stay at least a label apart however long the
   script — every 5s and 15s for a two-minute piece, wider for a long one.
   A label that would run off the right edge is left off. */
var TICK_STEPS = [[5, 15], [10, 30], [15, 60], [30, 120], [60, 300], [120, 600], [300, 1800], [600, 3600]];
var LABEL_MIN_GAP_PX = 56;
var TICK_MIN_GAP_PX = 6;
var LABEL_ROOM_PX = 34;

export function rundownTicks(spanSeconds, pxPerSecond, widthPx) {
  if (!(pxPerSecond > 0)) return [];
  var step = TICK_STEPS[TICK_STEPS.length - 1];
  for (var i = 0; i < TICK_STEPS.length; i++) {
    if (TICK_STEPS[i][1] * pxPerSecond >= LABEL_MIN_GAP_PX && TICK_STEPS[i][0] * pxPerSecond >= TICK_MIN_GAP_PX) {
      step = TICK_STEPS[i];
      break;
    }
  }
  var out = [];
  for (var s = 0; s <= spanSeconds; s += step[0]) {
    var x = Math.round(s * pxPerSecond);
    var major = s % step[1] === 0;
    out.push({
      seconds: s,
      x: x,
      major: major,
      label: major && x + LABEL_ROOM_PX <= widthPx ? formatDuration(s) : ""
    });
  }
  return out;
}

/* ---- painting ---- */

var extraSeconds = 0;
var currentRowId = null;
var lastBlocksHtml = "";
var lastRulerHtml = "";
var lastLayout = { pxPerSecond: 0, spanSeconds: 0, totalSeconds: 0, width: 0 };
var paintListeners = [];

/* #170: make the strip span `seconds` as well as the script. */
export function setRundownExtraSeconds(seconds) {
  var next = Math.max(0, Number(seconds) || 0);
  if (next === extraSeconds) return;
  extraSeconds = next;
  renderRundown();
}

/* #170: the x, in #rundown-overlay's pixels, of a time in the programme. */
export function rundownX(seconds) {
  return tenth((seconds || 0) * lastLayout.pxPerSecond);
}

/* #170: fn(layout) after every paint that may have moved the scale. */
export function onRundownPaint(fn) {
  if (typeof fn === "function") paintListeners.push(fn);
}

var CHECK_SVG = '<svg class="rd-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function blockHtml(row, b, isCurrent, focusable) {
  var st = rowStatus(row.status) || ROW_STATUSES[0];
  var num = pad2(b.index + 1);
  var len = formatDuration(b.seconds);
  var label = "Scene " + num + ", " + len + ", " + st.label.toLowerCase() + (isCurrent ? " — current scene" : "");
  return '<button type="button" class="rd-block is-' + escapeHtml(st.id) + (isCurrent ? ' is-current' : '') +
    '" data-row="' + escapeHtml(row.id) + '" tabindex="' + (focusable ? '0' : '-1') + '"' +
    (isCurrent ? ' aria-current="true"' : '') +
    ' style="left:' + b.left + 'px;width:' + b.width + 'px" aria-label="' + escapeHtml(label) +
    '" title="Scene ' + num + ' · ' + len + ' · ' + escapeHtml(st.label) + '">' +
    (b.showNumber ? '<span class="rd-num">' + num + '</span>' : '') +
    (b.showNumber && st.id === "shot" ? CHECK_SVG : '') +
    (b.showLength ? '<span class="rd-len">' + len + '</span>' : '') +
    '</button>';
}

/* A b-roll line's tick along its scene's block — where in the scene is not
   known (it is a direction beside the words, not a moment in them), so the
   scene's lines share its length evenly. */
function brollTicksHtml(row, b) {
  var n = brollCountInRow(row);
  var out = "";
  for (var i = 0; i < n; i++) {
    var x = tenth(b.left + b.width * (i + 1) / (n + 1) - 1);
    out += '<span class="rd-broll" style="left:' + x + 'px"></span>';
  }
  return out;
}

export function renderRundown() {
  var strip = document.getElementById("rundown");
  if (!strip) return;
  var rows = S.state && S.state.rows ? S.state.rows : [];
  strip.hidden = !rows.length;
  if (!rows.length) return;
  var track = strip.querySelector(".rundown-track");
  var blocksEl = strip.querySelector(".rundown-blocks");
  var rulerEl = strip.querySelector(".rundown-ruler");
  var playhead = strip.querySelector(".rundown-playhead");
  if (!track || !blocksEl || !rulerEl) return;
  var width = track.clientWidth;
  /* not laid out (a phone, where the strip is hidden, or a hidden tab):
     nothing to measure against, and the ResizeObserver paints it later */
  if (!width) return;

  var scenes = rows.map(function (r) { return { seconds: rowSeconds(r), status: r.status }; });
  var total = scenes.reduce(function (n, sc) { return n + sc.seconds; }, 0);
  var span = rundownSpan(total, extraSeconds);
  var s = rundownScale(total, extraSeconds, width);
  var blocks = rundownBlocks(scenes, s);

  var current = currentRowId && rows.some(function (r) { return r.id === currentRowId; }) ? currentRowId : null;
  /* One block takes Tab (the current scene's, or the first); the arrow keys
     walk the rest — sixty scenes should not be sixty Tab stops. */
  var tabRow = current || rows[0].id;
  var html = "";
  var ticks = "";
  blocks.forEach(function (b, i) {
    html += blockHtml(rows[i], b, rows[i].id === current, rows[i].id === tabRow);
    ticks += brollTicksHtml(rows[i], b);
  });
  html += ticks;
  if (html !== lastBlocksHtml) {
    var hadFocus = blocksEl.contains(document.activeElement) ? document.activeElement.getAttribute("data-row") : null;
    blocksEl.innerHTML = html;
    lastBlocksHtml = html;
    if (hadFocus) {
      var again = blocksEl.querySelector('.rd-block[data-row="' + cssAttr(hadFocus) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }

  var ruler = rundownTicks(span, s, width).map(function (t) {
    return '<span class="rd-tick' + (t.major ? ' is-major' : '') + '" style="left:' + t.x + 'px"></span>' +
      (t.label ? '<span class="rd-label" style="left:' + (t.x + 4) + 'px">' + t.label + '</span>' : '');
  }).join("");
  if (ruler !== lastRulerHtml) {
    rulerEl.innerHTML = ruler;
    lastRulerHtml = ruler;
  }

  if (playhead) {
    var at = null;
    for (var j = 0; j < rows.length; j++) if (rows[j].id === current) at = blocks[j];
    playhead.hidden = !at;
    if (at) playhead.style.left = tenth(at.left - 1) + "px";
  }

  var moved = s !== lastLayout.pxPerSecond || width !== lastLayout.width;
  lastLayout = { pxPerSecond: s, spanSeconds: span, totalSeconds: total, width: width };
  if (moved) paintListeners.forEach(function (fn) { try { fn(lastLayout); } catch (e) { /* a listener's own problem */ } });
}

/* Go to a scene from its block: unfold it if hidden shot scenes cover it,
   bring it to the middle of the window, and put the caret in its Audio. */
function goToScene(rowId) {
  revealRow(rowId);
  var rowEl = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"]');
  if (!rowEl) return;
  rowEl.scrollIntoView({ block: "center" });
  var cell = rowEl.querySelector(".audio-cell .cell-editable");
  if (cell) cell.focus({ preventScroll: true });
}

/* The scene the caret is in — the playhead's scene — kept when focus goes
   to the header or a panel, so clicking a toolbar button does not throw
   the playhead back to nothing. */
function noteCurrentRow(el) {
  var rowEl = el && el.closest ? el.closest("#rows .row") : null;
  var id = rowEl ? rowEl.getAttribute("data-id") : null;
  if (!id || id === currentRowId) return;
  currentRowId = id;
  renderRundown();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  var strip = document.getElementById("rundown");
  var rowsEl = document.getElementById("rows");
  if (!strip) return;
  /* focusin for a click or Tab into a scene; selectionchange too, because a
     window without system focus (a background window, a headless one)
     moves the caret without ever sending focus events. Either way the
     strip repaints only when the scene changed. */
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
  /* A panel opening, the window resizing: the strip's width changed, and so
     did the scale. */
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () { renderRundown(); }).observe(strip);
  }
}
