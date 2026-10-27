import { targetLengthOf } from "../../core/document/timing.ts";
import { formatDuration } from "../../core/production/timing.ts";
import { onRundownPaint, rundownLayout } from "./rundown.js";
import { targetLengthCommand } from "../../application/commands/document-settings.ts";

var ports = null;


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

export function paintTargetOverlay() {
  var layer = document.getElementById("rundown-overlay");
  if (!layer || !ports) return;
  var target = targetLengthOf(ports.document.current());
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
  if (!ports.document.current() || ports.review.reviewing()) return false;
  return !!ports.edits.edit(targetLengthCommand(seconds));
}

export function startTarget(given) {
  ports = given;
  lastOverlayHtml = "";
  var disposed = false;
  var off = onRundownPaint(function () { paintTargetOverlay(); });
  window.__targetTest = { parts: targetOverlayParts, set: setTargetLength, layout: rundownLayout };
  return {
    dispose: function () {
      if (disposed) return;
      disposed = true;
      off();
      ports = null;
    }
  };
}
