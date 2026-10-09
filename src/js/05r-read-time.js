import {
  estimatedSeconds,
  formatDuration,
  hasSetLength,
  parseSceneLength,
  rowSeconds,
  updateScriptStats
} from "./01-scene-status.js";
import { cssAttr } from "./04-richtext.js";
import { afterThisPaint, render, renderRow } from "./05-render.js";
import { showToast } from "./12-dirty-toast.js";
import { redo, undo } from "./12a-undo.js";
import { reviewMode } from "./13-hosted.js";
import { sceneAt, sceneLengthCommand } from "../application/commands/scene-length.ts";
import { REVIEW_ONLY, readSession, runCommand, sessionStamps } from "../legacy/session-bridge.ts";

var REVIEW_REFUSAL = "This is a review copy — comment on a scene instead of changing its length.";

var editing = null;

export function readTimeEditing() { return editing ? editing.rowId : null; }

function applySceneLength(rowId, seconds) {
  var outcome = runCommand(sceneLengthCommand(rowId, seconds, sessionStamps));
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected" && outcome.reason === REVIEW_ONLY) showToast(REVIEW_REFUSAL, "warn");
  return outcome.kind === "applied";
}

export function setSceneLength(rowId, seconds) {
  if (!applySceneLength(rowId, seconds)) return false;
  if (!renderRow(rowId)) render();
  updateScriptStats();
  return true;
}

export function openReadTimeEditor(btn) {
  if (!btn) return;
  if (reviewMode()) { showToast(REVIEW_REFUSAL, "warn"); return; }
  var rowId = btn.getAttribute("data-id");
  var scene = readSession(sceneAt(rowId));
  if (!scene) return;
  closeReadTimeEditor(false);
  var row = scene.row;
  var idx = scene.index;
  var wasSet = hasSetLength(row);
  var prefill = wasSet || rowSeconds(row) >= 0.5 ? formatDuration(rowSeconds(row)) : "";
  var input = document.createElement("input");
  input.type = "text";
  input.className = "row-read-input";
  input.value = prefill;
  input.setAttribute("inputmode", "text");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("aria-label", "Scene " + (idx + 1) + " length");
  input.placeholder = formatDuration(estimatedSeconds(row));
  input.title = "A length like 1:30, 90 or 1m30s. Leave it empty to use the estimate (" +
    formatDuration(estimatedSeconds(row)) + ").";
  btn.hidden = true;
  btn.parentNode.insertBefore(input, btn.nextSibling);
  var rowEl = btn.closest(".row");
  if (rowEl) rowEl.classList.add("is-setting-length");
  editing = { rowId: rowId, btn: btn, input: input, prefill: prefill, wasSet: wasSet };
  input.addEventListener("keydown", onEditorKeydown);
  input.addEventListener("blur", onEditorBlur);
  input.focus();
  input.select();
}

export function closeReadTimeEditor(commit, fromBlur) {
  if (!editing) return true;
  var ed = editing;
  if (commit) {
    var text = ed.input.value.trim();
    var unchanged = text === ed.prefill;
    if (!unchanged) {
      var secs = parseSceneLength(text);
      if (typeof secs === "number" && isNaN(secs)) {
        if (!fromBlur) {
          ed.input.setAttribute("aria-invalid", "true");
          showToast("That isn’t a length — try 1:30, 90 or 1m30s. Leave it empty to use the estimate.", "error");
          ed.input.select();
          return false;
        }
        showToast("Scene length unchanged — “" + text + "” isn’t a length.", "error");
      } else {
        editing = null;
        teardown(ed);
        afterThisPaint(
          function () { setSceneLength(ed.rowId, secs); },
          function () { applySceneLength(ed.rowId, secs); }
        );
        refocus(ed, !fromBlur);
        return true;
      }
    }
  }
  editing = null;
  teardown(ed);
  refocus(ed, !fromBlur);
  return true;
}

function teardown(ed) {
  ed.input.removeEventListener("keydown", onEditorKeydown);
  ed.input.removeEventListener("blur", onEditorBlur);
  if (ed.input.parentNode) ed.input.parentNode.removeChild(ed.input);
  ed.btn.hidden = false;
  var rowEl = ed.btn.closest(".row");
  if (rowEl) rowEl.classList.remove("is-setting-length");
}

function refocus(ed, wanted) {
  if (!wanted) return;
  var btn = ed.btn.isConnected ? ed.btn
    : document.querySelector('#rows .row-read[data-id="' + cssAttr(ed.rowId) + '"]');
  if (btn) btn.focus({ preventScroll: true });
}

function onEditorKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    closeReadTimeEditor(true, false);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeReadTimeEditor(false, false);
  } else {
    e.stopPropagation();
    if (editing) editing.input.removeAttribute("aria-invalid");
  }
}

function onEditorBlur() {
  closeReadTimeEditor(true, true);
}

export function __init() {
  var rowsEl = document.getElementById("rows");
  if (!rowsEl) return;
  rowsEl.addEventListener("mousedown", function (e) {
    var btn = e.target.closest && e.target.closest(".row-read");
    if (btn && btn.getAttribute("aria-disabled") !== "true") e.preventDefault();
  });
  rowsEl.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".row-read");
    if (!btn) return;
    e.preventDefault();
    openReadTimeEditor(btn);
  });
  rowsEl.addEventListener("keydown", function (e) {
    if (!(e.target.classList && e.target.classList.contains("row-read"))) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || reviewMode()) return;
    var k = String(e.key).toLowerCase();
    if (k !== "z" && k !== "y") return;
    e.preventDefault();
    if (k === "y" || e.shiftKey) redo(); else undo();
  });
}
