import type { HistoryDesktopPort } from "../../application/recovery/history-ports.ts";
import type { DesktopDocumentState } from "../../application/desktop/document-state.ts";
import type { DesktopIpcArgs, DesktopIpcContract, DesktopIpcReceiveArgs, DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";

export type Listener<T> = (value: T) => void;

type DesktopResultKeys<T> = T extends object ? keyof T : never;
type DesktopCompleteResult<T, All = T> = T extends object ? T & {
  [K in Exclude<DesktopResultKeys<All>, keyof T>]?: never;
} : T;
type DesktopCall<C extends keyof DesktopIpcContract> = (...args: DesktopIpcArgs<C>) => Promise<DesktopCompleteResult<DesktopIpcResult<C>>>;
type DesktopByteFields<T> = T extends object ? { [K in keyof T]: K extends "bytes" ? Uint8Array : T[K] } &
  ("bytes" extends keyof T ? object : { bytes?: never }) : T;
export type DesktopFileEntry = DesktopByteFields<DesktopIpcResult<"splitpage:read-file">>;
export type DesktopLaunchIntent = NonNullable<DesktopIpcResult<"splitpage:tab-boot-sync">>["launchIntent"];
export type DesktopRouteRequest = DesktopIpcArgs<"splitpage:route-open">[0];
export type DesktopBlob = DesktopByteFields<NonNullable<DesktopIpcResult<"splitpage:blob-get">>>;
type DesktopDraftFields<T> = T extends object ? {
  [K in keyof T]: K extends "file" ? DesktopByteFields<T[K]> : T[K];
} : T;
export type DesktopTakenDraft = DesktopDraftFields<NonNullable<DesktopIpcResult<"splitpage:draft-take">>>;
export type DesktopThumbnailResult = DesktopByteFields<DesktopIpcResult<"splitpage:video-thumbnail">>;
export type DesktopPdfBytes = DesktopByteFields<{ bytes: DesktopIpcResult<"splitpage:print-to-pdf"> }>["bytes"];
export type DesktopVideoGrant = Extract<DesktopIpcResult<"splitpage:video-file-grant">, string> | null;
export type DesktopBundleProgress = Pick<DesktopIpcArgs<"splitpage:bundle-progress">[0], "done" | "total">;

export interface DesktopPort extends HistoryDesktopPort {
  readonly isDesktop: true;
  readonly platform: string;
  readonly appVersion: DesktopIpcResult<"splitpage:get-app-version-sync">;
  readonly tabId: string | null;
  readonly windowId: string | null;
  readonly launchIntent: DesktopLaunchIntent;
  readonly hadPriorSession: boolean;
  readonly firstTabOfLaunch: boolean;
  readonly hasDraftToRestore: boolean;

  readonly openFileDialog: () => Promise<DesktopByteFields<DesktopIpcResult<"splitpage:open-file-dialog">>>;
  readonly saveFileDialog: DesktopCall<"splitpage:save-file-dialog">;
  readonly readFile: (id: string) => Promise<DesktopFileEntry>;
  readonly writeFile: (id: DesktopIpcArgs<"splitpage:write-file">[0], bytes: Uint8Array) => Promise<DesktopIpcResult<"splitpage:write-file">>;
  readonly statFile: DesktopCall<"splitpage:stat-file">;
  readonly routeOpen: DesktopCall<"splitpage:route-open">;
  readonly listRecents: DesktopCall<"splitpage:recents-list">;
  readonly removeRecent: DesktopCall<"splitpage:recents-remove">;
  readonly clearRecents: DesktopCall<"splitpage:recents-clear">;

  readonly onRestoreNotice: (cb: Listener<DesktopIpcReceiveArgs<"splitpage:restore-notice">[0]>) => void;
  readonly onReassignDocId: (cb: Listener<DesktopIpcReceiveArgs<"splitpage:reassign-doc-id">[0]>) => void;
  readonly onOpenFile: (cb: Listener<DesktopFileEntry>) => void;
  readonly onMenuCommand: (cb: Listener<DesktopIpcReceiveArgs<"splitpage:menu-command">[0]>) => void;
  readonly setDocumentState: (state: DesktopDocumentState) => void;

  readonly writeDraft: DesktopCall<"splitpage:draft-write">;
  readonly discardDraft: (seq: number) => Promise<DesktopIpcResult<"splitpage:draft-discard">>;
  readonly takeDraft: () => Promise<DesktopTakenDraft | null>;
  readonly draftRestoreDone: (outcome: DesktopIpcArgs<"splitpage:draft-restore-done">[0]["outcome"]) => void;
  readonly onDraftFlush: (cb: (request: { readonly keep: boolean }) => unknown) => void;

  readonly blobPut: DesktopCall<"splitpage:blob-put">;
  readonly blobGet: (sha: string) => Promise<DesktopBlob | null>;
  readonly blobMissing: DesktopCall<"splitpage:blob-missing">;
  readonly printToPdf: (html: DesktopIpcArgs<"splitpage:print-to-pdf">[0]) => Promise<DesktopPdfBytes>;

  readonly getSessionInfo: DesktopCall<"splitpage:get-session-info">;
  readonly openExternal: (...args: DesktopIpcArgs<"splitpage:open-external">) => void;
  readonly setTheme: (...args: DesktopIpcArgs<"splitpage:set-theme">) => void;
  readonly grantVideoFile: (file: unknown) => Promise<DesktopVideoGrant>;
  readonly openVideoFile: DesktopCall<"splitpage:video-file-open">;
  readonly videoFilePath: (file: unknown) => string | null;
  readonly openVideoPath: DesktopCall<"splitpage:video-path-open">;
  readonly bundleVideoFile: (token: string, job: string, onProgress?: Listener<DesktopBundleProgress>) => ReturnType<DesktopCall<"splitpage:bundle-file">>;
  readonly onBundleCarry: (cb: Listener<DesktopIpcReceiveArgs<"splitpage:bundle-carry">[0]>) => void;
  readonly cancelBundle: (...args: DesktopIpcArgs<"splitpage:bundle-cancel">) => void;
  readonly openBundledFile: DesktopCall<"splitpage:bundled-file-open">;
  readonly planBundleSave: DesktopCall<"splitpage:bundle-save-plan">;
  readonly chooseBundleSave: DesktopCall<"splitpage:bundle-save-choice">;
  readonly planBundleExport: (job: string, scriptName: string, bytes: Uint8Array) => ReturnType<DesktopCall<"splitpage:bundle-export-plan">>;
  readonly exportBundle: (job: string, fileId: string, onProgress?: Listener<DesktopBundleProgress>) => ReturnType<DesktopCall<"splitpage:bundle-export">>;
  readonly videoThumbnail: (...args: DesktopIpcArgs<"splitpage:video-thumbnail">) => Promise<DesktopThumbnailResult>;

  readonly getUpdateStatus: DesktopCall<"splitpage:update-status">;
  readonly checkForUpdate: DesktopCall<"splitpage:update-check">;
  readonly downloadUpdate: DesktopCall<"splitpage:update-download">;
  readonly installUpdate: DesktopCall<"splitpage:update-install">;
  readonly onUpdateStatus: (cb: Listener<DesktopIpcReceiveArgs<"splitpage:update-status">[0]> | null) => void;
  readonly openPrompterInBrowser: DesktopCall<"splitpage:prompter-open-in-browser">;
  readonly openPrompterInChromium: DesktopCall<"splitpage:prompter-open-in-chromium">;
  readonly voiceStatus: DesktopCall<"splitpage:voice-status">;
  readonly voiceStart: DesktopCall<"splitpage:voice-start">;
  readonly voiceMicrophones: DesktopCall<"splitpage:voice-microphones">;
  readonly voiceStop: DesktopCall<"splitpage:voice-stop">;
  readonly onVoiceEvent: (cb: Listener<DesktopIpcReceiveArgs<"splitpage:voice-event">[0]>) => void;
}

export type DesktopTestPort = { -readonly [K in keyof DesktopPort]?: DesktopPort[K] };

declare const malformedDesktopReply: unique symbol;
export type MalformedDesktopReply<T = unknown> = T & { readonly [malformedDesktopReply]: true };
type DesktopFaultInjectionPort = {
  -readonly [K in keyof DesktopPort]?: DesktopPort[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R | MalformedDesktopReply> : DesktopPort[K];
};

export type DesktopMember = keyof DesktopPort;

export const DESKTOP_PORT_MEMBERS = [
  "isDesktop", "platform", "appVersion", "tabId", "windowId", "launchIntent",
  "hadPriorSession", "firstTabOfLaunch", "hasDraftToRestore",
  "openFileDialog", "saveFileDialog", "readFile", "writeFile", "statFile", "routeOpen",
  "listRecents", "removeRecent", "clearRecents",
  "onRestoreNotice", "onReassignDocId", "onOpenFile", "onMenuCommand", "setDocumentState",
  "writeDraft", "discardDraft", "takeDraft", "draftRestoreDone", "onDraftFlush",
  "historyPut", "historyList", "historyGet", "historyCopy", "historyTouch", "historyListDocs",
  "blobPut", "blobGet", "blobMissing", "printToPdf",
  "getSessionInfo", "openExternal", "setTheme",
  "grantVideoFile", "openVideoFile", "videoFilePath", "openVideoPath",
  "bundleVideoFile", "onBundleCarry", "cancelBundle", "openBundledFile", "planBundleSave", "chooseBundleSave",
  "planBundleExport", "exportBundle", "videoThumbnail",
  "getUpdateStatus", "checkForUpdate", "downloadUpdate", "installUpdate", "onUpdateStatus",
  "openPrompterInBrowser", "openPrompterInChromium",
  "voiceStatus", "voiceStart", "voiceMicrophones", "voiceStop", "onVoiceEvent"
] as const satisfies readonly DesktopMember[];

export const UNUSED_DESKTOP_MEMBERS = [
  "__testRequestClose", "__testRequestQuit", "__testRequestCloseTab", "__testShell",
  "__testDupLoser", "__testDraftStatus", "__testCrashRenderer"
] as const;

let attached: DesktopPort | null = null;
let current: DesktopPort | null = null;

function use(port: DesktopPort | null | undefined): void {
  current = port || null;
}

export function attachDesktop(bridge: DesktopPort | null | undefined): void {
  attached = bridge || null;
  use(attached);
}

export function desktopPort(): DesktopPort | null {
  return current;
}

export function runningOnDesktop(): boolean {
  return current !== null;
}

export function canOpenPrompterInBrowser(): boolean {
  return current !== null && typeof current.openPrompterInBrowser === "function";
}

export function canOpenPrompterInChromium(): boolean {
  return current !== null && typeof current.openPrompterInChromium === "function";
}

export function useDesktopForTest(fake: DesktopTestPort | DesktopFaultInjectionPort | null | undefined): void {
  use(fake as DesktopPort | null | undefined);
}

export function restoreDesktop(): void {
  use(attached);
}
