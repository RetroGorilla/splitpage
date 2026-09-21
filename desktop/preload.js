/* Splitpage desktop — preload script.
 *
 * Runs in an isolated world (contextIsolation: true, sandbox: true) with a
 * Node environment but no direct access to the page's globals or vice
 * versa. Its only job is to build window.splitpageDesktop and hand it to
 * the page through contextBridge — and to refuse to do even that unless
 * the page is our own origin. A tunnelled remote page (--tunnel mode loads
 * a stranger's http://localhost:<port>/ with no bridge at all, per main.js)
 * must never get file-system access just because this script happened to
 * run in its window.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (location.origin === "splitpage://app") {
  let openFileCallback = null;
  let menuCommandCallback = null;
  let openServerDocCallback = null;
  let restoreNoticeCallback = null;
  let reassignDocIdCallback = null;
  let draftFlushCallback = null;
  let updateStatusCallback = null;

  ipcRenderer.on("splitpage:open-file", (_event, entry) => {
    if (openFileCallback) openFileCallback(reviveFileEntry(entry));
  });
  ipcRenderer.on("splitpage:menu-command", (_event, command) => {
    if (menuCommandCallback) menuCommandCallback(command);
  });
  ipcRenderer.on("splitpage:open-server-doc", (_event, payload) => {
    if (openServerDocCallback) openServerDocCallback(payload);
  });
  ipcRenderer.on("splitpage:restore-notice", (_event, payload) => {
    if (restoreNoticeCallback) restoreNoticeCallback(payload);
  });
  /* UPDATES: main pushes the whole status object whenever it changes — the
     launch check settling, and every step of a download. Pushed rather than
     polled because the check finishes after this page has already loaded and
     read the status once. */
  ipcRenderer.on("splitpage:update-status", (_event, status) => {
    if (updateStatusCallback) updateStatusCallback(status);
  });
  /* DOC-CLAIMS: main has decided this page's document is a copy of one open
     in another tab, and is handing it a replacement identity. The payload is
     three plain values ({fromId, toId, otherTitle}) — the renderer validates
     all three again before it applies anything. */
  ipcRenderer.on("splitpage:reassign-doc-id", (_event, payload) => {
    if (reassignDocIdCallback) reassignDocIdCallback(payload);
  });
  /* DRAFT-IPC-AND-SHAPES: main is asking this page to write whatever it is
     holding RIGHT NOW (Windows is signing the user out). The reply always
     goes back, quoting the same reqId — including when the page has no
     handler or the handler throws — because main is waiting on a budget and
     an answer that never comes costs it the whole budget for nothing. */
  ipcRenderer.on("splitpage:draft-flush", (_event, reqId) => {
    const reply = (result) => {
      try { ipcRenderer.send("splitpage:draft-flushed", reqId, result); } catch (_) { /* main is gone */ }
    };
    if (typeof draftFlushCallback !== "function") { reply({ ok: false, code: "NO_TAB" }); return; }
    /* The callback may return a promise (it usually does — a draft write is a
       round trip back to main) or nothing at all; Promise.resolve flattens
       both, and a synchronous throw inside it lands in the rejection arm. */
    Promise.resolve()
      .then(() => draftFlushCallback())
      .then(
        (result) => reply(result && typeof result === "object" ? result : { ok: true }),
        () => reply({ ok: false })
      );
  });

  /* IPC always hands `bytes` across as a Node Buffer serialised over
     structured clone, which arrives here as a Uint8Array already in most
     Electron versions — but coerce explicitly so the page can rely on
     `entry.bytes instanceof Uint8Array` regardless. */
  function reviveFileEntry(entry) {
    if (entry && entry.bytes && !(entry.bytes instanceof Uint8Array)) {
      entry = { ...entry, bytes: new Uint8Array(entry.bytes) };
    }
    return entry;
  }

  /* Synchronous by design: appVersion is a plain string on the exposed
     object, not a promise, and this only ever runs once, at preload time,
     before the page sees it. */
  const appVersion = ipcRenderer.sendSync("splitpage:get-app-version-sync");

  /* TAB-BOOT-SYNC: also synchronous, also read exactly once at preload time.
     The renderer's boot sequence has to know what this page is FOR before it
     decides anything — an IPC round trip would race those decisions instead
     of settling them. Every field is a scalar the main process computed; the
     launch intent deliberately carries no path and no server document id
     (invariant #34), only what kind of boot this is.

     A null answer means "not a tab page" (main did not recognise the sender).
     Nothing can be assumed in that case, so every field falls back to the
     quietest possible value: a blank page with no prior session. */
  const boot = ipcRenderer.sendSync("splitpage:tab-boot-sync") || {};
  const tabId = typeof boot.tabId === "string" ? boot.tabId : null;
  const windowId = typeof boot.windowId === "string" ? boot.windowId : null;
  const launchIntent = boot.launchIntent && typeof boot.launchIntent === "object"
    ? { type: String(boot.launchIntent.type || "blank") }
    : { type: "blank" };
  const hadPriorSession = boot.hadPriorSession === true;
  const firstTabOfLaunch = boot.firstTabOfLaunch === true;
  const hasDraftToRestore = boot.hasDraftToRestore === true;

  /* Also read once, at preload time: gates whether the TEST_MODE-only
     __testRequestClose/__testRequestQuit hooks below get exposed at all.
     The answer comes from the main process's own TEST_MODE flag (see
     main.js's splitpage:is-test-mode-sync), not from this script re-reading
     SPLITPAGE_TEST itself, so there is exactly one source of truth for "is
     this a test run" and preload can never disagree with main about it. */
  const testMode = ipcRenderer.sendSync("splitpage:is-test-mode-sync");

  const bridge = {
    isDesktop: true,
    platform: process.platform,
    appVersion,

    /* TAB-BOOT-SYNC's fields. tabId is this page's identity for the life of
       the tab — it survives a tear-off and a relaunch, and it names this
       tab's draft folder. The page can read it but can never choose it. */
    tabId,
    windowId,
    launchIntent,
    hadPriorSession,
    firstTabOfLaunch,
    hasDraftToRestore,

    openFileDialog() {
      return ipcRenderer.invoke("splitpage:open-file-dialog").then(reviveFileEntry);
    },

    saveFileDialog(options) {
      return ipcRenderer.invoke("splitpage:save-file-dialog", options || {});
    },

    readFile(id) {
      return ipcRenderer.invoke("splitpage:read-file", id).then(reviveFileEntry);
    },

    writeFile(id, data) {
      return ipcRenderer.invoke("splitpage:write-file", id, data);
    },

    statFile(id) {
      return ipcRenderer.invoke("splitpage:stat-file", id);
    },

    /* "Open this" — main decides WHERE it lands (this tab, a tab that
       already has it, or a new one) and answers which of the three it was.
       The payload names a document by opaque file id or server document id,
       never by path. */
    routeOpen(payload) {
      return ipcRenderer.invoke("splitpage:route-open", payload);
    },

    onOpenServerDoc(cb) {
      openServerDocCallback = cb;
    },

    onRestoreNotice(cb) {
      restoreNoticeCallback = cb;
    },

    onReassignDocId(cb) {
      reassignDocIdCallback = cb;
    },

    onOpenFile(cb) {
      openFileCallback = cb;
      /* Registering this callback is the renderer's "I'm ready" signal —
         main.js has been holding any OS-handed files (launch argv, a
         second instance's argv, macOS 'open-file') in a queue exactly
         until this fires, then flushes them through the listener above. */
      ipcRenderer.send("splitpage:renderer-ready");
    },

    onMenuCommand(cb) {
      menuCommandCallback = cb;
    },

    setDocumentState(state) {
      ipcRenderer.send("splitpage:set-document-state", state);
    },

    /* ---- crash drafts (DRAFT-IPC-AND-SHAPES) ----------------------------
       The page hands main what it is holding; main decides what of it goes
       into the header on disk (see buildDraftHeader in main.js). Nothing
       here names a tab — main looks the sender up — and nothing here names
       a path: the file a draft came from travels as the opaque fileId this
       page was given when the file was opened (invariant #34).

       These resolve with a WriteResult rather than rejecting, so a refusal
       always arrives with a code the renderer can back off on. */
    writeDraft(payload) {
      return ipcRenderer.invoke("splitpage:draft-write", payload);
    },

    discardDraft(seq) {
      return ipcRenderer.invoke("splitpage:draft-discard", { seq });
    },

    /* The crash draft for THIS tab, if there is one, with the file it was
       taken from already read (main resolves the path from its own header —
       the page never sees it). Nothing is deleted by taking: the draft stays
       until draftRestoreDone says what happened to it. */
    takeDraft() {
      return ipcRenderer.invoke("splitpage:draft-take").then((taken) => {
        if (taken && taken.file) taken.file = reviveFileEntry(taken.file);
        return taken;
      });
    },

    draftRestoreDone(outcome) {
      ipcRenderer.send("splitpage:draft-restore-done", { outcome });
    },

    onDraftFlush(cb) {
      draftFlushCallback = cb;
    },

    /* ---- version history (HISTORY-IPC) ----------------------------------
       The desktop store lives in the main process (main.js section 8b), not
       in this origin's IndexedDB: a 500 MB history has no business inside a
       Chromium profile folder the user can never find or back up. The page
       names a document only by docId and a snapshot only by its snapshot id
       (invariant #38) — nothing here can name a folder, and main validates
       both ids again before either reaches a path.

       `protect` is the list of snapshots a restore is currently reading, so
       main's eviction can skip them; src/js/03a-history-store.js fills it in
       from protectHistorySnapshot and the page never has to think about it. */
    historyPut(docId, meta, stateJson, protect) {
      return ipcRenderer.invoke("splitpage:history-put", docId, meta, stateJson, protect || []);
    },

    historyList(docId) {
      return ipcRenderer.invoke("splitpage:history-list", docId == null ? null : docId);
    },

    historyGet(query, snapshotId) {
      return ipcRenderer.invoke("splitpage:history-get", query, snapshotId);
    },

    historyCopy(fromDocId, toDocId) {
      return ipcRenderer.invoke("splitpage:history-copy", fromDocId, toDocId);
    },

    historyTouch(docId, title) {
      return ipcRenderer.invoke("splitpage:history-touch", docId, title);
    },

    historyImportOlder(entries) {
      return ipcRenderer.invoke("splitpage:history-import-older", entries);
    },

    historyUsage() {
      return ipcRenderer.invoke("splitpage:history-usage");
    },

    /* Every document this store has history for — {docId, title,
       lastOpenedAt}[], Older excluded. Backs File > Export app data.. on
       desktop (20h-appdata.js / 03a-history-store.js's exportHistoryAll). */
    historyListDocs() {
      return ipcRenderer.invoke("splitpage:history-list-docs");
    },

    getSessionInfo() {
      return ipcRenderer.invoke("splitpage:get-session-info");
    },

    openExternal(url) {
      ipcRenderer.send("splitpage:open-external", url);
    },

    /* ---- updates (see main.js section 9) --------------------------------
       Deliberately argument-free, all four of them. The page asks for the
       update to be downloaded and installed; it never gets to say what is
       downloaded or what is run — main chose the asset from the release it
       checked, and knows the only path it is willing to execute. */

    getUpdateStatus() {
      return ipcRenderer.invoke("splitpage:update-status");
    },

    checkForUpdate() {
      return ipcRenderer.invoke("splitpage:update-check");
    },

    downloadUpdate() {
      return ipcRenderer.invoke("splitpage:update-download");
    },

    installUpdate() {
      return ipcRenderer.invoke("splitpage:update-install");
    },

    onUpdateStatus(cb) {
      updateStatusCallback = cb;
    }
  };

  if (testMode) {
    /* Exists only so desktop/test/smoke.mjs can drive the SAME close a
       real user performs (BrowserWindow#close(), which fires the 'close'
       event main.js's dirty-document check depends on) instead of the
       page's own window.close(), which is a different, lighter-weight
       path — see main.js's splitpage:test-request-close comment. Never
       present outside SPLITPAGE_TEST=1. */
    bridge.__testRequestClose = () => ipcRenderer.send("splitpage:test-request-close");
    bridge.__testRequestQuit = () => ipcRenderer.send("splitpage:test-request-quit");
    /* The Ctrl+W path for THIS tab, so a test can close one tab of a window
       without touching the window. */
    bridge.__testRequestCloseTab = () => ipcRenderer.send("splitpage:test-request-close-tab");
    /* The shell driver (SMOKE-HARNESS shell()): create/activate/close/move
       tabs and read back what the shell thinks is open, without a real
       click, a real drag or a visible window. */
    bridge.__testShell = (op, args) => ipcRenderer.invoke("splitpage:test-shell", op, args);
    /* Runs main's own copy of planHistoryEviction over a fixture, so a smoke
       case can hold it against the renderer's original
       (window.__historyTest.planEviction) and prove the two have not drifted. */
    bridge.__testHistoryPlan = (fixture) => ipcRenderer.invoke("splitpage:test-history-plan", fixture);
    /* Runs main's real chooseDuplicateLoser (DOC-CLAIMS) over two claims the
       test invents, so a case can prove what the duplicate rule does with a
       given pair of birthtimes instead of reading the constant that gates
       it. Answers 'a', 'b' or null. */
    bridge.__testDupLoser = (a, b) => ipcRenderer.invoke("splitpage:test-dup-loser", a, b);
    /* What the draft store thinks of a tab: this one by default, or any tab
       of this run by id (a case that crashes a page has to ask about it from
       a different page). */
    bridge.__testDraftStatus = (tabId) => ipcRenderer.invoke("splitpage:test-draft-status", tabId);
    /* Kills this page's renderer the way a real crash does, so a smoke case
       can drive main's render-process-gone path — hold, reload, crash-loop
       guard — for real. The page does not come back from this call. */
    bridge.__testCrashRenderer = () => ipcRenderer.send("splitpage:test-crash-renderer");
  }

  contextBridge.exposeInMainWorld("splitpageDesktop", bridge);

}
