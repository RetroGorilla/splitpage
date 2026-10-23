import { amendHome, currentHome, homeConn, reviewMode, serverStatus } from "../legacy/location-bridge.ts";
import { syncDocIdentity } from "./02b-doc-id.js";
import { SAVED_JUST_NOW_MS, savedStatusText, savedWhenText } from "../../shared/clock.js";
import { onServerDoc } from "./13-hosted.js";
import { colorsWithMine } from "../core/document/person-colors.ts";
import { cleanAuthorName } from "../core/document/people.ts";
import { noteDraftChange } from "./20g-drafts.js";
import { autoSavePolicy, autoSaveTarget, noteSaveChange, saveBusy, scheduleAutoSave, unsavedChanges } from "../legacy/save-bridge.ts";
import { saveButtonView, saveStatus } from "../application/save/status.ts";
import { changeSet } from "../application/session/change-set.ts";
import { authorityOf, editCapability } from "../application/collaboration/authority.ts";
import { showActionToast, showToast } from "../legacy/effects-bridge.ts";
import { preferences } from "../legacy/preferences-bridge.ts";

var MY_COLOR = changeSet({ docFields: ["personColors"] });

function myColorPlan(doc) {
  if (!doc || reviewMode()) return null;
  var next = colorsWithMine(doc.personColors, cleanAuthorName(preferences().commentAuthor()).trim(), preferences().myColor());
  if (!next) return null;
  return { changes: MY_COLOR, apply: function (live) { live.personColors = next; } };
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
      if (change.kind !== "recovery") scheduleAutoSave();
      if (currentHome().kind === "import") amendHome(currentHome(), { dirty: true });
      if (change.changes.saveNow) autoSavePolicy().dueNow();
    },
    edit: function () {
      return editCapability(authorityOf(homeConn()));
    }
  };
}

function paintSaveButtons() {
  var view = saveButtonView({ busy: saveBusy(), dirty: hasUnsavedChanges() });
  ["btn-save", "wr-save"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = view.label;
    btn.disabled = view.disabled;
    btn.classList.toggle("is-dirty", view.dirty);
  });
}

function setSaveButtons() {
  paintSaveButtons();
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (typeof noteDraftChange === "function") noteDraftChange();
  updateSaveStatus();
}

export function saveStatusListeners() {
  return {
    paint: function () {
      paintSaveButtons();
      updateSaveStatus();
    },
    save: function (change) {
      if (change === "change") {
        if (!saveBusy()) setSaveButtons();
      } else if (change === "clean") {
        savedAt = 0;
        setSaveButtons();
      } else if (change === "running") {
        setSaveButtons();
      } else {
        updateSaveStatus();
      }
    },
    location: function (change) {
      if (change !== "writtenOut") updateSaveStatus();
    },
    status: function (change) {
      if (change === "link" || change === "session") updateSaveStatus();
    },
    preference: function (change) {
      if (preferences().nameOf(change.key) === "clock") updateSaveStatus();
    }
  };
}

function savedTitle(where) {
  var when = savedWhenText(savedAt, Date.now(), preferences().clock());
  if (when) return "Last saved " + (where ? "to " + where + " " : "") + "at " + when + ".";
  return where ? "Up to date with " + where + "." : "Everything is saved.";
}

function saveStatusView() {
  var target = typeof autoSaveTarget === "function" ? autoSaveTarget() : null;
  var where = target === "server" ? "the server"
    : currentHome().kind === "file" ? (currentHome().handle && currentHome().handle.name) || ""
    : currentHome().kind === "import" ? currentHome().name || ""
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
    homeKind: currentHome().kind,
    onServer: !!onServer,
    signedOut: !!serverStatus().sessionExpired(),
    linkOff: !!serverStatus().linkTurnedOff()
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

export { showActionToast, showToast };

export function __init() {
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("undo-owner-cleared", function (e) {
      var n = (e.detail && e.detail.count) || 0;
      if (n) showToast("That person is no longer on the crew, so " + (n === 1 ? "1 item is" : n + " items are") + " now unassigned.", "warn");
    });
  }
  window.__saveStatusTest = {
    refresh: updateSaveStatus
  };
}
