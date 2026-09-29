import { S } from "./_state.js";
import { formatDuration, parseSceneLength, targetLengthOf, updateScriptStats } from "./01-scene-status.js";
import { onRundownPaint, rundownLayout } from "./05f-rundown.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { reviewMode } from "./13-hosted.js";
import { queueAutoSave } from "./14-export.js";

export var TARGET_PRESETS = [30, 60, 120, 180, 300, 600];

function tenth(v) { return Math.round(v * 10) / 10; }

export function targetOverlayParts(total, target, scale) {
  var at = typeof scale === "function" ? scale : scale > 0 ? function (s) { return s * scale; } : null;
  if (!(target > 0) || !at) return null;
  var T = Math.max(0, Number(total) || 0);
  var lineX = tenth(at(target));
  var endX = tenth(at(T));
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

// Rewritten only when markup changed; runs after every strip paint
export function paintTargetOverlay() {
  var layer = document.getElementById("rundown-overlay");
  if (!layer) return;
  var target = targetLengthOf(S.state);
  var L = rundownLayout();
  var parts = target && L.pxPerSecond > 0 ? targetOverlayParts(L.totalSeconds, target, L.x) : null;
  var html = parts ? overlayHtml(parts) : "";
  if (html === lastOverlayHtml) return;
  layer.innerHTML = html;
  lastOverlayHtml = html;
  if (!parts) return;
  var label = layer.querySelector(".rd-target-label");
  if (label) label.classList.toggle("is-right", parts.lineX < (label.offsetWidth || 0) + LABEL_GAP_PX);
}

export function setTargetLength(seconds) {
  if (!S.state || reviewMode()) return false;
  var before = targetLengthOf(S.state);
  var after = seconds == null ? null : targetLengthOf({ targetSeconds: seconds });
  if (before === after) return false;
  if (after === null) delete S.state.targetSeconds; else S.state.targetSeconds = after;
  markDirty();
  updateScriptStats();
  queueAutoSave();
  return true;
}

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
