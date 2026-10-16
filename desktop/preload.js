"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

if (location.origin === "splitpage://app") {
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
  receive("splitpage:update-status", (_event, status) => {
    if (updateStatusCallback) updateStatusCallback(status);
  });
  receive("splitpage:voice-event", (_event, payload) => {
    if (voiceEventCallback) voiceEventCallback(payload);
  });
  receive("splitpage:reassign-doc-id", (_event, payload) => {
    if (reassignDocIdCallback) reassignDocIdCallback(payload);
  });
  receive("splitpage:draft-flush", (_event, reqId, keep) => {
    const reply = (result) => {
      try { send("splitpage:draft-flushed", reqId, result); } catch (_) { }
    };
    if (typeof draftFlushCallback !== "function") { reply({ ok: false, code: "NO_TAB" }); return; }
    Promise.resolve()
      .then(() => draftFlushCallback({ keep: keep === true }))
      .then(
        (result) => reply(result && typeof result === "object" ? result : { ok: true }),
        () => reply({ ok: false })
      );
  });

  function reviveFileEntry(entry) {
    if (entry && entry.bytes && !(entry.bytes instanceof Uint8Array)) {
      entry = { ...entry, bytes: new Uint8Array(entry.bytes) };
    }
    return entry;
  }

  const appVersion = sendSync("splitpage:get-app-version-sync");

  const boot = sendSync("splitpage:tab-boot-sync") || {};
  const tabId = typeof boot.tabId === "string" ? boot.tabId : null;
  const windowId = typeof boot.windowId === "string" ? boot.windowId : null;
  const launchIntent = boot.launchIntent && typeof boot.launchIntent === "object"
    ? { type: String(boot.launchIntent.type || "blank") }
    : { type: "blank" };
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

  const testMode = sendSync("splitpage:is-test-mode-sync");

  const bridge = {
    isDesktop: true,
    platform: process.platform,
    appVersion,

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

    routeOpen(payload) {
      return invoke("splitpage:route-open", payload);
    },

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
      send("splitpage:renderer-ready");
    },

    onMenuCommand(cb) {
      menuCommandCallback = cb;
    },

    setDocumentState(state) {
      send("splitpage:set-document-state", state);
    },

    writeDraft(payload) {
      return invoke("splitpage:draft-write", payload);
    },

    discardDraft(seq) {
      return invoke("splitpage:draft-discard", { seq });
    },

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

    historyPut(docId, meta, stateJson, opts) {
      const o = opts && typeof opts === "object" ? opts : {};
      const wire = { protect: Array.isArray(o.protect) ? o.protect : [] };
      if (o.older === true) wire.older = true;
      return invoke("splitpage:history-put", docId, meta, stateJson, wire);
    },

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

    historyListDocs() {
      return invoke("splitpage:history-list-docs");
    },

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

    setTheme(mode) {
      send("splitpage:set-theme", String(mode));
    },

    grantVideoFile(file) {
      let filePath;
      try { filePath = webUtils.getPathForFile(file) || ""; } catch { filePath = ""; }
      if (!filePath) return Promise.resolve(null);
      return invoke("splitpage:video-file-grant", filePath).then((t) => (typeof t === "string" ? t : null), () => null);
    },

    openVideoFile(token) {
      return invoke("splitpage:video-file-open", String(token || ""));
    },

    videoThumbnail(host, ref) {
      return invoke("splitpage:video-thumbnail", host, ref).then((got) => {
        if (got && got.ok && got.bytes && !(got.bytes instanceof Uint8Array)) got = { ...got, bytes: new Uint8Array(got.bytes) };
        return got || { ok: false, code: "UNAVAILABLE" };
      }, () => ({ ok: false, code: "REFUSED" }));
    },

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

    openPrompterInBrowser() {
      return invoke("splitpage:prompter-open-in-browser");
    },

    openPrompterInChromium() {
      return invoke("splitpage:prompter-open-in-chromium");
    },

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

    driveStatus() {
      return invoke("splitpage:drive-status");
    },

    driveSignIn() {
      return invoke("splitpage:drive-sign-in");
    },

    driveSignOut() {
      return invoke("splitpage:drive-sign-out");
    },

    driveList(folderId) {
      return invoke("splitpage:drive-list", folderId);
    },

    driveDownload(fileId) {
      return invoke("splitpage:drive-download", fileId);
    },

    driveUpload(request) {
      return invoke("splitpage:drive-upload", request);
    }
  };

  if (testMode) {
    bridge.__testRequestClose = () => send("splitpage:test-request-close");
    bridge.__testRequestQuit = () => send("splitpage:test-request-quit");
    bridge.__testRequestCloseTab = () => send("splitpage:test-request-close-tab");
    bridge.__testShell = (op, args) => invoke("splitpage:test-shell", op, args);
    bridge.__testDupLoser = (a, b) => invoke("splitpage:test-dup-loser", a, b);
    bridge.__testDraftStatus = (tabId) => invoke("splitpage:test-draft-status", tabId);
    bridge.__testCrashRenderer = () => send("splitpage:test-crash-renderer");
  }

  contextBridge.exposeInMainWorld("splitpageDesktop", bridge);

}
