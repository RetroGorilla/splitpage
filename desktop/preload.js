"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");
function reviveFileEntry(entry) {
  return entry && entry.bytes && !(entry.bytes instanceof Uint8Array) && (entry = { ...entry, bytes: new Uint8Array(entry.bytes) }), entry;
}
if (location.origin === "splitpage://app") {
  const channelDirections = new Map();
  for (const entry of ipcRenderer.sendSync("splitpage:ipc-table-sync") || [])
    channelDirections.has(entry.name) || channelDirections.set(entry.name, new Set()), channelDirections.get(entry.name).add(entry.direction);
  const channel = (name, direction) => {
    const directions = channelDirections.get(name);
    if (!directions || !directions.has(direction))
      throw new Error("splitpage: " + name + " (" + direction + ") is not a channel this origin may use");
    return name;
  }, invoke = (name, ...args) => ipcRenderer.invoke(channel(name, "invoke"), ...args), send = (name, ...args) => ipcRenderer.send(channel(name, "send"), ...args), sendSync = (name, ...args) => ipcRenderer.sendSync(channel(name, "sendSync"), ...args), receive = (name, handler) => ipcRenderer.on(channel(name, "receive"), handler);
  let openFileCallback = null, menuCommandCallback = null, restoreNoticeCallback = null, reassignDocIdCallback = null, draftFlushCallback = null, updateStatusCallback = null, voiceEventCallback = null;
  receive("splitpage:open-file", (_event, entry) => {
    openFileCallback && openFileCallback(reviveFileEntry(entry));
  }), receive("splitpage:menu-command", (_event, command) => {
    menuCommandCallback && menuCommandCallback(command);
  }), receive("splitpage:restore-notice", (_event, payload) => {
    restoreNoticeCallback && restoreNoticeCallback(payload);
  }), receive("splitpage:update-status", (_event, status) => {
    updateStatusCallback && updateStatusCallback(status);
  }), receive("splitpage:voice-event", (_event, payload) => {
    voiceEventCallback && voiceEventCallback(payload);
  });
  const bundleProgress = new Map();
  receive("splitpage:bundle-progress", (_event, payload) => {
    const cb = payload && bundleProgress.get(payload.job);
    cb && cb({ done: payload.done, total: payload.total });
  });
  const bundleJob = (job, onProgress, run) => (typeof onProgress == "function" && bundleProgress.set(job, onProgress), run().finally(() => {
    bundleProgress.delete(job);
  }));
  let bundleCarryCallback = null;
  receive("splitpage:bundle-carry", (_event, payload) => {
    bundleCarryCallback && payload && bundleCarryCallback(payload);
  }), receive("splitpage:reassign-doc-id", (_event, payload) => {
    reassignDocIdCallback && reassignDocIdCallback(payload);
  }), receive("splitpage:draft-flush", (_event, reqId, keep) => {
    const reply = (result) => {
      try {
        send("splitpage:draft-flushed", reqId, result);
      } catch {
      }
    };
    if (typeof draftFlushCallback != "function") {
      reply({ ok: !1, code: "NO_TAB" });
      return;
    }
    Promise.resolve().then(() => draftFlushCallback({ keep: keep === !0 })).then(
      (result) => reply(result && typeof result == "object" ? result : { ok: !0 }),
      () => reply({ ok: !1 })
    );
  });
  const appVersion = sendSync("splitpage:get-app-version-sync"), boot = sendSync("splitpage:tab-boot-sync") || {}, tabId = typeof boot.tabId == "string" ? boot.tabId : null, windowId = typeof boot.windowId == "string" ? boot.windowId : null, launchIntent = boot.launchIntent && typeof boot.launchIntent == "object" ? { type: String(boot.launchIntent.type || "blank") } : { type: "blank" }, hadPriorSession = boot.hadPriorSession === !0, firstTabOfLaunch = boot.firstTabOfLaunch === !0, hasDraftToRestore = boot.hasDraftToRestore === !0, testMode = sendSync("splitpage:is-test-mode-sync"), bridge = {
    isDesktop: !0,
    platform: process.platform,
    appVersion,
    tabId,
    windowId,
    launchIntent,
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
    onRestoreNotice(cb) {
      restoreNoticeCallback = cb;
    },
    onReassignDocId(cb) {
      reassignDocIdCallback = cb;
    },
    onOpenFile(cb) {
      openFileCallback = cb, send("splitpage:renderer-ready");
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
      return invoke("splitpage:draft-take").then((taken) => (taken && taken.file && (taken.file = reviveFileEntry(taken.file)), taken));
    },
    draftRestoreDone(outcome) {
      send("splitpage:draft-restore-done", { outcome });
    },
    onDraftFlush(cb) {
      draftFlushCallback = cb;
    },
    historyPut(docId, meta, stateJson, opts) {
      const o = opts && typeof opts == "object" ? opts : {}, wire = { protect: Array.isArray(o.protect) ? o.protect : [] };
      return o.older === !0 && (wire.older = !0), invoke("splitpage:history-put", docId, meta, stateJson, wire);
    },
    historyList(docId) {
      return invoke("splitpage:history-list", docId ?? null);
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
      return invoke("splitpage:blob-get", sha).then((got) => (got && got.bytes && !(got.bytes instanceof Uint8Array) && (got = { ...got, bytes: new Uint8Array(got.bytes) }), got || null));
    },
    blobMissing(shas) {
      return invoke("splitpage:blob-missing", shas);
    },
    printToPdf(html) {
      return invoke("splitpage:print-to-pdf", html).then((bytes) => new Uint8Array(bytes));
    },
    nativeReplica: (...args) => invoke("splitpage:native-replica", ...args),
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
      try {
        filePath = webUtils.getPathForFile(file) || "";
      } catch {
        filePath = "";
      }
      return filePath ? invoke("splitpage:video-file-grant", filePath).then((t) => typeof t == "string" ? t : null, () => null) : Promise.resolve(null);
    },
    openVideoFile(token) {
      return invoke("splitpage:video-file-open", String(token || ""));
    },
    videoFilePath(file) {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
    openVideoPath(storedPath, size) {
      return Number.isSafeInteger(size) ? invoke("splitpage:video-path-open", String(storedPath || ""), size) : invoke("splitpage:video-path-open", String(storedPath || ""));
    },
    bundleVideoFile(token, job, onProgress) {
      const id = String(job || "");
      return bundleJob(id, onProgress, () => invoke("splitpage:bundle-file", String(token || ""), id));
    },
    moveVideoFile(token, job, onProgress) {
      const id = String(job || "");
      return bundleJob(id, onProgress, () => invoke("splitpage:bundle-move", String(token || ""), id));
    },
    planCreateBundle(paths) {
      return invoke("splitpage:bundle-create-plan", paths);
    },
    bundlePath(path, job, choice, onProgress) {
      const id = String(job || "");
      return bundleJob(id, onProgress, () => invoke("splitpage:bundle-path", path, id, choice));
    },
    onBundleCarry(cb) {
      bundleCarryCallback = typeof cb == "function" ? cb : null;
    },
    cancelBundle(job) {
      send("splitpage:bundle-cancel", String(job || ""));
    },
    openBundledFile(name) {
      return invoke("splitpage:bundled-file-open", String(name || ""));
    },
    planBundleSave(fileId, names) {
      return invoke("splitpage:bundle-save-plan", String(fileId || ""), Array.isArray(names) ? names.map((n) => String(n)) : []);
    },
    chooseBundleSave(fileId, choice) {
      return invoke("splitpage:bundle-save-choice", String(fileId || ""), String(choice || ""));
    },
    planBundleExport(job, scriptName, data, scriptId) {
      return invoke("splitpage:bundle-export-plan", String(job || ""), String(scriptName || ""), data, String(scriptId || ""));
    },
    exportBundle(job, fileId, onProgress) {
      const id = String(job || "");
      return bundleJob(id, onProgress, () => invoke("splitpage:bundle-export", id, String(fileId || "")));
    },
    videoThumbnail(host, ref) {
      return invoke("splitpage:video-thumbnail", host, ref).then((got) => (got && got.ok && got.bytes && !(got.bytes instanceof Uint8Array) && (got = { ...got, bytes: new Uint8Array(got.bytes) }), got || { ok: !1, code: "UNAVAILABLE" }), () => ({ ok: !1, code: "REFUSED" }));
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
    voiceStart(microphone) {
      return microphone === void 0 ? invoke("splitpage:voice-start") : invoke("splitpage:voice-start", microphone);
    },
    voiceMicrophones() {
      return invoke("splitpage:voice-microphones");
    },
    voiceStop(session) {
      return session === void 0 ? invoke("splitpage:voice-stop") : invoke("splitpage:voice-stop", session);
    },
    onVoiceEvent(cb) {
      voiceEventCallback = cb;
    }
  };
  testMode && (bridge.__testRequestClose = () => send("splitpage:test-request-close"), bridge.__testRequestQuit = () => send("splitpage:test-request-quit"), bridge.__testRequestCloseTab = () => send("splitpage:test-request-close-tab"), bridge.__testShell = (op, args) => invoke("splitpage:test-shell", op, args), bridge.__testDupLoser = (a, b) => invoke("splitpage:test-dup-loser", a, b), bridge.__testDraftStatus = (tabId2) => invoke("splitpage:test-draft-status", tabId2), bridge.__testCrashRenderer = () => send("splitpage:test-crash-renderer")), contextBridge.exposeInMainWorld("splitpageDesktop", bridge);
}
