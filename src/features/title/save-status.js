import { SAVED_JUST_NOW_MS, savedStatusText, savedWhenText } from "../../../shared/clock.js";
import { saveButtonView, saveStatus } from "../../application/save/status.ts";

var ports = null;

function paintSaveButtons() {
  var view = saveButtonView({ busy: ports.saves.busy(), dirty: ports.saves.unsaved() });
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
  ports.identity.sync();
  ports.drafts.noteChange();
  updateSaveStatus();
}

function saveStatusListeners() {
  return {
    paint: function () {
      paintSaveButtons();
      updateSaveStatus();
    },
    save: function (change) {
      if (change === "change") {
        if (!ports.saves.busy()) setSaveButtons();
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
      if (ports.preferences.nameOf(change.key) === "clock") updateSaveStatus();
    }
  };
}

function savedTitle(where) {
  var when = savedWhenText(savedAt, Date.now(), ports.preferences.clock());
  if (when) return "Last saved " + (where ? "to " + where + " " : "") + "at " + when + ".";
  return where ? "Up to date with " + where + "." : "Everything is saved.";
}

function saveStatusView() {
  var target = ports.autoSave.target();
  var place = ports.place;
  var where = target === "server" ? "the server"
    : place.home().kind === "file" ? (place.home().handle && place.home().handle.name) || ""
    : place.home().kind === "import" ? place.home().name || ""
    : "";

  var onServer = place.home().kind === "server";
  var autosave = ports.autoSave.policy();
  var line = saveStatus({
    busy: ports.saves.busy(),
    dirty: ports.saves.unsaved(),
    halted: autosave.halted(),
    autoSaveOn: autosave.enabled(),
    target: target,
    where: where,
    homeKind: place.home().kind,
    onServer: !!onServer,
    signedOut: !!place.sessionExpired(),
    linkOff: !!place.linkTurnedOff()
  }).line;
  return line ? Object.assign({}, line) : null;
}

var savedAt = 0;
var lastViewText = "";
var justNowTimer = null;

function updateSaveStatus() {
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

function showRefusal(outcome) {
  if (!outcome || outcome.kind !== "unavailable" || !outcome.reason) return;
  var text = outcome.reason;
  ports.notices.show(/[.!?…]$/.test(text) ? text : text + ".", "warn");
}

function onOwnerCleared(e) {
  var n = (e.detail && e.detail.count) || 0;
  if (n) ports.notices.show("That person is no longer on the crew, so " + (n === 1 ? "1 item is" : n + " items are") + " now unassigned.", "warn");
}

export function mountSaveStatus(nextPorts) {
  ports = nextPorts;
  var listening = typeof document !== "undefined" && !!document.addEventListener;
  if (listening) document.addEventListener("undo-owner-cleared", onOwnerCleared);
  var probe = { refresh: updateSaveStatus };
  window.__saveStatusTest = probe;
  var disposed = false;
  return {
    refresh: updateSaveStatus,
    listeners: saveStatusListeners,
    showRefusal: showRefusal,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      if (listening) document.removeEventListener("undo-owner-cleared", onOwnerCleared);
      if (window.__saveStatusTest === probe) delete window.__saveStatusTest;
      if (justNowTimer) clearTimeout(justNowTimer);
      justNowTimer = null;
      savedAt = 0;
      lastViewText = "";
      ports = null;
    }
  };
}
