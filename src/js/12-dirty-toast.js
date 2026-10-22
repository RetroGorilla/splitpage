import { S } from "./_state.js";
import { home, homeConn } from "./_home.js";
import { syncDocIdentity } from "./02b-doc-id.js";
import { SAVED_JUST_NOW_MS, savedStatusText, savedWhenText } from "./00p-prefs.js";
import { linkTurnedOff, onServerDoc, reviewMode, serverSessionExpired } from "./13-hosted.js";
import { personColorsWithMine } from "./13a-presence.js";
import {
  autoSaveTarget,
  clearAutoSaveTimers,
  queueAutoSave,
  resumeAutoSave,
  scheduleAutoSave
} from "./14-export.js";
import { updateFileChip } from "./18-local-files.js";
import { notifyDesktopDocumentState } from "./20f-desktop.js";
import { noteDraftChange } from "./20g-drafts.js";
import { noteAbsorbedDirty, noteSessionEdit } from "../legacy/session-bridge.ts";
import { autoSavePolicy, confirmSavedNow, noteSaveChange, saveBusy, unsavedChanges } from "../legacy/save-bridge.ts";
import { saveButtonView, saveStatus } from "../application/save/status.ts";
import { changeSet } from "../application/session/change-set.ts";
import { authorityOf, editCapability } from "../application/collaboration/authority.ts";
import { showActionToast, showToast } from "../legacy/effects-bridge.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";

var MY_COLOR = changeSet({ docFields: ["personColors"] });

function myColorPlan(doc) {
  if (!doc || reviewMode()) return null;
  var next = personColorsWithMine(doc);
  if (!next) return null;
  return { changes: MY_COLOR, apply: function (live) { live.personColors = next; } };
}

function signLegacyEdit() {
  var plan = myColorPlan(S.state);
  if (plan) plan.apply(S.state);
}

export function hasUnsavedChanges() { return unsavedChanges(); }

export function legacySessionEffects() {
  return {
    dirty: function () {
      noteSaveChange();
    },
    attribute: myColorPlan,
    draft: function () {
      if (typeof noteDraftChange === "function") noteDraftChange();
    },
    save: function (change) {
      if (!saveBusy()) setSaveButtons();
      if (change.kind !== "recovery") scheduleAutoSave();
      if (home.kind === "import") { home.dirty = true; updateFileChip(); }
      else if (onServerDoc()) { updateFileChip(); }
      if (change.changes.saveNow) queueAutoSave();
    },
    edit: function () {
      return editCapability(authorityOf(homeConn()));
    }
  };
}

export function setSaveButtons() {
  var view = saveButtonView({ busy: saveBusy(), dirty: hasUnsavedChanges() });
  ["btn-save", "wr-save"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = view.label;
    btn.disabled = view.disabled;
    btn.classList.toggle("is-dirty", view.dirty);
  });
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (runningOnDesktop() && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  if (typeof noteDraftChange === "function") noteDraftChange();
  updateSaveStatus();
}

export function markDirty() {
  signLegacyEdit();
  noteSessionEdit();
}

export function markAbsorbedDirty(kind) {
  signLegacyEdit();
  noteAbsorbedDirty(kind);
}

export function clearDirty() {
  confirmSavedNow();
  clearAutoSaveTimers();
  resumeAutoSave();
  savedAt = 0;
  setSaveButtons("Save");
}

export function noteSaveStatus() {
  updateSaveStatus();
}

function savedTitle(where) {
  var when = savedWhenText(savedAt, Date.now());
  if (when) return "Last saved " + (where ? "to " + where + " " : "") + "at " + when + ".";
  return where ? "Up to date with " + where + "." : "Everything is saved.";
}

function saveStatusView() {
  var target = typeof autoSaveTarget === "function" ? autoSaveTarget() : null;
  var where = target === "server" ? "the server"
    : home.kind === "file" ? (home.handle && home.handle.name) || ""
    : home.kind === "import" ? home.name || ""
    : "";

  var onServer = typeof onServerDoc === "function" && onServerDoc();
  var autosave = autoSavePolicy();
  var line = saveStatus({
    busy: saveBusy(),
    dirty: unsavedChanges(),
    halted: autosave.halted(),
    autoSaveOn: autosave.enabled(),
    target: target,
    where: where,
    homeKind: home.kind,
    onServer: !!onServer,
    signedOut: !!serverSessionExpired,
    linkOff: !!linkTurnedOff
  }).line;
  return line ? Object.assign({}, line) : null;
}

var savedAt = 0;
var lastViewText = "";
var justNowTimer = null;

export function updateSaveStatus() {
  var view = saveStatusView();
  var text = view ? view.text : "";
  if (text === "Saved" && lastViewText === "Saving…") savedAt = Date.now();
  else if (text !== "Saved") savedAt = 0;
  lastViewText = text;
  if (text === "Saved") view.title = savedTitle(view.where);
  ["save-status", "wr-save-status"].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = !view;
    if (!view) { el.textContent = ""; el.removeAttribute("title"); return; }
    el.textContent = view.text;
    el.title = view.title;
    el.className = "save-status is-" + view.cls;
  });
  var btn = document.getElementById("btn-save");
  if (btn) {
    var shown = !view ? "Save" : text === "Saved" ? savedStatusText(savedAt, Date.now()) : view.text;
    btn.setAttribute("data-status", shown);
    btn.setAttribute("data-state", view ? view.cls : "none");
    btn.setAttribute("aria-label", view ? shown + ". Save now" : "Save");
    btn.title = view ? view.title + " Click to save now." : "Save this script";
  }
  if (savedAt && !justNowTimer) {
    var left = savedAt + SAVED_JUST_NOW_MS - Date.now();
    if (left > 0) {
      justNowTimer = setTimeout(function () {
        justNowTimer = null;
        if (savedAt) updateSaveStatus();
      }, left + 50);
    }
  }
}

export function showRefusal(outcome) {
  if (!outcome || outcome.kind !== "unavailable" || !outcome.reason) return;
  var text = outcome.reason;
  showToast(/[.!?…]$/.test(text) ? text : text + ".", "warn");
}

if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("undo-owner-cleared", function (e) {
    var n = (e.detail && e.detail.count) || 0;
    if (n) showToast("That person is no longer on the crew, so " + (n === 1 ? "1 item is" : n + " items are") + " now unassigned.", "warn");
  });
}

export { showActionToast, showToast };

export function __init() {}
