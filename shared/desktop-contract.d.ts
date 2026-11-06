export interface DesktopWireFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  lastModified: number;
  size: number;
}

export interface DesktopWireStamp {
  lastModified?: number;
  size: number;
}

export interface DesktopWireRecent {
  fileId: string;
  name: string;
  title: string;
  at: number;
}

export interface DesktopWireLaunch {
  type: string;
}

export interface DesktopWireBoot {
  tabId: string;
  windowId: string;
  launchIntent: DesktopWireLaunch;
  hadPriorSession: boolean;
  firstTabOfLaunch: boolean;
  hasDraftToRestore: boolean;
}

export interface DesktopWireFailure {
  ok: false;
  code: string;
}

export type DesktopWireDraftWrite = { ok: true; seq: number; bytes: number; obsolete?: undefined } | DesktopWireFailure;
export type DesktopWireDraftDiscard = { ok: true } | DesktopWireFailure;

export interface DesktopDraftWriteHeader {
  format: "splitpage-draft";
  formatVersion: 1;
  tabId: string;
  title: string;
  docId: string | null;
  docIdWrittenOut: boolean;
  schema: number | null;
  editSeq: number | null;
  writtenAt: number;
  appVersion: string;
  seq: number;
  origin: {
    kind: string;
    filePath: unknown;
    fileName: string | null;
    fileKind: string | null;
    importName: string | null;
    baseLastModified: number | null;
    baseSize: number | null;
  };
  placement: { windowKey: string; index: number; active: boolean };
  state: { bytes: number; sha256: string };
  base: { file: string; bytes: number; sha256: string } | null;
}

export type DesktopDraftReadHeader = Pick<DesktopDraftWriteHeader, "format" | "formatVersion" | "tabId" | "state"> & {
  base?: DesktopDraftWriteHeader["base"];
} & {
  [K in Exclude<keyof DesktopDraftWriteHeader, "format" | "formatVersion" | "tabId" | "state" | "base">]?: unknown;
};

export interface DesktopWireDraftSuccess {
  corrupt?: undefined;
  unsupported?: undefined;
  header: DesktopDraftReadHeader;
  stateJson: string;
  baseJson: string | null;
  baseProblem: "missing" | "corrupt" | null;
  ageMs?: number | null;
  previousSession?: string;
  usedPrevGeneration: boolean;
  file?: DesktopWireFile | null;
  fileProblem?: "missing" | "unreadable" | null;
}

type DesktopDraftFailureFields = {
  [K in Exclude<keyof DesktopWireDraftSuccess, "corrupt" | "unsupported">]?: undefined;
};

export type DesktopWireTakenDraft = DesktopWireDraftSuccess |
  (DesktopDraftFailureFields & { corrupt: true; unsupported?: undefined }) |
  (DesktopDraftFailureFields & { unsupported: true; corrupt?: undefined });

export interface DesktopWireDraftStatus {
  tabId: string | null;
  hasDraft: boolean;
  held: boolean;
  lastSeq: number | null;
  tombstoned: boolean;
  previousSession: string;
  writes: number;
  failures: number;
}

export interface DesktopWireHistoryMeta {
  id: string;
  label: string;
  at: string;
  atMs: number;
  by: string;
  rows: number;
  title: string;
  sizeBytes: number;
  kind: string;
  formatVersion: number;
  legacyId?: string;
}

export interface DesktopWireHistoryOptions {
  protect?: readonly { docId: string; id: string }[];
  older?: boolean;
}

export interface DesktopWireHistoryUsage {
  totalBytes: number;
  capBytes: number;
  overCap: boolean;
  docCount: number;
  readOnly: boolean;
}

export type DesktopWireHistoryPut = {
  ok: true; sizeBytes: number; duplicate: boolean; evicted: number; overCap: boolean;
} | { ok: false; code: string; evicted?: number };

export interface DesktopWireHistoryList {
  entries: DesktopWireHistoryMeta[];
  older: DesktopWireHistoryMeta[];
  olderExpiresAt: number | null;
  damaged?: number;
  olderDamaged?: number;
  usage: DesktopWireHistoryUsage | null;
}

export interface DesktopWireHistoryRead {
  meta: DesktopWireHistoryMeta | null | undefined;
  stateJson: string | undefined;
}

export interface DesktopWireHistoryDoc {
  docId: string;
  title: unknown;
  lastOpenedAt: number;
}

export interface DesktopWireUpdateStatus {
  version: string;
  checkedAt: string | null;
  checking: boolean;
  latest: string | null;
  updateAvailable: boolean;
  pending: null;
  justUpdated: null;
  desktop: boolean;
  canInstall: boolean;
  releaseUrl: unknown;
  error?: string | undefined;
  download: { state: "idle" | "downloading" | "ready" | "failed"; received: number; total: number; error: string | null; verified?: boolean };
}

export type DesktopWireDownload = { ok: true; state: "ready" } | { ok: false; error: string; message?: string };
export type DesktopWireInstall = { ok: true; testMode?: true; quitting?: true } | { ok: false; error: string; message?: string };
export type DesktopWirePrompter = { ok: true; kind: "file"; voice: "relay" | "browser"; browser?: string } | DesktopWireFailure;
export type DesktopWireVoiceStart = { ok: true; session: number } | DesktopWireFailure;
export interface DesktopWireMicrophone {
  id: string;
  name: string;
}
export type DesktopWireMicrophones = { ok: true; microphones: DesktopWireMicrophone[] } | DesktopWireFailure;
export interface DesktopWireVoiceEvent {
  type: string;
  session: number;
  text?: string;
  name?: string;
  lang?: string;
  code?: string;
  reason?: string;
}

export interface DesktopWireShellState {
  windowId: string;
  activeTabId: string | null;
  tabs: { tabId: string; title: string; dirty: boolean; crashed: boolean; pristine: boolean; fullPathForTooltip: unknown }[];
}

export interface DesktopWireTestShellArgs {
  windowId?: string | null;
  tabId?: string;
  index?: number;
  label?: string;
}

export type DesktopWireTestShellResult = DesktopWireShellState | string | boolean | null | string[] |
  { browser: string; url: string }[] |
  { windows: { windowId: string; activeTabId: string | null; tabs: { tabId: string; title: string; dirty: boolean; pristine: boolean; path: unknown }[] }[] } |
  { listening: boolean; port: number | null; shares: string[]; voiceStreams?: number } |
  { available: boolean; running: boolean; tabId: string | null; session: number | null; pid: number | null | undefined; started: number };

export type DesktopChannelRow = {
  [C in keyof DesktopIpcContract]: {
    name: C;
    argsSchema: readonly string[];
    allowedOrigins: readonly string[];
    testOnly?: boolean;
  } & ({ direction: "invoke" | "send" | "receive"; refusal?: undefined } |
    { direction: "sendSync"; refusal: DesktopIpcResult<C> });
}[keyof DesktopIpcContract];

export type DesktopRouteWhere = "this-tab" | "other-tab" | "new-tab";
export type DesktopWireHistoryCopy = { ok: true; copied: number; code?: undefined } |
  { ok: false; copied: number; code: string };

type DesktopChannelCall<A extends readonly unknown[], R> = { args: A; result: R };

export interface DesktopIpcContract {
  "splitpage:ipc-table-sync": DesktopChannelCall<[], readonly DesktopChannelRow[] | null>;
  "splitpage:open-file-dialog": DesktopChannelCall<[], DesktopWireFile | null>;
  "splitpage:save-file-dialog": DesktopChannelCall<[{ suggestedName?: string; filters?: { name: string; extensions: string[] }[] }], { id: string; name: string } | null>;
  "splitpage:read-file": DesktopChannelCall<[string], DesktopWireFile>;
  "splitpage:write-file": DesktopChannelCall<[string, string | ArrayBuffer | Uint8Array], DesktopWireStamp>;
  "splitpage:stat-file": DesktopChannelCall<[string], { lastModified: number; size: number } | null>;
  "splitpage:recents-list": DesktopChannelCall<[], DesktopWireRecent[]>;
  "splitpage:recents-remove": DesktopChannelCall<[string], DesktopWireRecent[]>;
  "splitpage:recents-clear": DesktopChannelCall<[], DesktopWireRecent[]>;
  "splitpage:get-session-info": DesktopChannelCall<[], { testDialogsSeen: number | undefined }>;
  "splitpage:get-app-version-sync": DesktopChannelCall<[], string | null>;
  "splitpage:tab-boot-sync": DesktopChannelCall<[], DesktopWireBoot | null>;
  "splitpage:is-test-mode-sync": DesktopChannelCall<[], boolean>;
  "splitpage:open-external": DesktopChannelCall<[unknown], void>;
  "splitpage:set-theme": DesktopChannelCall<[string], void>;
  "splitpage:video-file-grant": DesktopChannelCall<[string], string | null>;
  "splitpage:video-file-open": DesktopChannelCall<[string], { ok: true } | DesktopWireFailure>;
  "splitpage:video-path-open": DesktopChannelCall<[string], { ok: true } | DesktopWireFailure>;
  "splitpage:video-thumbnail": DesktopChannelCall<[string, string], { ok: true; bytes: Uint8Array; mime: string } | DesktopWireFailure>;
  "splitpage:update-status": DesktopChannelCall<[], DesktopWireUpdateStatus> & { receive: [DesktopWireUpdateStatus] };
  "splitpage:update-check": DesktopChannelCall<[], DesktopWireUpdateStatus>;
  "splitpage:update-download": DesktopChannelCall<[], DesktopWireDownload>;
  "splitpage:update-install": DesktopChannelCall<[], DesktopWireInstall>;
  "splitpage:prompter-open-in-browser": DesktopChannelCall<[], DesktopWirePrompter>;
  "splitpage:prompter-open-in-chromium": DesktopChannelCall<[], DesktopWirePrompter>;
  "splitpage:voice-status": DesktopChannelCall<[], { available: boolean }>;
  "splitpage:voice-start": DesktopChannelCall<[microphone?: string], DesktopWireVoiceStart>;
  "splitpage:voice-microphones": DesktopChannelCall<[], DesktopWireMicrophones>;
  "splitpage:voice-stop": DesktopChannelCall<[], { ok: true }>;
  "splitpage:set-document-state": DesktopChannelCall<[{ title?: string; dirty?: boolean; pristine?: boolean; docId?: string | null; fileId?: string | null }], void>;
  "splitpage:renderer-ready": DesktopChannelCall<[], void>;
  "splitpage:route-open": DesktopChannelCall<[{ kind: "file"; fileId: string }], { where: DesktopRouteWhere }>;
  "splitpage:draft-write": DesktopChannelCall<[unknown], DesktopWireDraftWrite>;
  "splitpage:draft-discard": DesktopChannelCall<[unknown], DesktopWireDraftDiscard>;
  "splitpage:draft-take": DesktopChannelCall<[], DesktopWireTakenDraft | null>;
  "splitpage:draft-restore-done": DesktopChannelCall<[{ outcome: unknown }], void>;
  "splitpage:draft-flushed": DesktopChannelCall<[number, unknown], void>;
  "splitpage:history-put": DesktopChannelCall<[string | null, unknown, string, DesktopWireHistoryOptions], DesktopWireHistoryPut>;
  "splitpage:history-list": DesktopChannelCall<[string | null], DesktopWireHistoryList>;
  "splitpage:history-get": DesktopChannelCall<[{ older?: boolean; docId?: string; protect?: readonly { docId: string; id: string }[] }, string], DesktopWireHistoryRead | null>;
  "splitpage:history-copy": DesktopChannelCall<[string, string], DesktopWireHistoryCopy>;
  "splitpage:history-touch": DesktopChannelCall<[string, unknown], void>;
  "splitpage:history-list-docs": DesktopChannelCall<[], DesktopWireHistoryDoc[]>;
  "splitpage:blob-put": DesktopChannelCall<[string, string | ArrayBuffer | Uint8Array], { ok: true; stored: boolean } | DesktopWireFailure>;
  "splitpage:blob-get": DesktopChannelCall<[string], { bytes: Uint8Array; mime: string } | null>;
  "splitpage:blob-missing": DesktopChannelCall<[readonly string[]], string[]>;
  "splitpage:print-to-pdf": DesktopChannelCall<[string], Uint8Array>;
  "splitpage:open-file": DesktopChannelCall<[DesktopWireFile], void>;
  "splitpage:menu-command": DesktopChannelCall<[string], void>;
  "splitpage:restore-notice": DesktopChannelCall<[{ skipped: { name: string; reason: string }[] }], void>;
  "splitpage:reassign-doc-id": DesktopChannelCall<[{ toId: string; fromId: string; otherTitle: string }], void>;
  "splitpage:draft-flush": DesktopChannelCall<[number, boolean?], void>;
  "splitpage:voice-event": DesktopChannelCall<[DesktopWireVoiceEvent], void>;
  "splitpage:tabstrip-window-id-sync": DesktopChannelCall<[], string | null>;
  "splitpage:tabstrip-get-state": DesktopChannelCall<[], DesktopWireShellState | null>;
  "splitpage:tabstrip-new-tab": DesktopChannelCall<[], void>;
  "splitpage:tabstrip-activate": DesktopChannelCall<[string], void>;
  "splitpage:tabstrip-close": DesktopChannelCall<[string], void>;
  "splitpage:tabstrip-reorder": DesktopChannelCall<[string, number], void>;
  "splitpage:tabstrip-move-here": DesktopChannelCall<[string, number], void>;
  "splitpage:tabstrip-tear-off": DesktopChannelCall<[string, number, number], void>;
  "splitpage:tabstrip-state": DesktopChannelCall<[DesktopWireShellState | null], void>;
  "splitpage:test-request-close": DesktopChannelCall<[], void>;
  "splitpage:test-request-close-tab": DesktopChannelCall<[], void>;
  "splitpage:test-request-quit": DesktopChannelCall<[], void>;
  "splitpage:test-crash-renderer": DesktopChannelCall<[], void>;
  "splitpage:test-draft-status": DesktopChannelCall<[string?], DesktopWireDraftStatus>;
  "splitpage:test-dup-loser": DesktopChannelCall<[{ docId?: unknown; homeKey?: unknown; seq?: unknown }, { docId?: unknown; homeKey?: unknown; seq?: unknown }], "a" | "b" | null>;
  "splitpage:test-shell": DesktopChannelCall<[string, DesktopWireTestShellArgs | null], DesktopWireTestShellResult>;
}

export type DesktopIpcArgs<C extends keyof DesktopIpcContract> = DesktopIpcContract[C]["args"];
export type DesktopIpcResult<C extends keyof DesktopIpcContract> = DesktopIpcContract[C]["result"];
export type DesktopIpcReceiveArgs<C extends keyof DesktopIpcContract> = DesktopIpcContract[C] extends {
  receive: infer A extends readonly unknown[];
} ? A : DesktopIpcArgs<C>;

export interface DesktopTabStripBridge {
  windowId: DesktopIpcResult<"splitpage:tabstrip-window-id-sync">;
  platform: string;
  getShellState: () => Promise<DesktopIpcResult<"splitpage:tabstrip-get-state">>;
  onShellStateChanged: (callback: (state: DesktopIpcArgs<"splitpage:tabstrip-state">[0]) => void) => void;
  newTab: (...args: DesktopIpcArgs<"splitpage:tabstrip-new-tab">) => DesktopIpcResult<"splitpage:tabstrip-new-tab">;
  activateTab: (...args: DesktopIpcArgs<"splitpage:tabstrip-activate">) => DesktopIpcResult<"splitpage:tabstrip-activate">;
  closeTab: (...args: DesktopIpcArgs<"splitpage:tabstrip-close">) => DesktopIpcResult<"splitpage:tabstrip-close">;
  reorderTab: (...args: DesktopIpcArgs<"splitpage:tabstrip-reorder">) => DesktopIpcResult<"splitpage:tabstrip-reorder">;
  moveTabHere: (...args: DesktopIpcArgs<"splitpage:tabstrip-move-here">) => DesktopIpcResult<"splitpage:tabstrip-move-here">;
  tearOffToNewWindow: (...args: DesktopIpcArgs<"splitpage:tabstrip-tear-off">) => DesktopIpcResult<"splitpage:tabstrip-tear-off">;
}
