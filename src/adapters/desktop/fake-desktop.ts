import type { HistoryOwner } from "../../application/recovery/history-ports.ts";
import type { SharedHistorySnapshotReader } from "../../../shared/history-store.ts";
import type { DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";
import type { DraftPayload } from "../../application/recovery/draft-origin.ts";
import type { DesktopFileEntry, DesktopPort, DesktopTakenDraft, DesktopTestPort } from "./desktop-port.ts";

type FlushHandler = Parameters<DesktopPort["onDraftFlush"]>[0];

type FakeExtras = Pick<DesktopPort, "listRecents"> & {
  _cancelNextSave?: boolean;
  _routeMissing?: boolean;
  _lastRoute?: unknown;
  _routeAnswer?: NonNullable<Awaited<ReturnType<DesktopPort["routeOpen"]>>>;
  _externalOpens?: unknown[];
  _videoGrants?: Record<string, unknown>;
  _videoOpens?: unknown[];
  _videoPaths?: Record<string, string>;
  _videoPathOpens?: string[];
  _videoPathAnswer?: Awaited<ReturnType<DesktopPort["openVideoPath"]>>;
  _bundleCalls?: { token: string; job: string }[];
  _bundleAnswer?: Awaited<ReturnType<DesktopPort["bundleVideoFile"]>>;  _bundleCarry?: Parameters<DesktopPort["onBundleCarry"]>[0];
  _bundleCancels?: string[];
  _moveCalls?: { token: string; job: string }[];
  _moveAnswer?: Awaited<ReturnType<DesktopPort["moveVideoFile"]>>;
  _bundledOpens?: string[];
  _printed?: string[];
  _printAnswer?: Awaited<ReturnType<DesktopPort["printToPdf"]>>;
  _thumbCalls?: [string, string][];
  _thumbAnswer?: Awaited<ReturnType<DesktopPort["videoThumbnail"]>>;
  _prompterCalls?: number;
  _chromiumCalls?: number;
  _lastDocState?: unknown;
  _prompterDocState?: unknown;
  _chromiumDocState?: unknown;
  _prompterAnswer?: NonNullable<Awaited<ReturnType<DesktopPort["openPrompterInBrowser"]>>>;
  _chromiumAnswer?: NonNullable<Awaited<ReturnType<DesktopPort["openPrompterInChromium"]>>>;
};

type MutablePort<K extends keyof DesktopPort> = { -readonly [P in K]?: DesktopPort[P] };
type FakeBlobBackend = Pick<DesktopPort, "platform" | "appVersion" | "tabId" | "windowId"> & MutablePort<"blobPut" | "blobGet" | "blobMissing"> & {
  _blobs?: Record<string, { bytes: Uint8Array; mime: string }>;
  _blobCalls?: Record<string, unknown>[];
  _blobFailNext?: { code: string } | null;
};
type FakeVoiceBackend = Pick<DesktopPort, "platform" | "appVersion" | "tabId" | "windowId"> & Pick<DesktopTestPort, "voiceStart" | "voiceStop" | "voiceMicrophones"> & {
  voiceStatus?: DesktopTestPort["voiceStatus"];
  onVoiceEvent?: DesktopPort["onVoiceEvent"];
  _voiceCalls?: { status: number; start: number; stop: number; microphones: number };
  _voiceStartArgs?: unknown[][];
  _voiceMicrophones?: { id: string; name: string }[];
  _voiceMicrophonesAnswer?: Awaited<ReturnType<DesktopPort["voiceMicrophones"]>>;
  _voiceAvailable?: boolean;
  _voiceSession?: number;
  _voiceRunning?: boolean;
  _voiceStartAnswer?: Awaited<ReturnType<DesktopPort["voiceStart"]>>;
  _voiceEmit?: (event: Omit<Parameters<Parameters<DesktopPort["onVoiceEvent"]>[0]>[0], "session">) => void;
};

type FakeSanitizedMeta = ReturnType<typeof sanitizeHistoryMeta>;
type FakeMalformedCoreReplies = {
  getSessionInfo: () => Promise<Omit<DesktopIpcResult<"splitpage:get-session-info">, "testDialogsSeen">>;
  openPrompterInBrowser: () => Promise<DesktopIpcResult<"splitpage:prompter-open-in-browser"> | Omit<Extract<DesktopIpcResult<"splitpage:prompter-open-in-browser">, { ok: true }>, "voice">>;
};
type FakeMalformedHistoryReplies = {
  historyList?: (docId: string | null) => Promise<Omit<DesktopIpcResult<"splitpage:history-list">, "entries" | "older"> & { entries: FakeSanitizedMeta[]; older: FakeSanitizedMeta[] }>;
  historyGet?: (...args: Parameters<DesktopPort["historyGet"]>) => Promise<(Omit<NonNullable<DesktopIpcResult<"splitpage:history-get">>, "meta"> & { meta: FakeSanitizedMeta }) | null>;
};
type FakeHistoryStoreBoundary = ReturnType<typeof createHistoryStore<ReturnType<typeof createMemoryHistoryTestBackend>>>;
type FakeHistoryBackend = Pick<DesktopPort, "platform" | "appVersion" | "tabId" | "windowId"> & Pick<DesktopTestPort, "historyPut" | "historyCopy" | "historyTouch" | "historyListDocs"> & FakeMalformedHistoryReplies & {
  _historyDump?: () => Record<string, unknown[]>;
  _historyStore?: FakeHistoryStoreBoundary;
  _historyBackend?: ReturnType<typeof createMemoryHistoryTestBackend>;
};

type FakeQueryFields = { [K in keyof Parameters<HistoryOwner["getHistorySnapshot"]>[0] | keyof NonNullable<Parameters<DesktopPort["historyPut"]>[3]>]?: unknown };

type FakeDraft = { [K in keyof Pick<DraftPayload, "seq" | "editSeq" | "originKind" | "baseJson" | "stateJson">]?: unknown };

type FakeOptions = { history?: boolean; blobs?: boolean; voice?: boolean; blobHash?: (bytes: Uint8Array) => string };
type FakeFile = { -readonly [K in keyof Required<Pick<DesktopFileEntry, "name" | "bytes" | "lastModified">>]: Required<Pick<DesktopFileEntry, "name" | "bytes" | "lastModified">>[K] } & { onDisk: boolean };
type FakeRecent = { fileId: string; name: string; title: string; at: number };

import { createMemoryHistoryTestBackend } from "../storage/history-backend-testing.ts";
import { HISTORY_OLDER_KEY, HISTORY_SNAP_ID_RE, historyUtf8Length, sanitizeHistoryMeta } from "../../../shared/history-policy.ts";
import { normalizeDocId } from "../../../shared/doc-id-policy.ts";
import { hashText as historyHashText } from "../storage/03c-history-idb.ts";
import { createHistoryStore } from "../../../shared/history-store.ts";
import { strBytes } from "../formats/bytes.ts";

export function makeFakeDesktopBackend(opts?: FakeOptions) {
  const files: Record<string, FakeFile> = {};
  let recents: FakeRecent[] = [];
  let nextId = 1;
  let openHandler: Parameters<DesktopPort["onOpenFile"]>[0] | null = null;
  let menuHandler: Parameters<DesktopPort["onMenuCommand"]>[0] | null = null;
  let restoreNoticeHandler: Parameters<DesktopPort["onRestoreNotice"]>[0] | null = null;
  let reassignDocIdHandler: Parameters<DesktopPort["onReassignDocId"]>[0] | null = null;
  function newId() { return "fake" + (nextId++); }

  const draftStore: { floor: number; current: { header: unknown; stateJson: string } | null; previous: { header: unknown; stateJson: string } | null; base: unknown; writes: number; failures: number } = { floor: -Infinity, current: null, previous: null, base: null, writes: 0, failures: 0 };
  const draftLog: Record<string, unknown>[] = [];
  let draftTaken: DesktopTakenDraft | null = null;
  let flushHandler: FlushHandler | null = null;
  let draftFailNext: { code: string; count: number } | null = null;
  function draftFail(code: string): ReturnType<DesktopPort["writeDraft"]> {
    if (code !== "HELD" && code !== "NEED_BASE" && code !== "STALE_SEQ" && code !== "DISCARDED") draftStore.failures++;
    draftStore.base = null;
    return Promise.resolve({ ok: false, code: code });
  }

  const backend = {
    isDesktop: true,
    platform: "test",
    appVersion: "0.0.0-test",

    tabId: "f".repeat(32),
    windowId: "w".repeat(32),
    launchIntent: { type: "blank" },
    hadPriorSession: false,
    firstTabOfLaunch: true,
    hasDraftToRestore: false,

    openFileDialog: function () { return Promise.resolve(null); },
    saveFileDialog: function (opts?: Partial<Parameters<DesktopPort["saveFileDialog"]>[0]> | null) {
      if (this._cancelNextSave) { this._cancelNextSave = false; return Promise.resolve(null); }
      const id = newId();
      files[id] = { name: (opts && opts.suggestedName) || "untitled", bytes: new Uint8Array(0), lastModified: Date.now() + nextId, onDisk: false };
      return Promise.resolve({ id: id, name: (files[id] as FakeFile).name });
    },
    readFile: function (id: string) {
      const f = files[id];
      if (!f) return Promise.reject(new Error("ENOENT: unknown file id"));
      if (!f.onDisk) return Promise.reject(new Error("ENOENT: no such file or directory"));
      return Promise.resolve({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
    },
    writeFile: function (id: string, data: unknown) {
      const f = files[id];
      if (!f) return Promise.reject(new Error("ENOENT: unknown file id"));
      const bytes = typeof data === "string" ? strBytes(data)
        : data instanceof Uint8Array ? data
        : data instanceof ArrayBuffer ? new Uint8Array(data)
        : null;
      if (!bytes) return Promise.reject(new Error("writeFile: unsupported data type"));
      f.bytes = bytes;
      f.onDisk = true;
      f.lastModified = Date.now() + (nextId++);
      return Promise.resolve({ lastModified: f.lastModified, size: bytes.length });
    },
    statFile: function (id: string) {
      const f = files[id];
      if (!f) return Promise.reject(new Error("ENOENT: unknown file id"));
      return Promise.resolve(f.onDisk ? { lastModified: f.lastModified, size: f.bytes.length } : null);
    },
    routeOpen: function (p: Partial<Parameters<DesktopPort["routeOpen"]>[0]> | null) {
      if (!p || p.kind !== "file") return Promise.reject(new Error("route-open: unknown kind"));
      const held = files[p.fileId as string];
      if (!held) return Promise.reject(new Error("ENOENT: unknown file id"));
      if (this._routeMissing || !held.onDisk) return Promise.reject(new Error("ENOENT: file is not readable"));
      this._lastRoute = p ? JSON.parse(JSON.stringify(p)) : null;
      return Promise.resolve(this._routeAnswer || { where: "this-tab" });
    },

    listRecents: function () { return Promise.resolve(recents.map(function (r) { return { fileId: r.fileId, name: r.name, title: r.title, at: r.at }; })); },
    removeRecent: function (fileId: string) {
      recents = recents.filter(function (r) { return r.fileId !== fileId; });
      return this.listRecents();
    },
    clearRecents: function () { recents = []; return this.listRecents(); },
    _addRecent: function (fileId: string, name: string, title?: string, at?: number) {
      recents = recents.filter(function (r) { return r.fileId !== fileId; });
      recents.unshift({ fileId: fileId, name: name, title: title || "", at: at || Date.now() });
      return fileId;
    },
    onOpenFile: function (cb: Parameters<DesktopPort["onOpenFile"]>[0]) { openHandler = cb; },
    onRestoreNotice: function (cb: Parameters<DesktopPort["onRestoreNotice"]>[0]) { restoreNoticeHandler = cb; },
    onReassignDocId: function (cb: Parameters<DesktopPort["onReassignDocId"]>[0]) { reassignDocIdHandler = cb; },
    onMenuCommand: function (cb: Parameters<DesktopPort["onMenuCommand"]>[0]) { menuHandler = cb; },
    setDocumentState: function (s: Parameters<DesktopPort["setDocumentState"]>[0]) { this._lastDocState = s; },
    getSessionInfo: function () {
      return Promise.resolve({ library: false, hosting: false, port: null, lanUrls: [], pin: "" });
    },
    openExternal: function (url: unknown) { (this._externalOpens = this._externalOpens || []).push(url); },
    grantVideoFile: function (file: unknown) {
      this._videoGrants = this._videoGrants || {};
      const token = "t" + Object.keys(this._videoGrants).length;
      this._videoGrants[token] = file && (file as Partial<Record<keyof Pick<DesktopFileEntry, "name">, unknown>>).name;
      return Promise.resolve(token);
    },
    openVideoFile: function (token: string) {
      const name = this._videoGrants && this._videoGrants[token];
      if (!name) return Promise.resolve({ ok: false, code: "UNKNOWN" });
      (this._videoOpens = this._videoOpens || []).push(name);
      return Promise.resolve({ ok: true });
    },
    videoFilePath: function (file: unknown) {
      const name = file && (file as Partial<Record<keyof Pick<DesktopFileEntry, "name">, unknown>>).name;
      const found = this._videoPaths && typeof name === "string" ? this._videoPaths[name] : undefined;
      return typeof found === "string" ? found : null;
    },
    openVideoPath: function (storedPath: string) {
      (this._videoPathOpens = this._videoPathOpens || []).push(storedPath);
      return Promise.resolve(this._videoPathAnswer || { ok: true });
    },
    bundleVideoFile: function (token: string, job: string, onProgress?: Parameters<DesktopPort["bundleVideoFile"]>[2]) {
      (this._bundleCalls = this._bundleCalls || []).push({ token, job });
      const name = this._videoGrants && this._videoGrants[token];
      if (typeof name !== "string") return Promise.resolve({ ok: false, code: "UNKNOWN" });
      if (onProgress) onProgress({ done: 1, total: 1 });
      return Promise.resolve(this._bundleAnswer || { ok: true, name: name });
    },
    moveVideoFile: function (token: string, job: string, onProgress?: Parameters<DesktopPort["moveVideoFile"]>[2]) {
      (this._moveCalls = this._moveCalls || []).push({ token, job });
      const name = this._videoGrants && this._videoGrants[token];
      if (typeof name !== "string") return Promise.resolve({ ok: false, code: "UNKNOWN" });
      if (onProgress) onProgress({ done: 1, total: 1 });
      return Promise.resolve(this._moveAnswer || { ok: true, name: name, outcome: "moved" as const });
    },
    planCreateBundle: function () { return Promise.resolve({ ok: true as const, plan: { files: [], bundled: [], missing: 0 } }); },
    bundlePath: function () { return Promise.resolve({ ok: false as const, code: "UNAVAILABLE" }); },
    onBundleCarry: function (cb: Parameters<DesktopPort["onBundleCarry"]>[0]) { this._bundleCarry = cb; },
    cancelBundle: function (job: string) { (this._bundleCancels = this._bundleCancels || []).push(job); },
    openBundledFile: function (name: string) {
      (this._bundledOpens = this._bundledOpens || []).push(name);
      return Promise.resolve({ ok: true });
    },
    printToPdf: function (html: string) {
      (this._printed = this._printed || []).push(html);
      return Promise.resolve(this._printAnswer || strBytes("%PDF-1.7\n%fake desktop print\n"));
    },
    videoThumbnail: function (host: string, ref: string) {
      (this._thumbCalls = this._thumbCalls || []).push([host, ref]);
      return Promise.resolve(this._thumbAnswer || { ok: false, code: "UNAVAILABLE" });
    },
    openPrompterInBrowser: function () {
      this._prompterCalls = (this._prompterCalls || 0) + 1;
      this._prompterDocState = this._lastDocState || null;
      return Promise.resolve(this._prompterAnswer || { ok: true, kind: "file" });
    },
    openPrompterInChromium: function () {
      this._chromiumCalls = (this._chromiumCalls || 0) + 1;
      this._chromiumDocState = this._lastDocState || null;
      return Promise.resolve(this._chromiumAnswer || { ok: true, kind: "file", voice: "browser", browser: "Microsoft Edge" });
    },

    writeDraft: function (payload: unknown) {
      draftLog.push({ op: "write", seq: payload && (payload as FakeDraft).seq, editSeq: payload && (payload as FakeDraft).editSeq,
                      originKind: payload && (payload as FakeDraft).originKind, hasBase: !!(payload && (payload as FakeDraft).baseJson) });
      if (draftFailNext && draftFailNext.count > 0) {
        draftFailNext.count--;
        return draftFail(draftFailNext.code);
      }
      if (!payload || typeof (payload as FakeDraft).stateJson !== "string" || typeof (payload as FakeDraft).seq !== "number") return draftFail("BAD_PAYLOAD");
      if (!(((payload as FakeDraft).seq as number) > draftStore.floor)) return draftFail("STALE_SEQ");
      if ((payload as FakeDraft).baseJson == null && draftStore.base == null) return draftFail("NEED_BASE");
      if ((payload as FakeDraft).baseJson != null) draftStore.base = (payload as FakeDraft).baseJson;
      draftStore.previous = draftStore.current;
      draftStore.current = { header: payload, stateJson: (payload as FakeDraft).stateJson as string };
      draftStore.floor = (payload as FakeDraft).seq as number;
      draftStore.writes++;
      return Promise.resolve({ ok: true, seq: (payload as FakeDraft).seq as number, bytes: ((payload as FakeDraft).stateJson as string).length });
    },
    discardDraft: function (seq: number | undefined) {
      draftLog.push({ op: "discard", seq: seq });
      if (typeof seq === "number") {
        if (seq < draftStore.floor) return Promise.resolve({ ok: false, code: "STALE_SEQ" });
        draftStore.floor = seq;
      }
      draftStore.current = null;
      draftStore.previous = null;
      draftStore.base = null;
      return Promise.resolve({ ok: true });
    },
    takeDraft: function () {
      draftLog.push({ op: "take" });
      return Promise.resolve(draftTaken);
    },
    draftRestoreDone: function (outcome: unknown) { draftLog.push({ op: "restore-done", outcome: outcome }); },
    onDraftFlush: function (cb: Parameters<DesktopPort["onDraftFlush"]>[0]) { flushHandler = cb; },

    _drafts: draftStore,
    _draftLog: draftLog,
    _setDraft: function (taken: DesktopTakenDraft | null) { draftTaken = taken; },
    _failNextDraftWrites: function (code: string | null, count: number | null | undefined) {
      draftFailNext = code ? { code: code, count: count == null ? 1 : count } : null;
    },
    _fireDraftFlush: function () { return flushHandler ? (flushHandler as () => ReturnType<FlushHandler>)() : null; },
    _addFile: function (name: string, text: string) {
      const id = newId();
      files[id] = { name: name, bytes: strBytes(text), lastModified: Date.now() + nextId, onDisk: true };
      return id;
    },
    _text: function (id: string) { return new TextDecoder().decode((files[id] as FakeFile).bytes); },
    _touch: function (id: string) { if (files[id]) files[id].lastModified = Date.now() + (nextId++); },
    _setBytesKeepMtime: function (id: string, text: string) { if (files[id]) files[id].bytes = strBytes(text); },
    _fireOpenFile: function (id: string) {
      const f = files[id];
      if (openHandler && f) openHandler({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
    },
    _fireMenuCommand: function (cmd: string) { if (menuHandler) menuHandler(cmd); },
    _fireRestoreNotice: function (notice: Parameters<Parameters<DesktopPort["onRestoreNotice"]>[0]>[0]) { if (restoreNoticeHandler) restoreNoticeHandler(notice); },
    _fireReassignDocId: function (msg: Parameters<Parameters<DesktopPort["onReassignDocId"]>[0]>[0]) { if (reassignDocIdHandler) reassignDocIdHandler(msg); }
  } satisfies Partial<Omit<DesktopPort, keyof FakeMalformedCoreReplies>> & FakeMalformedCoreReplies & Record<string, unknown> & ThisType<FakeExtras>;
  if (opts && opts.history) addFakeDesktopHistory(backend);
  if (opts && opts.blobs) addFakeDesktopBlobs(backend, opts);
  if (opts && opts.voice) addFakeDesktopVoice(backend);
  return backend;
}

function addFakeDesktopVoice(backend: FakeVoiceBackend) {
  let handler: Parameters<NonNullable<FakeVoiceBackend["onVoiceEvent"]>>[0] | null = null;
  backend._voiceCalls = { status: 0, start: 0, stop: 0, microphones: 0 };
  backend._voiceStartArgs = [];
  backend._voiceMicrophones = [];
  backend._voiceAvailable = true;
  backend._voiceSession = 0;
  backend._voiceRunning = false;
  backend.voiceStatus = function () {
    (backend._voiceCalls as NonNullable<FakeVoiceBackend["_voiceCalls"]>).status++;
    return Promise.resolve({ available: backend._voiceAvailable as boolean });
  };
  backend.voiceMicrophones = function () {
    (backend._voiceCalls as NonNullable<FakeVoiceBackend["_voiceCalls"]>).microphones++;
    if (backend._voiceMicrophonesAnswer) return Promise.resolve(backend._voiceMicrophonesAnswer);
    return Promise.resolve({ ok: true, microphones: (backend._voiceMicrophones as { id: string; name: string }[]).slice() });
  };
  backend.voiceStart = function (...args: unknown[]) {
    (backend._voiceStartArgs as unknown[][]).push(args);
    (backend._voiceCalls as NonNullable<FakeVoiceBackend["_voiceCalls"]>).start++;
    if (backend._voiceStartAnswer) return Promise.resolve(backend._voiceStartAnswer);
    (backend._voiceSession as number)++;
    backend._voiceRunning = true;
    return Promise.resolve({ ok: true, session: backend._voiceSession as number });
  };
  backend.voiceStop = function (session?: number) {
    (backend._voiceCalls as NonNullable<FakeVoiceBackend["_voiceCalls"]>).stop++;
    if (session === undefined || session === backend._voiceSession) backend._voiceRunning = false;
    return Promise.resolve({ ok: true });
  };
  backend.onVoiceEvent = function (cb: Parameters<NonNullable<FakeVoiceBackend["onVoiceEvent"]>>[0]) { handler = cb; };
  backend._voiceEmit = function (event: Omit<Parameters<Parameters<DesktopPort["onVoiceEvent"]>[0]>[0], "session">) {
    const e = Object.assign({ session: backend._voiceSession as number }, event);
    if (handler) handler(e);
  };
}

function addFakeDesktopBlobs(backend: FakeBlobBackend, opts: FakeOptions) {
  const SHA_RE = /^[0-9a-f]{64}$/;
  const MAX = 16 * 1024 * 1024;
  const hash = typeof opts.blobHash === "function" ? opts.blobHash : null;
  const store: Record<string, { bytes: Uint8Array; mime: string }> = {};
  const calls: Record<string, unknown>[] = [];
  function sniff(u: Uint8Array) {
    if (u.length >= 8 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return "image/png";
    if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
    if (u.length >= 6 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38) return "image/gif";
    if (u.length >= 12 && u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 &&
        u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return "image/webp";
    return null;
  }
  function badSha() { return Promise.reject(new Error("splitpage:blob: argument 1 is not sha256")); }
  backend.blobPut = function (sha: string, bytes: unknown) {
    calls.push({ op: "put", sha: sha });
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return badSha();
    if (typeof bytes === "string") return Promise.resolve({ ok: false, code: "BAD_BYTES" });
    const u = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
    if (!u) return Promise.reject(new Error("splitpage:blob-put: argument 2 is not bytes"));
    if (!u.length) return Promise.resolve({ ok: false, code: "EMPTY" });
    if (u.length > MAX) return Promise.resolve({ ok: false, code: "TOO_LARGE" });
    const mime = sniff(u);
    if (!mime) return Promise.resolve({ ok: false, code: "NOT_AN_IMAGE" });
    if (backend._blobFailNext) { const f = backend._blobFailNext; backend._blobFailNext = null; return Promise.resolve({ ok: false, code: f.code }); }
    if (hash && hash(u) !== sha) return Promise.resolve({ ok: false, code: "HASH_MISMATCH" });
    if (store[sha]) return Promise.resolve({ ok: true, stored: false });
    store[sha] = { bytes: new Uint8Array(u), mime: mime };
    return Promise.resolve({ ok: true, stored: true });
  };
  backend.blobGet = function (sha: string) {
    calls.push({ op: "get", sha: sha });
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return badSha();
    const e = store[sha];
    return Promise.resolve(e ? { bytes: new Uint8Array(e.bytes), mime: e.mime } : null);
  };
  backend.blobMissing = function (shas: readonly string[]) {
    calls.push({ op: "missing", count: Array.isArray(shas) ? shas.length : -1 });
    if (!Array.isArray(shas)) return Promise.reject(new Error("splitpage:blob-missing: argument 1 is not array"));
    if (shas.length > 2000) return Promise.reject(new Error("blob-missing: at most 2000 shas per call"));
    if (!shas.every(function (x) { return typeof x === "string" && SHA_RE.test(x); })) {
      return Promise.reject(new Error("blob-missing: every entry must be a sha256"));
    }
    const seen: Record<string, boolean> = {};
    return Promise.resolve(shas.filter(function (x) {
      if (seen[x] || store[x]) return false;
      seen[x] = true;
      return true;
    }));
  };
  backend._blobs = store;
  backend._blobCalls = calls;
  backend._blobFailNext = null;
}

function addFakeDesktopHistory(backend: FakeHistoryBackend) {
  const mem = createMemoryHistoryTestBackend({ name: "desktop-fake", persistent: true });
  let held: unknown[] = [];
  const store: FakeHistoryStoreBoundary = createHistoryStore({
    backend: mem,
    now: Date.now,
    hashText: historyHashText,
    holds: function () { return held; }
  });

  function bucketOf(query: unknown) {
    if (query && (query as FakeQueryFields).older === true) return HISTORY_OLDER_KEY;
    return normalizeDocId(query && (query as FakeQueryFields).docId) || null;
  }
  function invalid(what: string) { return Promise.reject(new Error("history: " + what)); }

  backend.historyPut = function (docId: string | null, meta: unknown, stateJson: string, opts?: Parameters<DesktopPort["historyPut"]>[3]) {
    const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
    const older = o.older === true;
    const id = older ? (docId === null ? HISTORY_OLDER_KEY : null) : normalizeDocId(docId);
    const m = sanitizeHistoryMeta(meta);
    if (!id || !m || typeof stateJson !== "string") return invalid("invalid put");
    if (Array.isArray(o.protect)) held = (o.protect as unknown[]).slice();
    return (older ? store.put(null, m, stateJson, { older: true }) : store.put(id, m, stateJson)).then(function (r) {
      if (!r.stored) return { ok: false, code: r.code };
      return { ok: true, sizeBytes: historyUtf8Length(stateJson), duplicate: !!r.duplicate, evicted: r.evicted || 0, overCap: !!r.overCap };
    });
  };

  backend.historyList = function (docId: string | null) {
    const id = docId == null ? null : normalizeDocId(docId);
    if (docId != null && !id) return invalid("invalid document id");
    return store.list(id).then(function (r) {
      return store.usage().then(null, function () { return null; }).then(function (usage) {
        return { ...r, entries: r.entries.map(sanitizeHistoryMeta), older: r.older.map(sanitizeHistoryMeta), usage: usage };
      });
    });
  };

  backend.historyGet = function (query: unknown, snapshotId: string) {
    const bucket = bucketOf(query);
    if (!bucket) return invalid("invalid document id");
    if (typeof snapshotId !== "string" || !HISTORY_SNAP_ID_RE.test(snapshotId)) return invalid("invalid snapshot id");
    if (query && Array.isArray((query as FakeQueryFields).protect)) held = ((query as FakeQueryFields).protect as unknown[]).slice();
    return store.get(bucket, snapshotId).then(function (hit) {
      return hit ? { meta: sanitizeHistoryMeta(hit.meta), stateJson: hit.stateJson } : null;
    });
  };

  backend.historyCopy = function (fromDocId: string, toDocId: string) {
    const from = normalizeDocId(fromDocId), to = normalizeDocId(toDocId);
    if (!from || !to) return invalid("invalid document id");
    return store.copy(from, to);
  };

  backend.historyTouch = function (docId: string, title: string) {
    const id = normalizeDocId(docId);
    if (!id) return invalid("invalid document id");
    return store.touch(id, title);
  };

  backend.historyListDocs = function () { return store.listDocs(); };

  backend._historyDump = function () {
    const raw = mem.inspect(), out: Record<string, unknown[]> = {};
    Object.keys(raw.index).forEach(function (bucket) {
      out[bucket] = ((raw.index[bucket] as NonNullable<typeof raw.index[string]>).snapshots || []).map(function (s) {
        return { meta: sanitizeHistoryMeta(s), stateJson: raw.bodies[(s as SharedHistorySnapshotReader).sha as string] };
      });
    });
    return out;
  };
  backend._historyStore = store;
  backend._historyBackend = mem;
}
