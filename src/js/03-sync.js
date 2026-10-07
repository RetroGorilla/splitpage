import { S } from "./_state.js";
import { PERSON_COLORS, PERSON_COLOR_NAMES, formatClock, readMyColor, writePref, PERSON_COLOR_KEY } from "./00p-prefs.js";
import { STATE_FIELDS, escapeHtml, migrateRows } from "./02-state.js";
import { dataUrlForSync, internDataUrl, isDurableSync } from "./02c-blobs.js";
import { noteRecovery, noteServerUpdate, provideSessionEffects } from "../legacy/session-bridge.ts";
import { isSha256Hex, refsIn } from "../../shared/blob-policy.js";
import { randomIds, systemClock } from "../adapters/identity/ids.ts";
import { DEFAULT_WPM } from "../core/document/timing.ts";
import { mergeStates as mergeStatesWith } from "../core/merge-states.ts";
import { byId } from "../core/merge/rows.ts";
import { textMergeContext as coreTextMergeContext } from "../core/merge/text-field.ts";
import { withDocumentPorts } from "../legacy/document-ports.ts";
import { fromHtml } from "../legacy/richtext.ts";
import {
  adoptRestoredState,
  normalizeDocId,
  noteMergedDocId
} from "./02b-doc-id.js";
import {
  captureSnapshot,
  getHistorySnapshot,
  historyNoop,
  listDocHistory,
  protectHistorySnapshot
} from "./03a-history-store.js";
import {
  SIDE_PANEL_IDS,
  applySidePanelWidth,
  holdScriptPlace,
  readSidePanelWidth,
  sidePanelOpening
} from "./03b-side-panels.js";
import { safeId } from "./04-richtext.js";
import { render } from "./05-render.js";
import { targetSectionHtml, wireTargetSection } from "./05t-target.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import {
  formatTimestamp,
  getSavedAuthorName,
  nowIso,
  saveAuthorName
} from "./10-comments.js";
import { markAbsorbedDirty, markDirty, showToast } from "./12-dirty-toast.js";
import { driveFormatSize, reviewMode } from "./13-hosted.js";
import { personColor } from "./13a-presence.js";
import { haltAutoSave, queueAutoSave } from "./14-export.js";
import { updateFileChip } from "./18-local-files.js";
export { GALLERY_FIELDS, ROW_FIELDS } from "../core/document/fields.ts";
export { mergeBrollShots, mergePeople, mergeProductionTags } from "../core/merge/lists.ts";
export { byId, rowContentEqual, rowFieldKey } from "../core/merge/rows.ts";
export { mergeTargetLength } from "../core/merge/scalars.ts";
export { mergeTextField } from "../core/merge/text-field.ts";

var STASH_KEY = "splitpage-conflict-stash";
export var SNAPSHOT_KEY = "splitpage-snapshots";
export var RELOAD_GUARD_KEY = "splitpage-conflict-reloaded";

S.baseState = null;

export function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

export function getEditorName() {
  return getSavedAuthorName() || "Anonymous";
}

provideSessionEffects({ editorName: getEditorName });

export function stampRow(row) {
  row.updatedAt = nowIso();
  row.updatedBy = getEditorName();
}

export function readLegacySnapshotsRaw() {
  try {
    var raw = localStorage.getItem(SNAPSHOT_KEY);
    return typeof raw === "string" ? raw : null;
  } catch (e) { return null; }
}

export function pushSnapshot(label, snapshotState) {
  return captureSnapshot(label, snapshotState || S.state, { allowSeedSkip: !snapshotState });
}

var restoreInFlight = false;
var RESTORE_BACKUP_ATTEMPTS = 3;

async function restoreSnapshot(id, opts) {
  opts = opts || {};
  if (restoreInFlight) return "busy";
  if (!S.state) return "missing";
  restoreInFlight = true;
  var docIdAtStart = S.state.docId;
  var moved = function () { return !S.state || S.state.docId !== docIdAtStart; };
  var releaseHold = historyNoop;
  try {
    releaseHold = protectHistorySnapshot({ docId: opts.older ? null : docIdAtStart, older: !!opts.older, id: id });

    var snap = await getHistorySnapshot({ docId: opts.older ? null : docIdAtStart, older: !!opts.older, id: id });
    if (moved()) return "changed";
    if (!snap) return "missing";
    var parsed = null;
    try { parsed = JSON.parse(snap.stateJson); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rows)) return "corrupt";

    var stored = false;
    for (var attempt = 0; attempt < RESTORE_BACKUP_ATTEMPTS; attempt++) {
      var stateAtCapture = S.state;
      var seqAtCapture = S.editSeq;
      var ticket = captureSnapshot("Before restoring an earlier version", S.state, { allowSeedSkip: false });
      if (!ticket) { stored = false; break; }
      var result = await ticket.done;
      if (moved()) return "changed";
      stored = !!(result && result.stored);
      if (S.state === stateAtCapture && S.editSeq === seqAtCapture) break;
      stored = false;
    }
    if (!stored && !opts.force) return "no-backup";

    adoptRestoredState(parsed);
    resetProductionPanelState();
    markAbsorbedDirty("recovery");
    render();
    closeHistoryPanel();
    showToast(opts.restoredText || "Restored the version from " + formatTimestamp(snap.meta && snap.meta.at), "ok");
    if (!opts.local) queueAutoSave();
    return "restored";
  } finally {
    releaseHold();
    restoreInFlight = false;
  }
}

var RESTORE_ARM_MS = 4000;
var RESTORE_LABEL = "Restore this version";
var RESTORE_OLDER_LABEL = "Restore";
var RESTORE_ARMED_LABEL = "Could not keep a backup — restore anyway?";
var restoreArmedKey = null;
var restoreArmTimer = null;

function restoreCardKey(bucket, id) {
  return (bucket === "older" ? "older" : "doc") + "/" + id;
}

function restoreButtonLabel(bucket, armed) {
  if (armed) return RESTORE_ARMED_LABEL;
  return bucket === "older" ? RESTORE_OLDER_LABEL : RESTORE_LABEL;
}

function applyRestoreArm() {
  var panel = document.getElementById("history-panel");
  if (!panel) return;
  Array.prototype.forEach.call(panel.querySelectorAll('[data-action="restore-snapshot"]'), function (b) {
    var bucket = b.getAttribute("data-bucket");
    var armed = restoreArmedKey !== null &&
      restoreCardKey(bucket, b.getAttribute("data-id")) === restoreArmedKey;
    b.classList.toggle("armed", armed);
    (b.querySelector(".history-restore-label") || b).textContent = restoreButtonLabel(bucket, armed);
    var snap = armed ? b.closest(".history-snap") : null;
    if (snap) snap.open = true;
  });
}

function disarmRestore() {
  clearTimeout(restoreArmTimer);
  restoreArmTimer = null;
  restoreArmedKey = null;
  applyRestoreArm();
}

export function restoreSnapshotFromCard(btn) {
  if (!btn) return;
  var id = btn.getAttribute("data-id") || "";
  var older = btn.getAttribute("data-bucket") === "older";
  var key = restoreCardKey(older ? "older" : "doc", id);
  var force = restoreArmedKey === key;
  if (force) disarmRestore();
  return restoreSnapshot(id, { older: older, force: force }).then(function (r) {
    if (r === "no-backup") {
      clearTimeout(restoreArmTimer);
      restoreArmedKey = key;
      applyRestoreArm();
      restoreArmTimer = setTimeout(disarmRestore, RESTORE_ARM_MS);
    } else if (r === "missing") {
      showToast("That version is no longer in the history.", "warn");
      renderHistory();
    } else if (r === "corrupt") {
      showToast("That version could not be read, so nothing was restored.", "warn");
    } else if (r === "changed") {
      showToast("A different document was opened while restoring, so nothing was restored.", "warn");
    }
    return r;
  }, function (e) {
    if (window.console) console.error(e);
    return "corrupt";
  });
}

export function textMergeContext(base, mine, theirs, mergedTags) {
  return coreTextMergeContext(fromHtml, base, mine, theirs, mergedTags);
}

export function mergeStates(base, mine, theirs) {
  return withDocumentPorts(STATE_FIELDS, function (migrate) {
    return mergeStatesWith(base, mine, theirs, {
      decode: fromHtml,
      ids: randomIds,
      clock: systemClock,
      editor: getEditorName,
      fields: STATE_FIELDS,
      migrate: migrate
    });
  });
}

function stashBlobsFor(docs) {
  var blobs = {}, any = false;
  docs.forEach(function (d) {
    refsIn(d).forEach(function (sha) {
      if (blobs[sha] || isDurableSync(sha)) return;
      var url = dataUrlForSync(sha);
      if (url) { blobs[sha] = url; any = true; }
    });
  });
  return any ? blobs : null;
}

export function stashLocalWork() {
  if (!S.state) return false;
  var payload = { at: nowIso(), by: getEditorName(), base: S.baseState, mine: S.state };
  var blobs = stashBlobsFor([S.state, S.baseState]);
  if (blobs) payload.blobs = blobs;
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify(payload));
    return true;
  } catch (e) { return false; }
}

export function acceptStash(stash, theirs) {
  if (!stash || typeof stash !== "object") return stash;
  if (stash.blobs && typeof stash.blobs === "object") {
    Object.keys(stash.blobs).forEach(function (sha) {
      if (isSha256Hex(sha) && typeof stash.blobs[sha] === "string") internDataUrl(stash.blobs[sha]);
    });
  }
  if (stash.imagesStripped) {
    var theirRows = byId(theirs && Array.isArray(theirs.rows) ? theirs.rows : []);
    [stash.mine, stash.base].forEach(function (doc) {
      if (!doc || !Array.isArray(doc.rows)) return;
      doc.rows.forEach(function (r) {
        if (!r || r.visualImage !== "__IMAGE__") return;
        var t = theirRows[r.id];
        delete r.visualImage;
        r.imageRef = t && t.imageRef ? JSON.parse(JSON.stringify(t.imageRef)) : null;
      });
    });
    delete stash.imagesStripped;
  }
  return stash;
}

export function clearStash() {
  try { sessionStorage.removeItem(STASH_KEY); } catch (e) {}
}

export function readStash() {
  try {
    var raw = sessionStorage.getItem(STASH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

export function updateIdentityChip() {
  var name = getSavedAuthorName();
  var chip = document.getElementById("identity-chip");
  document.getElementById("identity-name").textContent = name || "Set your name";
  chip.classList.toggle("unnamed", !name);
  var dot = chip.querySelector(".identity-dot");
  if (dot) {
    dot.setAttribute("aria-hidden", "true");
    if (name) dot.style.setProperty("--person", personColor(name));
    else dot.style.removeProperty("--person");
  }
}

var anchorPopover = null;

function closeAnchorPopover(opts) {
  var p = anchorPopover;
  if (!p) return;
  anchorPopover = null;
  document.removeEventListener("pointerdown", p.onOutside, true);
  document.removeEventListener("keydown", p.onKey, true);
  window.removeEventListener("resize", p.place);
  window.removeEventListener("scroll", p.place, true);
  p.el.remove();
  p.host.setAttribute("aria-expanded", "false");
  if (!(opts && opts.keepFocus) && document.contains(p.host)) {
    try { p.host.focus({ preventScroll: true }); } catch (e) { p.host.focus(); }
  }
}

function placeAnchorPopover(el, host) {
  var margin = 8, gap = 6;
  var r = host.getBoundingClientRect();
  var vw = document.documentElement.clientWidth || window.innerWidth;
  var vh = window.innerHeight;
  el.style.maxWidth = (vw - margin * 2) + "px";
  var w = el.offsetWidth, h = el.offsetHeight;
  var left = r.left + r.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, vw - margin - w));
  var top = r.bottom + gap;
  if (top + h > vh - margin && r.top - gap - h >= margin) top = r.top - gap - h;
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
  el.classList.toggle("is-above", top < r.top);
}

function openAnchorPopover(host, id, label, html) {
  var wasOpen = anchorPopover && anchorPopover.el.id === id;
  closeAnchorPopover({ keepFocus: true });
  if (wasOpen) { host.focus(); return null; }
  var el = document.createElement("div");
  el.id = id;
  el.className = "anchor-popover";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", label);
  el.innerHTML = html;
  document.body.appendChild(el);
  var p = {
    el: el,
    host: host,
    place: function () { placeAnchorPopover(el, host); },
    onOutside: function (e) {
      if (el.contains(e.target) || host.contains(e.target)) return;
      closeAnchorPopover({ keepFocus: true });
    },
    onKey: function (e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeAnchorPopover();
    }
  };
  anchorPopover = p;
  host.setAttribute("aria-expanded", "true");
  p.place();
  document.addEventListener("pointerdown", p.onOutside, true);
  document.addEventListener("keydown", p.onKey, true);
  window.addEventListener("resize", p.place);
  window.addEventListener("scroll", p.place, true);
  return el;
}

export function personSwatchesHtml(name, radioName, legendClass) {
  var current = readMyColor() || personColor(name || "");
  return '<fieldset class="swatch-group" role="radiogroup" aria-label="Your colour">' +
    '<legend class="' + (legendClass || "anchor-popover-label") + '">Your colour</legend>' +
    '<div class="swatch-row">' +
    PERSON_COLORS.map(function (c, i) {
      return '<label class="swatch" style="--swatch:' + c + '" title="' + PERSON_COLOR_NAMES[i] + '">' +
        '<input type="radio" name="' + (radioName || "person-color") + '" value="' + c + '" aria-label="' + PERSON_COLOR_NAMES[i] + '"' +
          (c === current ? " checked" : "") + '>' +
        '<span class="swatch-dot" aria-hidden="true"></span></label>';
    }).join("") +
    '</div></fieldset>';
}

export function setMyColor(color) {
  writePref(PERSON_COLOR_KEY, color);
  updateIdentityChip();
  render();
}

export function promptForName() {
  var current = getSavedAuthorName();
  var host = document.getElementById("identity-chip");
  var wrap = openAnchorPopover(host, "identity-editor", "Your name and colour",
    '<label class="anchor-popover-label" for="identity-input">Your name</label>' +
    '<div class="anchor-popover-row">' +
      '<input type="text" id="identity-input" placeholder="Your name" autocomplete="name" value="' + escapeHtml(current) + '">' +
      '<button type="button" id="identity-save" class="btn-outline">Save</button>' +
    '</div>' +
    personSwatchesHtml(current));
  if (!wrap) return;
  var input = document.getElementById("identity-input");
  input.focus();
  input.select();
  function commit() {
    var v = (input.value || "").trim();
    if (v) saveAuthorName(v);
    closeAnchorPopover();
    updateIdentityChip();
    render();
  }
  document.getElementById("identity-save").addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });
  wrap.addEventListener("change", function (e) {
    if (e.target && e.target.name === "person-color") setMyColor(e.target.value);
  });
}

function lengthHost() {
  var phone = document.getElementById("length-status");
  if (phone && phone.getClientRects().length) return phone;
  return document.getElementById("runtime-chip");
}

export function promptForWpm() {
  openClockPopover("wpm");
}

export function promptForTarget() {
  openClockPopover("target");
}

function openClockPopover(focusOn) {
  if (!S.state) return;
  var viewing = reviewMode();
  var off = viewing ? " disabled" : "";
  var host = lengthHost();
  var wrap = openAnchorPopover(host, "wpm-editor", "Reading speed and target length",
    '<label class="anchor-popover-label" for="wpm-input">Reading speed</label>' +
    '<div class="anchor-popover-row">' +
      '<input type="number" id="wpm-input" min="60" max="400" step="5" value="' +
        escapeHtml(String(S.state.wordsPerMinute || DEFAULT_WPM)) + '" aria-label="Words per minute"' + off + '>' +
      '<span class="anchor-popover-unit">words a minute</span>' +
      '<button type="button" id="wpm-save" class="btn-outline"' + off + '>Set</button>' +
    '</div>' +
    targetSectionHtml());
  if (!wrap) return;
  wireTargetSection(wrap, closeAnchorPopover);
  var targetInput = document.getElementById("target-input");
  var input = document.getElementById("wpm-input");
  var first = focusOn === "target" && targetInput && !targetInput.disabled ? targetInput : input;
  if (viewing) { wrap.setAttribute("tabindex", "-1"); wrap.focus(); }
  else { first.focus(); first.select(); }
  function commit() {
    if (reviewMode()) { closeAnchorPopover(); return; }
    var v = Math.round(Number(input.value));
    if (isFinite(v) && v >= 60 && v <= 400 && v !== S.state.wordsPerMinute) {
      S.state.wordsPerMinute = v;
      markDirty();
      render();
      queueAutoSave();
    }
    closeAnchorPopover();
  }
  document.getElementById("wpm-save").addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });
}

export function openSidePanel(id) {
  holdScriptPlace();
  SIDE_PANEL_IDS.forEach(function (pid) {
    if (pid !== id) {
      var el = document.getElementById(pid);
      if (el) el.hidden = true;
    }
  });
  document.getElementById(id).hidden = false;
  applySidePanelWidth(id, readSidePanelWidth(id));
  syncPanelClass();
}

export function openHistoryPanel() {
  openSidePanel("history-panel");
  renderHistory();
}
export function closeHistoryPanel() {
  var p = document.getElementById("history-panel");
  if (p) p.hidden = true;
  syncPanelClass();
}

var PANEL_TOGGLES = [
  ["production-panel", "btn-production"],
  ["gear-panel", "btn-gear"],
  ["broll-panel", "btn-broll"],
  ["comments-panel", "btn-comments"]
];

export function syncPanelClass() {
  var open = SIDE_PANEL_IDS.some(function (pid) {
    var el = document.getElementById(pid);
    return el && !el.hidden;
  });
  if (open !== document.body.classList.contains("panel-open")) sidePanelOpening(open);
  document.body.classList.toggle("panel-open", open);
  PANEL_TOGGLES.forEach(function (pair) {
    var panel = document.getElementById(pair[0]);
    var btn = document.getElementById(pair[1]);
    if (btn) btn.setAttribute("aria-pressed", panel && !panel.hidden ? "true" : "false");
  });
}

var historyRenderToken = 0;

var HISTORY_SUBTITLES = {
  idb: "Snapshots of this document, kept in this browser before anything that could overwrite your work.",
  desktop: "Snapshots of this document, kept on this computer before anything that could overwrite your work.",
  memory: "Snapshots of this document, kept only until this page closes — this browser isn't letting Splitpage store them."
};
var HISTORY_SUBTITLE_DEFAULT = "Snapshots of this document, kept before anything that could overwrite your work.";

var HISTORY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var HISTORY_RESTORE_HINT = "Replaces what's on screen, which is saved here first.";

var historyOpenKey = null;
var historyToggleBound = false;

function historyFig(text) {
  return '<span class="history-fig">' + escapeHtml(text) + '</span>';
}

function historyWhen(m) {
  var d = new Date(m && m.at);
  if (isNaN(d.getTime()) && m && Number(m.atMs) > 0) d = new Date(Number(m.atMs));
  return isNaN(d.getTime()) ? null : d;
}

function historyDayKey(d) {
  return d ? d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate() : "";
}

function historyDay(d) {
  if (!d) return { word: "Date unknown", date: "" };
  var now = new Date();
  var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  var key = historyDayKey(d);
  return {
    word: key === historyDayKey(now) ? "Today" : key === historyDayKey(yesterday) ? "Yesterday" : "",
    date: d.getDate() + " " + HISTORY_MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "")
  };
}

function historyClock(d) {
  return d ? formatClock(d) : "";
}

function historyClockWide() {
  return formatClock(new Date(2000, 0, 1, 12, 52)).length > 5;
}

function historySavedHtml(d) {
  if (!d) return "Date unknown";
  var day = historyDay(d);
  return (day.word ? escapeHtml(day.word) : historyFig(day.date)) + " at " + historyFig(historyClock(d));
}

function historyScenesHtml(n) {
  return historyFig(String(n)) + " scene" + (n === 1 ? "" : "s");
}

function historySizeText(bytes) {
  var n = Number(bytes);
  var gb = 1024 * 1024 * 1024;
  if (!(n >= gb)) return driveFormatSize(n);
  return (n / gb).toFixed(1).replace(/\.0$/, "") + " GB";
}

function historySizeHtml(bytes) {
  var text = historySizeText(Math.max(0, Math.floor(Number(bytes) || 0)));
  var parts = /^([\d.]+) (.+)$/.exec(text);
  return parts ? historyFig(parts[1]) + " " + escapeHtml(parts[2]) : escapeHtml(text);
}

function historyInitials(name) {
  var words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  var first = Array.from(words[0])[0] || "";
  var last = words.length > 1 ? (Array.from(words[words.length - 1])[0] || "") : "";
  return (first + last).toUpperCase();
}

function historyPersonHtml(name) {
  name = String(name || "").trim();
  if (!name) return '<span class="history-none">—</span>';
  return '<span class="person-avatar" style="--size: 20px; --presence: ' + escapeHtml(personColor(name)) + '" aria-hidden="true">' +
      escapeHtml(historyInitials(name)) + '</span>' +
    '<span class="history-person">' + escapeHtml(name) + '</span>';
}

function historyCardHtml(m, bucket) {
  var status = m.status === "writing" || m.status === "pending" ? m.status : "stored";
  var rows = Math.max(0, Math.floor(Number(m.rows) || 0));
  var armed = restoreArmedKey !== null && restoreCardKey(bucket, m.id) === restoreArmedKey;
  var id = safeId(m.id, "s");
  var when = historyWhen(m);
  var label = escapeHtml(restoreButtonLabel(bucket, armed));

  if (bucket === "older") {
    var titleId = "history-older-title-" + id;
    return '<li class="history-card history-older-item">' +
      '<div class="history-older-text">' +
        '<span class="history-card-doc" id="' + escapeHtml(titleId) + '">' + escapeHtml(m.title || "Untitled") + '</span>' +
        '<span class="history-older-meta">' + historySavedHtml(when) + (m.label ? " · " + escapeHtml(m.label) : "") + '</span>' +
      '</div>' +
      '<button type="button" class="btn-outline is-small history-older-restore' + (armed ? " armed" : "") + '" data-action="restore-snapshot"' +
        ' data-id="' + escapeHtml(id) + '" data-bucket="older" aria-describedby="' + escapeHtml(titleId) + '">' +
        '<span class="history-restore-label">' + label + '</span></button>' +
    '</li>';
  }

  var key = restoreCardKey("doc", id);
  var size = historySizeHtml(m.sizeBytes);
  return '<li class="history-card' + (status === "writing" ? " is-writing" : status === "pending" ? " is-pending" : "") + '">' +
    '<details class="history-snap" data-snap="' + escapeHtml(key) + '"' + (armed || key === historyOpenKey ? " open" : "") + '>' +
      '<summary class="history-row">' +
        '<time class="history-time' + (historyClockWide() ? " is-wide" : "") + '"' + (when ? ' datetime="' + escapeHtml(when.toISOString()) + '"' : "") + '>' +
          escapeHtml(when ? historyClock(when) : "—") + '</time>' +
        '<span class="history-card-label">' + escapeHtml(m.label || "Snapshot") +
          (status === "pending" ? '<span class="history-card-badge" title="Kept in this window only, and tried again after the next successful write">Not stored</span>' : "") +
        '</span>' +
        '<span class="history-scenes">' + historyScenesHtml(rows) + '</span>' +
      '</summary>' +
      '<div class="history-detail">' +
        '<dl class="history-facts">' +
          '<dt>Saved</dt><dd><span>' + historySavedHtml(when) + '</span></dd>' +
          '<dt>Saved by</dt><dd>' + historyPersonHtml(m.by) + '</dd>' +
          '<dt>Script at the time</dt><dd><span>' + historyScenesHtml(rows) + '</span></dd>' +
          (size ? '<dt>Snapshot size</dt><dd><span>' + size + '</span></dd>' : "") +
        '</dl>' +
        '<div class="history-restore">' +
          '<button type="button" class="btn-outline history-restore-btn' + (armed ? " armed" : "") + '" data-action="restore-snapshot"' +
            ' data-id="' + escapeHtml(id) + '">' +
            '<svg aria-hidden="true" focusable="false"><use href="#i-history"/></svg>' +
            '<span class="history-restore-label">' + label + '</span></button>' +
          '<p class="history-restore-hint">' + escapeHtml(HISTORY_RESTORE_HINT) + '</p>' +
        '</div>' +
      '</div>' +
    '</details>' +
  '</li>';
}

function historyDaysHtml(entries) {
  var days = [];
  var byDay = Object.create(null);
  entries.forEach(function (m) {
    var when = historyWhen(m);
    var key = historyDayKey(when);
    if (!byDay[key]) {
      byDay[key] = { when: when, items: [] };
      days.push(byDay[key]);
    }
    byDay[key].items.push(m);
  });
  return days.map(function (g, i) {
    var day = historyDay(g.when);
    return '<section class="history-day" aria-labelledby="history-day-' + i + '">' +
      '<h3 class="history-day-head" id="history-day-' + i + '">' +
        (day.word ? '<span>' + escapeHtml(day.word) + '</span>' : "") +
        (day.date ? historyFig(day.date) : "") +
      '</h3>' +
      '<ol class="history-day-list">' + g.items.map(function (m) { return historyCardHtml(m, "doc"); }).join("") + '</ol>' +
    '</section>';
  }).join("");
}

function onHistoryRowToggle(e) {
  var snap = e.target;
  if (!snap || !snap.classList || !snap.classList.contains("history-snap")) return;
  var key = snap.getAttribute("data-snap");
  if (snap.open) {
    historyOpenKey = key;
    Array.prototype.forEach.call(e.currentTarget.querySelectorAll(".history-snap[open]"), function (other) {
      if (other !== snap) other.open = false;
    });
  } else if (historyOpenKey === key) {
    historyOpenKey = null;
  }
}

function historyUsageHtml(backend, usage) {
  if (!usage || typeof usage !== "object") return "";
  if (usage.readOnly && backend === "desktop") {
    return "Version history is read-only: it was written by a newer version of Splitpage.";
  }
  var used = historySizeText(usage.totalBytes) || "0 KB";
  var cap = Number(usage.capBytes);
  var docs = Math.max(0, Math.floor(Number(usage.docCount) || 0));
  var html = "Version history uses " + historyFig(used) +
    (backend !== "memory" && isFinite(cap) && cap > 0 ? " of " + historyFig(historySizeText(cap)) : "") +
    " across " + historyFig(String(docs)) + " document" + (docs === 1 ? "" : "s") + ".";
  if (usage.overCap) html += " It is over its limit, so older snapshots are being removed first.";
  return html;
}

export async function renderHistory() {
  var listEl = document.getElementById("history-list");
  var panel = document.getElementById("history-panel");
  if (!listEl || !panel || panel.hidden || !S.state) return;
  if (!historyToggleBound) {
    historyToggleBound = true;
    listEl.addEventListener("toggle", onHistoryRowToggle, true);
  }
  var token = ++historyRenderToken;
  var docId = normalizeDocId(S.state.docId);
  var data;
  try {
    data = await listDocHistory(docId);
  } catch (e) {
    if (window.console) console.error(e);
    return;
  }
  if (token !== historyRenderToken) return;
  if (!S.state || panel.hidden) return;
  if (normalizeDocId(S.state.docId) !== docId) {
    return renderHistory();
  }
  data = data || {};

  var subtitle = document.getElementById("history-subtitle");
  if (subtitle) subtitle.textContent = HISTORY_SUBTITLES[data.backend] || HISTORY_SUBTITLE_DEFAULT;

  var entries = Array.isArray(data.entries) ? data.entries : [];
  var notice = typeof data.notice === "string" ? data.notice : "";
  if (!entries.length && notice) {
    listEl.innerHTML = '<p class="history-empty history-notice">' + escapeHtml(notice) + '</p>';
  } else if (!entries.length) {
    listEl.innerHTML = '<p class="history-empty">No snapshots of this document yet. Splitpage saves one automatically before anything that could overwrite your work — opening a document, replacing rows, or merging someone else\'s changes.</p>';
  } else {
    listEl.innerHTML = historyDaysHtml(entries);
  }

  var olderEl = document.getElementById("history-older");
  var olderCount = document.getElementById("history-older-count");
  var olderList = document.getElementById("history-older-list");
  var older = Array.isArray(data.older) ? data.older : [];
  if (olderEl) olderEl.hidden = !older.length;
  if (olderCount) olderCount.textContent = String(older.length);
  if (olderList) {
    olderList.innerHTML = older.map(function (m) {
      return historyCardHtml({
        id: m.id, label: m.label, at: m.at, by: m.by, rows: m.rows, title: m.title, status: "stored"
      }, "older");
    }).join("");
  }

  var usageEl = document.getElementById("history-usage");
  if (usageEl) {
    var usageHtml = notice ? (entries.length ? escapeHtml(notice) : "") : historyUsageHtml(data.backend, data.usage);
    usageEl.innerHTML = usageHtml;
    usageEl.hidden = !usageHtml;
  }
}

S.lastMergeUndo = null;
var undoArmed = false;
var undoArmTimer = null;
var undoMergeForceFor = null;

var UNDO_SAVED_NOTE = "Undo merge puts your version back here; the next save replaces the merged copy on the server.";
var UNDO_SAVED_TITLE = "Go back to the version you were saving, before someone else's changes were merged into it. " +
  "It stays unsaved until the next save, which replaces the merged copy on the server. Recoverable from Version history.";
var undoTitleDefault = null;

export function reportMerge(result, opts) {
  opts = opts || {};
  var s = result.stats;
  var bits = [];
  if (s.rowsFromMe) bits.push(s.rowsFromMe + " row" + (s.rowsFromMe === 1 ? "" : "s") + " you edited");
  if (s.rowsAddedByMe) bits.push(s.rowsAddedByMe + " row" + (s.rowsAddedByMe === 1 ? "" : "s") + " you added");
  if (s.rowsFromThem) bits.push(s.rowsFromThem + " changed by someone else");
  if (s.rowsAddedByThem) bits.push(s.rowsAddedByThem + " added by someone else");

  if (!bits.length && !result.conflicts.length) {
    if (!opts.alreadySaved) { markAbsorbedDirty(opts.kind || "server"); noteMergeAutoSave(opts); }
    return;
  }

  var summary = bits.length ? "Kept " + bits.join(", ") + "." : "Nothing was lost.";
  if (result.conflicts.length) {
    summary += " " + result.conflicts.length + " edit" + (result.conflicts.length === 1 ? " was" : "s were") +
      " changed on both sides — your version is saved as a comment.";
  }

  var undoBtn = document.getElementById("merge-undo");
  if (undoTitleDefault === null) undoTitleDefault = undoBtn.title;
  var offerUndo = opts.undo !== false && !!S.lastMergeUndo;
  undoBtn.hidden = !offerUndo;
  undoBtn.title = opts.undo === "saved" ? UNDO_SAVED_TITLE : undoTitleDefault;
  if (offerUndo && opts.undo === "saved") summary += " " + UNDO_SAVED_NOTE;

  document.getElementById("merge-summary").textContent = " " + summary;
  document.getElementById("merge-review").hidden = !result.conflicts.length;
  var banner = document.getElementById("merge-banner");
  banner.classList.toggle("notice-warn", !!result.conflicts.length);
  banner.hidden = false;

  result.conflicts.forEach(function (c) {
    var el = document.querySelector('#rows .row[data-id="' + safeId(c.rowId, "r") + '"]');
    if (el) el.classList.add("just-merged");
  });

  if (!opts.alreadySaved) { markAbsorbedDirty(opts.kind || "server"); noteMergeAutoSave(opts); }
}

function noteMergeAutoSave(opts) {
  if (!opts.noAutoSave) { queueAutoSave(); return; }
  haltAutoSave("Autosave is paused — changes recovered for you are on screen but not in your file yet. " +
               "Press Save once you have looked them over.");
}

var UNDO_LABELS = {
  "server-conflict": "Before merging in someone else's changes",
  "server-resume": "Before merging your recovered changes",
  "stash": "Before merging your unsaved changes"
};

export function applyMerge(opts) {
  opts = opts || {};
  var result = null;
  var snap = null;

  if (!opts.unchanged) {
    if (opts.undoPoint) snap = pushSnapshot(UNDO_LABELS[opts.source], opts.undoPoint);
    if (opts.keepLabel) pushSnapshot(opts.keepLabel, opts.mine);
    result = mergeStates(
      opts.base ? migrateRows(cloneState(opts.base)) : null,
      migrateRows(cloneState(opts.mine)),
      migrateRows(cloneState(opts.theirs))
    );
  }
  var next = result ? result.merged : opts.theirs;

  function armUndoPoint(docId) {
    if (!opts.undoPoint) return;
    S.lastMergeUndo = snap ? { id: snap.id, docId: docId, source: opts.source } : null;
  }

  if (opts.mergeOnly) {
    armUndoPoint(snap && snap.docId);
    return { state: next, result: result, snapshot: snap };
  }

  var kind = opts.recovery || opts.source === "server-resume" ? "recovery" : "server";

  function adopt() {
    next = kind === "recovery" ? noteRecovery(next) : noteServerUpdate(next);
    S.state = next;
    if (opts.historyFrom) noteMergedDocId(opts.historyFrom);
    armUndoPoint(S.state.docId);
    if (opts.newBase !== undefined) {
      baseStateWhy = "merge: " + (opts.source || "");
      S.baseState = typeof opts.newBase === "function" ? opts.newBase() : opts.newBase;
    }
    render();
    if (opts.chips) { updateIdentityChip(); updateFileChip(); }
    if (result) {
      if (opts.report !== false) reportMerge(result, { noAutoSave: !!opts.noAutoSave, kind: kind });
    } else if (opts.report !== false) {
      markAbsorbedDirty(kind);
    }
    if (opts.toast) {
      var said = typeof opts.toast.text === "function" ? opts.toast.text() : opts.toast.text;
      if (said) showToast(said, opts.toast.tone || "ok", !!opts.toast.sticky);
    }
    return { state: next, result: result, snapshot: snap };
  }

  if (!opts.awaitUndoPoint) return adopt();
  var written = snap && snap.done ? snap.done : null;
  return Promise.resolve(written).then(null, function () {}).then(adopt);
}

var baseStateWhy = "";

export function setBaseState(next, why) {
  baseStateWhy = String(why || "");
  S.baseState = next;
  return next;
}

export function baseStateReason() {
  return baseStateWhy;
}

var UNDO_CONFIRM = { "server-conflict": "Drop their changes?" };
var UNDO_LOCAL = { "server-conflict": true };
var UNDO_RESTORED = {
  "server-conflict": "Your version is back, unsaved. The next save replaces the merged copy on the server."
};

export function undoMerge(btn) {
  if (!S.lastMergeUndo) { showToast("No merge snapshot to undo.", "warn"); return; }
  if (!S.state || S.lastMergeUndo.docId !== S.state.docId) {
    showToast("That merge belongs to a different document, so there is nothing to undo here.", "warn");
    return;
  }
  if (undoArmed) {
    clearTimeout(undoArmTimer);
    undoArmed = false;
    btn.textContent = "Undo merge";
    btn.classList.remove("armed");
    var undo = S.lastMergeUndo;
    var force = undoMergeForceFor === undo;
    undoMergeForceFor = null;
    restoreSnapshot(undo.id, {
      force: force,
      local: !!UNDO_LOCAL[undo.source],
      restoredText: UNDO_RESTORED[undo.source]
    }).then(function (r) {
      if (r === "no-backup") {
        undoMergeForceFor = undo;
        showToast("Could not keep a backup of your current version. Undo the merge again to discard your edits anyway.", "warn");
      } else if (r === "missing") {
        showToast("The snapshot from before the merge is no longer in the history.", "warn");
      } else if (r === "corrupt") {
        showToast("The snapshot from before the merge could not be read, so nothing was undone.", "warn");
      } else if (r === "changed") {
        showToast("A different document was opened while undoing, so nothing was undone.", "warn");
      }
    }, function (e) { if (window.console) console.error(e); });
    return;
  }
  undoArmed = true;
  btn.textContent = UNDO_CONFIRM[S.lastMergeUndo.source] || "Discard my edits?";
  btn.classList.add("armed");
  clearTimeout(undoArmTimer);
  undoArmTimer = setTimeout(function () {
    undoArmed = false;
    btn.textContent = "Undo merge";
    btn.classList.remove("armed");
  }, 3000);
}

export function findRowIndex(id) {
  for (var i = 0; i < S.state.rows.length; i++) {
    if (S.state.rows[i].id === id) return i;
  }
  return -1;
}

export function __init() {}
