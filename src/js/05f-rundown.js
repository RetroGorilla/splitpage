import { S } from "./_state.js";
import { ROW_STATUSES, formatDuration, rowSeconds, rowStatus } from "./01-scene-status.js";
import { revealRow } from "./01b-hide-shot.js";
import { escapeHtml } from "./02-state.js";
import { findRowIndex } from "./03-sync.js";
import { cssAttr } from "./04-richtext.js";
import { cellOf, toPlainText } from "./04c-doc-model.js";
import { pad2 } from "./05-render.js";
import { clearDropMarkers, moveRowTo } from "./06-rows.js";
import { contentMemo } from "./07-production-tags.js";
import { brollCountInRow } from "./08c-broll.js";
import { reviewMode } from "./13-hosted.js";

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

   The layout is the pure functions just below (rundownSpan, rundownScale,
   rundownBlocks, rundownTicks, and for the lens rundownKnots,
   rundownLensSlots, rundownLens, knotMap, knotBlocks and rundownDropGap —
   unit-tested in src/test/rundown.test.mjs); everything after them is DOM.

   Three things were added on top of #169:

   - Minimized (#178): a per-device view setting (localStorage
     "splitpage-rundown-min", never the document) that shrinks the strip to
     a thin bar — the blocks as a coloured progress line and the playhead,
     no labels, no ruler, the whole bar one button that brings it back. The
     chevron at the strip's right end, File ▸ This document ▸ Minimize the
     rundown and the desktop View menu all flip it; the Settings dialog
     writes the key and says so with a `splitpage:pref` event.
   - The lens (#184): the scenes under the mouse (or a focused block) grow
     to a readable width and the rest compress to make room. It never
     re-renders the strip: it moves the blocks that are already there, one
     animation frame at a time.
   - Dropping a scene (#185): a scene dragged by its grip can be dropped in
     a gap between two blocks, which moves it there (moveRowTo, one undo
     step) and takes the script to it.

   ---- hooks for a target length (#170) ----

   A per-script target length is its own module (05t-target.js), which
   draws on the strip through three things, all here:
   - the scale: setRundownExtraSeconds(seconds) makes the strip span the
     target as well as the script (rundownScale's second argument), and
     repaints;
   - a layer to draw on: #rundown-overlay, over the blocks, which a paint
     never touches, with rundownX(seconds) for where a time falls on it and
     onRundownPaint(fn) to be told whenever the scale may have moved;
   - a place for the readout: #runtime-slot, after the script's length at
     the end of the strip (#207, page.html; updateScriptStats writes it).
   While the lens is on, rundownX() answers where the time is on screen,
   and the overlay fades out with the ruler, since the lens moves every
   frame and a paint listener is not. Minimized, the overlay stays: it is
   the thin bar's height, on the same scale, so a target line is still a
   line at the right place. */

/* The seconds of air the strip leaves after the script (or the target):
   the end of the last block never sits on the edge. */
export var RUNDOWN_TAIL_SECONDS = 10;
/* Between neighbouring blocks, and the narrowest a block is ever drawn. */
var BLOCK_GAP_PX = 2;
var BLOCK_MIN_PX = 2;
/* A label shows only where it fits: the number from this wide, and the
   read time after it from the second (the check a shot block carries
   needs a little more). The CSS says the same thing with container
   queries on each block (app.css, "the rundown strip"), which is what
   lets the lens change a block's width without a repaint; these are the
   numbers the unit tests hold it to. */
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

/* ---- the script's length (#207) ----

   The script's read time is a small label at the end of the rundown, not a
   clock in the header: "1:35", or against a target "1:35 / 2:00 · 0:25
   left". It sits just after the last block, in the tail the strip leaves
   after the script. Where that tail is too short for it — a long script,
   or one that has run over its target, fills the strip — it sits at the
   track's right edge instead, and the blocks are laid out short of it, so
   it never covers one. If even that would take more than LENGTH_MAX_SHARE
   of the strip, it drops the target and its delta (they stay in its
   tooltip) and tries again, and past that it is not shown on the strip at
   all.

   `widths` are the label's widths in pixels, the whole of it first, then
   without the target (the same, or left out, when there is no target).
   The answer is the width the blocks are laid out in (`width`), where the
   label goes (`left`), which of the widths it is drawn at (`fit`: 0, 1,
   or -1 for not at all) and whether it is at the right edge (`pinned`). */
export var LENGTH_GAP_PX = 6;
var LENGTH_MAX_SHARE = 0.25;

export function rundownLengthPlace(totalSeconds, extraSeconds, widthPx, widths) {
  var none = { width: widthPx, left: null, fit: -1, pinned: false };
  if (!(widthPx > 0) || !widths || !widths.length) return none;
  var end = tenth((totalSeconds || 0) * rundownScale(totalSeconds, extraSeconds, widthPx));
  /* the whole label, in the tail or else at the edge; only then the total
     alone — how far off the target it is matters more than where it sits */
  for (var i = 0; i < widths.length; i++) {
    if (end + LENGTH_GAP_PX + widths[i] <= widthPx) return { width: widthPx, left: end + LENGTH_GAP_PX, fit: i, pinned: false };
    if (widths[i] + LENGTH_GAP_PX <= LENGTH_MAX_SHARE * widthPx) {
      return { width: tenth(widthPx - widths[i] - LENGTH_GAP_PX), left: tenth(widthPx - widths[i]), fit: i, pinned: true };
    }
  }
  return none;
}

/* ---- the lens (#184): the pure half ----

   A layout is a list of KNOTS: knot i is where scene i starts, knot n is
   where the last scene ends, and knot n+1 is the strip's right edge — so
   n + 2 numbers, the first 0 and the last the strip's width, never
   decreasing. Scene i is drawn from knot i to knot i+1, less the 2px gap;
   the stretch after knot n is the tail. The to-scale layout is
   rundownKnots(); the lens computes another set and the strip glides
   between the two, knot by knot, which is what keeps every in-between
   frame a valid, ordered layout (a mix of two ordered lists is ordered).

   The lens works in SLOT coordinates (rundownLensSlots): the to-scale
   layout with every scene given at least a few pixels, so a scene with no
   words — a point in time, sharing its knot with the next — is somewhere
   the pointer can be. Given a focus (a point in slot coordinates) and an
   anchor (where on the strip that point should sit, normally the
   pointer), each scene near the focus wants to be LENS_MIN_PX wide, the
   want falling off smoothly (a raised cosine) over LENS_RADIUS_PX of slot
   distance, and the room that takes comes out of everything else evenly —
   every scene left of the focus shrinks by one factor and every scene
   right of it by another, so the whole script stays on the strip.

   Why an anchor as well as a focus: if the lens were always centred on
   the pointer's own x, a 2px scene magnified to 96px would be under the
   pointer for only 2px of mouse travel, and the strip would race past it —
   the classic fisheye problem. rundownLensFollow() and
   rundownLensRecenter() below decide where the focus and the anchor go as
   the pointer moves and as time passes; this function only draws a lens
   for them.

   The lens is an AREA that opens round the focus (#199), not a push to one
   side: the anchor may drift from the focus by only LENS_DRIFT_SHARE of
   the magnified room (never more than the room on the side it drifts to,
   so the rest of the script is only ever shrunk, never stretched), and the
   magnified room is never trimmed on one side only. Near either end of the
   strip, where the short side has too little to give up, the whole lens
   moves inward just far enough instead — so the scenes under it grow by
   the same amount on both sides wherever the pointer is. */

/* ---- the lens's tuning (#184, #199): the numbers to change by feel ----

   Size — how big the lens is:
   - LENS_MIN_PX: how wide the scene under the pointer grows. Kept tight
     on purpose: at 140px over 40px of reach, a long script's run of short
     scenes all grew at once and the strip lurched under the mouse (Adam,
     beta.6). A few scenes around the pointer grow; the rest hardly move.
   - LENS_RADIUS_PX: how far either side of the pointer (in slot pixels)
     a scene still grows, falling off smoothly to nothing.
   - LENS_MAX_SHARE: the most of the strip the lens may take in all,
     however many scenes are in reach.
   - LENS_FLOOR: the least share of its own width each side keeps: however
     much the lens wants, what is outside it never vanishes.
   - LENS_MIN_SLOT_PX: the room a scene with no words is given, so it is
     somewhere the pointer can be.

   Movement — how it follows the pointer (#199):
   - LENS_DRIFT_SHARE: how far the lens's centre may lag behind (or run
     ahead of) the pointer, as a share of the room it adds. Larger holds a
     sliver still under a slow pointer for longer (easier to click), but
     lets the lens sit further off to one side of it. 0 is a plain
     magnifier centred on the pointer.
   - LENS_RECENTER_MS: how quickly the lens slides back to centre on the
     pointer, a time constant: about two-thirds of the way there after
     this long, whether the pointer is moving or has stopped. Longer is
     calmer; shorter follows more tightly.
   - LENS_SLOW_PX_MS, LENS_FAST_PX_MS: the pointer speeds (px per ms)
     under which it is aiming (the lens holds what is under it still) and
     over which it is travelling (the lens goes wherever the pointer is).
   - LENS_GLIDE_MS: how softly the blocks move to each new layout, a time
     constant (the DOM half). */
export var LENS_MIN_PX = 96;
export var LENS_RADIUS_PX = 14;
var LENS_MAX_SHARE = 0.3;
var LENS_FLOOR = 0.12;
var LENS_MIN_SLOT_PX = 4;
export var LENS_DRIFT_SHARE = 0.15;
export var LENS_RECENTER_MS = 80;
export var LENS_SLOW_PX_MS = 0.12;
export var LENS_FAST_PX_MS = 0.6;
var LENS_GLIDE_MS = 70;

/* The to-scale knots of `blocks` (rundownBlocks) on a strip `widthPx`
   wide. */
export function rundownKnots(blocks, pxPerSecond, widthPx) {
  var k = [];
  for (var i = 0; i < blocks.length; i++) k.push(blocks[i].left);
  var last = blocks[blocks.length - 1];
  var end = last ? tenth((last.start + last.seconds) * pxPerSecond) : 0;
  k.push(Math.min(Math.max(end, k.length ? k[k.length - 1] : 0), widthPx));
  k.push(widthPx);
  return k;
}

/* Slot coordinates: the to-scale knots with every scene at least
   LENS_MIN_SLOT_PX wide, scaled back down to the strip's width. */
export function rundownLensSlots(blocks, pxPerSecond, widthPx) {
  var raw = blocks.map(function (b) { return Math.max(b.seconds * pxPerSecond, LENS_MIN_SLOT_PX); });
  var last = blocks[blocks.length - 1];
  var used = last ? (last.start + last.seconds) * pxPerSecond : 0;
  raw.push(Math.max(widthPx - used, LENS_MIN_SLOT_PX));
  var sum = raw.reduce(function (n, w) { return n + w; }, 0);
  var f = sum > 0 ? widthPx / sum : 0;
  var k = [0];
  var x = 0;
  for (var i = 0; i < raw.length; i++) {
    x += raw[i] * f;
    k.push(x);
  }
  k[k.length - 1] = widthPx;
  return k;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* The lensed knots for slot knots `slots`, magnified around `focus` (slot
   coordinates) with that point placed at `anchor` (strip pixels) — or as
   near it as the anchor is allowed to drift (see above). `opts` may carry
   minWidth and radius, and drift (in place of LENS_DRIFT_SHARE) and\n   recenterMs (in place of LENS_RECENTER_MS). */
export function rundownLens(slots, focus, anchor, opts) {
  opts = opts || {};
  var minW = opts.minWidth > 0 ? opts.minWidth : LENS_MIN_PX;
  var radius = opts.radius > 0 ? opts.radius : LENS_RADIUS_PX;
  var m = slots.length - 1;          /* intervals: the scenes, then the tail */
  var W = slots[m];
  if (!(W > 0) || m < 2) return slots.slice();
  var p = clamp(Number(focus) || 0, 0, W);

  /* The extra width each scene wants, split at the focus into the part
     left of it and the part right of it. */
  var extraL = [], extraR = [];
  var EL = 0, ER = 0;
  for (var j = 0; j < m; j++) {
    extraL.push(0);
    extraR.push(0);
    if (j === m - 1) break;          /* the tail never grows */
    var a0 = slots[j], a1 = slots[j + 1], w = a1 - a0;
    var dist = p < a0 ? a0 - p : p > a1 ? p - a1 : 0;
    if (dist >= radius) continue;
    var e = Math.max(0, minW * 0.5 * (1 + Math.cos(Math.PI * dist / radius)) - w);
    if (!e) continue;
    if (a1 <= p) { extraL[j] = e; EL += e; }
    else if (a0 >= p) { extraR[j] = e; ER += e; }
    else {
      var phi = w > 0 ? (p - a0) / w : 0.5;
      extraL[j] = e * phi; extraR[j] = e * (1 - phi);
      EL += extraL[j]; ER += extraR[j];
    }
  }
  /* Everything still has to fit, and the lens stays a lens: no more than
     LENS_MAX_SHARE of the strip is extra, however many scenes want it. */
  var maxExtra = Math.min(1 - LENS_FLOOR, LENS_MAX_SHARE) * W;
  var c = EL + ER > maxExtra ? maxExtra / (EL + ER) : 1;
  EL *= c; ER *= c;
  /* #199: the anchor drifts from the focus by at most LENS_DRIFT_SHARE of
     the magnified room, and never further than the room on the side it
     drifts towards (which would stretch the other side). */
  var share = opts.drift >= 0 ? opts.drift : LENS_DRIFT_SHARE;
  var drift = share * (EL + ER);
  var a = Number(anchor);
  if (!isFinite(a)) a = p;
  a = clamp(a, p - Math.min(ER, drift), p + Math.min(EL, drift));
  /* Each side keeps at least the floor of its own width. Near an end the
     short side cannot give up its share of the room; rather than cut the
     lens on that side (which made it lopsided), the lens moves inward.
     The two bounds never cross: the room is at most 1 - LENS_FLOOR of the
     strip. */
  a = Math.max(a, EL + LENS_FLOOR * p);
  a = Math.min(a, W - ER - LENS_FLOOR * (W - p));
  var kL = p > 0 ? (a - EL) / p : 1;
  var kR = W - p > 0 ? ((W - a) - ER) / (W - p) : 1;

  /* Out from the anchor, both ways: each interval's slot length at its
     side's factor, plus its (scaled) share of the extra. */
  var jp = 0;
  while (jp < m - 1 && slots[jp + 1] <= p) jp++;
  var Y = new Array(m + 1);
  var y = a;
  for (j = jp; j < m; j++) {
    y += (slots[j + 1] - Math.max(slots[j], p)) * kR + extraR[j] * c;
    Y[j + 1] = y;
  }
  y = a;
  for (j = jp; j >= 0; j--) {
    y -= (Math.min(slots[j + 1], p) - slots[j]) * kL + extraL[j] * c;
    Y[j] = y;
  }
  Y[0] = 0;
  Y[m] = W;

  /* The scene the focus is in is drawn as one straight block, but the two
     sides' factors differ, so along it the focus would not quite land on
     the anchor — and a pointer read back through the drawn block would
     creep a little on every move. Straighten it: the same width, placed
     so the focus is exactly at the anchor, and each side stretched or
     squeezed a touch to meet it. At either end of the scene the two agree
     already, so this never jumps as the focus crosses into the next. */
  var fw = slots[jp + 1] - slots[jp];
  if (fw > 0) {
    var phiF = (p - slots[jp]) / fw;
    var D = Y[jp + 1] - Y[jp];
    /* Near either end of the strip the focus scene may have grown wider
       than the room on one side of the anchor; narrow it just enough that
       the focus still lands on the anchor rather than the block being
       pushed off the end (which would slide it under the pointer). */
    if (jp > 0 && jp + 1 < m) {
      if (phiF > 0) D = Math.min(D, a / phiF);
      if (phiF < 1) D = Math.min(D, (W - a) / (1 - phiF));
    }
    var oldL = Y[jp], oldR = Y[jp + 1];
    /* the strip's two ends never move */
    var newL = jp === 0 ? 0 : jp + 1 === m ? W - D : clamp(a - phiF * D, 0, W - D);
    var newR = newL + D;
    for (j = 1; j < jp; j++) Y[j] = oldL > 0 ? Y[j] * newL / oldL : 0;
    for (j = jp + 2; j < m; j++) Y[j] = oldR < W ? W - (W - Y[j]) * (W - newR) / (W - oldR) : W;
    Y[jp] = newL;
    Y[jp + 1] = newR;
  }
  for (j = 1; j <= m; j++) if (Y[j] < Y[j - 1]) Y[j] = Y[j - 1];
  return Y;
}

/* How the lens follows the pointer. Two needs pull against each other: to
   click a 2px scene drawn 140px wide, the pointer has to move over it as
   over a still picture (anchor the lens, move the focus slowly); to get
   from one end of a long script to the other, the lens has to go where
   the pointer goes (focus on the to-scale point under it — which, for a
   sliver under the lens, races past at the magnification). No single rule
   does both, so the speed of the pointer decides, the way people use a
   magnifier: moving slowly is aiming, moving fast is travelling.

   - Slowly (under LENS_SLOW_PX_MS): the pointer moves over the layout as
     it is drawn (`shown`), and the lens is held so that what the pointer
     is over stays under it — nothing slides under a pointer that is
     aiming.
   - Fast (over LENS_FAST_PX_MS): the focus is the to-scale point under
     the pointer and the anchor the pointer itself, the plain magnifier.
   - Between the two, a mix of both.

   Moving is only half of it. Time is the other (#199): every frame,
   rundownLensRecenter() eases the lens back to centre on whatever the
   pointer is over, still keeping that under the pointer, over
   LENS_RECENTER_MS — whether the pointer is moving or has stopped. It
   used to re-centre a little per pixel moved instead, so a slow move
   built up an offset the lens then swung through, and a pointer that
   stopped left the lens wherever it was, off to one side: it led. Now it
   settles round the pointer. The anchor's drift cap (LENS_DRIFT_SHARE,
   in rundownLens) is what bounds how far off centre it can ever get
   while a slow pointer crosses a sliver.

   `knots` is the to-scale layout, `shown` what is on screen; `focus` and
   `anchor` the lens as it is; the pointer has moved `dx` to `x` in
   `dtMs`. The answer is the lens's new {focus, anchor}. */
function anchorFor(slots, focus, u, x, opts) {
  /* where the lens anchored at `a` draws the point `u` never decreases as
     `a` grows, so halving finds the anchor that puts `u` at `x` */
  var lo = 0, hi = slots[slots.length - 1];
  for (var i = 0; i < 24; i++) {
    var mid = (lo + hi) / 2;
    if (knotMap(slots, rundownLens(slots, focus, mid, opts), u) < x) lo = mid; else hi = mid;
  }
  /* the anchor the lens really uses — where the focus lands — so one held
     past the drift cap is the cap, not a wish the next move starts from */
  return knotMap(slots, rundownLens(slots, focus, (lo + hi) / 2, opts), focus);
}

/* Aiming and travelling are told apart by speed, and what counts as fast
   depends on how much the lens magnifies (Adam: "with a ton of scenes the
   rundown won't stay still"). In a 500-scene script a scene is 2-3px at
   rest and ~96px under the lens, so an ordinary hand correction read as
   travelling and raced 16-27 scenes past the pointer per 100px moved. Both
   speeds are scaled by the square root of the magnification at the focus
   (LENS_MIN_PX over that scene's slot width, capped at LENS_SPEED_MAG_MAX):
   a short script is unchanged, and a long one still travels on a flick. */
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

/* The lens `dtMs` later, the pointer still at `x` (or between two moves):
   the focus eased towards what the pointer is over on `shown`, and the
   anchor solved to keep that under the pointer, as far as the drift cap
   allows. Repeated, it comes to rest centred on the pointer. */
export function rundownLensRecenter(slots, shown, focus, anchor, x, dtMs, opts) {
  if (!(dtMs > 0) || x == null) return { focus: focus, anchor: anchor };
  var u = knotMap(shown, slots, x);
  var tau = opts && opts.recenterMs > 0 ? opts.recenterMs : LENS_RECENTER_MS;
  var f = focus + (u - focus) * (1 - Math.exp(-dtMs / tau));
  return { focus: f, anchor: anchorFor(slots, f, u, x, opts) };
}

/* The piecewise-linear map between two sets of knots: where `x`, a point
   on the layout `from`, lies on the layout `to`. Used both ways — from the
   strip back into slot coordinates to read what is under the pointer, and
   from time (the to-scale knots) to the strip for rundownX(). */
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

/* Labels the lens keeps (Adam, after #199). The lens takes its room out of
   every other block, so a block whose number only just fitted at rest lost
   it the moment the lens opened, anywhere on the strip: numbers far from
   the pointer blinked out. Now a label a block shows at rest stays while
   the lens is on, drawn on tighter padding (.keep-num / .keep-len,
   app.css), for as long as it still fits; only the scenes near the pointer
   gain labels. The widths are the block's (border included) that the
   tight layout needs: a two-digit number with no padding, a three-digit
   one from scene 100 on; the number and read time on 3px padding, and the
   shot check besides. `rest` is the block as rundownBlocks() laid it out. */
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

/* Each scene's block on a layout: its left and width, the gap taken off. */
export function knotBlocks(knots) {
  var out = [];
  for (var i = 0; i < knots.length - 2; i++) {
    out.push({ left: tenth(knots[i]), width: Math.max(BLOCK_MIN_PX, tenth(knots[i + 1] - knots[i] - BLOCK_GAP_PX)) });
  }
  return out;
}

/* #185: the gap a scene dragged from index `from` would be dropped in, for
   a pointer at `x` on the layout `knots` — gap g is before scene g, gap n
   after the last — or -1: nothing within `hitPx`, or one of the two gaps
   either side of the scene itself, where dropping would move nothing. */
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

/* Where gap `g` is drawn on the layout `knots`. */
function gapX(knots, g) {
  return g === 0 ? knots[0] : knots[g] - BLOCK_GAP_PX / 2;
}

/* ---- painting ---- */

var MIN_KEY = "splitpage-rundown-min";
var extraSeconds = 0;
var currentRowId = null;
var lastBlocksHtml = "";
var lastRulerHtml = "";
var lastLayout = { pxPerSecond: 0, spanSeconds: 0, totalSeconds: 0, width: 0 };
var paintListeners = [];
var minimized = false;
/* What the last paint drew, for the lens to move: the to-scale blocks and
   knots, the slot knots (worked out only once the lens wants them), the
   block elements in scene order, and the style each was last given. */
var base = { blocks: [], X: null, U: null, n: 0, W: 0, pps: 0, els: [], lefts: [], widths: [], keep: [], shot: [], current: -1 };

/* #170: make the strip span `seconds` as well as the script. */
export function setRundownExtraSeconds(seconds) {
  var next = Math.max(0, Number(seconds) || 0);
  if (next === extraSeconds) return;
  extraSeconds = next;
  renderRundown();
}

/* #170: the x, in #rundown-overlay's pixels, of a time in the programme —
   on screen, which while the lens is on is not to scale. */
export function rundownX(seconds) {
  var px = (seconds || 0) * lastLayout.pxPerSecond;
  if (lens.Z && base.X && lens.Z.length === base.X.length) return tenth(knotMap(base.X, lens.Z, px));
  return tenth(px);
}

/* #170: fn(layout) after every paint that may have moved the scale. */
export function onRundownPaint(fn) {
  if (typeof fn === "function") paintListeners.push(fn);
}

/* #170: the last paint's scale, to scale — {pxPerSecond, spanSeconds,
   totalSeconds, width} — for a layer drawn by time that must be right when
   the lens comes to rest (rundownX answers where a time is on screen, which
   under the lens is not to scale). A copy. */
export function rundownLayout() {
  return {
    pxPerSecond: lastLayout.pxPerSecond,
    spanSeconds: lastLayout.spanSeconds,
    totalSeconds: lastLayout.totalSeconds,
    width: lastLayout.width
  };
}

var CHECK_SVG = '<svg class="rd-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/* The first words of a scene, for a block the lens has made wide: its
   Audio, or its Visual when it has no Audio. Memoised on the cell's HTML
   like the word count, since this runs on every paint while typing.
   Made on first use, so nothing runs while the module is evaluated. */
var snippetOf = null;

function sceneSnippet(row) {
  if (!snippetOf) {
    snippetOf = contentMemo(function (html) {
      var text = toPlainText(cellOf(html)).replace(/\s+/g, " ").trim();
      return text.length > 90 ? text.slice(0, 90) : text;
    });
  }
  return snippetOf(row.audioText || "") || snippetOf(row.visualText || "");
}

/* A b-roll line's tick along its scene's block — where in the scene is not
   known (it is a direction beside the words, not a moment in them), so the
   scene's lines share its length evenly. Drawn inside the block, by
   percentage, so it moves with the block when the lens resizes it. */
function brollTicksHtml(row) {
  var n = brollCountInRow(row);
  var out = "";
  for (var i = 0; i < n; i++) {
    out += '<span class="rd-broll" style="left:calc(' + tenth((i + 1) / (n + 1) * 100) + '% - 1px)"></span>';
  }
  return out;
}

/* Every label goes in every block; which of them show is the block's own
   width, through the container queries in app.css — so the lens can widen
   a block and its number, length, status and first words appear without
   the strip being painted again. */
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

/* #207: measure the length label (updateScriptStats has written it), place
   it with rundownLengthPlace(), and answer the width the blocks get. Its
   widths are read without changing anything: the slot keeps its width
   while it is hidden (.is-short, app.css), so nothing has to be put back.
   On a phone the label is not on the strip (the header's status line has
   the length) and measures nothing: the blocks get the whole track. */
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
  /* the delta is on the label: the target's hatching need not say it too */
  strip.classList.toggle("has-length-delta", p.fit === 0 && sw > 0);
  lengthAt = { left: p.left, width: p.fit === -1 ? 0 : widths[p.fit], fit: p.fit, pinned: p.pinned };
  return p.width;
}

/* Under the lens the label stays where it is; when the lens pushes the
   script's end up to it (only ever in the tail, never when it is at the
   right edge), it steps aside until the lens lets go. */
function lengthCovered(Z) {
  if (lengthAt.left === null || lengthAt.pinned) return;
  var strip = stripEl();
  var el = strip && strip.querySelector(".rd-length");
  if (el) el.classList.toggle("is-covered", !!Z && Z[base.n] + 1 > lengthAt.left);
}

/* A pointer over the label (or just short of it) is not over the script:
   no lens there, so the label never moves from under the pointer. */
function overLength(x) {
  return lengthAt.left !== null && x >= lengthAt.left - 2 && x <= lengthAt.left + lengthAt.width + 2;
}

/* Minimized (#178): the same blocks as a coloured line — no labels, no
   ticks, nothing to focus; the bar's toggle is the one control. */
function segmentHtml(row, b, isCurrent) {
  var st = rowStatus(row.status) || ROW_STATUSES[0];
  return '<span class="rd-seg is-' + escapeHtml(st.id) + (isCurrent ? ' is-current' : '') +
    '" style="left:' + b.left + 'px;width:' + b.width + 'px"></span>';
}

export function renderRundown() {
  var strip = document.getElementById("rundown");
  if (!strip) return;
  var rows = S.state && S.state.rows ? S.state.rows : [];
  strip.hidden = !rows.length;
  if (!rows.length) { lensReset(); return; }
  var track = strip.querySelector(".rundown-track");
  var blocksEl = strip.querySelector(".rundown-blocks");
  var rulerEl = strip.querySelector(".rundown-ruler");
  var playhead = strip.querySelector(".rundown-playhead");
  if (!track || !blocksEl || !rulerEl) return;
  var width = track.clientWidth;
  /* not laid out (a hidden tab, or the strip hidden a moment ago): nothing
     to measure against, and the ResizeObserver paints it later */
  if (!width) return;

  var scenes = rows.map(function (r) { return { seconds: rowSeconds(r), status: r.status }; });
  var total = scenes.reduce(function (n, sc) { return n + sc.seconds; }, 0);
  /* #207: the script's length goes at its end; where it has to sit at the
     track's right edge, the blocks are laid out in what it leaves */
  width = placeLength(strip, total, width);
  var span = rundownSpan(total, extraSeconds);
  var s = rundownScale(total, extraSeconds, width);
  var blocks = rundownBlocks(scenes, s);

  var current = currentRowId && rows.some(function (r) { return r.id === currentRowId; }) ? currentRowId : null;
  /* One block takes Tab (the current scene's, or the first); the arrow keys
     walk the rest — sixty scenes should not be sixty Tab stops. */
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

  /* The ruler is hidden while minimized: nothing to build, and the next
     full paint rebuilds it (lastRulerHtml still holds what is in it). */
  if (!minimized) {
    var ruler = rundownTicks(span, s, width).map(function (t) {
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
  base.X = rundownKnots(blocks, s, width);
  base.U = null;
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

  /* A paint in the middle of a lens (the caret moved to another scene, the
     words changed) put the blocks back to scale; put them back where the
     lens has them, in this same frame, and let it carry on from there. */
  if (minimized) lensReset();
  else if (lens.Z) lensRepainted(countChanged);

  var moved = s !== lastLayout.pxPerSecond || width !== lastLayout.width;
  lastLayout = { pxPerSecond: s, spanSeconds: span, totalSeconds: total, width: width };
  if (moved) paintListeners.forEach(function (fn) { try { fn(lastLayout); } catch (e) { /* a listener's own problem */ } });
}

/* ---- the lens (#184): the DOM half ----

   lens.Z is what is on screen while the lens is anything but at rest: the
   displayed knots. Each animation frame moves it a step towards the
   target — the lensed knots while the lens is on, the to-scale ones once
   it is off — and writes the blocks' left and width from it, only where
   they changed. While the pointer is over the track, each frame also lets
   the lens re-centre on it (rundownLensRecenter, #199), and the frames run
   until that has come to rest too. Once it is off and back to scale,
   lens.Z is dropped and the blocks get their painted styles back exactly.
   Nothing here builds HTML. The glide's time constant is LENS_GLIDE_MS,
   with the lens's other tuning above. */
var DROP_HIT_PX = 20;
var lens = {
  on: false,       /* wanted: the pointer is over the track, or a block has keyboard focus, or a drag is */
  src: null,       /* "pointer" | "focus" | "drag" */
  p: 0,            /* the focus, in slot coordinates */
  a: 0,            /* where it is anchored, in track pixels */
  x: null,         /* the pointer's last x over the track, for a repaint to read the focus again */
  t: 0,            /* and when it was there, for its speed */
  Z: null,         /* the displayed knots, or null at rest */
  raf: 0,
  last: 0,         /* the last frame's time: the glide's and the re-centring's step */
  hold: false,     /* the second stage: the pointer has rested on one scene */
  holdAt: -1,      /* the scene the pointer is resting on, timed from when it arrived */
  holdTimer: 0
};
var noHover = false;

/* ---- the lens's second stage (Adam, after #199) ----
   Rest the pointer on one scene for LENS_HOLD_MS and the lens opens
   further, to LENS_HOLD_PX, so the scene has room for its status and its
   first words (the .rd-stat and .rd-snip container queries, app.css).
   Moving on to another scene drops back to the first stage and starts the
   wait again, so sweeping the strip never triggers it; moving about
   within the scene keeps it. The mouse only: a drag or keyboard focus
   keeps the first stage. Both numbers are tuned by feel. */
export var LENS_HOLD_MS = 700;
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

/* The pointer is over scene `i` (on the layout as drawn). */
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

/* The scene under `x` on the knots `Z`, or -1 in the tail. */
function sceneAt(Z, x) {
  for (var i = 0; i < base.n; i++) if (x >= Z[i] && x < Z[i + 1]) return i;
  return -1;
}
/* #185: the gap a dragged scene would land in (-1 for none), and the
   pointer's x while a drag is over the strip. */
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
  if (!base.U) base.U = rundownLensSlots(base.blocks, base.pps, base.W);
  return base.U;
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
    /* the labels this block showed at rest stay while they fit (above) */
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
  if (playhead && base.current !== -1) playhead.style.left = tenth(Z[base.current] - 1) + "px";
  if (drop.x !== null) showDrop(drop.x);
  lengthCovered(Z);
}

function lensFrame(now) {
  lens.raf = 0;
  if (!lens.Z || !base.X || lens.Z.length !== base.X.length) { lensSettle(); return; }
  var dt = lens.last ? Math.min(64, Math.max(1, now - lens.last)) : 16;
  lens.last = now;
  /* #199: the lens eases back to centre on the pointer, in time, not per
     pixel moved — so it comes to rest round a pointer that has stopped */
  var recentring = false;
  if (lens.on && lens.x !== null && (lens.src === "pointer" || lens.src === "drag")) {
    var next = rundownLensRecenter(slots(), lens.Z, lens.p, lens.a, lens.x, dt, lensOpts());
    recentring = Math.abs(next.focus - lens.p) > 0.002 || Math.abs(next.anchor - lens.a) > 0.02;
    lens.p = next.focus;
    lens.a = next.anchor;
  }
  var T = lensTarget();
  var alpha = prefersReducedMotion() ? 1 : 1 - Math.exp(-dt / LENS_GLIDE_MS);
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
  }
  var strip = stripEl();
  if (strip) strip.classList.add("is-lensed");
}

/* The lens at rest: the blocks' painted styles back, the ruler and the
   overlay faded back in. */
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
    if (playhead && base.current !== -1 && base.blocks[base.current]) playhead.style.left = tenth(base.blocks[base.current].left - 1) + "px";
    lengthCovered(null);
  }
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

/* Off at once, no glide back: minimized, emptied, or the strip hidden. */
function lensReset() {
  holdClear();
  lens.on = false;
  lens.src = null;
  lens.x = null;
  lensSettle();
}

/* A paint happened under the lens. The new elements are at scale; put
   them where the lens has them in this frame, then glide on. */
function lensRepainted(countChanged) {
  if (!lensAllowed()) { lensReset(); return; }
  if (countChanged || lens.Z.length !== base.X.length) {
    holdClear();
    lens.Z = base.X.slice();
    if (lens.x !== null) { lens.p = knotMap(lens.Z, slots(), lens.x); lens.a = lens.x; }
    else if (lens.src === "focus") lensOff();
  }
  /* base.lefts/widths are what each element holds now — the painted
     values after a rewrite — so this writes only what differs */
  applyKnots(lens.Z);
  lensKick();
}

/* The pointer (or a drag) at `x` on the track, at time `t` (ms). Arriving,
   the lens opens on what is under it; moving, rundownLensFollow() decides
   (slowly, it aims; fast, it travels). */
function lensAt(x, src, t) {
  if (!lensAllowed()) return;
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
  /* the second stage: timed from when the pointer reached this scene */
  if (src === "pointer") holdTrack(sceneAt(lens.Z, x)); else holdClear();
  lensKick();
}

/* Keyboard focus on block `i`: the lens opens on it without moving it. */
function lensFocus(i) {
  if (!lensAllowed() || noHover || i < 0 || i >= base.n) return;
  if (lens.on && (lens.src === "pointer" || lens.src === "drag")) return;
  lensStart();
  var U = slots();
  lens.on = true;
  lens.src = "focus";
  lens.x = null;
  lens.p = (U[i] + U[i + 1]) / 2;
  lens.a = (lens.Z[i] + lens.Z[i + 1]) / 2;
  lensKick();
}

function lensOff(src) {
  if (src && lens.src !== src) return;
  holdClear();
  lens.on = false;
  lens.src = null;
  lens.x = null;
  if (lens.Z) lensKick();
}

/* ---- minimizing (#178) ---- */

function readMinFlag() {
  try { return localStorage.getItem(MIN_KEY) === "1"; } catch (e) { return false; }
}

/* The File menu's switch and the strip's own toggle say the same thing. */
function updateRundownMinControls() {
  var item = document.getElementById("menu-rundown-min");
  if (item) item.setAttribute("aria-checked", minimized ? "true" : "false");
  var strip = stripEl();
  if (!strip) return;
  strip.classList.toggle("is-min", minimized);
  var toggle = strip.querySelector(".rundown-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", minimized ? "false" : "true");
    var words = minimized ? "Show the rundown" : "Minimize the rundown";
    toggle.setAttribute("aria-label", words);
    toggle.title = words;
  }
}

/* `persist` false when the setting came from somewhere that has already
   stored it (the Settings dialog's splitpage:pref event, a reload). */
function setRundownMinimized(on, persist) {
  on = !!on;
  if (persist !== false) { try { localStorage.setItem(MIN_KEY, on ? "1" : "0"); } catch (e) {} }
  if (on === minimized) { updateRundownMinControls(); return; }
  minimized = on;
  lensReset();
  hideDrop();
  /* The strip gives up (or takes back) its height. The header is sticky
     at the top of the document, so Chromium's scroll anchoring keeps the
     script still under the reader when it does; the condensing header
     (20i-topbar.js) sees a scroll it can hold either side of, and in the
     thin bar condensing changes no height at all (the ruler is already
     gone), so there is nothing to flip back and forth over. */
  updateRundownMinControls();
  /* Painted as the other thing at once: the blocks' string differs, so
     this is a real repaint, and a restored strip gets its ruler back. */
  renderRundown();
}

export function isRundownMinimized() { return minimized; }

export function toggleRundownMinimized() {
  setRundownMinimized(!minimized);
}

/* ---- dropping a scene on the strip (#185) ---- */

function dragIndex() {
  return S.dragRowId ? findRowIndex(S.dragRowId) : -1;
}

function dropAllowed() {
  return !!S.dragRowId && !minimized && !reviewMode() && base.n > 0 && !!base.X && !!S.state;
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

/* The marker between the two blocks the pointer at `x` is nearest, with
   "Move to after scene N" under it — or nothing, over a block's middle or
   beside the scene's own place. */
function showDrop(x) {
  var strip = stripEl();
  var track = strip && strip.querySelector(".rundown-track");
  if (!track || !dropAllowed()) { hideDrop(); return; }
  drop.x = x;
  var K = lens.Z && lens.Z.length === base.X.length ? lens.Z : base.X;
  var g = rundownDropGap(K, x, dragIndex(), DROP_HIT_PX);
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
  /* kept inside the strip: its half-width either side of the marker */
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

/* The script follows the scene to where it went (#185): unfolded if hidden
   shot scenes cover it, scrolled to the middle of what the header leaves,
   briefly lit, and the caret put in its Audio. The row is mid-FLIP
   (04a-row-motion.js) when this runs, so where it will be is read off its
   layout box, without the transform. */
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
  if (!S.dragRowId) return;
  e.preventDefault();
  var id = S.dragRowId;
  var allowed = dropAllowed();
  if (allowed) showDrop(trackX(e));
  var g = allowed ? drop.gap : -1;
  S.dragRowId = null;
  clearDropMarkers();
  hideDrop();
  lensOff();
  if (g < 0 || !S.state) return;
  var rows = S.state.rows;
  if (g === 0) moveRowTo(id, rows[0].id, false);
  else moveRowTo(id, rows[g - 1].id, true);
  followMovedScene(id);
}

/* Go to a scene from its block: unfold it if hidden shot scenes cover it,
   bring it to the middle of the window, and put the caret in its Audio. */
export function goToScene(rowId) {
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

/* The chevron at the strip's right end (#178). Made here rather than in
   page.html so the header's markup stays the header's. */
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

/* For the browser suites: the lens's numbers, read without a frame. */
function lensDebug() {
  return {
    on: lens.on, src: lens.src, p: lens.p, a: lens.a, hold: lens.hold, holdAt: lens.holdAt,
    Z: lens.Z ? lens.Z.slice() : null, X: base.X ? base.X.slice() : null,
    starts: base.blocks.map(function (b) { return b.start; }),
    dropGap: drop.gap, minimized: minimized,
    W: base.W, length: { left: lengthAt.left, width: lengthAt.width, fit: lengthAt.fit, pinned: !!lengthAt.pinned }
  };
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  var strip = document.getElementById("rundown");
  var rowsEl = document.getElementById("rows");
  if (!strip) return;
  try { noHover = !!(window.matchMedia && window.matchMedia("(hover: none)").matches); } catch (e) {}
  minimized = readMinFlag();
  var toggle = ensureToggle(strip);
  updateRundownMinControls();
  toggle.addEventListener("click", function () { toggleRundownMinimized(); });
  /* The Settings dialog (and anything else that writes a view preference)
     stores the key itself and then says so. */
  document.addEventListener("splitpage:pref", function (e) {
    var d = e && e.detail;
    if (!d || d.key !== MIN_KEY) return;
    var v = d.value;
    var on = v === true || v === "1" || v === 1 ? true : v === false || v === "0" || v === 0 ? false : readMinFlag();
    setRundownMinimized(on, false);
  });

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

  /* The lens follows a mouse or a pen over the track; a touch has no hover
     and gets the strip as it is. */
  var track = strip.querySelector(".rundown-track");
  if (track) {
    track.addEventListener("pointermove", function (e) {
      if (e.pointerType === "touch" || S.dragRowId) return;
      var x = trackX(e);
      if (overLength(x)) { lensOff("pointer"); return; }
      lensAt(x, "pointer", e.timeStamp);
    });
    track.addEventListener("pointerleave", function () { lensOff("pointer"); });
  }
  /* A block focused from the keyboard opens the lens on it. */
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

  /* A scene dragged by its grip, over the strip and dropped in a gap. The
     auto-scroll at the window's edge stands down over the strip
     (21-events.js); everywhere else a dragover says the drag has left. */
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

  /* A panel opening, the window resizing: the strip's width changed, and so
     did the scale. */
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () { renderRundown(); }).observe(strip);
  }
  window.__rundownTest = { lens: lensDebug, setMinimized: setRundownMinimized, x: rundownX };
}
