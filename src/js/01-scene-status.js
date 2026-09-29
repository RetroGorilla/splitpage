import { S } from "./_state.js";
import { armShotHideGrace, clearShotHideGrace, hideShotScenes } from "./01b-hide-shot.js";
import { findRowIndex, stampRow } from "./03-sync.js";
import { pad2, paintRowTimes, render, renderRow } from "./05-render.js";
import { renderRundown, setRundownExtraSeconds } from "./05f-rundown.js";
import { paintTargetOverlay } from "./05t-target.js";
import { cellOf, spokenText } from "./04c-doc-model.js";
import { contentMemo, scheduleProductionRefresh } from "./07-production-tags.js";
import { markDirty } from "./12-dirty-toast.js";
import { queueAutoSave } from "./14-export.js";

export var wordCount;

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

export function normalizeSceneLength(v) {
  if (typeof v !== "number" || !isFinite(v) || v < 0 || v > SCENE_LENGTH_MAX) return undefined;
  return Math.round(v);
}

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
        if (!parts) unit = "s";
        else if (last === "m") unit = "s";
        else if (last === "h") unit = "m";
        else return NaN;
        if (pos < s.length) return NaN;
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

export function normalizeTargetLength(v) {
  if (typeof v !== "number" || !isFinite(v)) return undefined;
  var whole = Math.round(v);
  return whole >= 1 && whole <= SCENE_LENGTH_MAX ? whole : undefined;
}

export function targetLengthOf(s) {
  var v = s ? normalizeTargetLength(s.targetSeconds) : undefined;
  return v === undefined ? null : v;
}

export function targetClock(total, target) {
  var diff = Math.round(target) - Math.max(0, Math.round(total));
  return {
    target: formatDuration(target),
    delta: formatDuration(Math.abs(diff)),
    over: diff < 0
  };
}

export function formatDuration(sec) {
  var whole = Math.max(0, Math.round(sec));
  var h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h ? (h + ":" + pad2(m) + ":" + pad2(s)) : (m + ":" + pad2(s));
}

export function formatTimecode(sec) {
  var whole = Math.max(0, Math.round(sec));
  var h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return (h ? h + ":" : "") + pad2(m) + ":" + pad2(s);
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

export function cycleRowStatus(rowId) {
  var idx = findRowIndex(rowId);
  if (idx === -1) return;
  var row = S.state.rows[idx];
  var wasShot = row.status === "shot";
  row.status = nextRowStatus(row.status);
  stampRow(row);
  markDirty();
  if (hideShotScenes) {
    if (!wasShot && row.status === "shot") armShotHideGrace(row.id);
    else if (wasShot && row.status !== "shot") clearShotHideGrace(row.id);
  }
  if (!renderRow(row.id)) render();
  updateScriptStats();
  scheduleProductionRefresh();
  queueAutoSave();
}

export function __init() {
  wordCount = contentMemo(function (html) {
    var text = spokenText(cellOf(html));
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
  });
}
