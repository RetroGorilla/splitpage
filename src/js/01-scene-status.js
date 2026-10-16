import { S } from "./_state.js";
import { armShotHideGrace, clearShotHideGrace, hideShotScenes } from "./01b-hide-shot.js";
import { paintRowTimes, render, renderRow } from "./05-render.js";
import { renderRundown, setRundownExtraSeconds } from "./05f-rundown.js";
import { paintTargetOverlay } from "./05t-target.js";
import { productionReaders } from "./07-production-tags.js";
import { showToast } from "./12-dirty-toast.js";
import { sceneStatus, sceneStatusCommand, shotGrace } from "../application/commands/scene-status.ts";
import { ROW_STATUSES, rowStatus } from "../core/production/looks.ts";
import { REVIEW_ONLY, readSession, runCommand, sessionStamps } from "../legacy/session-bridge.ts";
import {
  DEFAULT_WPM,
  SCENE_LENGTH_MAX,
  hasSetLength,
  normalizeSceneLength,
  normalizeTargetLength,
  parseSceneLength,
  targetLengthOf
} from "../core/document/timing.ts";
import {
  estimatedSeconds as estimatedSecondsIn,
  formatDuration,
  formatTimecode,
  rowSeconds as rowSecondsIn,
  targetClock,
  totalSeconds as totalSecondsIn
} from "../core/production/timing.ts";
export {
  DEFAULT_WPM,
  ROW_STATUSES,
  SCENE_LENGTH_MAX,
  formatDuration,
  formatTimecode,
  hasSetLength,
  normalizeSceneLength,
  normalizeTargetLength,
  parseSceneLength,
  rowStatus,
  targetClock,
  targetLengthOf
};

export var wordCount;

export function estimatedSeconds(row) {
  return estimatedSecondsIn(row, S.state, productionReaders);
}

export function rowSeconds(row) {
  return rowSecondsIn(row, S.state, productionReaders);
}

export function totalSeconds() {
  return totalSecondsIn(S.state, productionReaders);
}

var LENGTH_TITLE = "The script's read time, from the Audio column — click to set your reading speed or a target length";

function paintLength(el, totalHtml, slotHtml, title) {
  if (!el) return;
  var totalEl = el.querySelector(".rd-length-total");
  var slotEl = el.querySelector(".rd-length-slot");
  if (totalEl && totalEl.innerHTML !== totalHtml) totalEl.innerHTML = totalHtml;
  if (slotEl && slotEl.innerHTML !== slotHtml) slotEl.innerHTML = slotHtml;
  if (el.title !== title) el.title = title;
}

export function updateScriptStats() {
  if (!S.state) return;
  var target = targetLengthOf(S.state);
  var total = totalSeconds();
  var remaining = hideShotScenes ? S.state.rows.reduce(function (n, r) {
    return n + (r.status === "shot" ? 0 : rowSeconds(r));
  }, 0) : 0;
  var totalText = formatDuration(total);
  var totalHtml = totalText;
  var slotHtml = "";
  var title = LENGTH_TITLE;
  if (target) {
    var tc = targetClock(total, target);
    slotHtml = '<span class="rd-length-of"> / ' + tc.target + '</span>' +
      '<span class="rd-length-delta' + (tc.over ? ' is-over' : '') + '">' +
      tc.delta + (tc.over ? ' over' : ' left') + '</span>';
    title = "Read time " + totalText + " against a " + tc.target + " target, " +
      tc.delta + (tc.over ? " over" : " left") +
      (hideShotScenes ? " (" + formatDuration(remaining) + " still to shoot)" : "") +
      " — click to change the target or your reading speed";
  } else if (hideShotScenes) {
    totalHtml = formatDuration(remaining) + '<span class="rd-length-of"> / ' + totalText + '</span>';
    title = formatDuration(remaining) + " still to shoot of " + totalText +
      " — click to set your reading speed or a target length";
  }
  paintLength(document.getElementById("runtime-chip"), totalHtml, slotHtml, title);
  paintLength(document.getElementById("length-status"), totalHtml, slotHtml, title);
  paintRowTimes();
  setRundownExtraSeconds(target || 0);
  renderRundown();
  paintTargetOverlay();

  var chip = document.getElementById("progress-chip");
  var text = document.getElementById("progress-text");
  if (!chip || !text) return;
  var shot = S.state.rows.filter(function (r) { return r.status === "shot"; }).length;
  if (!shot) { chip.hidden = true; return; }
  chip.hidden = false;
  text.textContent = shot + "/" + S.state.rows.length + " shot";
}

var STATUS_REVIEW_REFUSAL = "This is a review copy — comment on a scene instead of changing its status.";

export function cycleRowStatus(rowId) {
  var before = readSession(sceneStatus(rowId));
  var outcome = runCommand(sceneStatusCommand(rowId, sessionStamps));
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected" && outcome.reason === REVIEW_ONLY) showToast(STATUS_REVIEW_REFUSAL, "warn");
  if (outcome.kind !== "applied" && outcome.kind !== "committed") return;
  if (hideShotScenes) {
    var grace = shotGrace(before, readSession(sceneStatus(rowId)));
    if (grace === "arm") armShotHideGrace(rowId);
    else if (grace === "clear") clearShotHideGrace(rowId);
  }
  if (!renderRow(rowId)) render();
  updateScriptStats();
}

export function __init() {
  wordCount = productionReaders.wordCount;
}
