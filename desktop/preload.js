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
  /* THE CHANNEL TABLE (desktop/ipc-channels.js) is the one list of channels
     this app has, and this script is held to it twice over: here, at
     runtime, and by desktop/test/ipc-table.test.mjs, which reads both
     preloads and the table and fails if either names a channel the other
     does not.

     It cannot simply be required. This script runs sandboxed (sandbox: true
     on every window and every tab view main.js makes) and a sandboxed
     preload's `require` resolves 'electron', 'events', 'timers' and 'url' —
     never a file off disk. So main hands this origin its own rows over
     instead, synchronously, exactly like the three boot reads further down.

     Every crossing below goes through invoke/send/sendSync/receive rather
     than ipcRenderer directly, and a name the table does not list FOR THIS
     ORIGIN throws. That is the fail-closed part, and it needs no branch of
     its own: the first of those calls happens at preload time, so a table
     that never arrived takes this script down long before
     contextBridge.exposeInMainWorld at the bottom, and the page gets no
     bridge at all rather than a bridge of unchecked names. */
  const channelDirections = new Map();
  for (const entry of ipcRenderer.sendSync("splitpage:ipc-table-sync") || []) {
    if (!channelDirections.has(entry.name)) channelDirections.set(entry.name, new Set());
    channelDirections.get(entry.name).add(entry.direction);
  }

  const channel = (name, direction) => {
    const directions = channelDirections.get(name);
    if (!directions || !directions.has(direction)) {
      throw new Error("splitpage: " + name + " (" + direction + ") is not a channel this origin may use");
    }
    return name;
  };

  const invoke = (name, ...args) => ipcRenderer.invoke(channel(name, "invoke"), ...args);
  const send = (name, ...args) => ipcRenderer.send(channel(name, "send"), ...args);
  const sendSync = (name, ...args) => ipcRenderer.sendSync(channel(name, "sendSync"), ...args);
  const receive = (name, handler) => ipcRenderer.on(channel(name, "receive"), handler);

  let openFileCallback = null;
  let menuCommandCallback = null;
  let openServerDocCallback = null;
  let restoreNoticeCallback = null;
  let reassignDocIdCallback = null;
  let draftFlushCallback = null;
  let updateStatusCallback = null;
  let voiceEventCallback = null;

  receive("splitpage:open-file", (_event, entry) => {
    if (openFileCallback) openFileCallback(reviveFileEntry(entry));
  });
  receive("splitpage:menu-command", (_event, command) => {
    if (menuCommandCallback) menuCommandCallback(command);
  });
  receive("splitpage:open-server-doc", (_event, payload) => {
    if (openServerDocCallback) openServerDocCallback(payload);
  });
  receive("splitpage:restore-notice", (_event, payload) => {
    if (restoreNoticeCallback) restoreNoticeCallback(payload);
  });
  /* UPDATES: main pushes the whole status object whenever it changes — the
     launch check settling, and every step of a download. Pushed rather than
     polled because the check finishes after this page has already loaded and
     read the status once. */
  receive("splitpage:update-status", (_event, status) => {
    if (updateStatusCallback) updateStatusCallback(status);
  });
  /* FOLLOW MY VOICE (main.js section 9d): what the Windows listener heard,
     for this tab's session only — {type, session, text | code | lang}. */
  receive("splitpage:voice-event", (_event, payload) => {
    if (voiceEventCallback) voiceEventCallback(payload);
  });
  /* DOC-CLAIMS: main has decided this page's document is a copy of one open
     in another tab, and is handing it a replacement identity. The payload is
     three plain values ({fromId, toId, otherTitle}) — the renderer validates
     all three again before it applies anything. */
  receive("splitpage:reassign-doc-id", (_event, payload) => {
    if (reassignDocIdCallback) reassignDocIdCallback(payload);
  });
  /* DRAFT-IPC-AND-SHAPES: main is asking this page to write whatever it is
     holding RIGHT NOW (Windows is signing the user out). The reply always
     goes back, quoting the same reqId — including when the page has no
     handler or the handler throws — because main is waiting on a budget and
     an answer that never comes costs it the whole budget for nothing. */
  receive("splitpage:draft-flush", (_event, reqId) => {
    const reply = (result) => {
      try { send("splitpage:draft-flushed", reqId, result); } catch (_) { /* main is gone */ }
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
  const appVersion = sendSync("splitpage:get-app-version-sync");

  /* TAB-BOOT-SYNC: also synchronous, also read exactly once at preload time.
     The renderer's boot sequence has to know what this page is FOR before it
     decides anything — an IPC round trip would race those decisions instead
     of settling them. Every field is a scalar the main process computed; the
     launch intent deliberately carries no path and no server document id
     (invariant #34), only what kind of boot this is.

     A null answer means "not a tab page" (main did not recognise the sender).
     Nothing can be assumed in that case, so every field falls back to the
     quietest possible value: a blank page with no prior session. */
  const boot = sendSync("splitpage:tab-boot-sync") || {};
  const tabId = typeof boot.tabId === "string" ? boot.tabId : null;
  const windowId = typeof boot.windowId === "string" ? boot.windowId : null;
  const launchIntent = boot.launchIntent && typeof boot.launchIntent === "object"
    ? { type: String(boot.launchIntent.type || "blank") }
    : { type: "blank" };
  /* #11: a server tab's connection — the server its document is on, the
     SSH forward it rides (host and ports), and, only for a tab another tab
     opened, the token that tab handed over so this one does not ask for the
     PIN again. Copied field by field as plain scalars, and frozen: the page
     reads it once, at boot, to decide where its first request goes. */
  const bootConn = boot.connection && typeof boot.connection === "object" ? boot.connection : null;
  const bootTunnel = bootConn && bootConn.tunnel && typeof bootConn.tunnel === "object" ? bootConn.tunnel : null;
  const connection = bootConn ? Object.freeze({
    serverUrl: typeof bootConn.serverUrl === "string" ? bootConn.serverUrl : "",
    token: typeof bootConn.token === "string" ? bootConn.token : "",
    tunnel: bootTunnel ? Object.freeze({
      userHost: String(bootTunnel.userHost || ""),
      remotePort: Number(bootTunnel.remotePort),
      localPort: Number(bootTunnel.localPort)
    }) : null
  }) : null;
  const hadPriorSession = boot.hadPriorSession === true;
  const firstTabOfLaunch = boot.firstTabOfLaunch === true;
  const hasDraftToRestore = boot.hasDraftToRestore === true;

  /* Also read once, at preload time: gates whether the TEST_MODE-only
     __testRequestClose/__testRequestQuit hooks below get exposed at all.
     The answer comes from the main process's own TEST_MODE flag (see
     main.js's splitpage:is-test-mode-sync), not from this script re-reading
     SPLITPAGE_TEST itself, so there is exactly one source of truth for "is
     this a test run" and preload can never disagree with main about it. */
  const testMode = sendSync("splitpage:is-test-mode-sync");

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
    connection,
    hadPriorSession,
    firstTabOfLaunch,
    hasDraftToRestore,

    openFileDialog() {
      return invoke("splitpage:open-file-dialog").then(reviveFileEntry);
    },

    saveFileDialog(options) {
      return invoke("splitpage:save-file-dialog", options || {});
    },

    readFile(id) {
      return invoke("splitpage:read-file", id).then(reviveFileEntry);
    },

    writeFile(id, data) {
      return invoke("splitpage:write-file", id, data);
    },

    statFile(id) {
      return invoke("splitpage:stat-file", id);
    },

    /* "Open this" — main decides WHERE it lands (this tab, a tab that
       already has it, or a new one) and answers which of the three it was.
       The payload names a document by opaque file id or server document id,
       never by path. A server document also names the server it is on and
       carries this tab's token for it, once, so a new tab main opens for it
       does not ask for the PIN again (#11) — main keeps that in memory only. */
    routeOpen(payload) {
      return invoke("splitpage:route-open", payload);
    },

    /* Recent documents (DESKTOP-RECENTS), the New Tab page's third column.
       Desktop only — the browser build has no equivalent and shows no
       column. Each entry is {fileId, name, title, at}: an opaque id, the
       file's basename and the title the document last reported, never a
       path. `fileId` is what routeOpen({kind:'file', fileId}) takes, so a
       click reopens with no picker. All three resolve to the list as it
       stands afterwards, so the page never has to re-ask. */
    listRecents() {
      return invoke("splitpage:recents-list");
    },

    removeRecent(fileId) {
      return invoke("splitpage:recents-remove", fileId);
    },

    clearRecents() {
      return invoke("splitpage:recents-clear");
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
      send("splitpage:renderer-ready");
    },

    onMenuCommand(cb) {
      menuCommandCallback = cb;
    },

    setDocumentState(state) {
      send("splitpage:set-document-state", state);
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
      return invoke("splitpage:draft-write", payload);
    },

    discardDraft(seq) {
      return invoke("splitpage:draft-discard", { seq });
    },

    /* The crash draft for THIS tab, if there is one, with the file it was
       taken from already read (main resolves the path from its own header —
       the page never sees it). Nothing is deleted by taking: the draft stays
       until draftRestoreDone says what happened to it. */
    takeDraft() {
      return invoke("splitpage:draft-take").then((taken) => {
        if (taken && taken.file) taken.file = reviveFileEntry(taken.file);
        return taken;
      });
    },

    draftRestoreDone(outcome) {
      send("splitpage:draft-restore-done", { outcome });
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

       historyPut's `opts` is the store's options bag: `protect` is the list
       of snapshots a restore is currently reading, so main's eviction can
       skip them (src/js/03a-history-store.js fills it in from
       protectHistorySnapshot); `older: true` writes into the Older bucket,
       and then docId must be null — Older is named by that flag, never by
       a string (#83 step 4 folded history-import-older into this). Only a
       literal true is passed on, so nothing else can smuggle the flag in. */
    historyPut(docId, meta, stateJson, opts) {
      const o = opts && typeof opts === "object" ? opts : {};
      const wire = { protect: Array.isArray(o.protect) ? o.protect : [] };
      if (o.older === true) wire.older = true;
      return invoke("splitpage:history-put", docId, meta, stateJson, wire);
    },

    /* {entries, older, olderExpiresAt, usage} — usage is main's
       {totalBytes, capBytes, overCap, docCount, readOnly} (or null), which
       used to be a call of its own. */
    historyList(docId) {
      return invoke("splitpage:history-list", docId == null ? null : docId);
    },

    historyGet(query, snapshotId) {
      return invoke("splitpage:history-get", query, snapshotId);
    },

    historyCopy(fromDocId, toDocId) {
      return invoke("splitpage:history-copy", fromDocId, toDocId);
    },

    historyTouch(docId, title) {
      return invoke("splitpage:history-touch", docId, title);
    },

    /* Every document this store has history for — {docId, title,
       lastOpenedAt}[], Older excluded. Backs File > Export app data.. on
       desktop (20h-appdata.js / 03a-history-store.js's exportHistoryAll). */
    historyListDocs() {
      return invoke("splitpage:history-list-docs");
    },

    /* ---- content-addressed blobs (issue #82, main.js section 8c) ---------
       Images live outside the document state, in <userData>/blobs, named by
       the SHA-256 of their bytes. The page names a blob by that sha (64
       lowercase hex) and nothing else — no path, no folder, no URL
       (invariant #28). src/js/20f-desktop.js's makeDesktopBlobBackend turns
       these into the page registry's backend.

       blobPut(sha, bytes): the bytes must hash to the sha and be a PNG,
       JPEG, GIF or WebP of at most 16 MiB. Answers {ok:true, stored} or
       {ok:false, code}.
       blobGet(sha): {bytes: Uint8Array, mime} or null.
       blobMissing(shas): the subset of shas (at most 2000) main does not
       hold. */
    blobPut(sha, bytes) {
      return invoke("splitpage:blob-put", sha, bytes);
    },

    blobGet(sha) {
      return invoke("splitpage:blob-get", sha).then((got) => {
        if (got && got.bytes && !(got.bytes instanceof Uint8Array)) got = { ...got, bytes: new Uint8Array(got.bytes) };
        return got || null;
      });
    },

    blobMissing(shas) {
      return invoke("splitpage:blob-missing", shas);
    },

    getSessionInfo() {
      return invoke("splitpage:get-session-info");
    },

    openExternal(url) {
      send("splitpage:open-external", url);
    },

    /* ---- updates (see main.js section 9) --------------------------------
       Deliberately argument-free, all four of them. The page asks for the
       update to be downloaded and installed; it never gets to say what is
       downloaded or what is run — main chose the asset from the release it
       checked, and knows the only path it is willing to execute. */

    getUpdateStatus() {
      return invoke("splitpage:update-status");
    },

    checkForUpdate() {
      return invoke("splitpage:update-check");
    },

    downloadUpdate() {
      return invoke("splitpage:update-download");
    },

    installUpdate() {
      return invoke("splitpage:update-install");
    },

    onUpdateStatus(cb) {
      updateStatusCallback = cb;
    },

    /* ---- the teleprompter in the browser (main.js section 9b) -----------
       Argument-free for the same reason the update calls are: the page asks
       for what it is showing to be opened in the default browser, and main
       decides what that is and what URL reaches it. Answers {ok:true, kind}
       or {ok:false, code} — never the URL. */
    openPrompterInBrowser() {
      return invoke("splitpage:prompter-open-in-browser");
    },

    /* The same, in an installed Chromium browser rather than the default
       one (issue #123). Answers {ok:true, kind, browser} or {ok:false,
       code} — NO_CHROMIUM when none is installed. */
    openPrompterInChromium() {
      return invoke("splitpage:prompter-open-in-chromium");
    },

    /* ---- Follow My Voice (main.js section 9d, issue #8) -----------------
       Argument-free (invariant #45): whether this machine can listen
       ({available}), start listening for this tab ({ok, session} or
       {ok:false, code}) and stop. What is heard arrives through
       onVoiceEvent. */
    voiceStatus() {
      return invoke("splitpage:voice-status");
    },

    voiceStart() {
      return invoke("splitpage:voice-start");
    },

    voiceStop() {
      return invoke("splitpage:voice-stop");
    },

    onVoiceEvent(cb) {
      voiceEventCallback = cb;
    },

    /* ---- Google Drive (main.js section 9c, issue #10) -------------------
       Main holds the OAuth listener, the tokens and every request to Google;
       these hand back names, ids, bytes and {ok:false, code} — never a
       token, never a URL. The account calls take no argument (invariant
       #28): the page cannot name the address the browser is sent to. */
    driveStatus() {
      return invoke("splitpage:drive-status");
    },

    driveSignIn() {
      return invoke("splitpage:drive-sign-in");
    },

    driveSignOut() {
      return invoke("splitpage:drive-sign-out");
    },

    /* A Drive folder id ("root" is My Drive). */
    driveList(folderId) {
      return invoke("splitpage:drive-list", folderId);
    },

    /* A Drive file id. Answers {ok, file:{id, name, mimeType, size,
       modifiedTime}, bytes}. */
    driveDownload(fileId) {
      return invoke("splitpage:drive-download", fileId);
    },

    /* {parentId, name, bytes, mimeType?} makes a new file in that folder;
       {fileId, bytes, mimeType?} replaces an existing file's content. */
    driveUpload(request) {
      return invoke("splitpage:drive-upload", request);
    }
  };

  if (testMode) {
    /* Exists only so desktop/test/smoke.mjs can drive the SAME close a
       real user performs (BrowserWindow#close(), which fires the 'close'
       event main.js's dirty-document check depends on) instead of the
       page's own window.close(), which is a different, lighter-weight
       path — see main.js's splitpage:test-request-close comment. Never
       present outside SPLITPAGE_TEST=1. */
    bridge.__testRequestClose = () => send("splitpage:test-request-close");
    bridge.__testRequestQuit = () => send("splitpage:test-request-quit");
    /* The Ctrl+W path for THIS tab, so a test can close one tab of a window
       without touching the window. */
    bridge.__testRequestCloseTab = () => send("splitpage:test-request-close-tab");
    /* The shell driver (SMOKE-HARNESS shell()): create/activate/close/move
       tabs and read back what the shell thinks is open, without a real
       click, a real drag or a visible window. */
    bridge.__testShell = (op, args) => invoke("splitpage:test-shell", op, args);
    /* Runs main's real chooseDuplicateLoser (DOC-CLAIMS) over two claims the
       test invents, so a case can prove what the duplicate rule does with a
       given pair instead of reading the source. Answers 'a', 'b' or null.
       (__testHistoryPlan sat here too, running main's copy of
       planHistoryEviction; #76 left one shared planner and nothing to
       compare it with.) */
    bridge.__testDupLoser = (a, b) => invoke("splitpage:test-dup-loser", a, b);
    /* What the draft store thinks of a tab: this one by default, or any tab
       of this run by id (a case that crashes a page has to ask about it from
       a different page). */
    bridge.__testDraftStatus = (tabId) => invoke("splitpage:test-draft-status", tabId);
    /* Kills this page's renderer the way a real crash does, so a smoke case
       can drive main's render-process-gone path — hold, reload, crash-loop
       guard — for real. The page does not come back from this call. */
    bridge.__testCrashRenderer = () => send("splitpage:test-crash-renderer");
  }

  contextBridge.exposeInMainWorld("splitpageDesktop", bridge);

}
