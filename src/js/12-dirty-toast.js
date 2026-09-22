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
  var saveInFlight = false;

  function setSaveButtons(text, disabled) {
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
    if (DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
    /* Last of the three, and in this order deliberately: the crash draft is
       written with the document's identity and its dirty state in the header,
       so both have to be settled before it is told anything changed
       (20g-drafts.js). It only sets a timer. */
    if (DESKTOP && typeof noteDraftChange === "function") noteDraftChange();
    /* Last of all, and derived from everything above rather than set
       alongside it: the save-state indicator (below) is the one place that
       says, in words, whether what is on screen is on disk yet. */
    updateSaveStatus();
  }

  function markDirty() {
    dirty = true;
    editSeq++;
    /* Unconditional, and NOT left to setSaveButtons() below: the line after
       this skips that funnel while a save is in flight, so an edit typed
       during a save would otherwise not reach the crash-draft writer until
       saveDoc()'s finally ran — the one window where a crash is most likely
       to cost work, since the document is large enough to still be writing.
       noteDraftChange() is O(1) and only moves a timer (20g-drafts.js). */
    if (DESKTOP && typeof noteDraftChange === "function") noteDraftChange();
    if (!saveInFlight) setSaveButtons("Save •");
    /* Only moves two timers (14-export.js), so it is safe on the keystroke
       path; the save itself waits for a pause in the typing. */
    scheduleAutoSave();
    if (openedFile.name) { openedFile.dirty = true; updateFileChip(); }
    /* A hosted document has no openedFile.name (openServerDoc() sets it to
       null on purpose — one Save button, one home for it), so the branch
       above never ran for it. updateHeaderFileChip() derives its hosted
       text from the live `dirty` flag, but nothing else called it at edit
       time — the chip kept showing its last "v5, everyone sees this" text
       after an edit, until an unrelated autosave or a manual Save
       eventually refreshed it, misleading a glance at the chip into
       thinking the edit was already synced. */
    else if (onServerDoc()) { updateFileChip(); }
  }

  function clearDirty() {
    dirty = false;
    /* Whatever a pending autosave was going to write has just been written
       (or has just been replaced by a different document), so its timers are
       stale either way; a halted autosave gets its second chance here for
       the same reason. */
    clearAutoSaveTimers();
    resumeAutoSave();
    /* Every successful save sets this again on its way past (noteSaveStatus,
       below); clearing it here is what stops "Saved to the file you had open
       an hour ago" turning up under a different document, since opening one
       comes through here too. */
    lastSaveDetail = "";
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

  /* What the last successful save did, for the tooltip — set by the quiet
     automatic saves, which have no toast to say it instead. */
  var lastSaveDetail = "";
  function noteSaveStatus(detail) {
    lastSaveDetail = detail || "";
    updateSaveStatus();
  }

  function saveStatusView() {
    var target = typeof autoSaveTarget === "function" ? autoSaveTarget() : null;
    var where = target === "server" ? "the server"
      : (docFileHandle.handle && docFileHandle.handle.name) || (openedFile && openedFile.name) || "";

    if (typeof onServerDoc === "function" && onServerDoc() && serverSessionExpired) {
      return { text: "Not saving", cls: "warn",
               title: "Your sign-in to the server has lapsed — reload the page to sign in again." };
    }
    if (saveInFlight) {
      return { text: "Saving…", cls: "busy",
               title: where ? "Writing your changes to " + where + "." : "Writing your changes." };
    }
    if (autoSaveHalt) return { text: "Not saving", cls: "warn", title: autoSaveHalt };
    if (!dirty) {
      /* A document nobody has saved or changed yet — the seed, or a blank
         start — has nothing to report, and "Saved" over a file that does not
         exist would be a lie. */
      if (!target && !docFileHandle.kind && !where) return null;
      return { text: "Saved", cls: "ok",
               title: lastSaveDetail || (where ? "Saved to " + where + "." : "Everything is saved.") };
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

  function updateSaveStatus() {
    var view = saveStatusView();
    ["save-status", "wr-save-status"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.hidden = !view;
      if (!view) { el.textContent = ""; el.removeAttribute("title"); return; }
      el.textContent = view.text;
      el.title = view.title;
      el.className = "save-status is-" + view.cls;
    });
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
  function showToast(msg, kind, sticky) {
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
