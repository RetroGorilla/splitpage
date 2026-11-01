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

export type DesktopWireDraftWrite = { ok: true; seq: number; bytes: number } | DesktopWireFailure;
export type DesktopWireDraftDiscard = { ok: true } | DesktopWireFailure;

export interface DesktopWireDraftHeader {
  format: string;
  formatVersion: number;
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
    filePath: string | null;
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

export interface DesktopWireTakenDraft {
  corrupt?: true;
  unsupported?: true;
  header?: DesktopWireDraftHeader;
  stateJson?: string;
  baseJson?: string | null;
  baseProblem?: string | null;
  ageMs?: number | null;
  previousSession?: string;
  usedPrevGeneration?: boolean;
  file?: DesktopWireFile | null;
  fileProblem?: "missing" | "unreadable" | null;
}

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
  usage: DesktopWireHistoryUsage | null;
}

export interface DesktopWireHistoryRead {
  meta: DesktopWireHistoryMeta;
  stateJson: string;
}

export interface DesktopWireHistoryDoc {
  docId: string;
  title: string;
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
  releaseUrl: string | null;
  error?: string | undefined;
  download: { state: string; received: number; total: number; error: string | null; verified?: boolean };
}

export type DesktopWireDownload = { ok: true; state: "ready" } | { ok: false; error: string; message?: string };
export type DesktopWireInstall = { ok: true; testMode?: true; quitting?: true } | { ok: false; error: string; message?: string };
export type DesktopWirePrompter = { ok: true; kind: "file"; voice: "relay" | "browser"; browser?: string } | DesktopWireFailure;
export type DesktopWireVoiceStart = { ok: true; session: number } | DesktopWireFailure;
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
  tabs: ({ tabId: string; title: string; dirty: boolean; crashed: boolean; pristine: boolean; fullPathForTooltip: string | null } | null)[];
}

export interface DesktopWireTestShellArgs {
  windowId?: string | null;
  tabId?: string;
  index?: number;
}

export type DesktopWireTestShellResult = DesktopWireShellState | string | boolean | null | string[] |
  { browser: string; url: string }[] |
  { windows: { windowId: string; activeTabId: string | null; tabs: ({ tabId: string; title: string; dirty: boolean; pristine: boolean; path: string | null } | null)[] }[] } |
  { listening: boolean; port: number | null; shares: string[]; voiceStreams?: number } |
  { available: boolean; running: boolean; tabId: string | null; session: number | null; pid: number | null | undefined; started: number };

export interface DesktopChannelRow {
  name: keyof DesktopIpcContract;
  direction: "invoke" | "send" | "sendSync" | "receive";
  argsSchema: readonly string[];
  allowedOrigins: readonly string[];
  refusal?: null | false;
  testOnly?: boolean;
}

type DesktopChannelCall<A extends readonly unknown[], R> = { args: A; result: R };

export interface DesktopIpcContract {
  "splitpage:ipc-table-sync": DesktopChannelCall<[], readonly DesktopChannelRow[]>;
  "splitpage:open-file-dialog": DesktopChannelCall<[], DesktopWireFile | null>;
  "splitpage:save-file-dialog": DesktopChannelCall<[{ suggestedName?: string; filters?: { name: string; extensions: string[] }[] }], { id: string; name: string } | null>;
  "splitpage:read-file": DesktopChannelCall<[string], DesktopWireFile>;
  "splitpage:write-file": DesktopChannelCall<[string, string | ArrayBuffer | ArrayBufferView], DesktopWireStamp>;
  "splitpage:stat-file": DesktopChannelCall<[string], { lastModified: number; size: number } | null>;
  "splitpage:recents-list": DesktopChannelCall<[], DesktopWireRecent[]>;
  "splitpage:recents-remove": DesktopChannelCall<[string], DesktopWireRecent[]>;
  "splitpage:recents-clear": DesktopChannelCall<[], DesktopWireRecent[]>;
  "splitpage:get-session-info": DesktopChannelCall<[], { testDialogsSeen: number | undefined }>;
  "splitpage:get-app-version-sync": DesktopChannelCall<[], string>;
  "splitpage:tab-boot-sync": DesktopChannelCall<[], DesktopWireBoot | null>;
  "splitpage:is-test-mode-sync": DesktopChannelCall<[], boolean>;
  "splitpage:open-external": DesktopChannelCall<[string], void>;
  "splitpage:set-theme": DesktopChannelCall<[string], void>;
  "splitpage:video-file-grant": DesktopChannelCall<[string], string | null>;
  "splitpage:video-file-open": DesktopChannelCall<[string], { ok: true } | DesktopWireFailure>;
  "splitpage:video-thumbnail": DesktopChannelCall<[string, string], { ok: true; bytes: Uint8Array; mime: string } | DesktopWireFailure>;
  "splitpage:update-status": DesktopChannelCall<[], DesktopWireUpdateStatus> & { receive: [DesktopWireUpdateStatus] };
  "splitpage:update-check": DesktopChannelCall<[], DesktopWireUpdateStatus>;
  "splitpage:update-download": DesktopChannelCall<[], DesktopWireDownload>;
  "splitpage:update-install": DesktopChannelCall<[], DesktopWireInstall>;
  "splitpage:prompter-open-in-browser": DesktopChannelCall<[], DesktopWirePrompter>;
  "splitpage:prompter-open-in-chromium": DesktopChannelCall<[], DesktopWirePrompter>;
  "splitpage:voice-status": DesktopChannelCall<[], { available: boolean }>;
  "splitpage:voice-start": DesktopChannelCall<[], DesktopWireVoiceStart>;
  "splitpage:voice-stop": DesktopChannelCall<[], { ok: true }>;
  "splitpage:set-document-state": DesktopChannelCall<[{ title?: string; dirty?: boolean; pristine?: boolean; docId?: string | null; fileId?: string | null }], void>;
  "splitpage:renderer-ready": DesktopChannelCall<[], void>;
  "splitpage:route-open": DesktopChannelCall<[{ kind: "file"; fileId: string }], { where: string }>;
  "splitpage:draft-write": DesktopChannelCall<[unknown], DesktopWireDraftWrite>;
  "splitpage:draft-discard": DesktopChannelCall<[unknown], DesktopWireDraftDiscard>;
  "splitpage:draft-take": DesktopChannelCall<[], DesktopWireTakenDraft | null>;
  "splitpage:draft-restore-done": DesktopChannelCall<[{ outcome: unknown }], void>;
  "splitpage:draft-flushed": DesktopChannelCall<[number, unknown], void>;
  "splitpage:history-put": DesktopChannelCall<[string | null, unknown, string, DesktopWireHistoryOptions], DesktopWireHistoryPut>;
  "splitpage:history-list": DesktopChannelCall<[string | null], DesktopWireHistoryList>;
  "splitpage:history-get": DesktopChannelCall<[{ older?: boolean; docId?: string; protect?: readonly { docId: string; id: string }[] }, string], DesktopWireHistoryRead | null>;
  "splitpage:history-copy": DesktopChannelCall<[string, string], { ok: boolean; copied: number; code?: string }>;
  "splitpage:history-touch": DesktopChannelCall<[string, unknown], void>;
  "splitpage:history-list-docs": DesktopChannelCall<[], DesktopWireHistoryDoc[]>;
  "splitpage:blob-put": DesktopChannelCall<[string, string | ArrayBuffer | ArrayBufferView], { ok: true; stored: boolean } | DesktopWireFailure>;
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
