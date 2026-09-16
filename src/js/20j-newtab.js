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

     Recently-opened documents as a third column (the issue's open
     question) are deliberately not here: nothing in the app keeps a recent
     list today — the browser remembers one handle and the desktop main
     process tracks open tabs, neither of which is a recents list — so that
     column is a feature of its own rather than a detail of this page.

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
    document.addEventListener("keydown", onNewTabKeydown, true);
    var first = el.querySelector('[data-newtab-action="new"]');
    if (first) first.focus();
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
    blankState: blankDocumentState
  };
