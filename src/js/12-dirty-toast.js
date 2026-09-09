  /* ================= dirty / toast ================= */

  /* There are two Save buttons — the header's, and the writer's, because the
     writer covers the header and an hour of writing should not have to be
     closed to be saved. They are one control with two faces: nothing
     addresses either of them directly, so they cannot come to disagree about
     whether there is anything to save. */
  function setSaveButtons(text, disabled) {
    ["btn-save", "wr-save"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.textContent = text;
      if (disabled !== undefined) btn.disabled = disabled;
      btn.classList.toggle("is-dirty", text.indexOf("•") !== -1);
    });
  }

  function markDirty() {
    dirty = true;
    editSeq++;
    setSaveButtons("Save •");
    if (openedFile.name) { openedFile.dirty = true; updateFileChip(); }
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

