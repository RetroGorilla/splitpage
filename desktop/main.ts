"use strict";

import type { DesktopNativePath, DesktopNativeFsPromises, DesktopNativeFs } from "./native-inputs.d.ts";

import type { DesktopMainTab, DesktopMainWindow } from "./main-types.d.ts";
import type { DesktopIpcEvent, DesktopFileIpcDependencies } from "./ipc-boundaries.d.ts";

import type { DesktopWireHistoryMeta, DesktopWireUpdateStatus, DesktopIpcArgs, DesktopIpcResult } from "../shared/desktop-contract.d.ts";

import type * as Electron from "electron";
import type * as NodeCrypto from "node:crypto";
import type * as NodeChildProcess from "node:child_process";
import type * as Drafts from "./drafts.ts";
import type * as FileService from "./file-service.ts";
import type * as DocClaims from "./doc-claims.ts";
import type * as Recents from "./recents.ts";
import type * as WindowAppearance from "./window-appearance.ts";
import type * as TabRegistry from "./tab-registry.ts";
import type * as RestoreNotice from "./restore-notice.ts";
import type * as PrompterShare from "./prompter-share.ts";
import type * as CloseQuit from "./close-quit.ts";
import type * as SessionRestore from "./session-restore.ts";
import type * as VoiceComposition from "./voice-composition.ts";
import type * as ChromiumBrowsers from "./chromium-browsers.ts";
import type * as BlobStore from "./blob-store.ts";
import type * as HistoryFsBackend from "./history-fs-backend.ts";
import type * as DesktopState from "./desktop-state.ts";
import type * as UpdateRelease from "./update-release.ts";
import type * as IpcSetup from "./ipc-setup.ts";
import type * as IpcFiles from "./ipc-files.ts";
import type * as IpcShell from "./ipc-shell.ts";
import type * as IpcDocument from "./ipc-document.ts";
import type * as IpcHistoryBlob from "./ipc-history-blob.ts";
import type * as IpcTabstrip from "./ipc-tabstrip.ts";
import type * as IpcTestMode from "./ipc-test-mode.ts";
import type * as IpcPrint from "./ipc-print.ts";
import type * as PrintPdf from "./print-pdf.ts";
import type * as HistoryPolicy from "../shared/history-policy.ts";
import type * as HistoryStore from "../shared/history-store.ts";
import type * as DocIdPolicy from "../shared/doc-id-policy.ts";
import type * as VideoEmbed from "../shared/video-embed.ts";

type NativeMainOptions<T> = { [K in keyof T]: T[K] | undefined };
type NativeMainDialog = Omit<Electron.Dialog, keyof DesktopFileIpcDependencies["dialog"] | "showSaveDialogSync">
  & DesktopFileIpcDependencies["dialog"] & {
    showSaveDialogSync: (...args: Parameters<Electron.Dialog["showSaveDialogSync"]>) => ReturnType<Electron.Dialog["showSaveDialogSync"]> | undefined;
  };
type NativeMainMenu = Omit<typeof Electron.Menu, "buildFromTemplate"> & {
  buildFromTemplate: (...args: Parameters<typeof Electron.Menu.buildFromTemplate>) => Omit<Electron.Menu, "popup"> & {
    popup: (options?: NativeMainOptions<Electron.PopupOptions>) => ReturnType<Electron.Menu["popup"]>;
  };
};
type NativeMainElectron = Omit<typeof Electron, "dialog" | "BrowserWindow" | "Menu" | "shell" | "net"> & {
  dialog: NativeMainDialog;
  shell: Omit<Electron.Shell, "openPath"> & { openPath: (path: string | null) => ReturnType<Electron.Shell["openPath"]> };
  net: Omit<Electron.Net, "fetch"> & { fetch: (input: unknown, options?: Parameters<Electron.Net["fetch"]>[1]) => ReturnType<Electron.Net["fetch"]> };
  BrowserWindow: Omit<typeof Electron.BrowserWindow, never> & (new (options?: NativeMainOptions<Electron.BrowserWindowConstructorOptions>) => Electron.BrowserWindow);
  Menu: NativeMainMenu;
};

const {
  app, BrowserWindow, WebContentsView, Menu, protocol, net, ipcMain, dialog, shell,
  session, nativeTheme, screen
}: NativeMainElectron = require("electron");
const path: DesktopNativePath = require("node:path");
const fs: DesktopNativeFs = require("node:fs");
const fsp: DesktopNativeFsPromises = require("node:fs/promises");
const crypto: typeof NodeCrypto = require("node:crypto");
const { spawn }: { spawn: (command: string | null, args: readonly string[], options: NodeChildProcess.SpawnOptions) => NodeChildProcess.ChildProcess } = require("node:child_process");
const { createDraftStore, MAX_BODY_BYTES }: { createDraftStore: typeof Drafts.createDraftStore; MAX_BODY_BYTES: typeof Drafts.MAX_BODY_BYTES } = require("./drafts.ts");
const {
  filesToOpenFrom, pathKey, createFileRegistry, readFileEntry
}: { filesToOpenFrom: typeof FileService.filesToOpenFrom; pathKey: typeof FileService.pathKey; createFileRegistry: typeof FileService.createFileRegistry; readFileEntry: typeof FileService.readFileEntry } = require("./file-service.ts");
const { createDocClaims }: { createDocClaims: typeof DocClaims.createDocClaims } = require("./doc-claims.ts");
const { createRecents }: { createRecents: typeof Recents.createRecents } = require("./recents.ts");
const { createThemeChoice, backgroundColorFor, titleBarOverlayFor, boundsIfVisible }: { createThemeChoice: typeof WindowAppearance.createThemeChoice; backgroundColorFor: typeof WindowAppearance.backgroundColorFor; titleBarOverlayFor: typeof WindowAppearance.titleBarOverlayFor; boundsIfVisible: typeof WindowAppearance.boundsIfVisible } = require("./window-appearance.ts");
const { createTabRegistry }: { createTabRegistry: typeof TabRegistry.createTabRegistry } = require("./tab-registry.ts");
const { createRestoreNotice }: { createRestoreNotice: typeof RestoreNotice.createRestoreNotice } = require("./restore-notice.ts");
const { isShareableName, MAX_SCRIPT_BYTES }: { isShareableName: typeof PrompterShare.isShareableName; MAX_SCRIPT_BYTES: typeof PrompterShare.MAX_SCRIPT_BYTES } = require("./prompter-share.ts");
const { createCloseQuit }: { createCloseQuit: typeof CloseQuit.createCloseQuit } = require("./close-quit.ts");
const { createSessionRestore }: { createSessionRestore: typeof SessionRestore.createSessionRestore } = require("./session-restore.ts");
const { createVoiceComposition }: { createVoiceComposition: typeof VoiceComposition.createVoiceComposition } = require("./voice-composition.ts");
const { findChromiumBrowsers, launchChromiumBrowser, chromiumBrowserName }: { findChromiumBrowsers: typeof ChromiumBrowsers.findChromiumBrowsers; launchChromiumBrowser: typeof ChromiumBrowsers.launchChromiumBrowser; chromiumBrowserName: typeof ChromiumBrowsers.chromiumBrowserName } = require("./chromium-browsers.ts");
const { createBlobStore }: { createBlobStore: typeof BlobStore.createBlobStore } = require("./blob-store.ts");
const { createHistoryFsBackend, MAX_BODY_BYTES: HISTORY_MAX_BODY_BYTES }: { createHistoryFsBackend: typeof HistoryFsBackend.createHistoryFsBackend; MAX_BODY_BYTES: typeof HistoryFsBackend.MAX_BODY_BYTES } = require("./history-fs-backend.ts");
const {
  DESKTOP_STATE_VERSION,
  normalizeBounds, normalizeTabSource, createDesktopStateStore
}: { DESKTOP_STATE_VERSION: typeof DesktopState.DESKTOP_STATE_VERSION; normalizeBounds: typeof DesktopState.normalizeBounds; normalizeTabSource: typeof DesktopState.normalizeTabSource; createDesktopStateStore: typeof DesktopState.createDesktopStateStore } = require("./desktop-state.ts");
const {
  DEFAULT_UPDATE_API, hasReleaseAssets, compareVersions, isAllowedDownloadHost, pickUpdateAsset, findChecksumsAsset, checksumFor
}: { DEFAULT_UPDATE_API: typeof UpdateRelease.DEFAULT_UPDATE_API; hasReleaseAssets: typeof UpdateRelease.hasReleaseAssets; compareVersions: typeof UpdateRelease.compareVersions; isAllowedDownloadHost: typeof UpdateRelease.isAllowedDownloadHost; pickUpdateAsset: typeof UpdateRelease.pickUpdateAsset; findChecksumsAsset: typeof UpdateRelease.findChecksumsAsset; checksumFor: typeof UpdateRelease.checksumFor } = require("./update-release.ts");
const { createIpcSetup }: { createIpcSetup: typeof IpcSetup.createIpcSetup } = require("./ipc-setup.ts");
const { createFileIpc }: { createFileIpc: typeof IpcFiles.createFileIpc } = require("./ipc-files.ts");
const { createShellIpc }: { createShellIpc: typeof IpcShell.createShellIpc } = require("./ipc-shell.ts");
const { createDocumentIpc }: { createDocumentIpc: typeof IpcDocument.createDocumentIpc } = require("./ipc-document.ts");
const { createHistoryBlobIpc }: { createHistoryBlobIpc: typeof IpcHistoryBlob.createHistoryBlobIpc } = require("./ipc-history-blob.ts");
const { createTabStripIpc }: { createTabStripIpc: typeof IpcTabstrip.createTabStripIpc } = require("./ipc-tabstrip.ts");
const { createTestModeIpc }: { createTestModeIpc: typeof IpcTestMode.createTestModeIpc } = require("./ipc-test-mode.ts");
const { createPrintIpc }: { createPrintIpc: typeof IpcPrint.createPrintIpc } = require("./ipc-print.ts");
const { createPdfPrinter }: { createPdfPrinter: typeof PrintPdf.createPdfPrinter } = require("./print-pdf.ts");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "splitpage",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true
    }
  }
]);

if (process.env.SPLITPAGE_USER_DATA) {
  app.setPath("userData", process.env.SPLITPAGE_USER_DATA);
}

const TEST_MODE = process.env.SPLITPAGE_TEST === "1";

let testDialogAnswers: unknown = null;
let testDialogCursor = 0;
let testDialogsSeen = 0;
const TEST_DIALOGS_FILE = TEST_MODE ? process.env.SPLITPAGE_TEST_DIALOGS || "" : "";
if (TEST_DIALOGS_FILE) {
  try {
    testDialogAnswers = JSON.parse(fs.readFileSync(TEST_DIALOGS_FILE, "utf8"));
    if (!Array.isArray(testDialogAnswers)) testDialogAnswers = null;
  } catch {
    testDialogAnswers = null;
  }
}
function consumeTestDialogAnswer() {
  testDialogsSeen++;
  if (!testDialogAnswers || testDialogCursor >= (testDialogAnswers as unknown[]).length) return undefined;
  return (testDialogAnswers as unknown[])[testDialogCursor++];
}

const SKIP_UPDATE_CHECK = process.env.SPLITPAGE_NO_UPDATE_CHECK === "1";

const testExternalOpens: string[] = [];
const testChromiumLaunches: { browser: string; url: string }[] = [];
const testVideoOpens: string[] = [];
const videoFileGrants = new Map<string, string>();
const VIDEO_FILE_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|wmv|mpg|mpeg|3gp)$/i;
if (TEST_MODE) {

  const cancelIndex = (opts: Electron.MessageBoxSyncOptions | Electron.MessageBoxOptions | undefined) => (opts && typeof opts.cancelId === "number")
    ? opts.cancelId
    : Math.max(0, ((opts && opts.buttons) || ["OK"]).length - 1);
  const optsOf = <T>(args: [T] | [Electron.BaseWindow | undefined, T]) => args[args.length - 1] as T;
  dialog.showMessageBoxSync = (...args: [Electron.MessageBoxSyncOptions] | [Electron.BaseWindow | undefined, Electron.MessageBoxSyncOptions]) => cancelIndex(optsOf(args));
  dialog.showMessageBox = async (...args: [Electron.MessageBoxOptions] | [Electron.BaseWindow | undefined, Electron.MessageBoxOptions]) => ({ response: cancelIndex(optsOf(args)), checkboxChecked: false });
  dialog.showOpenDialogSync = () => undefined;
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showSaveDialogSync = () => undefined;
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  dialog.showErrorBox = (title, content) => console.error("[splitpage-test] error box: " + title + " — " + content);

  shell.openExternal = async (url) => { testExternalOpens.push(String(url)); };
}

const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "splitpage")
  : path.resolve(__dirname, "..");

const SHARED_ROOT = path.join(APP_ROOT, "shared");
const historyPolicy: typeof HistoryPolicy = require(path.join(SHARED_ROOT, "history-policy.ts"));
const { HISTORY_OLDER_KEY, HISTORY_SNAP_ID_RE } = historyPolicy;
const { createHistoryStore }: typeof HistoryStore = require(path.join(SHARED_ROOT, "history-store.ts"));
const {
  DOC_ID_RE, chooseDuplicateLoser, docIdFromSha256Hex, duplicateReplacementInput
}: typeof DocIdPolicy = require(path.join(SHARED_ROOT, "doc-id-policy.ts"));

const STATIC_ALLOWLIST: NonNullable<Parameters<typeof createVoiceComposition>[0]["staticAllowlist"]> = {
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/icon-maskable.svg": { file: "icon-maskable.svg", type: "image/svg+xml" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/help.md": { file: "help.md", type: "text/markdown; charset=utf-8" },
  "/VERSION": { file: "VERSION", type: "text/plain; charset=utf-8" }
};

const rawArgv = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);

const argvFilesToOpen = filesToOpenFrom(rawArgv, process.cwd());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {

if (TEST_MODE) {
  process.on("uncaughtException", (err) => {
    console.error("[splitpage-test] uncaught main-process error: " + ((err && (err as Error).stack) || err));
    app.exit(70);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[splitpage-test] unhandled rejection: " + ((err && (err as Error).stack) || err));
  });
}

const fileIds = createFileRegistry();

const TITLEBAR_H = 36;

const MIN_WINDOW_W = 480;
const MIN_WINDOW_H = 400;

const CRASH_RELOAD_MAX = 2;
const CRASH_RELOAD_WINDOW_MS = 60 * 1000;

const TABSTRIP_ROOT = app.isPackaged
  ? path.join(APP_ROOT, "tabstrip")
  : path.join(__dirname, "tabstrip");

const TABSTRIP_ALLOWLIST: typeof STATIC_ALLOWLIST = {
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/tabstrip.js": { file: "tabstrip.js", type: "text/javascript; charset=utf-8" },
  "/tabstrip.css": { file: "tabstrip.css", type: "text/css; charset=utf-8" }
};

const {
  tabs, windowsById, webContentsIdToTabId, pathToTabId,
  mintUniqueTabId, mintUniqueWindowId, firstWindowRecord, claimRoutingKey, indexTabSource, unindexTabSource
} = createTabRegistry({ pathKey });

let lastFocusedWindowId: string | null = null;
let firstTabCreated = false;
let draftFlushReqId = 0;
const pendingDraftFlushes: Map<number, (result: object) => void> = new Map();
const DRAFT_FLUSH_BUDGET_MS = 1500;
const restoreNotice = createRestoreNotice({
  tabs,
  liveWindows,
  send: (wc, payload) => wc.send("splitpage:restore-notice", payload)
});

const voice = createVoiceComposition({
  isPackaged: app.isPackaged, appRoot: APP_ROOT, testMode: TEST_MODE, tabs,
  staticAllowlist: STATIC_ALLOWLIST, cspHeader: readAppCsp
});

const closeConfirmedTabViews = new WeakSet<Electron.WebContentsView>();

const {
  isQuitConfirmed, isSessionEnding, sessionWritesAreFrozen, closeConfirmedWindows,
  attachWindowClose, requestCloseTab, quitToInstall, registerQuitHandlers
} = createCloseQuit({
  app, dialog, testMode: TEST_MODE, tabs, windowsById, liveWindows, tabHasFile, tabIsUnsaved, draftsHasDraft,
  requestDraftFlush, draftFlushBudgetMs: DRAFT_FLUSH_BUDGET_MS, draftStore: () => draftStore, draftsList,
  draftsDiscardForUserDecision, draftsDiscardClean, consumeTestDialogAnswer, activateTab, focusWindow,
  destroyTabView, startInstallerNow, prompterShare: voice.prompterShare, voiceHelper: voice.voiceHelper
});

function homeKeyForClaim(tab: DesktopMainTab) {
  const absPath = tab.fileId ? fileIds.pathOf(tab.fileId) : null;
  if (absPath) return "file:" + pathKey(absPath);
  return null;
}

function tabWebContentsForClaim(webContentsId: number) {
  const tabId = webContentsIdToTabId.get(webContentsId);
  const tab = tabId ? tabs.get(tabId) : null;
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  return tab.view.webContents;
}

const docClaims = createDocClaims({
  policy: { DOC_ID_RE, chooseDuplicateLoser, docIdFromSha256Hex, duplicateReplacementInput },
  homeKeyOf: homeKeyForClaim,
  contentsFor: tabWebContentsForClaim,
  askToReassign: (wc, payload) => wc.send("splitpage:reassign-doc-id", payload)
});

let draftStore: ReturnType<typeof createDraftStore> | null = null;
let draftsPreviousSession = "none";
function draftsHasDraft(tabId: string) {
  try { return !!(draftStore && draftStore.hasDraft(tabId)); } catch { return false; }
}
function draftsIsHeld(tabId: string) {
  try { return !!(draftStore && draftStore.isHeld(tabId)); } catch { return false; }
}
function draftsList() {
  try { return draftStore ? draftStore.list() : []; } catch { return []; }
}
function draftsDiscardForUserDecision(tabIds: (string | undefined)[], reason: string) {
  if (!draftStore || !tabIds.length) return;
  try { draftStore.discardForUserDecision(tabIds, reason); }
  catch (err) {
    if (TEST_MODE) process.stderr.write(`[splitpage] draft discard failed: ${err && (err as Error).stack || err}\n`);
  }
}
function draftsDiscardClean(tabId: string | undefined) {
  if (!draftStore) return;
  try { Promise.resolve(draftStore.discardClean(tabId, Infinity)).catch(() => {}); } catch { }
}

function draftTestHooksFromEnv() {
  if (!TEST_MODE) return null;
  const hooks: NonNullable<NonNullable<Parameters<typeof createDraftStore>[0]>["testHooks"]> = {
    onKill() {
      process.kill(process.pid, "SIGKILL");
    }
  };
  const fail = process.env.SPLITPAGE_TEST_DRAFT_FAIL;
  if (typeof fail === "string" && fail) {
    const [code, count] = fail.split(":");
    if (code) hooks.failNext = { code, count: Number.isInteger(Number(count)) && Number(count) > 0 ? Number(count) : 1 };
  }
  const killAt = Number(process.env.SPLITPAGE_TEST_DRAFT_KILL_BEFORE_RENAME);
  if (Number.isInteger(killAt) && killAt > 0) hooks.killBeforeRenameAt = killAt;
  const delayMs = Number(process.env.SPLITPAGE_TEST_DRAFT_WRITE_DELAY_MS);
  if (Number.isFinite(delayMs) && delayMs > 0) hooks.writeDelayMs = delayMs;
  return hooks;
}

function initDraftStore() {
  try {
    draftStore = createDraftStore({
      dir: path.join(app.getPath("userData"), "drafts"),
      fs, fsp, path, crypto,
      appVersion: app.getVersion(),
      testHooks: draftTestHooksFromEnv()
    });
    const result = draftStore.init();
    draftsPreviousSession = (result && result.previousSession) || "none";
    return result;
  } catch (err) {
    draftStore = null;
    if (TEST_MODE) process.stderr.write(`[splitpage] draft store unavailable: ${err && (err as Error).stack || err}\n`);
    return { previousSession: "none", drafts: [] };
  }
}

function tabIsUnsaved(tab: DesktopMainTab | null | undefined): boolean {
  return !!(tab && !tab.crashedNotReloaded && (tab.dirty || draftsIsHeld(tab.id)));
}

function tabHasFile(tab: DesktopMainTab | null | undefined): boolean {
  if (!tab || tab.crashedNotReloaded || !tab.source || tab.source.kind !== "file") return false;
  const absPath = tab.source.absPath;
  return typeof absPath === "string" && !!absPath;
}

const DRAFT_ORIGIN_KINDS = new Set<unknown>(["untitled", "file", "import"]);
const DRAFT_FILE_KINDS = new Set<unknown>(["md", "html", "splitpage"]);
const DRAFT_NAME_MAX = 300;

function draftScalarString(v: unknown, max: number) {
  if (typeof v !== "string" || !v) return null;
  /* eslint-disable-next-line no-control-regex -- stripping control characters
     is the function's job; the class is written out above. */
  const clean = v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);
  return clean || null;
}

function draftFiniteNumber(v: unknown) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function buildDraftHeader(tab: DesktopMainTab, p: Record<string, unknown>) {
  const fileId = typeof p.fileId === "string" ? p.fileId : null;
  const filePath = fileId ? fileIds.pathOf(fileId) || null : null;
  const w = windowsById.get(tab.windowId);
  const index = w ? w.tabIds.indexOf(tab.id) : -1;
  return {
    title: draftScalarString(p.title, DRAFT_NAME_MAX) || "",
    docId: typeof p.docId === "string" && DOC_ID_RE.test(p.docId) ? p.docId : null,
    docIdWrittenOut: p.docIdWrittenOut === true,
    schema: draftFiniteNumber(p.schema),
    editSeq: draftFiniteNumber(p.editSeq),
    origin: {
      kind: DRAFT_ORIGIN_KINDS.has(p.originKind) ? p.originKind as string : "untitled",
      filePath,
      fileName: filePath ? path.basename(filePath) : null,
      fileKind: DRAFT_FILE_KINDS.has(p.fileKind) ? p.fileKind as string : null,
      importName: draftScalarString(p.importName, DRAFT_NAME_MAX),
      baseLastModified: draftFiniteNumber(p.baseLastModified),
      baseSize: draftFiniteNumber(p.baseSize)
    },
    placement: { windowKey: tab.windowId, index: index >= 0 ? index : 0, active: !!(w && w.activeTabId === tab.id) }
  };
}

function draftBodyTooLarge(str: string) {
  if (str.length > MAX_BODY_BYTES) return true;
  return Buffer.byteLength(str, "utf8") > MAX_BODY_BYTES;
}

function requestDraftFlush(tab: DesktopMainTab | null | undefined, budgetMs: number, keep?: boolean): Promise<object> {
  return new Promise((resolve) => {
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) { resolve({ ok: false, code: "NO_TAB" }); return; }
    const reqId = ++draftFlushReqId;
    const timer = setTimeout(() => {
      if (pendingDraftFlushes.delete(reqId)) resolve({ ok: false, code: "EBUSY" });
    }, budgetMs);
    pendingDraftFlushes.set(reqId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    try {
      tab.view.webContents.send("splitpage:draft-flush", reqId, keep === true);
    } catch {
      pendingDraftFlushes.delete(reqId);
      clearTimeout(timer);
      resolve({ ok: false, code: "NO_TAB" });
    }
  });
}

const desktopState = createDesktopStateStore({
  filePath: () => path.join(app.getPath("userData"), "desktop-state.json"),
  pathKey,
  onWriteError: (err) => {
    if (TEST_MODE) process.stderr.write(`[splitpage] desktop-state write failed: ${err && (err as Error).stack || err}\n`);
  }
});

const recents = createRecents({ store: desktopState, pathKey, fileIds });

const { hadPriorSession, isRestoringSession, restoreSessionAtLaunch, registerActivate } = createSessionRestore({
  app, BrowserWindow, desktopState, draftStore: () => draftStore, draftsList, tabs, windowsById, pathToTabId,
  claimRoutingKey, createTabWindow, createTab, activateTab, liveWindows, firstWindowRecord, payloadForSource,
  routeLaunchFile, argvFilesToOpen, restoreNotice, persistShellState
});

function noteRecentDocumentAndPersist(absPath: unknown, title: string) {
  if (!recents.note(absPath, title)) return;
  if (sessionWritesAreFrozen() || isRestoringSession() || !windowsById.size) recents.persist();
  else persistShellState();
}

function primaryDesktopWindow(state: ReturnType<typeof desktopState.read>) { return state.windows[0]; }

function shellStateAsV2() {
  const windows = [];
  for (const w of windowsById.values()) {
    if (!w.win || w.win.isDestroyed()) continue;
    const rows = [];
    for (const tabId of w.tabIds) {
      const tab = tabs.get(tabId);
      if (!tab) continue;
      if (tab.source.kind === "blank" && !draftsHasDraft(tabId)) continue;
      rows.push({ tabId, source: normalizeTabSource(tab.source), lastKnownTitle: tab.title || "" });
    }
    if (!rows.length) {
      const active = tabs.get(w.activeTabId);
      rows.push({ tabId: w.activeTabId, source: { kind: "blank" }, lastKnownTitle: (active && active.title) || "" });
    }
    windows.push({
      windowId: w.id,
      bounds: normalizeBounds(w.bounds),
      maximized: !!w.maximized,
      activeTabId: w.activeTabId,
      tabs: rows
    });
  }
  return { version: DESKTOP_STATE_VERSION, windows, recents: recents.list() };
}

function persistShellState() {
  if (sessionWritesAreFrozen() || isRestoringSession()) return Promise.resolve(false);
  if (!windowsById.size) return Promise.resolve(false);
  return desktopState.write(() => shellStateAsV2());
}

const HISTORY_DESKTOP_CAP_BYTES = 500 * 1024 * 1024;

function historyCapBytes() {
  if (TEST_MODE) {
    const n = Number(process.env.SPLITPAGE_TEST_HISTORY_CAP_BYTES);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return HISTORY_DESKTOP_CAP_BYTES;
}

const HISTORY_TEST_FAULT = TEST_MODE ? String(process.env.SPLITPAGE_TEST_HISTORY_FAULT || "") : "";

function historyTestKill() {
  process.kill(process.pid, "SIGKILL");
}

function historyTestBackendHooks() {
  if (HISTORY_TEST_FAULT !== "exit-after-body") return undefined;
  return { afterBodyPut: historyTestKill };
}

function historyWithEnospcFault(backend: ReturnType<typeof createHistoryFsBackend>): NonNullable<NonNullable<Parameters<typeof createHistoryStore>[0]>["backend"]> {
  let armed = HISTORY_TEST_FAULT;
  const enospc = () => {
    if (armed === "enospc-once") armed = "";
    else if (armed !== "enospc-always") return;
    const err: NodeJS.ErrnoException = new Error("Injected ENOSPC");
    err.code = "enospc";
    throw err;
  };
  return {
    get name() { return backend.name; },
    get persistent() { return backend.persistent; },
    get readOnly() { return backend.readOnly; },
    exclusive: (fn, o) => backend.exclusive((tx) => fn(Object.assign({}, tx, {
      put: async (sha: string, text: string) => { enospc(); return tx.put(sha, text); }
    })), o)
  };
}

let historyStore: ReturnType<typeof createHistoryStore> | null = null;

const historyHolds: Map<number, { docId: string; id: string }[]> = new Map();

function historyAllHolds() {
  const out = [];
  for (const held of historyHolds.values()) out.push(...held);
  return out;
}

function historyProtectList(protect: unknown) {
  const out: { docId: string; id: string }[] = [];
  if (!Array.isArray(protect)) return out;
  for (const p of protect.slice(0, 200)) {
    if (!p || typeof p !== "object") continue;
    const docId: string = typeof p.docId === "string" ? p.docId : "";
    const id: string = typeof p.id === "string" ? p.id : "";
    if (!(docId === HISTORY_OLDER_KEY || DOC_ID_RE.test(docId)) || !HISTORY_SNAP_ID_RE.test(id)) continue;
    out.push({ docId, id });
  }
  return out;
}

const HISTORY_V1_BACKUP_DIR = "v1-backup";
const HISTORY_V1_BACKUP_DELAY_MS = 3000;

function removeHistoryV1Backup(historyDir: string) {
  const target = path.join(historyDir, HISTORY_V1_BACKUP_DIR);
  const timer = setTimeout(() => {
    fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((err) => {
      if (TEST_MODE) process.stderr.write(`[splitpage] history v1-backup not removed (next launch tries again): ${err && (err as Error).stack || err}\n`);
    });
  }, HISTORY_V1_BACKUP_DELAY_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
}

function initHistoryStore() {
  const historyDir = path.join(app.getPath("userData"), "history");
  const backend = createHistoryFsBackend({
    dir: historyDir,
    fs, fsp, path, crypto,
    testHooks: historyTestBackendHooks()
  });
  historyStore = createHistoryStore({
    backend: /^enospc-/.test(HISTORY_TEST_FAULT) ? historyWithEnospcFault(backend) : backend,
    now: Date.now,
    hashText: (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex"),
    capBytes: historyCapBytes,
    maxBodyBytes: HISTORY_MAX_BODY_BYTES,
    holds: historyAllHolds
  });
  backend.open().then((r) => {
    if (!r.readOnly) removeHistoryV1Backup(historyDir);
  }, (err) => {
    if (TEST_MODE) process.stderr.write(`[splitpage] history open failed: ${err && (err as Error).stack || err}\n`);
  });
}

type MainHistoryMeta = NonNullable<NonNullable<Awaited<ReturnType<ReturnType<typeof createHistoryStore>["get"]>>>["meta"]>;
function historyWireMeta<M extends DesktopWireHistoryMeta | null | undefined>(m: M): M extends DesktopWireHistoryMeta ? DesktopWireHistoryMeta : M;
function historyWireMeta(m: DesktopWireHistoryMeta | null | undefined) {
  if (!m || typeof m !== "object") return m;
  const out: DesktopWireHistoryMeta & Partial<Pick<MainHistoryMeta, "docId">> = Object.assign({}, m);
  delete out.docId;
  return out;
}

let blobStore: ReturnType<typeof createBlobStore> | null = null;

function initBlobStore() {
  try {
    blobStore = createBlobStore({ dir: path.join(app.getPath("userData"), "blobs"), fs, fsp, path, crypto });
    return blobStore.init();
  } catch (err) {
    blobStore = null;
    if (TEST_MODE) process.stderr.write(`[splitpage] blob store unavailable: ${err && (err as Error).stack || err}\n`);
    return null;
  }
}

function readAppVersion() {
  try { return fs.readFileSync(path.join(APP_ROOT, "VERSION"), "utf8").trim(); } catch { return app.getVersion(); }
}

function updateApiUrl() {
  return (TEST_MODE && process.env.SPLITPAGE_UPDATE_API) || DEFAULT_UPDATE_API;
}

async function fetchPublishedChecksum(assets: Parameters<typeof findChecksumsAsset>[0], assetName: Parameters<typeof checksumFor>[1]) {
  const entry = findChecksumsAsset(assets, updateApiUrl());
  if (!entry) return null;
  try {
    const res = await net.fetch((entry as Record<string, unknown>).browser_download_url, { headers: { "User-Agent": "splitpage-desktop" } });
    if (!res.ok) return null;
    return checksumFor(await res.text(), assetName);
  } catch { }
  return null;
}

let updateStatus: DesktopWireUpdateStatus = {
  version: readAppVersion(),
  checkedAt: null,
  checking: !SKIP_UPDATE_CHECK,
  latest: null,
  updateAvailable: false,
  pending: null,
  justUpdated: null,
  desktop: true,
  canInstall: false,
  releaseUrl: null,
  download: { state: "idle", received: 0, total: 0, error: null }
};

let updateAsset: ReturnType<typeof pickUpdateAsset> = null;
let updateAssets: Parameters<typeof pickUpdateAsset>[0] = [];
let updateFile: string | null = null;
let updateDownloadPromise: Promise<DesktopIpcResult<"splitpage:update-download">> | null = null;

function updateDir() {
  return path.join(app.getPath("userData"), "updates");
}

function broadcastUpdateStatus() {
  for (const tab of tabs.values()) {
    if (!tab.view || tab.view.webContents.isDestroyed()) continue;
    try { tab.view.webContents.send("splitpage:update-status", updateStatus); } catch { }
  }
}

function setUpdateStatus(patch: Partial<DesktopWireUpdateStatus>) {
  updateStatus = { ...updateStatus, ...patch };
  broadcastUpdateStatus();
}

function setDownloadState(patch: Partial<DesktopWireUpdateStatus["download"]>) {
  setUpdateStatus({ download: { ...updateStatus.download, ...patch } });
}

async function checkForUpdate() {
  if (SKIP_UPDATE_CHECK) return;
  const current = readAppVersion();
  const apiUrl = updateApiUrl();
  try {
    const res = await net.fetch(apiUrl, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "splitpage-desktop" }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.json() as Record<string, unknown>;
    if (!hasReleaseAssets(body.assets)) throw new Error("the release has no assets");
    const latest = String(body.tag_name || body.name || "").replace(/^v/, "").trim();
    const newer = !!latest && compareVersions(latest, current) > 0;
    updateAssets = Array.isArray(body.assets) ? body.assets : [];
    updateAsset = newer ? pickUpdateAsset(updateAssets, { platform: process.platform, arch: process.arch, apiUrl }) : null;
    setUpdateStatus({
      version: current,
      checkedAt: new Date().toISOString(),
      checking: false,
      latest,
      updateAvailable: newer,
      canInstall: !!updateAsset,
      releaseUrl: body.html_url || null,
      error: undefined
    });
  } catch (err) {
    updateAsset = null;
    updateAssets = [];
    setUpdateStatus({
      version: current,
      latest: null,
      updateAvailable: false,
      canInstall: false,
      releaseUrl: null,
      checkedAt: new Date().toISOString(),
      checking: false,
      error: (err as Error).message
    });
  }
}

function downloadUpdate(): Promise<DesktopIpcResult<"splitpage:update-download">> {
  if (updateDownloadPromise) return updateDownloadPromise;
  if (updateStatus.download.state === "ready" && updateFile) {
    return Promise.resolve({ ok: true, state: "ready" });
  }
  const asset = updateAsset;
  if (!asset) return Promise.resolve({ ok: false, error: "no-installer" });
  if (!isAllowedDownloadHost(asset.url, updateApiUrl())) return Promise.resolve({ ok: false, error: "bad-url" });

  updateDownloadPromise = (async (): Promise<DesktopIpcResult<"splitpage:update-download">> => {
    const dir = updateDir();
    const target = path.join(dir, asset.name);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    if (path.dirname(path.resolve(target)) !== path.resolve(dir)) throw new Error("bad asset name");

    updateFile = null;
    setDownloadState({ state: "downloading", received: 0, total: asset.size || 0, error: null });

    const res = await net.fetch(asset.url, { headers: { "User-Agent": "splitpage-desktop" } });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const declared = Number(res.headers.get("content-length")) || asset.size || 0;
    setDownloadState({ total: declared });

    const hash = crypto.createHash("sha256");
    const handle = await fsp.open(target, "w");
    let received = 0;
    let lastReport = 0;
    try {
      const reader = (res.body as NonNullable<typeof res.body>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        await handle.write(buf);
        received += buf.length;
        const now = Date.now();
        if (now - lastReport > 200) { lastReport = now; setDownloadState({ received }); }
      }
    } finally {
      await handle.close();
    }
    setDownloadState({ received });

    if (declared && received !== declared) {
      throw new Error(`download is ${received} bytes, expected ${declared} — it was cut short`);
    }
    const digest = hash.digest("hex");
    const published = await fetchPublishedChecksum(updateAssets, asset.name);
    if (!published) {
      throw new Error("this release has no published checksum, so it is not being installed");
    }
    if (published !== digest) {
      throw new Error("the download does not match the checksum published for it");
    }

    updateFile = target;
    setDownloadState({ state: "ready", error: null, verified: true });
    return { ok: true, state: "ready" };
  })().catch(async (err): Promise<DesktopIpcResult<"splitpage:update-download">> => {
    updateFile = null;
    await fsp.rm(updateDir(), { recursive: true, force: true }).catch(() => {});
    setDownloadState({ state: "failed", error: (err as Error).message });
    return { ok: false, error: "download-failed", message: (err as Error).message };
  }).finally(() => { updateDownloadPromise = null; });

  return updateDownloadPromise;
}

function startInstallerNow(): DesktopIpcResult<"splitpage:update-install"> {
  try {
    if (process.platform === "win32") {
      const child = spawn(updateFile, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
    } else {
      shell.openPath(updateFile);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "could-not-run", message: (err as Error).message };
  }
}

function runUpdateInstaller(): Promise<DesktopIpcResult<"splitpage:update-install">> {
  if (updateStatus.download.state !== "ready" || !updateFile) {
    return Promise.resolve({ ok: false, error: "not-downloaded" });
  }
  if (!fs.existsSync(updateFile)) {
    setDownloadState({ state: "idle", received: 0, error: null });
    updateFile = null;
    return Promise.resolve({ ok: false, error: "not-downloaded" });
  }
  if (TEST_MODE) return Promise.resolve({ ok: true, testMode: true });

  return quitToInstall(() => setDownloadState({ state: "ready" }));
}

async function pickChromiumBrowser() {
  if (TEST_MODE && process.env.SPLITPAGE_TEST_CHROMIUM) {
    const id = process.env.SPLITPAGE_TEST_CHROMIUM;
    const name = chromiumBrowserName(id);
    return name ? { id, name, path: "(test)" } : null;
  }
  try {
    const found = await findChromiumBrowsers();
    return found[0] || null;
  } catch {
    return null;
  }
}

async function openPrompterInBrowser(tab: DesktopMainTab | null, opts?: { chromium: boolean }): Promise<DesktopIpcResult<"splitpage:prompter-open-in-browser">> {
  if (!tab) return { ok: false, code: "NO_TAB" };
  if (tab.dirty) return { ok: false, code: "UNSAVED_CHANGES" };
  const chromium = !!(opts && opts.chromium);
  let browser = null;
  if (chromium) {
    browser = await pickChromiumBrowser();
    if (!browser) return { ok: false, code: "NO_CHROMIUM" };
    if (!tabs.has(tab.id)) return { ok: false, code: "NO_TAB" };
    if (tab.dirty) return { ok: false, code: "UNSAVED_CHANGES" };
  }
  const source = tab.source || { kind: "blank" };
  let url;
  const relay = !chromium && voice.prompterRelaysVoice();
  if (source.kind === "file") {
    const absPath = source.absPath;
    if (!isShareableName(absPath)) return { ok: false, code: "NOT_A_PROJECT" };
    let text;
    try {
      const st = await fsp.stat(absPath);
      if (!st.isFile()) return { ok: false, code: "READ_FAILED" };
      if (st.size > MAX_SCRIPT_BYTES) return { ok: false, code: "TOO_LARGE" };
      text = await fsp.readFile(absPath, "utf8");
    } catch {
      return { ok: false, code: "READ_FAILED" };
    }
    if (!tabs.has(tab.id)) return { ok: false, code: "NO_TAB" };
    if (tab.dirty) return { ok: false, code: "UNSAVED_CHANGES" };
    try {
      url = await voice.prompterShareInstance().publish(tab.id, path.basename(absPath), text, { voice: relay });
    } catch (err) {
      if (TEST_MODE) process.stderr.write(`[splitpage] prompter share failed: ${err && (err as Error).stack || err}\n`);
      return { ok: false, code: "SERVE_FAILED" };
    }
  } else {
    return { ok: false, code: "NOT_SAVED" };
  }
  if (browser) {
    try {
      if (TEST_MODE) testChromiumLaunches.push({ browser: browser.id, url });
      else await launchChromiumBrowser(browser, url);
    } catch {
      return { ok: false, code: "OPEN_FAILED" };
    }
    return { ok: true, kind: source.kind, voice: "browser", browser: browser.name };
  }
  try {
    await shell.openExternal(url);
  } catch {
    return { ok: false, code: "OPEN_FAILED" };
  }
  return { ok: true, kind: source.kind, voice: relay ? "relay" : "browser" };
}

const videoEmbed: typeof VideoEmbed = require(path.join(SHARED_ROOT, "video-embed.ts"));

const VIDEO_TEST_BASES = TEST_MODE && process.env.SPLITPAGE_TEST_VIDEO_BASE
  ? (() => {
      const base = String(process.env.SPLITPAGE_TEST_VIDEO_BASE).replace(/\/+$/, "");
      const out: Record<string, string> = {};
      for (const k of Object.keys(videoEmbed.VIDEO_HOSTS)) out[k] = base + "/" + k;
      return out;
    })()
  : null;

const YOUTUBE_EMBED_REFERER = "https://com.retrogorilla.splitpage/";

function videoThumbnail(host: DesktopIpcArgs<"splitpage:video-thumbnail">[0], ref: DesktopIpcArgs<"splitpage:video-thumbnail">[1]): Promise<DesktopIpcResult<"splitpage:video-thumbnail">> {
  const v = videoEmbed.parseVideoRef(host, ref);
  if (!v) return Promise.resolve({ ok: false, code: "BAD_REF" });
  return videoEmbed.fetchVideoThumbnail(v, { fetch: globalThis.fetch, bases: VIDEO_TEST_BASES || undefined }).then((res) => {
    if (TEST_MODE) process.stderr.write("[splitpage] video-thumbnail " + host + " " + (res.ok ? "ok" : res.code) + "\n");
    return res.ok ? { ok: true, bytes: res.bytes, mime: res.mime } : { ok: false, code: res.code };
  });
}

function installPlayerReferer(ses: Electron.Session) {
  const embedPrefix = (VIDEO_TEST_BASES ? VIDEO_TEST_BASES.youtubePlayer : videoEmbed.VIDEO_HOSTS.youtubePlayer) + "/embed/";
  const filter = { urls: [embedPrefix + "*"] };
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders || {};
    const hasReferer = Object.keys(headers).some((k) => k.toLowerCase() === "referer");
    const fromTab = details.resourceType === "subFrame" && typeof details.webContentsId === "number" &&
      webContentsIdToTabId.has(details.webContentsId);
    if (!hasReferer && fromTab && details.url.startsWith(embedPrefix)) headers.Referer = YOUTUBE_EMBED_REFERER;
    callback({ requestHeaders: headers });
  });
}

let appCspHeader: string | null = null;

async function readAppCsp() {
  if (appCspHeader !== null) return appCspHeader;
  appCspHeader = "";
  try {
    const html = await fsp.readFile(path.join(APP_ROOT, "index.html"), "utf8");
    const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html.slice(0, 20000));
    if (m) appCspHeader = m[1] + "; frame-ancestors 'none'";
  } catch { }
  return appCspHeader;
}

const TABSTRIP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

function registerProtocol() {
  protocol.handle("splitpage", async (request) => {
    let url;
    try { url = new URL(request.url); } catch { return new Response("bad url", { status: 400 }); }
    const pathname = decodeURIComponent(url.pathname);

    if (url.hostname === "tabstrip") {
      const stripEntry = TABSTRIP_ALLOWLIST[pathname === "/" ? "/index.html" : pathname];
      if (!stripEntry) return new Response("not found", { status: 404 });
      const stripPath = path.join(TABSTRIP_ROOT, stripEntry.file);
      if (!stripPath.startsWith(TABSTRIP_ROOT)) return new Response("not found", { status: 404 });
      try {
        const buf = await fsp.readFile(stripPath);
        return new Response(buf, {
          status: 200,
          headers: { "content-type": stripEntry.type, "content-security-policy": TABSTRIP_CSP }
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    if (url.hostname !== "app") return new Response("not found", { status: 404 });

    if (pathname === "/update-status.json") {
      return new Response(JSON.stringify(updateStatus), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    const key = pathname === "/" ? "/index.html" : pathname;
    const entry = STATIC_ALLOWLIST[key];
    if (!entry) return new Response("not found", { status: 404 });

    const absPath = path.join(APP_ROOT, entry.file);
    if (!absPath.startsWith(APP_ROOT)) return new Response("not found", { status: 404 });
    try {
      const buf = await fsp.readFile(absPath);
      const headers: Record<string, string> = { "content-type": entry.type };
      const csp = await readAppCsp();
      if (csp) headers["content-security-policy"] = csp;
      return new Response(buf, { status: 200, headers });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

const themeChoice = createThemeChoice({ filePath: () => path.join(app.getPath("userData"), "theme.json") });

function backgroundColorForTheme() {
  return backgroundColorFor(nativeTheme.shouldUseDarkColors);
}

function visibleBounds(b: Electron.Rectangle | null | undefined) {
  return boundsIfVisible(b, screen.getAllDisplays());
}

function savedBoundsIfVisible() {
  return visibleBounds((primaryDesktopWindow(desktopState.read()) as NonNullable<ReturnType<typeof primaryDesktopWindow>>).bounds);
}

function titleBarOverlayColors() {
  return titleBarOverlayFor(nativeTheme.shouldUseDarkColors, TITLEBAR_H);
}

function createTabWindow(restoreSpec?: Partial<Pick<ReturnType<ReturnType<typeof createDesktopStateStore>["read"]>["windows"][number], "windowId" | "bounds" | "maximized">> & Pick<Electron.BrowserWindowConstructorOptions, "x" | "y">): DesktopMainWindow {
  const spec = restoreSpec || {};
  const saved = visibleBounds(normalizeBounds(spec.bounds)) || (windowsById.size ? null : savedBoundsIfVisible());
  const iconPath = app.isPackaged ? undefined : path.join(APP_ROOT, "installer", "icon.ico");

  const win = new BrowserWindow({
    width: saved ? saved.width : 1400,
    height: saved ? saved.height : 900,
    x: saved ? saved.x : (typeof spec.x === "number" ? spec.x : undefined),
    y: saved ? saved.y : (typeof spec.y === "number" ? spec.y : undefined),
    minWidth: MIN_WINDOW_W,
    minHeight: MIN_WINDOW_H,
    backgroundColor: backgroundColorForTheme(),
    show: false,
    skipTaskbar: TEST_MODE,
    title: "Splitpage",
    icon: iconPath,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlayColors(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "tabstrip-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: !TEST_MODE
    }
  });

  const windowId = mintUniqueWindowId(spec.windowId);
  const rec: DesktopMainWindow = {
    id: windowId,
    win,
    tabIds: [],
    activeTabId: null,
    lastFocusedAt: Date.now(),
    boundsSaveTimer: null,
    bounds: saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null,
    maximized: !!spec.maximized
  };
  windowsById.set(windowId, rec);
  if (lastFocusedWindowId === null) lastFocusedWindowId = windowId;

  if (rec.maximized && saved && !TEST_MODE) win.maximize();

  win.once("ready-to-show", () => { if (!TEST_MODE) win.show(); });

  win.loadURL("splitpage://tabstrip/index.html");

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("splitpage://tabstrip/")) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on("focus", () => {
    lastFocusedWindowId = windowId;
    rec.lastFocusedAt = Date.now();
  });

  win.on("resize", () => { layoutWindow(windowId); scheduleBoundsSave(windowId); });
  win.on("move", () => scheduleBoundsSave(windowId));
  win.on("maximize", () => {
    rec.maximized = true;
    layoutWindow(windowId);
    persistShellState();
  });
  win.on("unmaximize", () => {
    rec.maximized = false;
    if (!win.isDestroyed()) rec.bounds = win.getBounds();
    layoutWindow(windowId);
    persistShellState();
  });

  attachWindowClose(win, rec);

  win.on("closed", () => {
    clearTimeout(rec.boundsSaveTimer as ReturnType<typeof setTimeout> | undefined);
    for (const tabId of rec.tabIds.slice()) forgetTab(tabId);
    windowsById.delete(windowId);
    if (lastFocusedWindowId === windowId) {
      const next = windowsById.keys().next();
      lastFocusedWindowId = next.done ? null : next.value;
    }
    persistShellState();
  });

  return rec;
}

function windowRecordFor(windowId: string | null | undefined) {
  return windowsById.get(windowId) || (lastFocusedWindowId ? windowsById.get(lastFocusedWindowId) : null) || firstWindowRecord();
}

function forgetTab(tabId: string | undefined) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  unindexTabSource(tab);
  webContentsIdToTabId.delete(tab.webContentsId);
  tabs.delete(tabId);
  voice.forgetTab(tabId);
  const w = windowsById.get(tab.windowId);
  if (w) {
    const i = (w.tabIds as readonly (string | undefined)[]).indexOf(tabId);
    if (i !== -1) w.tabIds.splice(i, 1);
    if (w.activeTabId === tabId) {
      w.activeTabId = w.tabIds.length ? w.tabIds[Math.max(0, Math.min(i, w.tabIds.length - 1))] as string : null;
    }
  }
  historyHolds.delete(tab.webContentsId);
  restoreNotice.retarget(tabId, w);
}

function createTab(windowId: string, opts?: Partial<Pick<DesktopMainTab, "source" | "launchIntent" | "pendingPayload">> & { tabId?: string | undefined; index?: unknown }): DesktopMainTab | null {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return null;
  const o = opts || {};
  const tabId = mintUniqueTabId(o.tabId);

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: !TEST_MODE
    }
  });
  view.setBackgroundColor(backgroundColorForTheme());

  const tab: DesktopMainTab = {
    id: tabId,
    windowId,
    view,
    webContentsId: view.webContents.id,
    source: normalizeTabSource(o.source),
    fileId: null,
    title: "",
    dirty: false,
    pristine: true,
    docId: null,
    launchIntent: o.launchIntent || { type: "blank" },
    ready: false,
    pendingPayload: o.pendingPayload || null,
    reloadTimes: [],
    crashedNotReloaded: false,
    firstTabOfLaunch: !firstTabCreated
  };

  tabs.set(tabId, tab);
  webContentsIdToTabId.set(tab.webContentsId, tabId);
  indexTabSource(tab);

  const at = typeof o.index === "number" ? Math.max(0, Math.min(o.index, w.tabIds.length)) : w.tabIds.length;
  w.tabIds.splice(at, 0, tabId);
  w.win.contentView.addChildView(view);

  wireTabView(tab);

  view.webContents.loadURL(`splitpage://app/index.html?tab=${tabId}`);

  firstTabCreated = true;
  activateTab(tabId);
  persistShellState();
  return tab;
}

function wireTabView(tab: DesktopMainTab) {
  const contents = tab.view.webContents;
  const tabId = tab.id;

  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (url.startsWith("splitpage://app/")) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  contents.on("context-menu", (event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions || [];
      if (suggestions.length) {
        suggestions.forEach((s) => {
          template.push({ label: s, click: () => contents.replaceMisspelling(s) });
        });
      } else {
        template.push({ label: "No spelling suggestions", enabled: false });
      }
      template.push({ type: "separator" });
      template.push({
        label: "Add to dictionary",
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
      template.push({ type: "separator" });
    }
    const flags = params.editFlags || {};
    if (flags.canCut) template.push({ label: "Cut", click: () => contents.cut() });
    if (flags.canCopy) template.push({ label: "Copy", click: () => contents.copy() });
    if (flags.canPaste) template.push({ label: "Paste", click: () => contents.paste() });
    if (flags.canSelectAll) template.push({ label: "Select all", click: () => contents.selectAll() });
    if (!template.length) return;
    const w = windowsById.get(tab.windowId);
    Menu.buildFromTemplate(template).popup({ window: w ? w.win : undefined });
  });

  contents.on("will-prevent-unload", (event) => {
    const w = windowsById.get(tab.windowId);
    if (isQuitConfirmed() || isSessionEnding()
        || (w && closeConfirmedWindows.has(w.win)) || closeConfirmedTabViews.has(tab.view)) {
      event.preventDefault();
      return;
    }
    const answer = consumeTestDialogAnswer();
    let leave;
    if (answer === "confirm") leave = true;
    else if (answer === "cancel") leave = false;
    else {
      const choice = dialog.showMessageBoxSync(w ? w.win : undefined, {
        type: "warning",
        buttons: ["Leave without saving", "Stay"],
        defaultId: 1,
        cancelId: 1,
        title: "Splitpage",
        message: "You have unsaved changes",
        detail: "If you leave now, your changes will be lost."
      });
      leave = choice === 0;
    }
    if (leave) event.preventDefault();
  });

  contents.on("render-process-gone", (_event, details) => {
    if (details && details.reason === "clean-exit") return;
    if (!tabs.has(tabId)) return;
    if (draftStore && draftsHasDraft(tabId)) {
      try { draftStore.hold(tabId); } catch { }
    }

    const now = Date.now();
    tab.reloadTimes = tab.reloadTimes.filter((t) => now - t < CRASH_RELOAD_WINDOW_MS);
    const w = windowsById.get(tab.windowId);
    const windowAlive = !!(w && !w.win.isDestroyed());
    tab.ready = false;

    if (tab.reloadTimes.length >= CRASH_RELOAD_MAX || !windowAlive || isQuitConfirmed() || isSessionEnding()) {
      tab.crashedNotReloaded = true;
      if (windowAlive) { applyWindowTitle(w); pushShellState(w.id); }
      return;
    }

    tab.reloadTimes.push(now);
    tab.crashedNotReloaded = false;
    tab.pendingPayload = payloadForSource(tab.source);
    try { contents.reload(); } catch { tab.crashedNotReloaded = true; }
  });

  contents.on("did-navigate", () => {
    if (!tabs.has(tabId)) return;
    tab.ready = false;
    if (draftStore) { try { draftStore.resetSeq(tabId); } catch { } }
  });

  contents.on("destroyed", () => {
    if (!tabs.has(tabId)) return;
    const w = windowsById.get(tab.windowId);
    forgetTab(tabId);
    if (w && !w.win.isDestroyed()) {
      if (!w.tabIds.length) {
        closeConfirmedWindows.add(w.win);
        w.win.close();
      } else {
        activateTab(w.activeTabId);
        pushShellState(w.id);
        persistShellState();
      }
    }
  });
}

function destroyTabView(tabId: string | undefined) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const w = windowsById.get(tab.windowId);
  forgetTab(tabId);
  closeConfirmedTabViews.add(tab.view);
  try {
    if (w && !w.win.isDestroyed()) w.win.contentView.removeChildView(tab.view);
  } catch { }
  try {
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  } catch { }
  if (w && !w.win.isDestroyed()) {
    if (!w.tabIds.length) {
      closeConfirmedWindows.add(w.win);
      w.win.close();
      return;
    }
    activateTab(w.activeTabId);
    pushShellState(w.id);
  }
  persistShellState();
}

function layoutWindow(windowId: string) {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return;
  const size = w.win.getContentBounds();
  const height = Math.max(0, size.height - TITLEBAR_H);
  for (const tabId of w.tabIds) {
    const tab = tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) continue;
    const active = tabId === w.activeTabId;
    if (active) tab.view.setBounds({ x: 0, y: TITLEBAR_H, width: size.width, height });
    tab.view.setVisible(active);
  }
}

function activateTab(tabId: string | null | undefined) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const w = windowsById.get(tab.windowId);
  if (!w || w.win.isDestroyed()) return;
  w.activeTabId = tabId as string;
  layoutWindow(w.id);
  applyWindowTitle(w);
  if (!TEST_MODE) {
    try { tab.view.webContents.focus(); } catch { }
  }
  pushShellState(w.id);
}

function applyWindowTitle(w: DesktopMainWindow | null | undefined) {
  if (!w || w.win.isDestroyed()) return;
  const tab = tabs.get(w.activeTabId);
  const title = (tab && tab.title) || "Untitled";
  const dirty = !!(tab && tab.dirty && !tab.crashedNotReloaded);
  w.win.setTitle(dirty ? `• ${title} — Splitpage` : `${title} — Splitpage`);
  if (process.platform === "darwin") w.win.setDocumentEdited(dirty);
}

function scheduleBoundsSave(windowId: string) {
  const w = windowsById.get(windowId);
  if (!w) return;
  clearTimeout(w.boundsSaveTimer as ReturnType<typeof setTimeout> | undefined);
  w.boundsSaveTimer = setTimeout(() => {
    if (!w.win || w.win.isDestroyed()) return;
    w.maximized = w.win.isMaximized();
    if (!w.maximized) w.bounds = w.win.getBounds();
    persistShellState();
  }, 400);
}

function shellStateForWindow(windowId: string) {
  const w = windowsById.get(windowId);
  if (!w) return null;
  return {
    windowId,
    activeTabId: w.activeTabId,
    tabs: w.tabIds.map((id) => {
      const t = tabs.get(id);
      if (!t) return null;
      return {
        tabId: id,
        title: t.title || "Untitled",
        dirty: !!t.dirty && !t.crashedNotReloaded,
        crashed: !!t.crashedNotReloaded,
        pristine: !!t.pristine,
        fullPathForTooltip: t.source.kind === "file" ? t.source.absPath : null
      };
    }).filter(Boolean as unknown as (tab: NonNullable<DesktopIpcResult<"splitpage:tabstrip-get-state">>["tabs"][number] | null) => tab is NonNullable<DesktopIpcResult<"splitpage:tabstrip-get-state">>["tabs"][number])
  };
}

function pushShellState(windowId: string) {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return;
  try { w.win.webContents.send("splitpage:tabstrip-state", shellStateForWindow(windowId)); } catch { }
}

function deliverOpenFile(tab: DesktopMainTab, absPath: unknown) {
  const id = fileIds.register(absPath);
  readFileEntry(id, absPath).then((entry) => {
    if (tab.view.webContents.isDestroyed()) return;
    tab.fileId = id;
    tab.view.webContents.send("splitpage:open-file", entry);
    noteRecentDocumentAndPersist(absPath, tab.title || "");
  }).catch(() => { });
}

function routeOpenPath(absPath: unknown, opts?: { fromWindowId?: string | null; fromTabId?: string }): (NonNullable<DesktopIpcResult<"splitpage:route-open">> & { tabId: string }) | null {
  const o = opts || {};
  let resolved;
  try {
    if (!fs.statSync(absPath).isFile()) return null;
    resolved = path.resolve(absPath);
  } catch { return null; }

  const existingId = pathToTabId.get(pathKey(resolved));
  const existing = existingId ? tabs.get(existingId) : null;
  if (existing) {
    activateTab(existing.id);
    focusWindow(existing.windowId);
    return { where: existingId === o.fromTabId ? "this-tab" : "other-tab", tabId: existing.id };
  }

  const w = windowRecordFor(o.fromWindowId);
  if (!w) return null;
  const target = tabs.get(o.fromTabId) || tabs.get(w.activeTabId);
  if (target && target.pristine && target.ready) {
    target.source = { kind: "file", absPath: resolved };
    indexTabSource(target);
    deliverOpenFile(target, resolved);
    activateTab(target.id);
    focusWindow(target.windowId);
    persistShellState();
    return { where: "this-tab", tabId: target.id };
  }

  const created = createTab(w.id, {
    source: { kind: "file", absPath: resolved },
    launchIntent: { type: "open-file" },
    pendingPayload: { kind: "open-file", absPath: resolved }
  });
  focusWindow(w.id);
  return created ? { where: "new-tab", tabId: created.id } : null;
}

function reorderTab(tabId: string | undefined, index: number | undefined) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  const w = windowsById.get(tab.windowId);
  if (!w) return false;
  const from = (w.tabIds as readonly (string | undefined)[]).indexOf(tabId);
  if (from === -1) return false;
  w.tabIds.splice(from, 1);
  const to = Math.max(0, Math.min(from < (index as number) ? (index as number) - 1 : index as number, w.tabIds.length));
  w.tabIds.splice(to, 0, tabId as string);
  pushShellState(w.id);
  persistShellState();
  return true;
}

function moveTabToWindow(tabId: string, targetWindowId: string, index: number | undefined) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  const from = windowsById.get(tab.windowId);
  const to = windowsById.get(targetWindowId);
  if (!from || !to || from === to || to.win.isDestroyed()) return false;

  const i = from.tabIds.indexOf(tabId);
  if (i !== -1) from.tabIds.splice(i, 1);
  if (from.activeTabId === tabId) {
    from.activeTabId = from.tabIds.length ? from.tabIds[Math.max(0, Math.min(i, from.tabIds.length - 1))] as string : null;
  }

  try { from.win.contentView.removeChildView(tab.view); } catch { }
  to.win.contentView.addChildView(tab.view);

  tab.windowId = to.id;
  const at = typeof index === "number" ? Math.max(0, Math.min(index, to.tabIds.length)) : to.tabIds.length;
  to.tabIds.splice(at, 0, tabId);

  if (!from.tabIds.length && !from.win.isDestroyed()) {
    closeConfirmedWindows.add(from.win);
    from.win.close();
  } else {
    layoutWindow(from.id);
    applyWindowTitle(from);
    pushShellState(from.id);
  }
  activateTab(tabId);
  pushShellState(to.id);
  persistShellState();
  return true;
}

function tearOffToNewWindow(tabId: string, screenX: number, screenY: number) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  const from = windowsById.get(tab.windowId);
  if (!from) return false;
  if (from.tabIds.length <= 1) return false;
  const size: Pick<Electron.Rectangle, "width" | "height"> & Partial<Pick<Electron.Rectangle, "x" | "y">> = from.win.isDestroyed() ? { width: 1400, height: 900 } : from.win.getBounds();
  const created = createTabWindow({
    bounds: {
      x: Math.round((Number.isFinite(screenX) ? screenX : size.x) as number),
      y: Math.round((Number.isFinite(screenY) ? screenY : size.y) as number),
      width: size.width,
      height: size.height
    }
  });
  return moveTabToWindow(tabId, created.id, 0);
}

function liveWindows() {
  return [...windowsById.values()].filter((w) => w.win && !w.win.isDestroyed());
}

function cycleTab(windowId: string | null, delta: number) {
  const w = windowsById.get(windowId);
  if (!w || w.tabIds.length < 2) return;
  const i = (w.tabIds as readonly (string | null)[]).indexOf(w.activeTabId);
  const next = w.tabIds[((i === -1 ? 0 : i) + delta + w.tabIds.length) % w.tabIds.length];
  activateTab(next);
}

function focusWindow(windowId: string | null | undefined) {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return;
  lastFocusedWindowId = windowId as string;
  if (TEST_MODE) return;
  if (w.win.isMinimized()) w.win.restore();
  w.win.show();
  w.win.focus();
}

function payloadForSource(source: DesktopMainTab["source"] | null | undefined): DesktopMainTab["pendingPayload"] {
  if (!source) return null;
  if (source.kind === "file") return { kind: "open-file", absPath: source.absPath };
  return null;
}

function flushPendingPayload(tab: DesktopMainTab, opts?: { force: boolean }) {
  const payload = tab.pendingPayload;
  if (!payload) return;
  if (!(opts && opts.force) && draftsHasDraft(tab.id)) return;
  tab.pendingPayload = null;
  if (payload.kind === "open-file") {
    deliverOpenFile(tab, payload.absPath);
  }
}

function routeLaunchFile(absPath: string) {
  let resolved;
  try {
    if (!fs.statSync(absPath).isFile()) return;
    resolved = path.resolve(absPath);
  } catch { return; }

  const existingId = pathToTabId.get(pathKey(resolved));
  if (existingId && tabs.has(existingId)) {
    activateTab(existingId);
    return;
  }

  const w = firstWindowRecord();
  const target = w ? tabs.get(w.activeTabId) : null;
  if (target && target.source.kind === "blank" && !target.pendingPayload && !draftsHasDraft(target.id)) {
    target.source = { kind: "file", absPath: resolved };
    target.launchIntent = { type: "open-file" };
    target.pendingPayload = { kind: "open-file", absPath: resolved };
    indexTabSource(target);
    if (target.ready) flushPendingPayload(target);
    activateTab(target.id);
    return;
  }

  routeOpenPath(resolved, { fromWindowId: w ? w.id : null });
}

function activeTabContents() {
  const w = windowRecordFor(lastFocusedWindowId);
  if (!w) return null;
  const tab = tabs.get(w.activeTabId);
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  return tab.view.webContents;
}

function sendMenuCommand(command: string) {
  const contents = activeTabContents();
  if (contents) contents.send("splitpage:menu-command", command);
}

function focusedWindowRecord() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    for (const w of windowsById.values()) if (w.win === focused) return w;
  }
  return windowRecordFor(lastFocusedWindowId);
}

function buildMenu() {
  const isMac = process.platform === "darwin";

  const exportSubmenu: Electron.MenuItemConstructorOptions[] = [
    { label: "Word (.docx)", click: () => sendMenuCommand("export-docx") },
    { label: "Markdown (.md)", click: () => sendMenuCommand("export-md") },
    { label: "Markdown, two columns (.md)", click: () => sendMenuCommand("export-md-table") },
    { label: "Spreadsheet (.xlsx)", click: () => sendMenuCommand("export-xlsx") },
    { label: "Spreadsheet (.csv)", click: () => sendMenuCommand("export-csv") },
    { label: "Breakdown only (.xlsx)", click: () => sendMenuCommand("export-breakdown-xlsx") },
    { label: "Breakdown only (.csv)", click: () => sendMenuCommand("export-breakdown") },
    { label: "PDF (.pdf)", click: () => sendMenuCommand("export-pdf") },
    { type: "separator" },
    { label: "SplitShare (.html)", click: () => sendMenuCommand("export-html") },
    { type: "separator" },
    { label: "Narration only (.docx)", click: () => sendMenuCommand("export-narration-docx") },
    { label: "Narration only (.txt)", click: () => sendMenuCommand("export-narration-txt") },
    { type: "separator" },
    { label: "Gear (.pdf)", click: () => sendMenuCommand("export-packing-gear") },
    { label: "Props (.pdf)", click: () => sendMenuCommand("export-packing-prop") },
    { type: "separator" },
    { label: "B-roll shot list (.pdf)", click: () => sendMenuCommand("export-broll-pdf") },
    { label: "B-roll shot list (.xlsx)", click: () => sendMenuCommand("export-broll-xlsx") },
    { label: "B-roll shot list (.csv)", click: () => sendMenuCommand("export-broll-csv") }
  ];

  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendMenuCommand("save") },
      { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenuCommand("save-as") },
      { type: "separator" },
      { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => sendMenuCommand("open") },
      { label: "Paste a script…", click: () => sendMenuCommand("paste") },
      { label: "Import from Google Doc link…", click: () => sendMenuCommand("gdoc-import") },
      { type: "separator" },
      { label: "Version history…", click: () => sendMenuCommand("history") },
      { type: "separator" },
      {
        label: "New Tab",
        accelerator: "CmdOrCtrl+T",
        click: () => {
          const w = focusedWindowRecord();
          if (w) createTab(w.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
        }
      },
      { type: "separator" },
      { label: "Export…", accelerator: "CmdOrCtrl+E", registerAccelerator: false, click: () => sendMenuCommand("export") },
      { label: "Export", submenu: exportSubmenu },
      { type: "separator" },
      { label: "Settings…", click: () => sendMenuCommand("settings") },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit", label: "Exit" }
    ]
  };

  const editMenu: Electron.MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "selectAll" },
      { type: "separator" },
      {
        label: "Find & replace",
        accelerator: "CmdOrCtrl+F",
        registerAccelerator: false,
        click: () => sendMenuCommand("find")
      },
      {
        label: "Search Commands…",
        accelerator: "CmdOrCtrl+K",
        registerAccelerator: false,
        click: () => sendMenuCommand("command-menu")
      }
    ]
  };

  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { label: "Production", accelerator: "CmdOrCtrl+Alt+P", click: () => sendMenuCommand("toggle-production") },
      { label: "Gear", click: () => sendMenuCommand("toggle-gear") },
      { label: "Comments", accelerator: "CmdOrCtrl+Alt+C", click: () => sendMenuCommand("toggle-comments") },
      { label: "Write", click: () => sendMenuCommand("write") },
      { label: "Present", click: () => sendMenuCommand("present") },
      {
        label: "Present in Browser (Follow My Voice)",
        accelerator: "CmdOrCtrl+Shift+P",
        click: () => sendMenuCommand("prompter-open-in-browser")
      },
      { label: "Use Chromium Speech Recognition", click: () => sendMenuCommand("prompter-open-in-chromium") },
      { type: "separator" },
      { label: "Hide shot scenes", accelerator: "CmdOrCtrl+Alt+H", click: () => sendMenuCommand("toggle-hide-shot") },
      { label: "Minimise the rundown", click: () => sendMenuCommand("toggle-rundown-min") },
      { type: "separator" },
      ...(app.isPackaged ? [] : [
        { role: "reload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const }
      ]),
      { label: "Actual Size", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: () => sendMenuCommand("script-zoom-reset") },
      { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", registerAccelerator: false, click: () => sendMenuCommand("script-zoom-in") },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: () => sendMenuCommand("script-zoom-out") },
      { type: "separator" },
      { role: "togglefullscreen" }
    ]
  };

  const tabMenu: Electron.MenuItemConstructorOptions = {
    label: "Tab",
    submenu: [
      {
        label: "Close Tab",
        accelerator: "CmdOrCtrl+W",
        click: () => {
          const w = focusedWindowRecord();
          if (w && w.activeTabId) requestCloseTab(w.activeTabId);
        }
      },
      { type: "separator" },
      {
        label: "Next Tab",
        accelerator: "Control+Tab",
        click: () => { const w = focusedWindowRecord(); if (w) cycleTab(w.id, 1); }
      },
      {
        label: "Previous Tab",
        accelerator: "Control+Shift+Tab",
        click: () => { const w = focusedWindowRecord(); if (w) cycleTab(w.id, -1); }
      }
    ]
  };

  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: "Help",
    submenu: [
      { label: "User guide…", accelerator: "F1", click: () => sendMenuCommand("help") },
      { label: "Tagging reference", click: () => sendMenuCommand("tagging-help") },
      { label: "Take the tour", click: () => sendMenuCommand("tour") },
      { label: "Set up Splitpage…", click: () => sendMenuCommand("setup") },
      { type: "separator" },
      { label: "About Splitpage", click: () => sendMenuCommand("about") }
    ]
  };

  const template: Electron.MenuItemConstructorOptions[] = isMac
    ? [{ role: "appMenu" }, fileMenu, editMenu, viewMenu, tabMenu, helpMenu]
    : [fileMenu, editMenu, viewMenu, tabMenu, helpMenu];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


const { registerIpc } = createIpcSetup({ ipcMain, app, testMode: TEST_MODE, windowsById });

function tabStripWindowOf(event: DesktopIpcEvent) {
  for (const w of windowsById.values()) {
    if (!w.win.isDestroyed() && w.win.webContents === event.sender) return w;
  }
  return null;
}

function tabOf(event: DesktopIpcEvent) {
  const tabId = webContentsIdToTabId.get(event.sender.id);
  return tabId ? tabs.get(tabId) || null : null;
}

function dialogParentFor(event: DesktopIpcEvent) {
  const tab = tabOf(event);
  if (tab) {
    const w = windowsById.get(tab.windowId);
    if (w && !w.win.isDestroyed()) return w.win;
  }
  return BrowserWindow.fromWebContents(event.sender) || undefined;
}

function launchIntentFor(tab: DesktopMainTab) {
  if (draftsHasDraft(tab.id)) return { type: "restore-draft" };
  if (tab.source.kind === "file" && tab.pendingPayload) return { type: "open-file" };
  return { type: "blank" };
}

const { registerFileIpc } = createFileIpc({
  dialog, fileIds, pathToTabId, tabs, recents, tabOf, dialogParentFor,
  consumeTestDialogAnswer, testDialogsSeen: () => testDialogsSeen, testMode: TEST_MODE
});

const { registerShellIpc } = createShellIpc({
  tabOf, launchIntentFor, draftStore: () => draftStore, draftsIsHeld, hadPriorSession,
  shell, nativeTheme, themeChoice, videoFileGrants, VIDEO_FILE_EXT, testVideoOpens, testMode: TEST_MODE,
  videoThumbnail, updateStatus: () => updateStatus, skipUpdateCheck: SKIP_UPDATE_CHECK, setUpdateStatus,
  checkForUpdate, downloadUpdate, runUpdateInstaller, openPrompterInBrowser,
  voiceHelperInstance: voice.voiceHelperInstance
});

const { registerDocumentIpc } = createDocumentIpc({
  tabOf, fileIds, unindexTabSource, indexTabSource, recents, windowsById, applyWindowTitle,
  pushShellState, persistShellState, docClaims, testMode: TEST_MODE, flushPendingPayload, restoreNotice,
  routeOpenPath, draftStore: () => draftStore, draftFiniteNumber, draftBodyTooLarge, buildDraftHeader,
  draftsPreviousSession: () => draftsPreviousSession, pendingDraftFlushes
});

const { registerHistoryBlobIpc } = createHistoryBlobIpc({
  historyStore: () => historyStore, historyHolds, historyProtectList, historyWireMeta,
  blobStore: () => blobStore, historyPolicy, DOC_ID_RE
});

const { registerTabStripIpc } = createTabStripIpc({
  tabStripWindowOf, shellStateForWindow, tabs, createTab, activateTab, requestCloseTab, reorderTab,
  moveTabToWindow, tearOffToNewWindow
});

const { registerTestModeIpc } = createTestModeIpc({
  testMode: TEST_MODE, app, BrowserWindow, tabOf, tabs, windowsById, requestCloseTab,
  draftStore: () => draftStore, draftsPreviousSession: () => draftsPreviousSession, chooseDuplicateLoser,
  shellStateForWindow, createTab, activateTab, reorderTab, createTabWindow, moveTabToWindow, liveWindows,
  testExternalOpens, testChromiumLaunches, testVideoOpens, prompterShare: voice.prompterShare,
  voiceHelperInstance: voice.voiceHelperInstance
});

const { registerPrintIpc } = createPrintIpc({ pdfPrinter: createPdfPrinter({ app, session, WebContentsView }) });

app.on("second-instance", (_event, argv, cwd) => {
  const files = filesToOpenFrom(app.isPackaged ? argv.slice(1) : argv.slice(2), cwd);
  for (const f of files) routeOpenPath(f, { fromWindowId: lastFocusedWindowId });
  focusWindow(lastFocusedWindowId);
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (!app.isReady()) {
    argvFilesToOpen.push(filePath);
    return;
  }
  routeOpenPath(filePath, { fromWindowId: lastFocusedWindowId });
  focusWindow(lastFocusedWindowId);
});

app.setAppUserModelId("com.retrogorilla.splitpage");

app.whenReady().then(() => {
  nativeTheme.themeSource = themeChoice.read();
  desktopState.sweepTempFiles();
  recents.load();
  const draftInit = initDraftStore();
  initBlobStore();
  initHistoryStore();
  registerProtocol();
  registerIpc({
    registerFileIpc, registerShellIpc, registerDocumentIpc,
    registerHistoryBlobIpc, registerTabStripIpc, registerTestModeIpc, registerPrintIpc
  });
  buildMenu();

  nativeTheme.on("updated", () => {
    const overlay = titleBarOverlayColors();
    for (const w of windowsById.values()) {
      if (w.win.isDestroyed()) continue;
      w.win.setBackgroundColor(backgroundColorForTheme());
      try { w.win.setTitleBarOverlay(overlay); } catch { }
    }
    for (const tab of tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.setBackgroundColor(backgroundColorForTheme());
    }
  });

  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
  });

  const APP_PAGE_RE = /^splitpage:\/\/app(\/|$)/;
  const APP_PERMISSIONS = ["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen"];
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = webContents.getURL();
    const asking = details && typeof details.requestingUrl === "string" ? details.requestingUrl
      : (details && details.isMainFrame === false ? "" : url);
    callback(APP_PAGE_RE.test(url) && APP_PAGE_RE.test(asking) && APP_PERMISSIONS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const url = webContents ? webContents.getURL() : "";
    const asking = (details && details.requestingUrl) || requestingOrigin || "";
    return APP_PAGE_RE.test(url) && APP_PAGE_RE.test(asking) && APP_PERMISSIONS.includes(permission);
  });
  installPlayerReferer(session.defaultSession);

  if (!SKIP_UPDATE_CHECK) checkForUpdate();

  restoreSessionAtLaunch(draftInit);

  registerActivate();
});

registerQuitHandlers();

}
