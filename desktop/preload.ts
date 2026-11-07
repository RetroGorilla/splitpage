"use strict";

import type { DesktopPort, DesktopFileEntry } from "../src/adapters/desktop/desktop-port.ts";
import type { DesktopChannel } from "./ipc-channels.ts";
import type { DesktopChannelRow, DesktopIpcArgs, DesktopIpcContract, DesktopIpcReceiveArgs, DesktopIpcResult } from "../shared/desktop-contract.d.ts";

type PreloadChannelName<D extends DesktopChannelRow["direction"]> = Extract<DesktopChannel, { direction: D }>["name"];

interface PreloadElectronBoundary {
  contextBridge: { exposeInMainWorld: (name: string, value: DesktopPort & Partial<PreloadTestHooks>) => void };
  ipcRenderer: {
    invoke: <C extends PreloadChannelName<"invoke">>(name: C, ...args: DesktopIpcArgs<C>) => Promise<DesktopIpcResult<C>>;
    send: <C extends PreloadChannelName<"send">>(name: C, ...args: DesktopIpcArgs<C>) => void;
    sendSync: <C extends PreloadChannelName<"sendSync">>(name: C, ...args: DesktopIpcArgs<C>) => DesktopIpcResult<C>;
    on: <C extends PreloadChannelName<"receive">>(name: C, handler: (event: unknown, ...args: DesktopIpcReceiveArgs<C>) => void) => void;
  };
  webUtils: { getPathForFile: (file: unknown) => string };
}

interface PreloadTestHooks {
  __testRequestClose: () => void;
  __testRequestQuit: () => void;
  __testRequestCloseTab: () => void;
  __testShell: (...args: DesktopIpcArgs<"splitpage:test-shell">) => Promise<DesktopIpcResult<"splitpage:test-shell">>;
  __testDupLoser: (...args: DesktopIpcArgs<"splitpage:test-dup-loser">) => Promise<DesktopIpcResult<"splitpage:test-dup-loser">>;
  __testDraftStatus: (...args: DesktopIpcArgs<"splitpage:test-draft-status">) => Promise<DesktopIpcResult<"splitpage:test-draft-status">>;
  __testCrashRenderer: () => void;
}


const { contextBridge, ipcRenderer, webUtils }: PreloadElectronBoundary = require("electron");

if (location.origin === "splitpage://app") {
  const channelDirections = new Map<keyof DesktopIpcContract, Set<DesktopChannelRow["direction"]>>();
  for (const entry of ipcRenderer.sendSync("splitpage:ipc-table-sync") || []) {
    if (!channelDirections.has(entry.name)) channelDirections.set(entry.name, new Set());
    (channelDirections.get(entry.name) as Set<DesktopChannelRow["direction"]>).add(entry.direction);
  }

  const channel = <C extends keyof DesktopIpcContract>(name: C, direction: DesktopChannelRow["direction"]): C => {
    const directions = channelDirections.get(name);
    if (!directions || !directions.has(direction)) {
      throw new Error("splitpage: " + name + " (" + direction + ") is not a channel this origin may use");
    }
    return name;
  };

  const invoke = <C extends PreloadChannelName<"invoke">>(name: C, ...args: DesktopIpcArgs<C>) => ipcRenderer.invoke(channel(name, "invoke"), ...args);
  const send = <C extends PreloadChannelName<"send">>(name: C, ...args: DesktopIpcArgs<C>) => ipcRenderer.send(channel(name, "send"), ...args);
  const sendSync = <C extends PreloadChannelName<"sendSync">>(name: C, ...args: DesktopIpcArgs<C>) => ipcRenderer.sendSync(channel(name, "sendSync"), ...args);
  const receive = <C extends PreloadChannelName<"receive">>(name: C, handler: (event: unknown, ...args: DesktopIpcReceiveArgs<C>) => void) => ipcRenderer.on(channel(name, "receive"), handler);

  let openFileCallback: Parameters<DesktopPort["onOpenFile"]>[0] | null = null;
  let menuCommandCallback: Parameters<DesktopPort["onMenuCommand"]>[0] | null = null;
  let restoreNoticeCallback: Parameters<DesktopPort["onRestoreNotice"]>[0] | null = null;
  let reassignDocIdCallback: Parameters<DesktopPort["onReassignDocId"]>[0] | null = null;
  let draftFlushCallback: Parameters<DesktopPort["onDraftFlush"]>[0] | null = null;
  let updateStatusCallback: Parameters<DesktopPort["onUpdateStatus"]>[0] | null = null;
  let voiceEventCallback: Parameters<DesktopPort["onVoiceEvent"]>[0] | null = null;

  receive("splitpage:open-file", (_event, entry) => {
    if (openFileCallback) openFileCallback(reviveFileEntry(entry));
  });
  receive("splitpage:menu-command", (_event, command) => {
    if (menuCommandCallback) menuCommandCallback(command);
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
  const bundleProgress = new Map<string, Parameters<DesktopPort["bundleVideoFile"]>[2]>();
  receive("splitpage:bundle-progress", (_event, payload) => {
    const cb = payload && bundleProgress.get(payload.job);
    if (cb) cb({ done: payload.done, total: payload.total });
  });
  function bundleJob<T>(job: string, onProgress: Parameters<DesktopPort["bundleVideoFile"]>[2], run: () => Promise<T>): Promise<T> {
    if (typeof onProgress === "function") bundleProgress.set(job, onProgress);
    return run().finally(() => { bundleProgress.delete(job); });
  }
  let bundleCarryCallback: Parameters<DesktopPort["onBundleCarry"]>[0] | null = null;
  receive("splitpage:bundle-carry", (_event, payload) => {
    if (bundleCarryCallback && payload) bundleCarryCallback(payload);
  });
  receive("splitpage:reassign-doc-id", (_event, payload) => {
    if (reassignDocIdCallback) reassignDocIdCallback(payload);
  });
  receive("splitpage:draft-flush", (_event, reqId, keep) => {
    const reply = (result: DesktopIpcArgs<"splitpage:draft-flushed">[1]) => {
      try { send("splitpage:draft-flushed", reqId, result); } catch (_) { }
    };
    if (typeof draftFlushCallback !== "function") { reply({ ok: false, code: "NO_TAB" }); return; }
    Promise.resolve()
      .then(() => (draftFlushCallback as NonNullable<typeof draftFlushCallback>)({ keep: keep === true }))
      .then(
        (result) => reply(result && typeof result === "object" ? result : { ok: true }),
        () => reply({ ok: false })
      );
  });

  function reviveFileEntry(entry: DesktopFileEntry): DesktopFileEntry;
  function reviveFileEntry(entry: DesktopFileEntry | null): DesktopFileEntry | null;
  function reviveFileEntry(entry: DesktopFileEntry | null): DesktopFileEntry | null {
    if (entry && entry.bytes && !(entry.bytes instanceof Uint8Array)) {
      entry = { ...entry, bytes: new Uint8Array(entry.bytes) };
    }
    return entry;
  }

  const appVersion = sendSync("splitpage:get-app-version-sync");

  const boot: Partial<NonNullable<DesktopIpcResult<"splitpage:tab-boot-sync">>> = sendSync("splitpage:tab-boot-sync") || {};
  const tabId = typeof boot.tabId === "string" ? boot.tabId : null;
  const windowId = typeof boot.windowId === "string" ? boot.windowId : null;
  const launchIntent = boot.launchIntent && typeof boot.launchIntent === "object"
    ? { type: String(boot.launchIntent.type || "blank") }
    : { type: "blank" };
  const hadPriorSession = boot.hadPriorSession === true;
  const firstTabOfLaunch = boot.firstTabOfLaunch === true;
  const hasDraftToRestore = boot.hasDraftToRestore === true;

  const testMode = sendSync("splitpage:is-test-mode-sync");

  const bridge: DesktopPort & Partial<PreloadTestHooks> = {
    isDesktop: true,
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
      return invoke("splitpage:read-file", id).then<DesktopFileEntry>(reviveFileEntry);
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
      const wire: DesktopIpcArgs<"splitpage:history-put">[3] = { protect: Array.isArray(o.protect) ? o.protect : [] };
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

    printToPdf(html) {
      return invoke("splitpage:print-to-pdf", html).then((bytes) => new Uint8Array(bytes));
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

    videoFilePath(file) {
      try { return webUtils.getPathForFile(file) || null; } catch { return null; }
    },

    openVideoPath(storedPath) {
      return invoke("splitpage:video-path-open", String(storedPath || ""));
    },

    bundleVideoFile(token, job, onProgress) {
      const id = String(job || "");
      return bundleJob(id, onProgress, () => invoke("splitpage:bundle-file", String(token || ""), id));
    },

    onBundleCarry(cb) {
      bundleCarryCallback = typeof cb === "function" ? cb : null;
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

    videoThumbnail(host, ref) {
      return invoke("splitpage:video-thumbnail", host, ref).then((got): Awaited<ReturnType<DesktopPort["videoThumbnail"]>> => {
        if (got && got.ok && got.bytes && !(got.bytes instanceof Uint8Array)) got = { ...got, bytes: new Uint8Array(got.bytes) };
        return got || { ok: false, code: "UNAVAILABLE" };
      }, (): Awaited<ReturnType<DesktopPort["videoThumbnail"]>> => ({ ok: false, code: "REFUSED" }));
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
      return microphone === undefined ? invoke("splitpage:voice-start") : invoke("splitpage:voice-start", microphone);
    },

    voiceMicrophones() {
      return invoke("splitpage:voice-microphones");
    },

    voiceStop(session) {
      return session === undefined ? invoke("splitpage:voice-stop") : invoke("splitpage:voice-stop", session);
    },

    onVoiceEvent(cb) {
      voiceEventCallback = cb;
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
