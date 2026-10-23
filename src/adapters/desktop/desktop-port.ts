import { setRunningOnDesktop } from "../../application/desktop-presence.ts";

export type Listener<T> = (value: T) => void;

export interface DesktopResult {
  readonly ok?: boolean;
  readonly code?: string;
  readonly [key: string]: unknown;
}

export interface DesktopFileEntry {
  readonly id: string;
  readonly name: string;
  readonly bytes?: Uint8Array;
  readonly lastModified?: number;
}

export interface DesktopTunnel {
  readonly userHost: string;
  readonly remotePort: number;
  readonly localPort: number;
}

export interface DesktopConnection {
  readonly serverUrl: string;
  readonly token: string;
  readonly tunnel: DesktopTunnel | null;
}

export interface DesktopLaunchIntent {
  readonly type: string;
}

export interface DesktopDocumentState {
  readonly title: string;
  readonly dirty: boolean;
  readonly pristine: boolean;
  readonly docId: string | null;
  readonly fileId: string | null;
  readonly serverKey: string | null;
  readonly serverUrl: string | null;
  readonly tunnel: unknown;
  readonly role: string | null;
}

export interface DesktopRouteRequest {
  readonly kind: "file" | "server";
  readonly fileId?: string;
  readonly serverDocId?: string;
  readonly serverUrl?: string;
  readonly token?: string;
  readonly tunnel?: unknown;
}

export interface DesktopHistoryOptions {
  readonly protect?: readonly string[];
  readonly older?: boolean;
}

export interface DesktopBlob {
  readonly bytes: Uint8Array;
  readonly [key: string]: unknown;
}

export interface DesktopTakenDraft {
  readonly file?: DesktopFileEntry;
  readonly [key: string]: unknown;
}

export interface DesktopPort {
  readonly isDesktop: true;
  readonly platform: string;
  readonly appVersion: string;
  readonly tabId: string | null;
  readonly windowId: string | null;
  readonly launchIntent: DesktopLaunchIntent;
  readonly connection: DesktopConnection | null;
  readonly hadPriorSession: boolean;
  readonly firstTabOfLaunch: boolean;
  readonly hasDraftToRestore: boolean;

  readonly openFileDialog: () => Promise<DesktopFileEntry | null>;
  readonly saveFileDialog: (options: { readonly suggestedName?: string; readonly [key: string]: unknown }) => Promise<DesktopFileEntry | null>;
  readonly readFile: (id: string) => Promise<DesktopFileEntry>;
  readonly writeFile: (id: string, data: Uint8Array) => Promise<{ readonly lastModified?: number } | null>;
  readonly statFile: (id: string) => Promise<DesktopResult>;
  readonly routeOpen: (request: DesktopRouteRequest) => Promise<{ readonly where?: string } | null>;
  readonly listRecents: () => Promise<readonly unknown[]>;
  readonly removeRecent: (fileId: string) => Promise<readonly unknown[]>;
  readonly clearRecents: () => Promise<readonly unknown[]>;

  readonly onOpenServerDoc: (cb: Listener<{ readonly serverDocId?: string; readonly [key: string]: unknown }>) => void;
  readonly onRestoreNotice: (cb: Listener<{ readonly skipped?: readonly { readonly name?: string; readonly reason?: string }[] }>) => void;
  readonly onReassignDocId: (cb: Listener<{ readonly toId: string; readonly [key: string]: unknown } | null>) => void;
  readonly onOpenFile: (cb: Listener<DesktopFileEntry>) => void;
  readonly onMenuCommand: (cb: Listener<string>) => void;
  readonly setDocumentState: (state: DesktopDocumentState) => void;

  readonly writeDraft: (payload: unknown) => Promise<DesktopResult | null>;
  readonly discardDraft: (seq: number) => Promise<DesktopResult | null>;
  readonly takeDraft: () => Promise<DesktopTakenDraft | null>;
  readonly draftRestoreDone: (outcome: unknown) => void;
  readonly onDraftFlush: (cb: (request: { readonly keep: boolean }) => unknown) => void;

  readonly historyPut: (docId: string | null, meta: unknown, stateJson: string, opts?: DesktopHistoryOptions) => Promise<unknown>;
  readonly historyList: (docId: string | null) => Promise<unknown>;
  readonly historyGet: (query: unknown, snapshotId: string) => Promise<unknown>;
  readonly historyCopy: (fromDocId: string, toDocId: string) => Promise<unknown>;
  readonly historyTouch: (docId: string, title: string) => Promise<unknown>;
  readonly historyListDocs: () => Promise<unknown>;

  readonly blobPut: (sha: string, bytes: Uint8Array) => Promise<unknown>;
  readonly blobGet: (sha: string) => Promise<DesktopBlob | null>;
  readonly blobMissing: (shas: readonly string[]) => Promise<readonly string[]>;

  readonly getSessionInfo: () => Promise<{ readonly hosting?: boolean; readonly [key: string]: unknown } | null>;
  readonly openExternal: (url: string) => void;
  readonly setTheme: (mode: string) => void;

  readonly grantVideoFile: (file: unknown) => Promise<string | null>;
  readonly openVideoFile: (token: string) => Promise<DesktopResult | null>;
  readonly videoThumbnail: (host: string, ref: string) => Promise<DesktopResult>;

  readonly getUpdateStatus: () => Promise<DesktopResult | null>;
  readonly checkForUpdate: () => Promise<DesktopResult | null>;
  readonly downloadUpdate: () => Promise<DesktopResult | null>;
  readonly installUpdate: () => Promise<DesktopResult | null>;
  readonly onUpdateStatus: (cb: Listener<unknown>) => void;

  readonly openPrompterInBrowser: () => Promise<DesktopResult | null>;
  readonly openPrompterInChromium: () => Promise<DesktopResult | null>;

  readonly voiceStatus: () => Promise<{ readonly available?: boolean } | null>;
  readonly voiceStart: () => Promise<DesktopResult | null>;
  readonly voiceStop: () => Promise<DesktopResult | null>;
  readonly onVoiceEvent: (cb: Listener<unknown>) => void;

  readonly driveStatus: () => Promise<DesktopResult | null>;
  readonly driveSignIn: () => Promise<DesktopResult | null>;
  readonly driveSignOut: () => Promise<DesktopResult | null>;
  readonly driveList: (folderId: string) => Promise<DesktopResult | null>;
  readonly driveDownload: (fileId: string) => Promise<DesktopResult | null>;
  readonly driveUpload: (request: unknown) => Promise<DesktopResult | null>;
}

export type DesktopMember = keyof DesktopPort;

export const DESKTOP_PORT_MEMBERS = [
  "isDesktop", "platform", "appVersion", "tabId", "windowId", "launchIntent", "connection",
  "hadPriorSession", "firstTabOfLaunch", "hasDraftToRestore",
  "openFileDialog", "saveFileDialog", "readFile", "writeFile", "statFile", "routeOpen",
  "listRecents", "removeRecent", "clearRecents",
  "onOpenServerDoc", "onRestoreNotice", "onReassignDocId", "onOpenFile", "onMenuCommand", "setDocumentState",
  "writeDraft", "discardDraft", "takeDraft", "draftRestoreDone", "onDraftFlush",
  "historyPut", "historyList", "historyGet", "historyCopy", "historyTouch", "historyListDocs",
  "blobPut", "blobGet", "blobMissing",
  "getSessionInfo", "openExternal", "setTheme",
  "grantVideoFile", "openVideoFile", "videoThumbnail",
  "getUpdateStatus", "checkForUpdate", "downloadUpdate", "installUpdate", "onUpdateStatus",
  "openPrompterInBrowser", "openPrompterInChromium",
  "voiceStatus", "voiceStart", "voiceStop", "onVoiceEvent",
  "driveStatus", "driveSignIn", "driveSignOut", "driveList", "driveDownload", "driveUpload"
] as const satisfies readonly DesktopMember[];

export const UNUSED_DESKTOP_MEMBERS = [
  "__testRequestClose", "__testRequestQuit", "__testRequestCloseTab", "__testShell",
  "__testDupLoser", "__testDraftStatus", "__testCrashRenderer"
] as const;

let attached: DesktopPort | null = null;
let current: DesktopPort | null = null;

function use(port: DesktopPort | null | undefined): void {
  current = port || null;
  setRunningOnDesktop(current !== null);
}

export function attachDesktop(bridge: DesktopPort | null | undefined): void {
  attached = bridge || null;
  use(attached);
}

export function desktopPort(): DesktopPort | null {
  return current;
}

export function canOpenPrompterInBrowser(): boolean {
  return current !== null && typeof current.openPrompterInBrowser === "function";
}

export function canOpenPrompterInChromium(): boolean {
  return current !== null && typeof current.openPrompterInChromium === "function";
}

export function useDesktopForTest(fake: Partial<DesktopPort> | null | undefined): void {
  use(fake as DesktopPort | null | undefined);
}

export function restoreDesktop(): void {
  use(attached);
}

export type DriveAnswer = DesktopResult & { readonly ok: boolean };

async function driveCall(run: (port: DesktopPort) => Promise<DesktopResult | null>): Promise<DriveAnswer> {
  try {
    const res = await run(current as DesktopPort);
    return (res || { ok: false, code: "FAILED" }) as DriveAnswer;
  } catch {
    return { ok: false, code: "FAILED" };
  }
}

export const desktopDrive = Object.freeze({
  status: (): Promise<DriveAnswer> => driveCall((p) => p.driveStatus()),
  signIn: (): Promise<DriveAnswer> => driveCall((p) => p.driveSignIn()),
  signOut: (): Promise<DriveAnswer> => driveCall((p) => p.driveSignOut()),
  list: (folderId: string): Promise<DriveAnswer> => driveCall((p) => p.driveList(folderId)),
  download: (fileId: string): Promise<DriveAnswer> => driveCall((p) => p.driveDownload(fileId)),
  upload: (request: unknown): Promise<DriveAnswer> => driveCall((p) => p.driveUpload(request))
});
