  /* ================= the New Tab page =================

     A new desktop tab (and a fresh copy of the app in the browser) used to
     land on the seeded demo document, so the first thing anyone did was
     clear out somebody else's example script or go hunting through the File
     drawer for Open. This page puts the only two things a new tab is
     actually for one click away: an empty script, or the file picker.

     WHAT IT IS NOT: a modal. It is an opaque full-page layer at z-index
     130 — above the topbar (120), below the side panels (140), the modals
     (150) and the tour (160) — so the first-run wizard still shows over it
     on a genuinely first run, and so nothing here can swallow a dialog.

     WHAT IT DOES NOT TOUCH: the document. Showing the page changes no
     state at all; the demo is still underneath, which is why "Look at the
     example script instead" (and Esc) can simply dismiss it. Only the
     "New script" button replaces the document, and it replaces it with a
     genuinely empty one — one blank scene, no tags, no comments, no
     b-roll, a fresh identity — not a filtered copy of the seed.

     The third column is the recently-edited list. Two stores lie behind it,
     because the two builds remember a file in two incompatible ways: the
     browser keeps structured-cloned FileSystemFileHandles in its own
     IndexedDB store (00-prelude.js), and desktop keeps paths in
     desktop-state.json and hands this page opaque ids (RECENTS-IPC,
     desktop/main.js), because a path is main's to hold and never this
     page's (invariant #34). recentEntries() below is the one place that
     difference lives; everything past it works on {id, name, title, at,
     missing} whichever build it is running in.

     Like 20b/20c/20e this fragment wires itself directly rather than
     through init(): #newtab-page is in the DOM by the time this classic
     script runs. */

  var newTabPageShown = false;

  function newTabPageEl() { return document.getElementById("newtab-page"); }

  /* The test harness turns the page off the same way it turns the first-run
     wizard off, and for the same reason: every existing suite boots on the
     pristine demo and clicks into it, and a full-page layer over that would
     break all of them. Both drivers set the flag before any page script
     runs unless the suite asked for the page with ?newtab=1. */
  function newTabSuppressed() {
    return window.__splitpageNoNewTab === true;
  }

  function openNewTabPage() {
    var el = newTabPageEl();
    if (!el || newTabPageShown) return;
    newTabPageShown = true;
    el.hidden = false;
    refreshRecents();
    document.addEventListener("keydown", onNewTabKeydown, true);
    var first = el.querySelector('[data-newtab-action="new"]');
    if (first) first.focus();
  }

  /* ---- the recently-edited column ----

     Nothing here is cached: the page reads the list each time it opens, so
     a tab that has been sitting on it for an hour is not offering a list
     from an hour ago. */
  var recentHandles = {};   /* browser only: id -> FileSystemFileHandle */
  var recentsBusy = false;

  function desktopRecents() {
    return DESKTOP && typeof DESKTOP.recentsList === "function" ? DESKTOP : null;
  }

  async function recentEntries() {
    var bridge = desktopRecents();
    if (bridge) {
      try {
        var list = await bridge.recentsList();
        return (Array.isArray(list) ? list : []).filter(function (e) { return e && e.id; });
      } catch (e) { return []; }
    }
    recentHandles = {};
    var rows = await listRecentFiles();
    return rows.map(function (r) {
      recentHandles[r.key] = r.handle;
      return { id: r.key, name: r.name, title: r.title, at: r.at, missing: false };
    });
  }

  /* "3 minutes ago" is more use than a timestamp on a list this short, and
     the exact minute of an edit is not what anyone is scanning for. */
  function recentWhen(at) {
    var ms = Date.now() - (at || 0);
    if (!at || ms < 0) return "";
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + " hour" + (hours === 1 ? "" : "s") + " ago";
    var days = Math.floor(hours / 24);
    if (days < 30) return days + " day" + (days === 1 ? "" : "s") + " ago";
    return "a while ago";
  }

  function renderRecents(entries) {
    var col = document.getElementById("newtab-recents");
    var list = document.getElementById("newtab-recents-list");
    if (!col || !list) return;
    /* An empty list is no column at all rather than an empty box captioned
       "Recent" — on a first run there is nothing to have been recent. */
    if (!entries.length) { col.hidden = true; return; }
    col.hidden = false;
    var html = "";
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var label = e.title || e.name || "Untitled";
      var when = recentWhen(e.at);
      html +=
        '<li class="newtab-recent' + (e.missing ? " is-missing" : "") + '">' +
          '<button type="button" class="newtab-recent-open" data-newtab-action="recent" data-recent-id="' +
            escapeHtml(e.id) + '"' + (e.missing ? ' title="This file has moved or been deleted"' : "") + '>' +
            '<span class="newtab-recent-title">' + escapeHtml(label) + '</span>' +
            '<span class="newtab-recent-sub">' + escapeHtml(e.name || "") +
              (when ? " · " + escapeHtml(when) : "") +
              (e.missing ? " · missing" : "") + '</span>' +
          '</button>' +
          '<button type="button" class="newtab-recent-forget" data-newtab-action="forget" data-recent-id="' +
            escapeHtml(e.id) + '" title="Forget ' + escapeHtml(e.name || label) +
            '" aria-label="Forget ' + escapeHtml(e.name || label) + '">×</button>' +
        '</li>';
    }
    list.innerHTML = html;
  }

  async function refreshRecents() {
    var entries = [];
    try { entries = await recentEntries(); } catch (e) { entries = []; }
    renderRecents(entries);
  }

  /* One click, whichever build. Desktop hands the id back to main, which
     routes it exactly as it routes a file the OS handed it — so a document
     already open in another tab activates that tab instead of opening a
     second copy. The browser reopens its own handle, which may need the
     permission prompt this click is allowed to raise. */
  async function openRecent(id) {
    if (recentsBusy) return;
    recentsBusy = true;
    try {
      var bridge = desktopRecents();
      if (bridge) {
        var r = null;
        try { r = await bridge.recentsOpen(id); } catch (e) { r = null; }
        if (!r || !r.ok) {
          showToast(r && r.code === "MISSING"
            ? ((r.name || "That file") + " has moved or been deleted.")
            : "Could not open that document.", "warn");
          await refreshRecents();
          return;
        }
        /* main answers where it landed; 'this-tab' arrives back here as an
           open-file event, which closes the page on its own
           (adoptProjectState). Anything else means another tab has it. */
        if (r.where !== "this-tab") closeNewTabPage();
        return;
      }
      var handle = recentHandles[id];
      if (!handle) { await refreshRecents(); return; }
      var perm = "denied";
      try {
        /* A handle with no permission API needs no permission — that is a
           handle this page can already read (an origin-private one, or the
           desktop shim's, whose queryPermission is a constant "granted"
           anyway). Only a picker-derived handle has a grant that can lapse
           between launches. */
        if (typeof handle.queryPermission !== "function") perm = "granted";
        else {
          perm = await handle.queryPermission({ mode: "readwrite" });
          /* The click is the user gesture this needs — the same re-grant the
             resume banner asks for (18-local-files.js). */
          if (perm !== "granted" && typeof handle.requestPermission === "function") {
            perm = await handle.requestPermission({ mode: "readwrite" });
          }
        }
      } catch (e) { perm = "denied"; }
      if (perm !== "granted") {
        showToast("Splitpage needs permission to reopen that file.", "warn");
        return;
      }
      try {
        await openProjectFile(await handle.getFile(), handle);
      } catch (e) {
        /* Moved, renamed, deleted, or on a drive that is not connected. An
           entry that cannot be opened is dropped rather than left on the
           list offering the same failure again. */
        showToast((handle.name || "That file") + " has moved or been deleted.", "warn");
        await forgetRecentFile(id);
        await refreshRecents();
      }
    } finally {
      recentsBusy = false;
    }
  }

  async function forgetRecent(id) {
    var bridge = desktopRecents();
    if (bridge) { try { await bridge.recentsForget(id); } catch (e) {} }
    else await forgetRecentFile(id);
    await refreshRecents();
  }

  async function forgetAllRecents() {
    var bridge = desktopRecents();
    if (bridge) { try { await bridge.recentsForget(null); } catch (e) {} }
    else await clearRecentFiles();
    await refreshRecents();
  }

  function closeNewTabPage() {
    var el = newTabPageEl();
    if (!newTabPageShown) return;
    newTabPageShown = false;
    if (el) el.hidden = true;
    document.removeEventListener("keydown", onNewTabKeydown, true);
  }

  function onNewTabKeydown(e) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    closeNewTabPage();
  }

  /* ---- "New script": a genuinely empty document ----

     migrateRows fills in every list the document carries (comments,
     productionTags, people, brollShots, wordsPerMinute) and mints a fresh
     docId, so building the blank from its two required fields is enough —
     and is the only way to be sure nothing of the seed survives.

     Not dirty, and editSeq untouched: an empty document nobody has typed
     into yet is exactly what isPristineSeedDocument() (03a-history-store.js)
     means by pristine, which is what lets the desktop shell keep routing an
     open into this tab and keep closing it without a prompt. */
  function blankDocumentState() {
    return migrateRows({
      title: "Untitled Script",
      rows: [{ id: makeId("r"), visualText: "", visualImage: null, audioText: "" }]
    });
  }

  function startBlankScript() {
    /* Clicked before loadInitialState() resolved: assigning `state` now
       would just be overwritten when the boot load lands (the same race
       20f-desktop.js's open handlers wait out). */
    if (!state && initialStateReady) return initialStateReady.then(startBlankScript);
    state = blankDocumentState();
    baseState = cloneState(state);
    /* A blank document's id has never left this page, so a first Save can
       take it with it rather than forking a new one (02b-doc-id.js). */
    docIdWrittenOut = false;
    resetProductionPanelState();
    render();
    updateFileChip();
    updateIdentityChip();
    updateSaveStatus();
    if (typeof syncDocIdentity === "function") syncDocIdentity();
    if (DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
    closeNewTabPage();
    return Promise.resolve(true);
  }

  /* ---- "Open a file" ----
     Exactly the File ▸ Open a document… path, picker and all. A cancelled
     picker leaves the page up (nothing happened); an open that main routed
     into some OTHER tab leaves this one on the New Tab page too, which is
     what that tab now is. */
  async function newTabOpenFile() {
    await openLocalFile();
    if (openedFile.name || docFileHandle.kind) closeNewTabPage();
  }

  (function wireNewTabPage() {
    var el = newTabPageEl();
    if (!el) return;
    el.addEventListener("click", function (e) {
      var target = e.target.closest("[data-newtab-action]");
      if (!target) return;
      e.preventDefault();
      var action = target.getAttribute("data-newtab-action");
      if (action === "new") startBlankScript();
      else if (action === "open") newTabOpenFile();
      else if (action === "dismiss") closeNewTabPage();
      else if (action === "recent") openRecent(target.getAttribute("data-recent-id"));
      else if (action === "forget") forgetRecent(target.getAttribute("data-recent-id"));
      else if (action === "forget-all") forgetAllRecents();
    });
  })();

  /* ---- deciding whether to show it, at boot ----

     The same "must never appear over a document that is about to open"
     rule the first-run wizard's gate follows (20b-onboarding.js), minus
     its once-per-launch conditions: a new tab is a new tab every time.

       - the pristine-seed gate (invariant #30) — the document on screen is
         the shipped demo and nothing else;
       - no hosted document, and no file adopted this load;
       - desktop: the tab's own launchIntent says 'blank' and there is no
         crash draft coming (TAB-BOOT-SYNC);
       - browser: no remembered file handle, which is the one thing
         tryResumeLastProject() (21-events.js) may still be about to reopen
         or offer to reopen. */
  async function newTabEligibleForAutoShow() {
    if (newTabSuppressed()) return false;
    if (!seedCheckPasses()) return false;
    if (DESKTOP && typeof draftRestorePending !== "undefined" && draftRestorePending) return false;
    if (typeof serverDoc !== "undefined" && serverDoc && serverDoc.id) return false;
    if (typeof docFileHandle !== "undefined" && docFileHandle && docFileHandle.kind) return false;
    if (DESKTOP) {
      if ((DESKTOP.launchIntent && DESKTOP.launchIntent.type !== "blank") ||
          DESKTOP.hasDraftToRestore) return false;
    } else {
      var handle = null;
      try { handle = await loadLastFileHandle(); } catch (e) { handle = null; }
      if (handle) return false;
    }
    /* Re-check what the round trip above gave a file time to change. */
    if (typeof serverDoc !== "undefined" && serverDoc && serverDoc.id) return false;
    if (typeof docFileHandle !== "undefined" && docFileHandle && docFileHandle.kind) return false;
    if (openedFile.name) return false;
    return true;
  }

  async function maybeAutoShowNewTabPage() {
    var eligible = false;
    try { eligible = await newTabEligibleForAutoShow(); } catch (e) { eligible = false; }
    if (eligible) openNewTabPage();
  }

  maybeAutoShowNewTabPage();

  /* ---- test hook ----
     Same trick as window.__onboarding: the gate and the blank document are
     what a headless suite has to drive, and neither has a UI affordance
     that can be clicked into existence on demand. Nothing in the app reads
     this. */
  window.__newTab = {
    open: openNewTabPage,
    close: closeNewTabPage,
    isOpen: function () { return newTabPageShown; },
    eligible: newTabEligibleForAutoShow,
    blank: startBlankScript,
    blankState: blankDocumentState,
    /* The recents column, which has two stores behind it and a permission
       prompt no headless browser can answer: a suite drives the list itself
       rather than the click that fills it. */
    recents: recentEntries,
    refreshRecents: refreshRecents,
    remember: function (handle, info) { return rememberRecentFile(handle, info); },
    forgetAll: forgetAllRecents
  };
