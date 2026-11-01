import type { TargetPorts } from "./ports.ts";
import { targetLengthOf } from "../../core/document/timing.ts";
import { formatDuration } from "../../core/production/timing.ts";
import { onRundownPaint, rundownLayout } from "./rundown.ts";
import { targetLengthCommand } from "../../application/commands/document-settings.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

let ports: TargetPorts | null = null;


function tenth(v: number) { return Math.round(v * 10) / 10; }

export function targetOverlayParts(total: number, target: number | null, scale: number | ((seconds: number) => number)) {
  const at = typeof scale === "function" ? scale : scale > 0 ? function (s: number) { return s * scale; } : null;
  if (!((target as number) > 0) || !at) return null;
  const T = Math.max(0, Number(total) || 0);
  const lineX = tenth(at(target as number));
  const endX = tenth(at(T));
  const diff = Math.round(target as number) - Math.round(T);
  const over = T > (target as number);
  const width = tenth(Math.abs(endX - lineX));
  return {
    lineX: lineX,
    label: "Target " + formatDuration(target as number),
    hatch: width >= 0.5 ? {
      left: Math.min(lineX, endX),
      width: width,
      over: over,
      delta: formatDuration(Math.abs(diff)) + (over ? " over" : " left")
    } : null
  };
}

function overlayHtml(p: NonNullable<ReturnType<typeof targetOverlayParts>>) {
  let html = "";
  if (p.hatch) {
    html += '<span class="rd-target-hatch ' + (p.hatch.over ? 'is-over' : 'is-left') +
      '" style="left:' + p.hatch.left + 'px;width:' + p.hatch.width + 'px">' +
      '<span class="rd-target-delta">' + p.hatch.delta + '</span></span>';
  }
  html += '<span class="rd-target-line" style="left:' + p.lineX + 'px"></span>';
  html += '<span class="rd-target-label" style="left:' + p.lineX + 'px">' + p.label + '</span>';
  return html;
}

let lastOverlayHtml = "";
const LABEL_GAP_PX = 4;

export function paintTargetOverlay() {
  const layer = document.getElementById("rundown-overlay");
  if (!layer || !ports) return;
  const target = targetLengthOf(ports.document.current() as Parameters<typeof targetLengthOf>[0]);
  const L = rundownLayout();
  const parts = target && L.pxPerSecond > 0 ? targetOverlayParts(L.totalSeconds, target, L.x) : null;
  const html = parts ? overlayHtml(parts) : "";
  if (html === lastOverlayHtml) return;
  layer.innerHTML = html;
  lastOverlayHtml = html;
  if (!parts) return;
  const label = layer.querySelector<HTMLElement>(".rd-target-label");
  if (label) label.classList.toggle("is-right", parts.lineX < (label.offsetWidth || 0) + LABEL_GAP_PX);
}

export function setTargetLength(seconds: number | null | undefined) {
  if (!(ports as TargetPorts).document.current()) return false;
  return !!(ports as TargetPorts).edits.edit(targetLengthCommand(seconds));
}

export function startTarget(given: TargetPorts) {
  ports = given;
  lastOverlayHtml = "";
  let disposed = false;
  const off = onRundownPaint(function () { paintTargetOverlay(); });
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__targetTest", function () { return { parts: targetOverlayParts, set: setTargetLength, layout: rundownLayout }; }, function (withdraw) { withdrawHook = withdraw; });
  return {
    dispose: function () {
      if (disposed) return;
      disposed = true;
      off();
      if (withdrawHook) withdrawHook();
      ports = null;
    }
  };
}
