import { parseSceneLength, targetLengthOf } from "../../core/document/timing.ts";
import { formatDuration } from "../../core/production/timing.ts";
import { targetLengthCommand } from "../../application/commands/document-settings.ts";

export var TARGET_PRESETS = [30, 60, 120, 180, 300, 600];

function setTargetLength(ports, seconds) {
  if (!ports.document.current() || ports.review.reviewing()) return false;
  return !!ports.edits.edit(targetLengthCommand(seconds));
}

export function targetSectionHtml(ports) {
  var current = targetLengthOf(ports.document.current());
  var viewing = ports.review.reviewing();
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

export function wireTargetSection(ports, wrap, close) {
  var input = wrap.querySelector("#target-input");
  if (!input || ports.review.reviewing()) return;
  function commit() {
    var text = input.value.trim();
    var secs = parseSceneLength(text);
    if (typeof secs === "number" && isNaN(secs)) {
      input.setAttribute("aria-invalid", "true");
      ports.notices.show("That isn’t a length — try 2:00, 90 or 1m30s. Leave it empty for no target.", "error");
      input.select();
      return;
    }
    setTargetLength(ports, secs || null);
    close();
  }
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); return; }
    if (e.key !== "Escape") input.removeAttribute("aria-invalid");
  });
  wrap.querySelector("#target-save").addEventListener("click", commit);
  wrap.querySelector("#target-clear").addEventListener("click", function () {
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


export function startTargetSection(ports) {
  var disposed = false;
  return {
    section: {
      html: function () { return disposed ? "" : targetSectionHtml(ports); },
      wire: function (wrap, close) { if (!disposed) wireTargetSection(ports, wrap, close); }
    },
    dispose: function () { disposed = true; }
  };
}
