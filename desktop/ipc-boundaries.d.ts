import type { DesktopMainTab, DesktopMainWindow, DesktopLookupMap } from "./main-types.d.ts";

import type { App, BrowserWindow, Dialog, IpcMainEvent, IpcMainInvokeEvent, Menu, NativeTheme, Shell } from "electron";
import type { chooseDuplicateLoser } from "../shared/doc-id-policy.ts";
import type {
  DesktopIpcArgs, DesktopIpcResult, DesktopWireBoot,
  DesktopWireHistoryMeta, DesktopWireLaunch,
  DesktopWireUpdateStatus
} from "../shared/desktop-contract.d.ts";
import type { createDraftStore } from "./drafts.ts";
import type { createHistoryStore } from "../shared/history-store.ts";
import type * as importHistoryPolicy from "../shared/history-policy.ts";
import type { openableVideoPath, resolveBundledFile } from "../shared/video-embed.ts";
import type { createBundleJobs } from "./bundle-jobs.ts";
import type { DesktopIpcWrappers } from "./ipc-setup.ts";
import type { createVoiceComposition } from "./voice-composition.ts";
import type { createPdfPrinter } from "./print-pdf.ts";
import type { createBlobStore } from "./blob-store.ts";
import type { createFileRegistry } from "./file-service.ts";
import type { createRecents } from "./recents.ts";
import type { createDocClaims } from "./doc-claims.ts";
import type { createRestoreNotice } from "./restore-notice.ts";
import type { createThemeChoice } from "./window-appearance.ts";
import type { createCloseQuit } from "./close-quit.ts";
import type { createTabRegistry } from "./tab-registry.ts";
import type { createDesktopStateStore } from "./desktop-state.ts";

export type DesktopIpcEvent = IpcMainEvent | IpcMainInvokeEvent;




export interface DesktopMainCommon {
  tabOf: (event: DesktopIpcEvent) => DesktopMainTab | null;
  tabs: DesktopLookupMap<string, DesktopMainTab>;
  windowsById: DesktopLookupMap<string, DesktopMainWindow>;
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
  requestCloseTab: ReturnType<typeof createCloseQuit>["requestCloseTab"];
  reorderTab: (id: string | undefined, index: number | undefined) => boolean;
  moveTabToWindow: (tabId: string, windowId: string, index?: number) => boolean;
}

export interface DesktopFileIpcDependencies extends Pick<DesktopMainCommon, "tabOf" | "tabs" | "fileIds" | "recents" | "testMode"> {
  documentsPath: () => string;
  dialog: {
    showOpenDialog: (parent: BrowserWindow | undefined, options: Parameters<Dialog["showOpenDialog"]>[0]) => ReturnType<Dialog["showOpenDialog"]>;
    showMessageBoxSync: (parent: BrowserWindow | undefined, options: Parameters<Dialog["showMessageBoxSync"]>[0]) => ReturnType<Dialog["showMessageBoxSync"]>;
    showSaveDialog: (parent: BrowserWindow | undefined, options: {
      defaultPath: string | undefined; filters: { name: string; extensions: string[] }[] | undefined;
    }) => ReturnType<Dialog["showSaveDialog"]>;
  };
  dialogParentFor: (event: DesktopIpcEvent) => BrowserWindow | undefined;
  pathToTabId: Map<string, string>;
  consumeTestDialogAnswer: () => unknown;
  testDialogsSeen: () => number;
  bundleJobs: Pick<ReturnType<typeof createBundleJobs>, "noteSaveTarget" | "carryForSave" | "saveLanded">;
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
  routeOpenPath: (path: unknown, options: { fromWindowId: string; fromTabId: string }) => DesktopIpcResult<"splitpage:route-open"> | null;
  draftFiniteNumber: (value: unknown) => number | null;
  draftBodyTooLarge: (text: string) => boolean;
  buildDraftHeader: (tab: DesktopMainTab, payload: Record<string, unknown>) => Parameters<ReturnType<typeof createDraftStore>["write"]>[1];
  pendingDraftFlushes: Map<number, (result: object) => void>;
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
  openableVideoPath: typeof openableVideoPath;
  resolveBundledFile: typeof resolveBundledFile;
  bundleJobs: Pick<ReturnType<typeof createBundleJobs>, "copy" | "cancel">;
  testVideoOpens: string[];
  videoThumbnail: (...args: DesktopIpcArgs<"splitpage:video-thumbnail">) => Promise<DesktopIpcResult<"splitpage:video-thumbnail">>;
  updateStatus: () => DesktopWireUpdateStatus;
  skipUpdateCheck: boolean;
  setUpdateStatus: (patch: Partial<DesktopWireUpdateStatus>) => void;
  checkForUpdate: () => Promise<void>;
  downloadUpdate: () => Promise<DesktopIpcResult<"splitpage:update-download">>;
  runUpdateInstaller: () => Promise<DesktopIpcResult<"splitpage:update-install">>;
  openPrompterInBrowser: (tab: DesktopMainTab | null, options?: { chromium: boolean }) => Promise<DesktopIpcResult<"splitpage:prompter-open-in-browser">>;
  voiceHelperInstance: ReturnType<typeof createVoiceComposition>["voiceHelperInstance"];
}

export type DesktopHistoryStoreBoundary = ReturnType<typeof createHistoryStore>;

export interface DesktopHistoryBlobIpcDependencies {
  historyStore: () => DesktopHistoryStoreBoundary | null;
  historyHolds: Map<number, { docId: string; id: string }[]>;
  historyProtectList: (value: unknown) => { docId: string; id: string }[];
  historyWireMeta: <M extends DesktopWireHistoryMeta | null | undefined>(meta: M) => M extends DesktopWireHistoryMeta ? DesktopWireHistoryMeta : M;
  blobStore: () => ReturnType<typeof createBlobStore> | null;
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
  Menu: Pick<typeof Menu, "getApplicationMenu">;
  chooseDuplicateLoser: typeof chooseDuplicateLoser;
  createTabWindow: (options: object) => DesktopMainWindow;
  liveWindows: () => DesktopMainWindow[];
  testExternalOpens: string[];
  testChromiumLaunches: { browser: string; url: string }[];
  testVideoOpens: string[];
  prompterShare: ReturnType<typeof createVoiceComposition>["prompterShare"];
  voiceHelperInstance: ReturnType<typeof createVoiceComposition>["voiceHelperInstance"];
}

export interface DesktopPrintIpcDependencies {
  pdfPrinter: ReturnType<typeof createPdfPrinter>;
}

export type DesktopRegisterIpcGroup = (wrappers: DesktopIpcWrappers) => void;

export interface DesktopCloseQuitDependencies extends Pick<DesktopMainCommon, "testMode" | "tabs" | "windowsById" | "draftStore" | "activateTab">, Pick<DesktopTestModeIpcDependencies, "app" | "liveWindows"> {
  app: Pick<App, "on" | "quit">;
  dialog: Pick<DesktopFileIpcDependencies["dialog"], "showMessageBoxSync">;
  tabHasFile: (tab: DesktopMainTab | null | undefined) => boolean;
  tabIsUnsaved: (tab: DesktopMainTab | null | undefined) => boolean;
  draftsHasDraft: (id: string) => boolean;
  requestDraftFlush: (tab: DesktopMainTab | null | undefined, budgetMs: number, keep?: boolean) => Promise<object>;
  draftFlushBudgetMs: number;
  draftsList: ReturnType<typeof createDraftStore>["list"];
  draftsDiscardForUserDecision: (ids: (string | undefined)[], reason: string) => void;
  draftsDiscardClean: (id: string | undefined) => void;
  consumeTestDialogAnswer: () => unknown;
  focusWindow: (id: string) => void;
  destroyTabView: (id: string | undefined) => void;
  startInstallerNow: () => DesktopIpcResult<"splitpage:update-install">;
  prompterShare: DesktopTestModeIpcDependencies["prompterShare"];
  voiceHelper: () => Pick<ReturnType<DesktopTestModeIpcDependencies["voiceHelperInstance"]>, "stopAll"> | null;
  bundleCopies: () => Pick<ReturnType<typeof createBundleJobs>, "abortAll" | "busy" | "idle"> | null;
}

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
