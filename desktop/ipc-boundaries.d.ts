"use strict";

import type { App, BrowserWindow, Dialog, IpcMainEvent, IpcMainInvokeEvent, NativeTheme, Shell, WebContents, WebContentsView } from "electron";
import type {
  DesktopIpcArgs, DesktopIpcResult, DesktopWireBoot,
  DesktopWireHistoryMeta, DesktopWireHistoryOptions, DesktopWireHistoryUsage, DesktopWireLaunch,
  DesktopWireUpdateStatus
} from "../shared/desktop-contract.d.ts";
import type { createDraftStore } from "./drafts.ts";
import type * as importHistoryPolicy from "../shared/history-policy.ts";
import type { DesktopIpcWrappers } from "./ipc-setup.ts";
import type { createFileRegistry } from "./file-service.ts";
import type { createRecents } from "./recents.ts";
import type { createDocClaims } from "./doc-claims.ts";
import type { createRestoreNotice } from "./restore-notice.ts";
import type { createThemeChoice } from "./window-appearance.ts";
import type { createTabRegistry } from "./tab-registry.ts";
import type { createDesktopStateStore } from "./desktop-state.ts";

export type DesktopIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

export interface DesktopMainTab {
  id: string;
  windowId: string;
  title: string;
  dirty: boolean;
  pristine: boolean;
  docId: string | null;
  fileId: string | null | undefined;
  source: { kind: "file"; absPath: string } | { kind: "blank" };
  ready: boolean;
  keepDraftOnClose?: boolean;
  pendingPayload: unknown;
  launchIntent: DesktopWireLaunch;
  firstTabOfLaunch?: boolean;
  view: WebContentsView;
}

export interface DesktopMainWindow {
  id: string;
  win: BrowserWindow;
  activeTabId: string | null;
  tabIds: string[];
}

export interface DesktopMainCommon {
  tabOf: (event: DesktopIpcEvent) => DesktopMainTab | null;
  tabs: Map<string | undefined, DesktopMainTab>;
  windowsById: Map<string, DesktopMainWindow>;
  fileIds: ReturnType<typeof createFileRegistry>;
  recents: ReturnType<typeof createRecents>;
  testMode: boolean;
  draftStore: () => ReturnType<typeof createDraftStore> | null;
  draftsPreviousSession: () => string;
  shellStateForWindow: (id: string) => DesktopIpcResult<"splitpage:tabstrip-get-state">;
  createTab: (windowId: string, options: {
    source: DesktopMainTab["source"]; launchIntent: DesktopWireLaunch;
    tabId?: string | undefined; pendingPayload?: DesktopMainTab["pendingPayload"]; index?: unknown;
  }) => DesktopMainTab | null;
  activateTab: (id: string | undefined) => void;
  requestCloseTab: (id: string | undefined) => void;
  reorderTab: (id: string | undefined, index: number | undefined) => boolean;
  moveTabToWindow: (tabId: string, windowId: string, index?: number) => boolean;
}

export interface DesktopFileIpcDependencies extends Pick<DesktopMainCommon, "tabOf" | "tabs" | "fileIds" | "recents" | "testMode"> {
  dialog: {
    showOpenDialog: (parent: BrowserWindow | undefined, options: Parameters<Dialog["showOpenDialog"]>[0]) => ReturnType<Dialog["showOpenDialog"]>;
    showMessageBoxSync: (parent: BrowserWindow | undefined, options: Parameters<Dialog["showMessageBoxSync"]>[0]) => ReturnType<Dialog["showMessageBoxSync"]>;
    showSaveDialog: (parent: BrowserWindow | undefined, options: {
      defaultPath: string | undefined; filters: { name: string; extensions: string[] }[] | undefined;
    }) => ReturnType<Dialog["showSaveDialog"]>;
  };
  dialogParentFor: (event: DesktopIpcEvent) => BrowserWindow | undefined;
  pathToTabId: Map<string, string>;
  consumeTestDialogAnswer: () => string | null | undefined;
  testDialogsSeen: () => number;
}

export interface DesktopDocumentIpcDependencies extends Pick<DesktopMainCommon, "tabOf" | "fileIds" | "recents" | "windowsById" | "testMode" | "draftStore" | "draftsPreviousSession"> {
  unindexTabSource: (tab: DesktopMainTab) => void;
  indexTabSource: (tab: DesktopMainTab) => void;
  applyWindowTitle: (window: DesktopMainWindow) => void;
  pushShellState: (windowId: string) => void;
  persistShellState: () => void;
  docClaims: ReturnType<typeof createDocClaims>;
  flushPendingPayload: (tab: DesktopMainTab, options?: { force: boolean }) => void;
  restoreNotice: Pick<ReturnType<typeof createRestoreNotice>, "isFor" | "deliver">;
  routeOpenPath: (path: string, options: { fromWindowId: string; fromTabId: string }) => DesktopIpcResult<"splitpage:route-open"> | null;
  draftFiniteNumber: (value: unknown) => number | null;
  draftBodyTooLarge: (text: string) => boolean;
  buildDraftHeader: (tab: DesktopMainTab, payload: Record<string, unknown>) => Parameters<ReturnType<typeof createDraftStore>["write"]>[1];
  pendingDraftFlushes: Map<number, (result: object) => void>;
}

export interface DesktopVoiceBoundary {
  available: () => boolean;
  start: (id: string) => DesktopIpcResult<"splitpage:voice-start">;
  stop: (id: string) => DesktopIpcResult<"splitpage:voice-stop">;
  status: () => { available: boolean; running: boolean; tabId: string | null; session: number | null; pid: number | null | undefined; started: number };
}

export interface DesktopShellIpcDependencies extends Pick<DesktopMainCommon, "tabOf" | "draftStore" | "testMode"> {
  launchIntentFor: (tab: DesktopMainTab) => DesktopWireBoot["launchIntent"];
  draftsIsHeld: (id: string) => boolean;
  hadPriorSession: () => boolean;
  shell: Pick<Shell, "openExternal" | "openPath">;
  nativeTheme: Pick<NativeTheme, "themeSource">;
  themeChoice: Pick<ReturnType<typeof createThemeChoice>, "write">;
  videoFileGrants: Map<string, string>;
  VIDEO_FILE_EXT: RegExp;
  testVideoOpens: string[];
  videoThumbnail: (...args: DesktopIpcArgs<"splitpage:video-thumbnail">) => Promise<DesktopIpcResult<"splitpage:video-thumbnail">>;
  updateStatus: () => DesktopWireUpdateStatus;
  skipUpdateCheck: boolean;
  setUpdateStatus: (patch: Partial<DesktopWireUpdateStatus>) => void;
  checkForUpdate: () => Promise<void>;
  downloadUpdate: () => Promise<DesktopIpcResult<"splitpage:update-download">>;
  runUpdateInstaller: () => Promise<DesktopIpcResult<"splitpage:update-install">>;
  openPrompterInBrowser: (tab: DesktopMainTab | null, options?: { chromium: boolean }) => Promise<DesktopIpcResult<"splitpage:prompter-open-in-browser">>;
  voiceHelperInstance: () => DesktopVoiceBoundary;
}

export interface DesktopHistoryStoreBoundary {
  put: (docId: string | null, meta: DesktopWireHistoryMeta, state: string, opts: DesktopWireHistoryOptions) => Promise<{ stored: boolean; code?: string; duplicate?: boolean; evicted?: number; overCap?: boolean }>;
  list: (docId: string | null) => Promise<Omit<DesktopIpcResult<"splitpage:history-list">, "usage">>;
  usage: () => Promise<DesktopWireHistoryUsage>;
  get: (bucket: string, id: string) => Promise<DesktopIpcResult<"splitpage:history-get">>;
  copy: (...args: DesktopIpcArgs<"splitpage:history-copy">) => Promise<DesktopIpcResult<"splitpage:history-copy">>;
  touch: (...args: DesktopIpcArgs<"splitpage:history-touch">) => Promise<void>;
  listDocs: () => Promise<DesktopIpcResult<"splitpage:history-list-docs">>;
}

export interface DesktopHistoryBlobIpcDependencies {
  historyStore: () => DesktopHistoryStoreBoundary | null;
  historyHolds: Map<number, { docId: string; id: string }[]>;
  historyProtectList: (value: unknown) => { docId: string; id: string }[];
  historyWireMeta: (meta: DesktopWireHistoryMeta) => DesktopWireHistoryMeta;
  blobStore: () => {
    put: (sha: string, bytes: Buffer) => Promise<DesktopIpcResult<"splitpage:blob-put">>;
    get: (sha: string) => Promise<Buffer | null>;
    missing: (shas: readonly string[]) => Promise<string[]>;
  } | null;
  historyPolicy: Pick<typeof importHistoryPolicy, "HISTORY_OLDER_KEY" | "HISTORY_SNAP_ID_RE" | "historyUtf8Length" | "sanitizeHistoryMeta">;
  DOC_ID_RE: RegExp;
}

export interface DesktopTabStripIpcDependencies extends Pick<DesktopMainCommon, "tabs" | "shellStateForWindow" | "createTab" | "activateTab" | "requestCloseTab" | "reorderTab" | "moveTabToWindow"> {
  tabStripWindowOf: (event: DesktopIpcEvent) => DesktopMainWindow | null;
  tearOffToNewWindow: (tabId: string, x: number, y: number) => void;
}

export interface DesktopTestModeIpcDependencies extends Pick<DesktopMainCommon, "testMode" | "tabOf" | "tabs" | "windowsById" | "requestCloseTab" | "draftStore" | "draftsPreviousSession" | "shellStateForWindow" | "createTab" | "activateTab" | "reorderTab" | "moveTabToWindow"> {
  app: Pick<App, "quit">;
  BrowserWindow: Pick<typeof BrowserWindow, "fromWebContents">;
  chooseDuplicateLoser: <T extends { docId: string; homeKey: string; seq: number }>(a: T, b: T) => T | null;
  createTabWindow: (options: object) => DesktopMainWindow;
  liveWindows: () => DesktopMainWindow[];
  testExternalOpens: string[];
  testChromiumLaunches: { browser: string; url: string }[];
  testVideoOpens: string[];
  prompterShare: () => { status: () => { listening: boolean; port: number | null; shares: string[]; voiceStreams: number } } | null;
  voiceHelperInstance: () => DesktopVoiceBoundary;
}

export interface DesktopPrintIpcDependencies {
  pdfPrinter: { print: (sender: WebContents, html: string) => Promise<DesktopIpcResult<"splitpage:print-to-pdf">> };
}

export type DesktopRegisterIpcGroup = (wrappers: DesktopIpcWrappers) => void;

export interface DesktopSessionRestoreDependencies extends Pick<DesktopMainCommon, "tabs" | "windowsById" | "draftStore" | "createTab" | "activateTab">, Pick<ReturnType<typeof createTabRegistry>, "pathToTabId" | "claimRoutingKey" | "firstWindowRecord"> {
  app: Pick<App, "on">;
  BrowserWindow: Pick<typeof BrowserWindow, "getAllWindows">;
  desktopState: Pick<ReturnType<typeof createDesktopStateStore>, "read">;
  draftsList: ReturnType<typeof createDraftStore>["list"];
  createTabWindow: (options: Partial<Pick<ReturnType<ReturnType<typeof createDesktopStateStore>["read"]>["windows"][number], "windowId" | "bounds" | "maximized">>) => DesktopMainWindow;
  liveWindows: DesktopTestModeIpcDependencies["liveWindows"];
  payloadForSource: (source: DesktopMainTab["source"]) => DesktopMainTab["pendingPayload"];
  routeLaunchFile: (file: string) => void;
  argvFilesToOpen: string[];
  restoreNotice: Pick<ReturnType<typeof createRestoreNotice>, "set">;
  persistShellState: DesktopDocumentIpcDependencies["persistShellState"];
}
