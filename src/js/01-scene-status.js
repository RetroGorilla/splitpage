import { S } from "./_state.js";
import { armShotHideGrace, clearShotHideGrace, hideShotScenes } from "./01b-hide-shot.js";
import { escapeHtml } from "./02-state.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { cssAttr } from "./04-richtext.js";
import { pad2, render } from "./05-render.js";
import { contentMemo, scheduleProductionRefresh } from "./07-production-tags.js";
import { formatTimestamp } from "./10-comments.js";
import { markDirty } from "./12-dirty-toast.js";
import { htmlToPlainText, queueAutoSave } from "./14-export.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
export var wordCount;

/* ================= scene status and runtime ================= */

/* Three states, not five: a scene is either still being written, ready to
   point a camera at, or in the can. Anything finer belongs in a comment. */
export var ROW_STATUSES = [
  { id: "todo",  label: "To do", cls: "is-open", color: "var(--text-faint)" },
  { id: "ready", label: "Ready", cls: "is-half", color: "var(--visual)" },
  { id: "shot",  label: "Shot",  cls: "",        color: "var(--ok)" }
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

export function updateScriptStats() {
  if (!S.state) return;
  var totalEl = document.getElementById("runtime-total");
  if (totalEl) {
    /* With shot scenes hidden, the number that matters is what's left to
       record — but the total is still worth keeping in view, so both show. */
    if (hideShotScenes) {
      var remaining = S.state.rows.reduce(function (n, r) {
        return n + (r.status === "shot" ? 0 : rowSeconds(r));
      }, 0);
      totalEl.textContent = formatDuration(remaining) + " / " + formatDuration(totalSeconds());
    } else {
      totalEl.textContent = formatDuration(totalSeconds());
    }
  }

  var chip = document.getElementById("progress-chip");
  var text = document.getElementById("progress-text");
  if (!chip || !text) return;
  var shot = S.state.rows.filter(function (r) { return r.status === "shot"; }).length;
  /* the chip only earns its space once there is progress to report */
  if (!shot) { chip.hidden = true; return; }
  chip.hidden = false;
  text.textContent = shot + "/" + S.state.rows.length + " shot";
}

/* Repaint just the parts of one row that a status change touches, rather
   than re-rendering every row in the document to move one dot — that cost
   a whole frame (13 ms at 120 scenes) per click, and clicking down a
   shoot list is exactly when you do it repeatedly.
   Kept deliberately narrow and focus-safe: no editable is replaced, so a
   caret mid-sentence survives. Everything here mirrors the status markup
   in rowHtml() — change one, change the other. */
function paintRowStatus(row) {
  var rowEl = document.querySelector('#rows .row[data-id="' + cssAttr(row.id) + '"]');
  if (!rowEl) return false;
  var st = rowStatus(row.status) || ROW_STATUSES[0];

  rowEl.classList.toggle("is-shot", row.status === "shot");

  var btn = rowEl.querySelector(".status-btn");
  if (btn) {
    btn.title = st.label + " — click to change";
    btn.setAttribute("aria-label", "Scene status: " + st.label);
  }
  var dot = rowEl.querySelector(".status-dot");
  if (dot) {
    dot.className = "status-dot " + st.cls;
    dot.style.setProperty("--st", st.color);
  }

  /* stampRow() just changed who touched it and when */
  var gutter = rowEl.querySelector(".gutter");
  var meta = rowEl.querySelector(".row-meta");
  if (row.updatedBy && gutter) {
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "row-meta";
      gutter.appendChild(meta);
    }
    meta.title = "Last edited by " + row.updatedBy;
    meta.innerHTML = escapeHtml(String(row.updatedBy).split(/\s+/)[0]) +
      "<br>" + escapeHtml(formatTimestamp(row.updatedAt));
  }
  return true;
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
  /* full render only if the row isn't on screen to patch (it always is) */
  if (!paintRowStatus(row)) render();
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
     on every refresh, but only the row being typed in has changed. */
  wordCount = contentMemo(function (html) {
    var text = htmlToPlainText(html);
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
  });
}
