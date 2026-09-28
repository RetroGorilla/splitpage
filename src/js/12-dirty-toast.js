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

/* ================= dirty / toast ================= */

/* There are two Save buttons — the header's, and the writer's, because the
   writer covers the header and an hour of writing should not have to be
   closed to be saved. They are one control with two faces: nothing
   addresses either of them directly, so they cannot come to disagree about
   whether there is anything to save. */
/* Set by saveDoc() (14-export.js) around the actual write/save-to-server
   call. While a save is genuinely in flight, markDirty() must not
   overwrite the button's "Saving…" text with "Save •" just because a
   keystroke landed in the meantime — the button stays visibly disabled
   either way, so the mismatch is purely cosmetic, but it reads as "the
   save already finished (or never started)" to anyone watching it. */
/* Deliberately NOT called saveInFlight: 14-export.js has its own
   autosave mutex under that name, and because the fragments concatenate
   into one closure the two `var`s hoisted to a single binding, so the
   button label and the autosave lock silently shared state (issue #59).
   This one is only ever about what the two Save buttons say. */
S.saveButtonBusy = false;

export function setSaveButtons(text, disabled) {
  ["btn-save", "wr-save"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = text;
    if (disabled !== undefined) btn.disabled = disabled;
    btn.classList.toggle("is-dirty", text.indexOf("•") !== -1);
  });
  /* Both markDirty() and clearDirty() funnel through here (invariant #20 —
     one save state behind the two Save buttons), which makes this the one
     place a desktop window title needs to hear about too, rather than a
     third thing to remember to call from every mutation site. Defined in
     20f-desktop.js; hoisted, so the fragment order doesn't matter. */
  /* The same funnel is where a change of document identity is noticed
     (02b-doc-id.js). Every path that makes a different document current —
     an open, a server load, a Save As fork, a publish — ends in
     clearDirty() or markDirty(), so checking here means no new ingress path
     can forget to. It is a string compare when nothing changed, so typing
     costs nothing. Before the desktop notification, so the main process
     never hears about a document state whose identity is stale. */
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  /* Last of the three, and in this order deliberately: the crash draft is
     written with the document's identity and its dirty state in the header,
     so both have to be settled before it is told anything changed
     (20g-drafts.js). It only sets a timer. */
  if (S.DESKTOP && typeof noteDraftChange === "function") noteDraftChange();
  /* Last of all, and derived from everything above rather than set
     alongside it: the save-state indicator (below) is the one place that
     says, in words, whether what is on screen is on disk yet. */
  updateSaveStatus();
}

export function markDirty() {
  S.dirty = true;
  S.editSeq++;
  /* The colour you picked goes into each document you edit (#194), so it
     reaches everyone who opens it, online or not. Before noteEdit() so it
     rides with this edit; the undo stack skips the map (12a-undo.js). A
     reviewer's copy never goes back to the server, so theirs is left
     alone. */
  if (!reviewMode()) recordMyColor(S.state);
  /* Every edit ends here, so this is where the undo stack hears about it:
     12a-undo.js diffs the document against its last copy once this task
     is done, and records the difference as one undo entry. */
  noteEdit();
  /* Unconditional, and NOT left to setSaveButtons() below: the line after
     this skips that funnel while a save is in flight, so an edit typed
     during a save would otherwise not reach the crash-draft writer until
     saveDoc()'s finally ran — the one window where a crash is most likely
     to cost work, since the document is large enough to still be writing.
     noteDraftChange() is O(1) and only moves a timer (20g-drafts.js). */
  if (S.DESKTOP && typeof noteDraftChange === "function") noteDraftChange();
  if (!S.saveButtonBusy) setSaveButtons("Save •");
  /* Only moves two timers (14-export.js), so it is safe on the keystroke
     path; the save itself waits for a pause in the typing. */
  scheduleAutoSave();
  if (home.kind === "import") { home.dirty = true; updateFileChip(); }
  /* A hosted document is not an import (one Save button, one home for it,
     _home.js), so the branch above never ran for it. updateHeaderFileChip()
     derives its hosted text from the live `dirty` flag, but nothing else
     called it at edit
     time — the chip kept showing its last "v5, everyone sees this" text
     after an edit, until an unrelated autosave or a manual Save
     eventually refreshed it, misleading a glance at the chip into
     thinking the edit was already synced. */
  else if (onServerDoc()) { updateFileChip(); }
}

export function clearDirty() {
  S.dirty = false;
  /* Whatever a pending autosave was going to write has just been written
     (or has just been replaced by a different document), so its timers are
     stale either way; a halted autosave gets its second chance here for
     the same reason. */
  clearAutoSaveTimers();
  resumeAutoSave();
  /* Every successful save sets this again on its way past (the Saving… →
     Saved step in updateSaveStatus, below, which comes after this: a save
     calls clearDirty() while the status still reads Saving…). Clearing it
     here is what stops "Last saved to the file you had open an hour ago"
     turning up under a different document, since opening one comes
     through here too — and opening one straight from Saved used to keep
     the old time, because Saved → Saved never touched it. */
  savedAt = 0;
  setSaveButtons("Save");
}

/* ---- the save-state indicator ----

   A line of small text beside each Save button saying whether the document
   on screen is safely somewhere else yet: "Saved", "Saving…", "Unsaved
   changes". It is deliberately the quietest thing in the header — with
   autosave on, the interesting states last about two seconds, and an
   indicator that flashed or moved would make every sentence typed into an
   event. The detail — which file, why autosave stopped, what to press —
   lives in its `title`, where it costs nothing until it is wanted.

   Derived, never set: every caller goes through setSaveButtons(), the one
   funnel both markDirty() and clearDirty() already share (invariant #20),
   so a new path that changes the save state cannot forget to update it. */

/* Called by the quiet automatic saves, which have no toast to say where the
   document went: the tooltip says it instead ("Last saved to script.md at
   2:52 PM"), derived below like everything else here. */
export function noteSaveStatus() {
  updateSaveStatus();
}

/* The tooltip over "Saved just now" / "All changes saved" (#208): where the
   document went and when this page last wrote it, in the person's own
   clock (Settings ▸ Clock). `where` is the server, the file's name — a
   desktop file's too, its handle carries one (makeDesktopHandle) — or ""
   when the write was a download with no file to name. Nothing written yet
   (a document just opened, a pull that brought the server's copy in) has
   no time to give: it is simply up to date. */
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
    /* A document nobody has saved or changed yet — the seed, or a blank
       start — has nothing to report, and "Saved" over a file that does not
       exist would be a lie. */
    if (!target && home.kind !== "file" && !where) return null;
    /* its title is savedTitle(where), filled in by updateSaveStatus once
       it knows whether this is the Saving… → Saved step (savedAt) */
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

/* When the document on screen was last written, for the header's "Saved
   just now" and the time in its tooltip (#169, #208). Derived like
   everything else here: it is the moment the indicator went from Saving…
   to Saved, so every save path — a manual Save, an autosave, the server —
   sets it without a call of its own, and opening a document (Saved
   straight from anything else, through clearDirty) does not, since a time
   would then be a claim about a write this page never made. */
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
  /* The header's Save button draws the same words in place of its own
     (app.css, #btn-save::before): the status is the button. Its text node
     stays "Save" / "Save •", which the writer's button mirrors and the
     suites read. */
  var btn = document.getElementById("btn-save");
  if (btn) {
    /* "Saved just now", then "All changes saved" (savedStatusText,
       00p-prefs.js) — never an age, which read as autosave falling behind */
    var shown = !view ? "Save" : text === "Saved" ? savedStatusText(savedAt, Date.now()) : view.text;
    btn.setAttribute("data-status", shown);
    btn.setAttribute("data-state", view ? view.cls : "none");
    btn.setAttribute("aria-label", view ? shown + ". Save now" : "Save");
    btn.title = view ? view.title + " Click to save now." : "Save this script";
  }
  /* "Saved just now" becomes "All changes saved" a minute after the write
     without anything else happening: one timer, for that one moment. A
     write inside the minute moves savedAt, and the late timer finds it
     still "just now" and sets itself again. */
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

/* `sticky` is for the handful of messages that must not scroll past while
   you are looking the other way — a lapsed sign-in above all, since every
   save until you act on it will fail. Sticky toasts dismiss on click.

   Returns the element it appended, with its own dismiss() on it. A sticky
   toast otherwise has no end but a click, so a caller that says something
   is wrong has no way to take it back when it comes right: "Crash recovery
   is paused — this disk is full" sat on screen for the rest of the session
   after recovery resumed, contradicting the message posted next to it. No
   existing caller reads the return value; this is a pure addition. */
export function showToast(msg, kind, sticky) {
  var host = document.getElementById("toast-host");
  var el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "") + (sticky ? " is-sticky" : "");
  el.textContent = msg;
  function dismiss() {
    /* A class, not an inline style. Written inline, the fade-out was the
       one piece of motion in the app that no stylesheet could reach: it
       sat outside the motion tokens, and the
       `@media (prefers-reduced-motion: reduce) { .toast { ... } }` rule in
       app.css had nothing to apply to, so a viewer who had asked for less
       motion got the toast's exit anyway. .is-leaving mirrors toast-in —
       the same 6px of travel, going the other way — and collapses with
       every other movement token.

       The 220ms removal is deliberately longer than --dur-exit rather
       than equal to it: the element has to outlive its own transition, and
       nothing reads a toast's presence closely enough for the extra
       100ms to matter. */
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

/* A toast with one action button beside its words ("Undo"), up a little
   longer than a plain one so there is time to reach it. The button runs
   onAction once and takes the toast away. `sticky` keeps it up until it is
   clicked away or its button is used — for a state that lasts, such as a
   link its owner turned off (13-hosted.js's flagLinkOff), where the action
   ("Save a copy…") is still the thing to do an hour later. */
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

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
