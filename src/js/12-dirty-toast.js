import { S } from "./_state.js";
import { home } from "./_home.js";
import { syncDocIdentity } from "./02b-doc-id.js";
import { SAVED_JUST_NOW_MS, savedStatusText, savedWhenText } from "./00p-prefs.js";
import { linkTurnedOff, onServerDoc, reviewMode, serverSessionExpired } from "./13-hosted.js";
import { recordMyColor } from "./13a-presence.js";
import {
  autoSaveEnabled,
  autoSaveHalt,
  autoSaveTarget,
  clearAutoSaveTimers,
  resumeAutoSave,
  scheduleAutoSave
} from "./14-export.js";
import { updateFileChip } from "./18-local-files.js";
import { notifyDesktopDocumentState } from "./20f-desktop.js";
import { noteDraftChange } from "./20g-drafts.js";
import { noteEdit } from "./12a-undo.js";

S.saveButtonBusy = false;

export function setSaveButtons(text, disabled) {
  ["btn-save", "wr-save"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = text;
    if (disabled !== undefined) btn.disabled = disabled;
    btn.classList.toggle("is-dirty", text.indexOf("•") !== -1);
  });
  // Runs before desktop notify so main never sees stale identity
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  if (typeof noteDraftChange === "function") noteDraftChange();
  updateSaveStatus();
}

export function markDirty() {
  S.dirty = true;
  S.editSeq++;
  if (!reviewMode()) recordMyColor(S.state);
  noteEdit();
  // Unconditional: setSaveButtons is skipped during in-flight save
  if (typeof noteDraftChange === "function") noteDraftChange();
  if (!S.saveButtonBusy) setSaveButtons("Save •");
  scheduleAutoSave();
  if (home.kind === "import") { home.dirty = true; updateFileChip(); }
  // Hosted docs skip the import branch; chip must refresh
  else if (onServerDoc()) { updateFileChip(); }
}

export function clearDirty() {
  S.dirty = false;
  clearAutoSaveTimers();
  resumeAutoSave();
  // Reset so old save time never shows under another doc
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

  if (typeof onServerDoc === "function" && onServerDoc() && serverSessionExpired) {
    return { text: "Not saving", cls: "warn",
             title: "Your sign-in to the server has lapsed — reload the page to sign in again." };
  }
  if (typeof onServerDoc === "function" && onServerDoc() && linkTurnedOff) {
    return { text: "Not saving", cls: "warn",
             title: "The owner turned off the link you opened this with — File ▸ Save a copy… keeps what's on screen." };
  }
  if (S.saveButtonBusy) {
    return { text: "Saving…", cls: "busy",
             title: where ? "Writing your changes to " + where + "." : "Writing your changes." };
  }
  if (autoSaveHalt) return { text: "Not saving", cls: "warn", title: autoSaveHalt };
  if (!S.dirty) {
    if (!target && home.kind !== "file" && !where) return null;
    return { text: "Saved", cls: "ok", title: "", where: where };
  }
  if (target && autoSaveEnabled) {
    return { text: "Unsaved changes", cls: "pending",
             title: "Autosave will write these to " + where + " a moment after you stop typing." };
  }
  return { text: "Unsaved changes", cls: "pending",
           title: target
             ? "Autosave is off — press Save to write these to " + where + "."
             : "Press Save to choose where this script is kept." };
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

export function showToast(msg, kind, sticky) {
  var host = document.getElementById("toast-host");
  var el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "") + (sticky ? " is-sticky" : "");
  el.textContent = msg;
  function dismiss() {
    el.classList.add("is-leaving");
    setTimeout(function () { el.remove(); }, 220);
  }
  if (sticky) {
    el.title = "Click to dismiss";
    el.addEventListener("click", dismiss);
  } else {
    setTimeout(dismiss, 2600);
  }
  el.dismiss = dismiss;
  host.appendChild(el);
  return el;
}

export function showActionToast(msg, kind, label, onAction, sticky) {
  var el = showToast(msg, kind, true);
  if (!sticky) {
    el.classList.remove("is-sticky");
    el.removeAttribute("title");
  }
  el.classList.add("has-action");
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-action";
  btn.textContent = label;
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    el.dismiss();
    onAction();
  });
  el.appendChild(btn);
  if (!sticky) setTimeout(el.dismiss, 6000);
  return el;
}

export function __init() {}
