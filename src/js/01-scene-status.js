import { S } from "./_state.js";
import { armShotHideGrace, clearShotHideGrace, hideShotScenes } from "./01b-hide-shot.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { pad2, paintRowTimes, render, renderRow } from "./05-render.js";
import { renderRundown } from "./05f-rundown.js";
import { cellOf, spokenText } from "./04c-doc-model.js";
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

/* A scene's length (#179). By default it is estimated from its Audio words
   at the document's reading speed; a length set by hand (the rail's Read
   time, 05r-read-time.js) replaces the estimate outright — Adam's call: an
   override, not a minimum. It is the row key `lengthSeconds`, a whole
   number of seconds, absent when the scene uses the estimate (every file
   from before #179 reads that way). Everything that uses a scene's length
   reads rowSeconds(): the gutter's start times, the program clock, the
   rundown strip, the panels, the CSV and Present's clock. Present's scroll
   speed does not — that is words and reading speed, as before. */
export var SCENE_LENGTH_MAX = 24 * 3600;

export function estimatedSeconds(row) {
  var wpm = (S.state && S.state.wordsPerMinute) || DEFAULT_WPM;
  return wordCount(row.audioText) / wpm * 60;
}

export function hasSetLength(row) {
  return !!row && typeof row.lengthSeconds === "number" && isFinite(row.lengthSeconds) &&
    row.lengthSeconds >= 0 && row.lengthSeconds <= SCENE_LENGTH_MAX;
}

export function rowSeconds(row) {
  return hasSetLength(row) ? row.lengthSeconds : estimatedSeconds(row);
}

/* What a stored `lengthSeconds` is allowed to be (migrateRows, 02-state.js):
   a whole number of seconds from 0 to a day, or nothing. */
export function normalizeSceneLength(v) {
  if (typeof v !== "number" || !isFinite(v) || v < 0 || v > SCENE_LENGTH_MAX) return undefined;
  return Math.round(v);
}

/* What you can type as a scene's length (#179, typing convention signed
   off by Adam): "1:30" and "1:02:03", a bare number of seconds ("90"), or
   numbers with units — "90s", "1m30", "1m 30s", "2 min", "1.5m", "1h 5m".
   A bare number after minutes is seconds ("1m30"), after hours minutes
   ("1h30"). Units must run hours, minutes, seconds, each once. Blank is
   null (use the estimate); anything else unreadable is NaN. The result is
   whole seconds. */
var LENGTH_UNITS = { h: 3600, m: 60, s: 1 };

function lengthUnit(word) {
  if (!word) return "";
  if (/^(h|hr|hrs|hour|hours)$/.test(word)) return "h";
  if (/^(m|min|mins|minute|minutes)$/.test(word)) return "m";
  if (/^(s|sec|secs|second|seconds)$/.test(word)) return "s";
  return null;
}

export function parseSceneLength(text) {
  var s = String(text == null ? "" : text).trim().toLowerCase();
  if (!s) return null;
  var total;
  var clock = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
  if (clock) {
    total = clock[3] != null
      ? (+clock[1]) * 3600 + (+clock[2]) * 60 + (+clock[3])
      : (+clock[1]) * 60 + (+clock[2]);
  } else {
    var re = /(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*/g;
    var pos = 0, m, last = "", order = ["h", "m", "s"], parts = 0;
    total = 0;
    while (pos < s.length) {
      re.lastIndex = pos;
      m = re.exec(s);
      if (!m || m.index !== pos) return NaN;
      pos = re.lastIndex;
      var unit = lengthUnit(m[2]);
      if (unit === null) return NaN;
      if (!unit) {
        /* a bare number: seconds alone or after minutes, minutes after hours */
        if (!parts) unit = "s";
        else if (last === "m") unit = "s";
        else if (last === "h") unit = "m";
        else return NaN;
        if (pos < s.length) return NaN;   /* only ever the last thing typed */
      }
      if (last && order.indexOf(unit) <= order.indexOf(last)) return NaN;
      total += parseFloat(m[1]) * LENGTH_UNITS[unit];
      last = unit;
      parts++;
    }
    if (!parts) return NaN;
  }
  total = Math.round(total);
  if (!isFinite(total) || total < 0 || total > SCENE_LENGTH_MAX) return NaN;
  return total;
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
     #85), not a parse of the markup here — and only the words that are
     said: a stage direction ("(beat)", #167) takes no reading time. */
  wordCount = contentMemo(function (html) {
    var text = spokenText(cellOf(html));
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
  });
}
