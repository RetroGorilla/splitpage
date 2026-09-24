import { S } from "./_state.js";
import { armShotHideGrace, clearShotHideGrace, hideShotScenes } from "./01b-hide-shot.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { pad2, paintRowTimes, render, renderRow } from "./05-render.js";
import { renderRundown } from "./05f-rundown.js";
import { cellOf, toPlainText } from "./04c-doc-model.js";
import { contentMemo, scheduleProductionRefresh } from "./07-production-tags.js";
import { markDirty } from "./12-dirty-toast.js";
import { queueAutoSave } from "./14-export.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
export var wordCount;

/* ================= scene status and runtime ================= */

/* Three states, not five: a scene is either still being written, ready to
   point a camera at, or in the can. Anything finer belongs in a comment.

   Drawn as lamps (#169): To do is an unlit outline, Ready the program
   amber, Shot lit in the text colour with a small dark check. `cls` keeps
   the names the status dot always had (is-open, is-half), which the lamp
   rules in app.css and the suites read. */
export var ROW_STATUSES = [
  { id: "todo",  label: "To do", cls: "is-open", color: "var(--text-faint)" },
  { id: "ready", label: "Ready", cls: "is-half", color: "var(--audio)" },
  { id: "shot",  label: "Shot",  cls: "",        color: "var(--text)" }
];

export function rowStatus(id) {
  for (var i = 0; i < ROW_STATUSES.length; i++) {
    if (ROW_STATUSES[i].id === id) return ROW_STATUSES[i];
  }
  return null;
}

function nextRowStatus(id) {
  for (var i = 0; i < ROW_STATUSES.length; i++) {
    if (ROW_STATUSES[i].id === id) return ROW_STATUSES[(i + 1) % ROW_STATUSES.length].id;
  }
  return ROW_STATUSES[0].id;
}

export var DEFAULT_WPM = 150;

export function rowSeconds(row) {
  var wpm = (S.state && S.state.wordsPerMinute) || DEFAULT_WPM;
  return wordCount(row.audioText) / wpm * 60;
}

export function totalSeconds() {
  return S.state.rows.reduce(function (n, r) { return n + rowSeconds(r); }, 0);
}

export function formatDuration(sec) {
  var whole = Math.max(0, Math.round(sec));
  var h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h ? (h + ":" + pad2(m) + ":" + pad2(s)) : (m + ":" + pad2(s));
}

/* A point in the programme rather than a length (#169): the program clock
   and each scene's start, "01:35" and "00:31" — minutes always two digits,
   the way a timecode reads. A length (a scene's read time) stays
   formatDuration's "0:19". */
export function formatTimecode(sec) {
  var whole = Math.max(0, Math.round(sec));
  var h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return (h ? h + ":" : "") + pad2(m) + ":" + pad2(s);
}

export function updateScriptStats() {
  if (!S.state) return;
  var totalEl = document.getElementById("runtime-total");
  if (totalEl) {
    /* With shot scenes hidden, the number that matters is what's left to
       record — but the total is still worth keeping in view, so both show:
       what is left as the clock, the whole after it, quieter. */
    if (hideShotScenes) {
      var remaining = S.state.rows.reduce(function (n, r) {
        return n + (r.status === "shot" ? 0 : rowSeconds(r));
      }, 0);
      /* digits and colons only — nothing here needs escaping */
      var clockHtml = formatTimecode(remaining) +
        '<span class="program-clock-of"> / ' + formatTimecode(totalSeconds()) + '</span>';
      if (totalEl.innerHTML !== clockHtml) totalEl.innerHTML = clockHtml;
    } else {
      var clock = formatTimecode(totalSeconds());
      if (totalEl.textContent !== clock) totalEl.textContent = clock;
    }
  }
  /* Everything else that moves with the read times moves here too: each
     scene's start and length in its gutter and rail (paintRowTimes,
     05-render.js) and the rundown strip (05f-rundown.js). This runs from
     render() and from the idle refresh while typing, so none of them waits
     for the next full render. */
  paintRowTimes();
  renderRundown();

  var chip = document.getElementById("progress-chip");
  var text = document.getElementById("progress-text");
  if (!chip || !text) return;
  var shot = S.state.rows.filter(function (r) { return r.status === "shot"; }).length;
  /* the chip only earns its space once there is progress to report */
  if (!shot) { chip.hidden = true; return; }
  chip.hidden = false;
  text.textContent = shot + "/" + S.state.rows.length + " shot";
}

export function cycleRowStatus(rowId) {
  var idx = findRowIndex(rowId);
  if (idx === -1) return;
  var row = S.state.rows[idx];
  var wasShot = row.status === "shot";
  row.status = nextRowStatus(row.status);
  stampRow(row);
  markDirty();
  /* A scene turning Shot while the toggle is on stays visible for a beat
     (armShotHideGrace, 01b-hide-shot.js) rather than collapsing out from
     under the click that just changed it. Leaving Shot cancels any such
     grace still pending — nothing left to delay. */
  if (hideShotScenes) {
    if (!wasShot && row.status === "shot") armShotHideGrace(row.id);
    else if (wasShot && row.status !== "shot") clearShotHideGrace(row.id);
  }
  /* Repaint just this row rather than every row in the document to move
     one dot — that cost a whole frame (13 ms at 120 scenes) per click, and
     clicking down a shoot list is exactly when you do it repeatedly.
     renderRow() (05-render.js) replaces only the parts whose markup
     changed — the gutter and the row's class here — so no editable is
     touched and a caret mid-sentence survives. A full render only if the
     row isn't on screen to repaint (folded into a shot strip). */
  if (!renderRow(row.id)) render();
  updateScriptStats();          /* the shot counter in the header */
  scheduleProductionRefresh();  /* the Shoot view counts shot scenes */
  queueAutoSave();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* Only the Audio column is spoken aloud — visual notes are directions to a
     camera operator, not words anybody reads out — so they are deliberately
     left out of the estimate. */
  /* Same reasoning as tagsInField(): the runtime estimate re-counts every row
     on every refresh, but only the row being typed in has changed. The
     words are the cell's text as the document model reads it (cellOf,
     #85), not a parse of the markup here. */
  wordCount = contentMemo(function (html) {
    var text = toPlainText(cellOf(html));
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
  });
}
