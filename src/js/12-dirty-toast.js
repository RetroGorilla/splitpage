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
    if (DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  }

  function markDirty() {
    dirty = true;
    editSeq++;
    if (!saveInFlight) setSaveButtons("Save •");
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
    setSaveButtons("Save");
  }

  /* `sticky` is for the handful of messages that must not scroll past while
     you are looking the other way — a lapsed sign-in above all, since every
     save until you act on it will fail. Sticky toasts dismiss on click. */
  function showToast(msg, kind, sticky) {
    var host = document.getElementById("toast-host");
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "") + (sticky ? " is-sticky" : "");
    el.textContent = msg;
    function dismiss() {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.2s ease";
      setTimeout(function () { el.remove(); }, 220);
    }
    if (sticky) {
      el.title = "Click to dismiss";
      el.addEventListener("click", dismiss);
    } else {
      setTimeout(dismiss, 2600);
    }
    host.appendChild(el);
  }
