import { hasSetLength, parseSceneLength } from "../../core/document/timing.ts";
import { estimatedSeconds, formatDuration, rowSeconds } from "../../core/production/timing.ts";
import { cssAttr } from "../common/dom.ts";
import { sceneAt, sceneLengthCommand } from "../../application/commands/scene-length.ts";
import { REVIEW_REFUSAL_REASON } from "../../application/collaboration/authority.ts";

var REVIEW_REFUSAL = "This is a review copy — comment on a scene instead of changing its length.";

var ports = null;
var editing = null;

export function readTimeEditing() { return editing ? editing.rowId : null; }

function applySceneLength(rowId, seconds) {
  var outcome = ports.edits.run(sceneLengthCommand(rowId, seconds, ports.edits.stamps));
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected" && outcome.reason === REVIEW_REFUSAL_REASON) ports.notices.show(REVIEW_REFUSAL, "warn");
  return outcome.kind === "applied" || outcome.kind === "committed";
}

export function setSceneLength(rowId, seconds) {
  if (!ports) return false;
  return applySceneLength(rowId, seconds);
}

export function openReadTimeEditor(btn) {
  if (!btn || !ports) return;
  if (ports.review.reviewing()) { ports.notices.show(REVIEW_REFUSAL, "warn"); return; }
  var rowId = btn.getAttribute("data-id");
  var scene = ports.document.read(sceneAt(rowId));
  if (!scene) return;
  closeReadTimeEditor(false);
  var row = scene.row;
  var idx = scene.index;
  var wasSet = hasSetLength(row);
  var doc = ports.document.current();
  var secs = rowSeconds(row, doc, ports.text.productionReaders);
  var estimate = formatDuration(estimatedSeconds(row, doc, ports.text.productionReaders));
  var prefill = wasSet || secs >= 0.5 ? formatDuration(secs) : "";
  var input = document.createElement("input");
  input.type = "text";
  input.className = "row-read-input";
  input.value = prefill;
  input.setAttribute("inputmode", "text");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("aria-label", "Scene " + (idx + 1) + " length");
  input.placeholder = estimate;
  input.title = "A length like 1:30, 90 or 1m30s. Leave it empty to use the estimate (" + estimate + ").";
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
          ports.notices.show("That isn’t a length — try 1:30, 90 or 1m30s. Leave it empty to use the estimate.", "error");
          ed.input.select();
          return false;
        }
        ports.notices.show("Scene length unchanged — “" + text + "” isn’t a length.", "error");
      } else {
        editing = null;
        teardown(ed);
        ports.paint.afterThisPaint(
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

export function __init(given) {
  ports = given;
  var offs = [];
  var disposed = false;
  var owner = { dispose: function () {
    if (disposed) return;
    disposed = true;
    closeReadTimeEditor(false, true);
    while (offs.length) offs.pop()();
    ports = null;
  } };
  var rowsEl = document.getElementById("rows");
  if (!rowsEl) return owner;
  function listen(type, fn) {
    rowsEl.addEventListener(type, fn);
    offs.push(function () { rowsEl.removeEventListener(type, fn); });
  }
  listen("mousedown", function (e) {
    var btn = e.target.closest && e.target.closest(".row-read");
    if (btn && btn.getAttribute("aria-disabled") !== "true") e.preventDefault();
  });
  listen("click", function (e) {
    var btn = e.target.closest && e.target.closest(".row-read");
    if (!btn) return;
    e.preventDefault();
    openReadTimeEditor(btn);
  });
  listen("keydown", function (e) {
    if (!(e.target.classList && e.target.classList.contains("row-read"))) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || ports.review.reviewing()) return;
    var k = String(e.key).toLowerCase();
    if (k !== "z" && k !== "y") return;
    e.preventDefault();
    if (k === "y" || e.shiftKey) ports.undo.redo(); else ports.undo.undo();
  });
  return owner;
}
