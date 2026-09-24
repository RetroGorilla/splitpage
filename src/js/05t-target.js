import { S } from "./_state.js";
import { formatDuration, parseSceneLength, targetLengthOf, updateScriptStats } from "./01-scene-status.js";
import { onRundownPaint, rundownLayout } from "./05f-rundown.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { reviewMode } from "./13-hosted.js";
import { queueAutoSave } from "./14-export.js";

/* ================= a target length per script (#170) =================

   A script can be aimed at a length — "this is a two-minute piece" — and
   then everything that shows its length shows it against that:

   - the program clock reads "01:35 / 02:00" and "0:25 left" (dim) or
     "0:05 over" (tally red) — updateScriptStats(), 01-scene-status.js,
     which also has the pure halves (normalizeTargetLength,
     targetLengthOf, targetClock);
   - the rundown strip spans the target as well as the script
     (setRundownExtraSeconds, 05f-rundown.js) and, on its overlay, this
     file draws a dashed line at the target labelled "Target 2:00", and
     hatches the gap to it (labelled with the time left) — or, once the
     script runs over, the part of the blocks past it;
   - it is set in the clock's popover, under the reading speed (03-sync.js
     promptForWpm / promptForTarget), and from the command menu's "Set
     target length…".

   It is the document key `targetSeconds` (whole seconds, absent for none),
   set only through setTargetLength() below, which is one markDirty() — so
   it is one undo step, saved, synced and merged like the title with no
   code of its own here. A review session sees it and cannot change it.

   The overlay is drawn TO SCALE (rundownLayout(), not rundownX()): while
   the hover lens is on the overlay fades out, since the blocks under it are
   not to scale then, and it has to be right the moment the lens comes to
   rest. Minimized, the thin bar keeps the line as a small tick; the label
   and the hatching need the full strip. */

/* The presets the popover offers: 0:30, 1:00, 2:00, 3:00, 5:00, 10:00. */
export var TARGET_PRESETS = [30, 60, 120, 180, 300, 600];

function tenth(v) { return Math.round(v * 10) / 10; }

/* Where the target goes on a strip at `pxPerSecond`, for a script `total`
   seconds long: the line's x, its label, and the hatched stretch between
   the end of the script and the target — {left, width, over, delta} — or
   null when the two meet. Pure; px to one decimal, as the blocks are. */
export function targetOverlayParts(total, target, pxPerSecond) {
  if (!(target > 0) || !(pxPerSecond > 0)) return null;
  var T = Math.max(0, Number(total) || 0);
  var lineX = tenth(target * pxPerSecond);
  var endX = tenth(T * pxPerSecond);
  var diff = Math.round(target) - Math.round(T);
  var over = T > target;
  var width = tenth(Math.abs(endX - lineX));
  return {
    lineX: lineX,
    label: "Target " + formatDuration(target),
    hatch: width >= 0.5 ? {
      left: Math.min(lineX, endX),
      width: width,
      over: over,
      delta: formatDuration(Math.abs(diff)) + (over ? " over" : " left")
    } : null
  };
}

/* The overlay's markup for those parts. Digits, colons and fixed words —
   nothing needs escaping. */
function overlayHtml(p) {
  var html = "";
  if (p.hatch) {
    html += '<span class="rd-target-hatch ' + (p.hatch.over ? 'is-over' : 'is-left') +
      '" style="left:' + p.hatch.left + 'px;width:' + p.hatch.width + 'px">' +
      '<span class="rd-target-delta">' + p.hatch.delta + '</span></span>';
  }
  html += '<span class="rd-target-line" style="left:' + p.lineX + 'px"></span>';
  html += '<span class="rd-target-label" style="left:' + p.lineX + 'px">' + p.label + '</span>';
  return html;
}

var lastOverlayHtml = "";
var LABEL_GAP_PX = 4;

/* Draw (or clear) the target on #rundown-overlay for the strip's last
   paint. Called after every paint from updateScriptStats(), and by the
   strip itself when its scale moves (a panel opening, the window
   resizing). Rewritten only when the markup changes. */
export function paintTargetOverlay() {
  var layer = document.getElementById("rundown-overlay");
  if (!layer) return;
  var target = targetLengthOf(S.state);
  var L = rundownLayout();
  var parts = target ? targetOverlayParts(L.totalSeconds, target, L.pxPerSecond) : null;
  var html = parts ? overlayHtml(parts) : "";
  if (html === lastOverlayHtml) return;
  layer.innerHTML = html;
  lastOverlayHtml = html;
  if (!parts) return;
  /* "Target 2:00" sits just left of its line, under the hatching — or
     right of it when the line is too near the strip's start for that */
  var label = layer.querySelector(".rd-target-label");
  if (label) label.classList.toggle("is-right", parts.lineX < (label.offsetWidth || 0) + LABEL_GAP_PX);
}

/* Set (seconds) or clear (null, or 0) the script's target, as one edit.
   Returns whether anything changed. Refused in a review session. */
export function setTargetLength(seconds) {
  if (!S.state || reviewMode()) return false;
  var before = targetLengthOf(S.state);
  var after = seconds == null ? null : targetLengthOf({ targetSeconds: seconds });
  if (before === after) return false;
  if (after === null) delete S.state.targetSeconds; else S.state.targetSeconds = after;
  markDirty();
  updateScriptStats();   /* the clock and the strip */
  queueAutoSave();
  return true;
}

/* ---- the popover's section (03-sync.js puts it under the reading speed) ---- */

export function targetSectionHtml() {
  var current = targetLengthOf(S.state);
  var viewing = reviewMode();
  var off = viewing ? " disabled" : "";
  return '<div class="target-section" role="group" aria-labelledby="target-heading">' +
    '<label class="anchor-popover-label" id="target-heading" for="target-input">Target length</label>' +
    '<div class="anchor-popover-row">' +
      '<input type="text" id="target-input" autocomplete="off" spellcheck="false" inputmode="text"' +
        ' placeholder="No target" value="' + (current ? formatDuration(current) : "") + '"' +
        ' title="A length like 2:00, 90, 90s or 1m30"' + off + '>' +
      '<button type="button" id="target-save" class="btn-outline"' + off + '>Set</button>' +
    '</div>' +
    '<div class="target-presets">' +
      TARGET_PRESETS.map(function (s) {
        return '<button type="button" class="target-preset" data-target-seconds="' + s + '" aria-pressed="' +
          (current === s ? "true" : "false") + '"' + off + '>' + formatDuration(s) + '</button>';
      }).join("") +
    '</div>' +
    '<button type="button" id="target-clear" class="target-clear" aria-pressed="' + (current ? "false" : "true") + '"' + off + '>No target</button>' +
    (viewing ? '<p class="target-note">Viewing only — the writer sets the target.</p>' : '') +
  '</div>';
}

/* Wire the section inside popover `wrap`; `close()` shuts the popover.
   Enter or Set takes what is typed (parseSceneLength's forms, #179: 1:30,
   90, 90s, 1m30); empty is no target; a preset or "No target" is set at
   once. Each closes the popover. */
export function wireTargetSection(wrap, close) {
  var input = wrap.querySelector("#target-input");
  if (!input || reviewMode()) return;
  function commit() {
    var text = input.value.trim();
    var secs = parseSceneLength(text);
    if (typeof secs === "number" && isNaN(secs)) {
      input.setAttribute("aria-invalid", "true");
      showToast("That isn’t a length — try 2:00, 90 or 1m30s. Leave it empty for no target.", "error");
      input.select();
      return;
    }
    setTargetLength(secs || null);
    close();
  }
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); return; }
    if (e.key !== "Escape") input.removeAttribute("aria-invalid");
  });
  wrap.querySelector("#target-save").addEventListener("click", commit);
  wrap.querySelector("#target-clear").addEventListener("click", function () {
    setTargetLength(null);
    close();
  });
  Array.prototype.forEach.call(wrap.querySelectorAll(".target-preset"), function (btn) {
    btn.addEventListener("click", function () {
      setTargetLength(Number(btn.getAttribute("data-target-seconds")));
      close();
    });
  });
}

export function __init() {
  onRundownPaint(function () { paintTargetOverlay(); });
  window.__targetTest = { parts: targetOverlayParts, set: setTargetLength, layout: rundownLayout };
}
