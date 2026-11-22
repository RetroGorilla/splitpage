import { parseBeatLength, targetLengthOf } from "../../core/document/timing.ts";
import { formatDuration } from "../../core/production/timing.ts";
import { targetLengthCommand } from "../../application/commands/document-settings.ts";
import type { DocumentChromePorts } from "./ports.ts";

type TargetSectionPorts = Pick<DocumentChromePorts, "document" | "edits" | "notices">;

export const TARGET_PRESETS = [30, 60, 120, 180, 300, 600];

function setTargetLength(ports: TargetSectionPorts, seconds: number | null) {
  if (!ports.document.current()) return false;
  return !!ports.edits.edit(targetLengthCommand(seconds));
}

export function targetSectionHtml(ports: TargetSectionPorts) {
  const current = targetLengthOf(ports.document.current() as Parameters<typeof targetLengthOf>[0]);
  return '<div class="target-section" role="group" aria-labelledby="target-heading">' +
    '<label class="anchor-popover-label" id="target-heading" for="target-input">Target length</label>' +
    '<div class="anchor-popover-row">' +
      '<input type="text" id="target-input" autocomplete="off" spellcheck="false" inputmode="text"' +
        ' placeholder="No target" value="' + (current ? formatDuration(current) : "") + '"' +
        ' title="A length like 2:00, 90, 90s or 1m30">' +
      '<button type="button" id="target-save" class="btn-outline">Set</button>' +
    '</div>' +
    '<div class="target-presets">' +
      TARGET_PRESETS.map(function (s) {
        return '<button type="button" class="target-preset" data-target-seconds="' + s + '" aria-pressed="' +
          (current === s ? "true" : "false") + '">' + formatDuration(s) + '</button>';
      }).join("") +
    '</div>' +
    '<button type="button" id="target-clear" class="target-clear" aria-pressed="' + (current ? "false" : "true") + '">No target</button>' +
  '</div>';
}

export function wireTargetSection(ports: TargetSectionPorts, wrap: HTMLElement, close: () => void) {
  const input = wrap.querySelector<HTMLInputElement>("#target-input");
  if (!input) return;
  function commit() {
    const text = (input as HTMLInputElement).value.trim();
    const secs = parseBeatLength(text);
    if (typeof secs === "number" && isNaN(secs)) {
      (input as HTMLInputElement).setAttribute("aria-invalid", "true");
      ports.notices.show("That isn’t a length — try 2:00, 90 or 1m30s. Leave it empty for no target.", "error");
      (input as HTMLInputElement).select();
      return;
    }
    setTargetLength(ports, secs || null);
    close();
  }
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); return; }
    if (e.key !== "Escape") input.removeAttribute("aria-invalid");
  });
  (wrap.querySelector("#target-save") as HTMLElement).addEventListener("click", commit);
  (wrap.querySelector("#target-clear") as HTMLElement).addEventListener("click", function () {
    setTargetLength(ports, null);
    close();
  });
  Array.prototype.forEach.call(wrap.querySelectorAll(".target-preset"), function (btn) {
    btn.addEventListener("click", function () {
      setTargetLength(ports, Number(btn.getAttribute("data-target-seconds")));
      close();
    });
  });
}


export function startTargetSection(ports: TargetSectionPorts) {
  let disposed = false;
  return {
    section: {
      html: function () { return disposed ? "" : targetSectionHtml(ports); },
      wire: function (wrap: HTMLElement, close: () => void) { if (!disposed) wireTargetSection(ports, wrap, close); }
    },
    dispose: function () { disposed = true; }
  };
}
