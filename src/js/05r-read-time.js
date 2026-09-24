import { S } from "./_state.js";
import {
  estimatedSeconds,
  formatDuration,
  hasSetLength,
  parseSceneLength,
  rowSeconds,
  updateScriptStats
} from "./01-scene-status.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { cssAttr } from "./04-richtext.js";
import { render, renderRow } from "./05-render.js";
import { scheduleProductionRefresh } from "./07-production-tags.js";
import { scheduleBrollRefresh } from "./08c-broll.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { redo, undo } from "./12a-undo.js";
import { reviewMode } from "./13-hosted.js";
import { queueAutoSave } from "./14-export.js";

/* ================= a scene's length, set by hand (#179) =================

   The rail's Read time (.row-read, painted by paintRowTimes in
   05-render.js) is a button. A click opens a small text box in its place,
   holding the time shown; Enter or leaving the box sets it, Esc puts it
   back. What you can type is parseSceneLength's (01-scene-status.js):
   "1:30", "90", "90s", "1m30", "1m 30s". An empty box goes back to the
   estimate. A length set this way replaces the estimate outright, is the
   row key `lengthSeconds`, and goes through markDirty() like any edit —
   so it is undone, saved, synced and merged with no code of its own here.

   A review session reads it and cannot change it: the button is
   aria-disabled there and a click does nothing. */

var editing = null;   /* {rowId, btn, input, prefill, wasSet} */

export function readTimeEditing() { return editing ? editing.rowId : null; }

/* Set (a number of seconds) or clear (null) one scene's length, as one
   edit. Returns whether anything changed. */
export function setSceneLength(rowId, seconds) {
  if (!S.state || reviewMode()) return false;
  var idx = findRowIndex(rowId);
  if (idx === -1) return false;
  var row = S.state.rows[idx];
  var before = hasSetLength(row) ? row.lengthSeconds : null;
  var after = seconds == null ? null : seconds;
  if (before === after) return false;
  if (after === null) delete row.lengthSeconds; else row.lengthSeconds = after;
  stampRow(row);
  markDirty();
  /* the gutter's "last edited by" moved; the times are paintRowTimes' */
  if (!renderRow(row.id)) render();
  updateScriptStats();          /* the clock, every later start, the rundown */
  scheduleProductionRefresh();  /* the Shoot view's times */
  scheduleBrollRefresh();       /* the shot list's scene starts */
  queueAutoSave();
  return true;
}

export function openReadTimeEditor(btn) {
  if (!btn || !S.state || reviewMode()) return;
  var rowId = btn.getAttribute("data-id");
  var idx = findRowIndex(rowId);
  if (idx === -1) return;
  closeReadTimeEditor(false);
  var row = S.state.rows[idx];
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

/* Close the box; `commit` reads it first. Returns false when what was
   typed is not a length and the box stays open (Enter), true otherwise. */
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
        /* left by a click elsewhere: nothing is set, and it says why */
        showToast("Scene length unchanged — “" + text + "” isn’t a length.", "error");
      } else {
        editing = null;
        teardown(ed);
        setSceneLength(ed.rowId, secs);
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

/* Back to the time itself after Enter or Esc, so the keyboard carries on
   from where it was; after a click elsewhere, the focus is already there. */
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
    /* the script's own shortcuts (Ctrl+B, the tag keys…) are not for this box */
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
  /* Keep the caret's cell focused through the press, so the row stays the
     current one (on a phone the rail only shows on the scene you are in)
     until the box takes the focus itself. */
  rowsEl.addEventListener("mousedown", function (e) {
    var btn = e.target.closest && e.target.closest(".row-read");
    if (btn && btn.getAttribute("aria-disabled") !== "true") e.preventDefault();
  });
  rowsEl.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".row-read");
    if (!btn || btn.getAttribute("aria-disabled") === "true") return;
    e.preventDefault();
    openReadTimeEditor(btn);
  });
  /* Enter and Esc hand the focus back to the time, and the window's
     Ctrl+Z (21-events.js) leaves everything inside #rows to the cells — so
     the time answers the document's undo and redo itself, or setting a
     length and pressing Ctrl+Z straight after would do nothing. */
  rowsEl.addEventListener("keydown", function (e) {
    if (!(e.target.classList && e.target.classList.contains("row-read"))) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || reviewMode()) return;
    var k = String(e.key).toLowerCase();
    if (k !== "z" && k !== "y") return;
    e.preventDefault();
    if (k === "y" || e.shiftKey) redo(); else undo();
  });
}
