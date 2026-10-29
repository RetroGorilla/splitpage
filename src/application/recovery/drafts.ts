import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { refsIn } from "../../../shared/blob-policy.js";
import { NO_DESTINATION } from "../transitions/ports.ts";
import { SCHEMA_VERSION } from "../../core/document/fields.ts";
import { createCaptureSchedule } from "./capture-schedule.ts";
import { cloneState } from "../../core/document/clone.ts";
import type { DocumentView } from "../session/document-session.ts";
import type { OperationContext } from "../session/operation.ts";
import type { Notice, NoticeKind } from "../effects/ports.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { CaptureSchedule, CaptureTiming } from "./capture-schedule.ts";
import type { DraftCapture } from "./draft-writer.ts";
import type { DraftMeta, StoredDraft } from "./ports.ts";
import type { StashedWork } from "./conflict-stash.ts";
import type { DraftFile, DraftFlush, DraftOpening, DraftParsedFile, DraftsMount, DraftsPorts } from "./drafts-ports.ts";

interface DraftServer {
  readonly base: string;
  readonly docId: string;
  readonly rev: number;
  readonly copy?: boolean;
}

interface DraftOrigin {
  kind: "untitled" | "server" | "file" | "import";
  fileId: unknown;
  fileKind: unknown;
  importName: unknown;
  baseLastModified: unknown;
  baseSize: number | null;
  server: DraftServer | null;
}

interface DraftPayload {
  seq: number;
  editSeq: number;
  title: string;
  docId: string | null;
  docIdWrittenOut: boolean;
  schema: unknown;
  originKind: DraftOrigin["kind"];
  fileId: unknown;
  fileKind: unknown;
  importName: unknown;
  baseLastModified: unknown;
  baseSize: number | null;
  server: DraftServer | null;
  stateJson: string;
  baseJson: string | null;
}

interface BrowserCapture {
  readonly base: string;
  readonly draft: DraftCapture;
}

interface BrowserCopy {
  readonly key: string | undefined;
  readonly docId: string;
  readonly server: DraftServer;
}

interface TakenOrigin {
  readonly kind?: string | undefined;
  readonly fileName?: string | undefined;
  readonly importName?: string | undefined;
  readonly server?: DraftServer | undefined;
}

interface TakenHeader {
  readonly origin?: TakenOrigin | undefined;
  readonly writtenAt?: number | undefined;
  readonly title?: string | undefined;
  readonly docIdWrittenOut?: boolean | undefined;
}

interface TakenDraft {
  readonly header?: TakenHeader | undefined;
  readonly stateJson?: unknown;
  readonly baseJson?: unknown;
  readonly ageMs?: number | null | undefined;
  readonly previousSession?: string | undefined;
  readonly browserKey?: string | undefined;
  readonly unsupported?: boolean | undefined;
  readonly corrupt?: boolean | undefined;
  readonly file?: unknown;
  readonly fileProblem?: string | undefined;
}

interface HeaderedDraft extends TakenDraft {
  readonly header: TakenHeader;
}

interface DraftToast {
  readonly dismiss?: (() => void) | undefined;
  readonly parentNode?: { readonly removeChild: (child: DraftToast) => unknown } | null | undefined;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface DraftTiming extends Mutable<CaptureTiming> {
  largeBytes: number;
  slowStringifyMs: number;
}

let ports: DraftsPorts | null = null;

function live(): DraftsPorts {
  if (!ports) throw new TypeError("Drafts are not started");
  return ports;
}

function runningOnDesktop(): boolean { return live().running(); }
function currentDocument(): DocumentView | null { return live().document.current(); }
function mergeBase(): unknown { return live().session.mergeBase(); }
function noteAbsorbedDirty(reason: string): void { live().session.noteAbsorbedDirty(reason); }
function currentHome(): ReturnType<DraftsPorts["place"]["home"]> { return live().place.home(); }
function fileHome(): ReturnType<DraftsPorts["place"]["fileHome"]> { return live().place.fileHome(); }
function importHome(): ReturnType<DraftsPorts["place"]["importHome"]> { return live().place.importHome(); }
function documentLocation(): { readonly writtenOut: () => boolean; readonly markWrittenOut: (on: boolean) => void } { return { writtenOut: live().place.writtenOut, markWrittenOut: live().markWrittenOut }; }
function migrateRows(raw: unknown): ValidatedDocument { return live().entry.migrate(raw); }
function persist(refs: readonly string[]): Promise<string[]> { return live().pictures.persist(refs); }
function inlineStateJson(json: string, failed: readonly string[]): string { return live().pictures.inline(json, failed); }
function copyDocHistorySafe(fromId: string, toId: string): void { live().identity.copyHistory(fromId, toId); }
function syncDocIdentity(): void { live().identity.sync(); }
function resetProductionPanelState(): void { live().resetProductionPanel(); }
function showToast(message: string, kind?: NoticeKind, sticky?: boolean): Notice { return live().notices.show(message, kind, sticky); }
function browserDraftKey(base: string, docId: string): string { return live().browserDraft.key(base, docId); }
function draftBaseOf(serverUrl: unknown): string { return live().browserDraft.base(serverUrl); }
function browserWriterIsLive(writerId: string): Promise<boolean> { return live().lock.isLive(writerId); }
function holdWriterLock(): void { live().lock.hold(); }
function releaseBrowserWriterLock(): void { live().lock.release(); }
function applyStashedWork(disk: ValidatedDocument, work: StashedWork | null, options?: Readonly<Record<string, unknown>> | null): ReturnType<DraftsPorts["recovery"]["applyStashedWork"]> { return live().recovery.applyStashedWork(disk, work, options); }
function browserDrafts(): ReturnType<DraftsPorts["recovery"]["browserDrafts"]> { return live().recovery.browserDrafts(); }
function captureRestore(): OperationContext { return live().recovery.captureRestore(); }
function desktopDrafts(): ReturnType<DraftsPorts["recovery"]["desktopDrafts"]> { return live().recovery.desktopDrafts(); }
function draftResume(): ReturnType<DraftsPorts["recovery"]["draftResume"]> { return live().recovery.draftResume(); }
function recoveryStarted(): boolean { return live().recovery.started(); }
function stillRestoring(ctx: OperationContext): boolean { return live().recovery.stillRestoring(ctx); }
function useBrowserDraftFactory(factory: unknown): ReturnType<DraftsPorts["recovery"]["useBrowserDraftFactory"]> { return live().recovery.useBrowserDraftFactory(factory); }
function documentTransitions(): DraftsPorts["transitions"] { return live().transitions; }
function openDocument(opening: DraftOpening): Promise<unknown> { return live().documents.open(opening); }
function saveChanges(): number { return live().saves.editSeq(); }
function unsavedChanges(): boolean { return live().saves.unsaved(); }
function parseProjectFileState(file: unknown): Promise<DraftParsedFile | null> { return live().files.parse(file); }
function makeDesktopHandle(entry: unknown): ReturnType<DraftsPorts["files"]["handle"]> { return live().files.handle(entry); }
function notifyDesktopDocumentState(): void { live().documentState.notify(); }
function now(): number { return live().clock.now(); }
function setTimer(run: () => void, ms: number): unknown { return live().timers.set(run, ms); }
function clearTimer(handle: unknown): void { live().timers.clear(handle); }
function reportError(error: unknown): void { live().report(error); }

let draftOnDisk = false;

const draftTiming: DraftTiming = {
  idle: 1500,
  max: 5000,
  slow: 15000,
  largeBytes: 8388608,
  slowStringifyMs: 50,
  backoffMin: 5000,
  backoffMax: 60000
};

let draftSchedule: CaptureSchedule | null = null;

function schedule(): CaptureSchedule {
  if (!draftSchedule) {
    draftSchedule = createCaptureSchedule({
      timing: function () { return draftTiming; },
      timers: {
        set: function (run, ms) { return setTimer(run, ms); },
        clear: function (handle) { clearTimer(handle); }
      },
      capture: function () { captureAndSendDraft(); }
    });
  }
  return draftSchedule;
}

let draftSeq = 0;
let draftInFlight: Promise<DraftFlush | null | undefined> | null = null;
let draftStopped = false;
let draftPausedReason = "";
let draftPausedToast: DraftToast | null = null;
let draftSentEditSeq: number | null = null;
let draftSentBase: unknown = {};
let draftSentSignature = "";
const draftStats: { writes: number; failures: number; discards: number; obsolete: number; lastCode: string | null } =
  { writes: 0, failures: 0, discards: 0, obsolete: 0, lastCode: null };

let browserDraftsOff = false;
let browserCopyOf: BrowserCopy | null = null;

function browserDraftStore(): ReturnType<DraftsPorts["recovery"]["browserDrafts"]>["store"] {
  return browserDrafts().store;
}

function browserKeyOnDisk(): string | null {
  return recoveryStarted() ? browserDrafts().writer.tracked() : null;
}

function browserDraftTarget(): (DraftServer & { readonly copy: boolean }) | null {
  if (runningOnDesktop() || browserDraftsOff) return null;
  if (browserCopyOf && currentHome().kind === "none") {
    const doc = currentDocument();
    if (doc && doc.docId === browserCopyOf.docId) {
      return { base: browserCopyOf.server.base, docId: browserCopyOf.server.docId, rev: browserCopyOf.server.rev, copy: true };
    }
  }
  browserCopyOf = null;
  return null;
}

function browserDraftCapture(server: DraftServer | null): BrowserCapture | null {
  const base = server ? draftBaseOf(server.base) : "";
  if (!server || !base || !server.docId) return null;
  return { base: base, draft: browserDrafts().writer.capture(browserDraftKey(base, server.docId)) };
}

function browserWriteDraft(payload: DraftPayload, captured: BrowserCapture | null): Promise<DraftFlush> {
  const server = payload.server;
  if (!captured || !server) return Promise.resolve({ ok: false, code: "UNAVAILABLE" });
  return browserDrafts().writer.write(captured.draft, {
    base: captured.base,
    docId: String(server.docId),
    rev: server.rev || 0,
    title: payload.title,
    editSeq: payload.editSeq,
    schema: payload.schema,
    docIdWrittenOut: payload.docIdWrittenOut,
    stateJson: payload.stateJson,
    baseJson: server.copy ? null : payload.baseJson
  }, { keepBase: !!server.copy });
}

function browserDiscardDraft(): Promise<DraftFlush> {
  return browserDrafts().writer.discard().then(function () { return { ok: true }; });
}

function draftBackendWrite(payload: DraftPayload, captured: BrowserCapture | null): Promise<DraftFlush | null | undefined> {
  if (runningOnDesktop()) return desktopDrafts().write(payload);
  return browserWriteDraft(payload, captured);
}

function draftBackendCanDiscard(): boolean {
  if (runningOnDesktop()) return desktopDrafts().canDiscard();
  return !!browserKeyOnDisk();
}

function draftBackendDiscard(seq: number): Promise<DraftFlush | null | undefined> {
  if (runningOnDesktop()) return desktopDrafts().discard(seq);
  return browserDiscardDraft();
}

function draftWriterLive(): boolean {
  if (draftStopped) return false;
  if (runningOnDesktop()) return desktopDrafts().writable();
  return !browserDraftsOff && (!!browserKeyOnDisk() || !!browserDraftTarget());
}

function holdBrowserWriterLock(): void {
  if (runningOnDesktop()) return;
  holdWriterLock();
}

function noteDraftChange(): void {
  if (!draftWriterLive()) return;
  schedule().noteChange();
}

function fieldOf(value: unknown, name: string): unknown {
  const field: unknown = Reflect.get(Object(value), name);
  return field;
}

function draftOriginOf(): DraftOrigin {
  const origin: DraftOrigin = {
    kind: "untitled", fileId: null, fileKind: null, importName: null,
    baseLastModified: null, baseSize: null, server: null
  };
  if (!runningOnDesktop()) {
    const target = browserDraftTarget();
    if (target) {
      origin.kind = "server";
      origin.server = { base: target.base, docId: target.docId, rev: target.rev, copy: target.copy };
    }
    return origin;
  }
  const file = fileHome();
  const handle = file && file["handle"];
  const fileId = (handle && fieldOf(handle, "_desktopId")) || null;
  if (file && fileId) {
    origin.kind = "file";
    origin.fileId = fileId;
    origin.fileKind = file["format"];
    origin.baseLastModified = file["lastModified"] || null;
    return origin;
  }
  const imported = importHome();
  if (imported) {
    origin.kind = "import";
    origin.importName = imported["name"];
    origin.baseLastModified = imported["lastModified"] || null;
    return origin;
  }
  return origin;
}

function draftOriginSignature(origin: DraftOrigin): string {
  const doc = currentDocument();
  return [
    origin.kind, origin.fileId || "", origin.fileKind || "", origin.importName || "",
    origin.server ? (origin.server.docId + "@" + origin.server.rev + "@" + origin.server.base) : "",
    (doc && doc.docId) || "", documentLocation().writtenOut() ? "1" : "0"
  ].join("|");
}

function captureAndSendDraft(keepClean?: boolean): Promise<DraftFlush | null | undefined> {
  schedule().cancel();
  const doc = draftWriterLive() ? currentDocument() : null;
  if (!doc) return Promise.resolve(null);
  if (draftResume().restorePending()) { schedule().keepPending(); return Promise.resolve(null); }
  if (draftInFlight) { schedule().keepPending(); return draftInFlight; }

  const unsaved = unsavedChanges();
  const keepCleanFile = !unsaved && keepClean === true && runningOnDesktop() && draftOriginOf().kind === "file";
  if (!unsaved && !keepCleanFile) {
    schedule().dropPending();
    if (!draftOnDisk || !draftBackendCanDiscard()) return Promise.resolve(null);
    const discardSeq = ++draftSeq;
    draftOnDisk = false;
    draftStats.discards++;
    return Promise.resolve().then(function () {
      return draftBackendDiscard(discardSeq);
    }).then(function (r) {
      if (r && r.ok === false) {
        draftStats.lastCode = r.code || "error";
        draftOnDisk = true;
      }
      return r || null;
    }, function () { draftOnDisk = true; return null; });
  }

  const origin = draftOriginOf();
  if (!runningOnDesktop() && origin.kind !== "server") {
    schedule().dropPending();
    return Promise.resolve(null);
  }
  const signature = draftOriginSignature(origin);
  if ((draftOnDisk || !keepCleanFile) &&
      saveChanges() === draftSentEditSeq && draftSentBase === mergeBase() && signature === draftSentSignature) {
    schedule().dropPending();
    return Promise.resolve(null);
  }

  const startedAt = now();
  let stateJson: string;
  try {
    stateJson = JSON.stringify(doc);
  } catch (e) {
    draftStopped = true;
    showDraftPaused("TOO_LARGE");
    return Promise.resolve({ ok: false, code: "TOO_LARGE" });
  }
  const elapsed = now() - startedAt;
  schedule().setSlow(stateJson.length > draftTiming.largeBytes || elapsed > draftTiming.slowStringifyMs);

  const editSeqAtCapture = saveChanges();
  const baseAtCapture = mergeBase();
  const sendBase = mergeBase() !== draftSentBase;
  let baseTextCache: string | null = null;
  let inlineFailed: string[] | null = null;
  function baseTextFor(): string {
    if (baseTextCache === null) {
      baseTextCache = baseAtCapture ? JSON.stringify(baseAtCapture) : "null";
      if (inlineFailed) baseTextCache = inlineStateJson(baseTextCache, inlineFailed);
    }
    return baseTextCache;
  }
  const payload: DraftPayload = {
    seq: ++draftSeq,
    editSeq: editSeqAtCapture,
    title: (doc.title || ""),
    docId: normalizeDocId(doc.docId) || null,
    docIdWrittenOut: documentLocation().writtenOut(),
    schema: SCHEMA_VERSION,
    originKind: origin.kind,
    fileId: origin.fileId,
    fileKind: origin.fileKind,
    importName: origin.importName,
    baseLastModified: origin.baseLastModified,
    baseSize: origin.baseSize,
    server: origin.server,
    stateJson: stateJson,
    baseJson: sendBase ? baseTextFor() : null
  };

  const captured = runningOnDesktop() ? null : browserDraftCapture(origin.server);

  const draftRefs: string[] = refsIn(doc);
  if (sendBase && baseAtCapture) {
    refsIn(baseAtCapture).forEach(function (sha: string) { if (draftRefs.indexOf(sha) === -1) draftRefs.push(sha); });
  }

  schedule().dropPending();
  const sent = draftRefs.length
    ? persist(draftRefs).then(function (failed: string[]) {
        if (failed.length) {
          inlineFailed = failed;
          payload.stateJson = inlineStateJson(payload.stateJson, failed);
          if (baseTextCache !== null) baseTextCache = inlineStateJson(baseTextCache, failed);
          if (payload.baseJson) payload.baseJson = baseTextCache;
        }
        return sendDraftPayload(payload, captured, baseTextFor, false);
      })
    : sendDraftPayload(payload, captured, baseTextFor, false);
  draftInFlight = sent.then(function (r) {
    draftInFlight = null;
    if (r && r.ok) {
      draftStats.writes++;
      draftStats.lastCode = null;
      if (r.obsolete) {
        draftStats.obsolete++;
        schedule().keepPending();
      } else {
        draftOnDisk = true;
        draftSentEditSeq = editSeqAtCapture;
        draftSentBase = baseAtCapture;
        draftSentSignature = signature;
      }
      schedule().landed();
      if (draftPausedReason) {
        draftPausedReason = "";
        clearDraftPausedToast();
        showToast("Crash recovery is working again", "ok");
      }
    } else {
      noteDraftWriteRefused((r && r.code) || "error");
    }
    schedule().resume();
    return r;
  }, function (err) {
    draftInFlight = null;
    reportError(err);
    noteDraftWriteRefused("offline");
    return { ok: false, code: "offline" };
  });
  return draftInFlight;
}

function sendDraftPayload(payload: DraftPayload, captured: BrowserCapture | null, baseTextFor: () => string, retriedWithBase: boolean): Promise<DraftFlush | null | undefined> {
  return Promise.resolve().then(function () {
    return draftBackendWrite(payload, captured);
  }).then(function (r) {
    if (r && r.ok === false && r.code === "NEED_BASE" && !retriedWithBase) {
      const again: DraftPayload = Object.assign({}, payload);
      again.seq = ++draftSeq;
      again.baseJson = baseTextFor();
      return sendDraftPayload(again, captured, baseTextFor, true);
    }
    return r;
  });
}

function draftReasonFor(code: string): string {
  switch (code) {
    case "HELD": return "the changes recovered from the last session are being kept";
    case "ENOSPC": return "this disk is full";
    case "EACCES":
    case "EPERM": return "this computer would not let Splitpage write it";
    case "EBUSY": return "another program is using the file";
    case "EIO": return "the disk reported an error";
    case "TOO_LARGE": return "this document is too large to copy";
    case "QUOTA": return "this browser's storage is full";
    case "offline": return "the app did not answer";
    default: return "the copy was refused";
  }
}

function isTimingKey(k: string): k is keyof DraftTiming {
  return Object.prototype.hasOwnProperty.call(draftTiming, k);
}

function presentDocument(): DocumentView {
  const doc = currentDocument();
  if (!doc) throw new TypeError("There is no document open");
  return doc;
}

function takenServer(t: TakenDraft): DraftServer {
  const server = t.header && t.header.origin && t.header.origin.server;
  if (!server) throw new TypeError("A browser draft has no server origin");
  return server;
}

function clearDraftPausedToast(): void {
  const el = draftPausedToast;
  draftPausedToast = null;
  if (!el) return;
  if (typeof el.dismiss === "function") el.dismiss();
  else if (el.parentNode) el.parentNode.removeChild(el);
}

function showDraftPaused(code: string): void {
  const reason = draftReasonFor(code);
  if (draftPausedReason === reason) return;
  clearDraftPausedToast();
  draftPausedReason = reason;
  draftPausedToast = showToast("Crash recovery is paused — " + draftPausedReason, "warn", true);
}

function noteDraftWriteRefused(code: string): void {
  draftStats.lastCode = code;
  if (code !== "HELD") draftStats.failures++;

  if (code === "DISCARDED" || code === "NO_TAB") { draftStopped = true; return; }
  if (code === "UNAVAILABLE" && !runningOnDesktop()) { browserDraftsOff = true; schedule().dropPending(); return; }

  if (code !== "STALE_SEQ") showDraftPaused(code);

  schedule().refused();
}

function flushDraftNow(opts?: { readonly keep?: boolean } | null): Promise<DraftFlush> {
  if (!draftWriterLive()) return Promise.resolve({ ok: true });
  const keepClean = !!(opts && opts.keep === true);
  schedule().cancel();
  schedule().cancelRetry();
  return Promise.resolve(draftInFlight).then(function () {
    return captureAndSendDraft(keepClean);
  }).then(function (r) {
    return r || { ok: true };
  }, function (err) {
    reportError(err);
    return { ok: false, code: "EIO" };
  });
}

function draftParse(json: unknown): unknown {
  if (typeof json !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch (e) { return null; }
}

function draftMigrate(json: unknown): ValidatedDocument | null {
  const raw = draftParse(json);
  if (!raw || typeof raw !== "object" || !Array.isArray(fieldOf(raw, "rows"))) return null;
  return migrateRows(raw);
}

function draftStableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) {
    const items = v.map(function (x: unknown) { return draftStableJson(x); });
    return "[" + items.join(",") + "]";
  }
  const keys = Object.keys(v).sort();
  const parts = keys.map(function (k) {
    return JSON.stringify(k) + ":" + draftStableJson(fieldOf(v, k));
  });
  return "{" + parts.join(",") + "}";
}

function sameDocContent(a: DocumentView | null | undefined, b: DocumentView | null | undefined): boolean {
  if (!a || !b) return false;
  function normalized(s: DocumentView): string {
    const c: Mutable<ValidatedDocument> = migrateRows(cloneState(s));
    c.rev = 0;
    c.lastEditedBy = "";
    c.lastEditedAt = "";
    c.docId = "";
    return draftStableJson(c);
  }
  try {
    return normalized(a) === normalized(b);
  } catch (e) { return false; }
}

function draftAgeText(ageMs: unknown): string {
  if (typeof ageMs !== "number" || !isFinite(ageMs) || ageMs < 0) return "";
  const mins = Math.round(ageMs / 60000);
  if (mins < 1) return "from a moment ago";
  if (mins < 60) return "from " + mins + " minute" + (mins === 1 ? "" : "s") + " ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return "from " + hours + " hour" + (hours === 1 ? "" : "s") + " ago";
  const days = Math.round(hours / 24);
  return "from " + days + " day" + (days === 1 ? "" : "s") + " ago";
}

function draftWhenText(t: TakenDraft | null | undefined): string {
  const age = draftAgeText(t && t.ageMs);
  let why = "";
  if (t && t.previousSession === "running") why = "before Splitpage closed unexpectedly";
  else if (t && t.previousSession === "session-end") why = "before Windows signed you out";
  else if (t && t.previousSession === "clean-exit") why = "before Splitpage closed";
  if (age && why) return age + ", " + why;
  return age || why;
}

function draftTitleOf(s: DocumentView | null | undefined, fallback?: string): string {
  return (s && s.title) || fallback || "this script";
}

function hasHeader(t: TakenDraft): t is HeaderedDraft {
  return !!t.header;
}

function recoverDraftAsUnsavedCopy(t: TakenDraft | null | undefined, reasonText: string, mine?: ValidatedDocument | null): boolean {
  if (!t || !hasHeader(t)) return false;
  mine = mine || draftMigrate(t.stateJson);
  if (!mine) return false;
  const origin: TakenOrigin = t.header.origin || {};
  const wasUntitled = origin.kind === "untitled";

  resetProductionPanelState();
  const arrived = documentTransitions().recover({
    from: { document: mine },
    reason: "recoverDraftAsUnsavedCopy: a copy with no home has no ancestor",
    destination: NO_DESTINATION,
    baseline: null,
    detached: !wasUntitled,
    writtenOut: wasUntitled ? !!t.header.docIdWrittenOut : false
  });
  if (arrived.forkedFrom) copyDocHistorySafe(arrived.forkedFrom, arrived.document.docId);
  syncDocIdentity();
  noteAbsorbedDirty("recovery");
  showToast(reasonText, "warn", true);
  return true;
}

function restoreServerDraft(t: HeaderedDraft, mine: ValidatedDocument): string {
  recoverDraftAsUnsavedCopy(t,
    "Your unsaved changes to “" + draftTitleOf(mine) + "” were recovered. It was a document on a " +
    "Splitpage server, which this version no longer opens, so they are open here as an unsaved copy. " +
    "Save them wherever you want them.", mine);
  return "untitled-copy";
}

function keptForNextLaunch(): string {
  showToast("Another script was opened while the changes from the last session were being restored — " +
    "they have been kept for the next launch.", "warn", true);
  return "kept";
}

async function restoreFileDraft(t: HeaderedDraft, mine: ValidatedDocument, base: ValidatedDocument | null, origin: TakenOrigin, ctx: OperationContext): Promise<string> {
  const title = draftTitleOf(mine, origin.fileName);
  const missingName = origin.fileName || title;

  if (!t.file) {
    const gone = t.fileProblem === "unreadable"
      ? "couldn't be read"
      : "isn't where it was";
    recoverDraftAsUnsavedCopy(t,
      "The file these recovered changes belong to (" + missingName + ") " + gone +
      " — they are open here as an unsaved copy.", mine);
    return t.fileProblem === "unreadable" ? "unreadable" : "untitled-copy";
  }

  const handle = makeDesktopHandle(t.file);
  let file: DraftFile | null;
  try { file = await handle.getFile(); } catch (e) { file = null; }
  const parsed = file ? await parseProjectFileState(file) : null;
  if (!stillRestoring(ctx)) return keptForNextLaunch();
  if (!file || !parsed || parsed.error) {
    recoverDraftAsUnsavedCopy(t,
      "The file these recovered changes belong to (" + missingName + ") could not be read — they " +
      "are open here as an unsaved copy.", mine);
    return "unreadable";
  }

  const disk = parsed.state;
  const refId = normalizeDocId((base && base.docId) || mine.docId);
  if (parsed.docIdEmbedded && refId && normalizeDocId(disk.docId) !== refId) {
    recoverDraftAsUnsavedCopy(t,
      "A different script has been saved as " + missingName + " — the changes recovered from the " +
      "last session are open here as an unsaved copy.", mine);
    return "untitled-copy";
  }
  if (refId) disk.docId = refId;

  openDocument({ kind: "file", file: file, handle: handle, parsed: { state: disk, kind: parsed.kind }, options: { skipSnapshot: true, silent: true } });
  const diskCopy = cloneState(disk);

  if (sameDocContent(mine, disk)) {
    documentLocation().markWrittenOut(!!t.header.docIdWrittenOut);
    showToast("Opened " + (disk.title || file.name) + " — the changes from the last session were already saved", "ok");
    return "nothing-unsaved";
  }

  if (sameDocContent(base, disk)) {
    documentTransitions().restore({ from: { document: mine } });
    documentLocation().markWrittenOut(!!t.header.docIdWrittenOut);
    noteAbsorbedDirty("recovery");
    showToast("Restored your unsaved changes to " + (presentDocument().title || file.name) +
      (draftWhenText(t) ? " " + draftWhenText(t) : ""), "ok", true);
    return "applied";
  }

  const merged = await applyStashedWork(disk, { base: base, mine: mine }, {
    recovery: true,
    awaitUndoPoint: true,
    keepLabel: "Your unsaved changes, recovered",
    newBase: diskCopy,
    historyFrom: mine.docId,
    chips: true,
    noAutoSave: true,
    toast: {
      text: (file.name || "That file") + " had changed since the last session — your recovered " +
        "changes were merged into it. Nothing has been saved yet.",
      tone: "warn",
      sticky: true
    }
  });
  if (merged && merged.replaced) return keptForNextLaunch();
  documentLocation().markWrittenOut(!!t.header.docIdWrittenOut);
  return "merged";
}

function adoptUntitledDraft(t: HeaderedDraft, mine: ValidatedDocument, base: ValidatedDocument | null): string {
  resetProductionPanelState();
  documentTransitions().recover({
    from: { document: mine },
    reason: "adoptUntitledDraft: the draft's own base, if it had one",
    destination: NO_DESTINATION,
    baseline: base || null,
    detached: false,
    writtenOut: !!t.header.docIdWrittenOut
  });
  syncDocIdentity();
  noteAbsorbedDirty("recovery");
  showToast("Restored your unsaved script" + (draftWhenText(t) ? " " + draftWhenText(t) : "") +
    " — it has never been saved, so save it somewhere.", "warn", true);
  return "applied";
}

async function runDraftRestore(t: TakenDraft | null | undefined): Promise<string> {
  if (!t) return "nothing-unsaved";
  if (t.unsupported) {
    showToast("The changes recovered from the last session were saved by a newer version of " +
      "Splitpage — they have been kept, untouched.", "warn", true);
    return "failed";
  }
  if (t.corrupt) {
    showToast("The changes recovered from the last session couldn't be read — they have been kept " +
      "for the next launch.", "warn", true);
    return "failed";
  }
  if (!hasHeader(t) || typeof t.stateJson !== "string") return "failed";

  const mine = draftMigrate(t.stateJson);
  if (!mine) {
    showToast("The changes recovered from the last session couldn't be read — they have been kept " +
      "for the next launch.", "warn", true);
    return "failed";
  }
  const base = t.baseJson ? draftMigrate(t.baseJson) : null;
  const origin: TakenOrigin = t.header.origin || { kind: "untitled" };
  const ctx = captureRestore();

  if (origin.kind === "server") return restoreServerDraft(t, mine);
  if (origin.kind === "file") return await restoreFileDraft(t, mine, base, origin, ctx);
  if (origin.kind === "import") {
    recoverDraftAsUnsavedCopy(t,
      "Your unsaved changes to " + (origin.importName || "an imported file") + " were recovered. " +
      "They are open here as an unsaved copy — save them as a Splitpage script to keep them.", mine);
    return "untitled-copy";
  }
  return adoptUntitledDraft(t, mine, base);
}

function takenFromBrowserDraft(rec: StoredDraft, key: string): HeaderedDraft {
  const at = Number(rec.writtenAt) || 0;
  return {
    header: {
      origin: { kind: "server", server: { base: rec.base || "", docId: String(rec.docId), rev: rec.rev || 0 } },
      writtenAt: at,
      title: rec.title || "",
      docIdWrittenOut: !!rec.docIdWrittenOut
    },
    stateJson: rec.stateJson,
    baseJson: rec.baseJson,
    ageMs: at ? Math.max(0, now() - at) : undefined,
    browserKey: key
  };
}

function browserDraftRestoreDone(t: TakenDraft, key: string, outcome: string): void {
  if (outcome !== "untitled-copy") return;
  const server = takenServer(t);
  const doc = currentHome().kind === "none" ? currentDocument() : null;
  browserCopyOf = doc
    ? { key: key, docId: doc.docId, server: { base: server.base, docId: server.docId, rev: server.rev } }
    : null;
  draftOnDisk = true;
  browserDrafts().writer.take(key);
}

function newestLeftoverBrowserDraft(): Promise<HeaderedDraft | null> {
  const store = browserDraftStore();
  return store.list().then(function (metas) {
    const newest = metas.slice().sort(function (a, b) { return b.writtenAt - a.writtenAt; });
    return (function next(i: number): Promise<DraftMeta | null> | null {
      const meta = newest[i];
      if (i >= newest.length || !meta) return null;
      return browserWriterIsLive(meta.writerId).then(function (isLive) {
        return isLive ? next(i + 1) : meta;
      });
    })(0);
  }).then(function (pick) {
    return pick ? store.get(pick.key) : null;
  }).then(function (rec) {
    return rec ? takenFromBrowserDraft(rec, rec.key) : null;
  }, function () { return null; });
}

function draftTaker(): (() => Promise<unknown>) | null {
  if (!runningOnDesktop()) return browserDraftsOff ? null : newestLeftoverBrowserDraft;
  const take = desktopDrafts().taker();
  if (!(take && draftResume().restorePending())) return null;
  return take;
}

async function applyTakenDraft(taken: unknown): Promise<string> {
  const t = taken as TakenDraft | null | undefined;
  const resume = draftResume();
  let outcome: string;
  try {
    outcome = !runningOnDesktop() && t && t.browserKey && unsavedChanges() ? "kept" : await runDraftRestore(t);
  } catch (e) {
    reportError(e);
    outcome = "failed";
    showToast("Could not restore the changes from the last session — they have been kept for the " +
      "next launch.", "warn", true);
  }
  resume.setRestorePending(false);
  if (runningOnDesktop()) {
    try { desktopDrafts().restoreDone(outcome); } catch (e2) {}
  }
  if (!runningOnDesktop() && t && t.browserKey) browserDraftRestoreDone(t, t.browserKey, outcome);
  if (typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  noteDraftChange();
  return outcome;
}

export function startDrafts(given: DraftsPorts): DraftsMount {
  ports = given;
  const mounted = given;
  draftResume().setRestorePending(!!(runningOnDesktop() && desktopDrafts().hasDraftToRestore()));

  draftOnDisk = !!(runningOnDesktop() && desktopDrafts().hasDraftToRestore());

  return {
    flush: flushDraftNow,
    noteChange: noteDraftChange,
    taker: draftTaker,
    applyTaken: applyTakenDraft,
    holdLock: holdBrowserWriterLock,
    releaseLock: releaseBrowserWriterLock,
    testing: {
      flushNow: function () { return flushDraftNow(); },
      status: function () {
        return {
          seq: draftSeq,
          writes: draftStats.writes,
          failures: draftStats.failures,
          discards: draftStats.discards,
          obsolete: draftStats.obsolete,
          lastCode: draftStats.lastCode,
          paused: !!draftPausedReason,
          pausedReason: draftPausedReason,
          pending: schedule().pending(),
          onDisk: draftOnDisk,
          stopped: draftStopped,
          slow: schedule().slow(),
          restorePending: draftResume().restorePending()
        };
      },
      setTiming: function (t: Readonly<Record<string, number>> | null | undefined) {
        if (!t) return;
        for (const [k, value] of Object.entries(t)) {
          if (isTimingKey(k)) draftTiming[k] = value;
        }
      },
      restorePending: function () { return draftResume().restorePending(); },
      applyForTest: function (taken: unknown) {
        draftResume().setRestorePending(true);
        return applyTakenDraft(taken);
      },
      noteChange: function () { noteDraftChange(); },
      sameDocContent: sameDocContent,
      browser: {
        list: function () { return browserDraftStore().list(); },
        get: function (docId: string, serverUrl?: unknown) {
          const base = draftBaseOf(serverUrl === undefined ? "" : serverUrl);
          return browserDraftStore().get(browserDraftKey(base, docId));
        },
        all: function () {
          const store = browserDraftStore();
          return store.list().then(function (metas) {
            return Promise.all(metas.map(function (m) { return store.get(m.key); }));
          });
        },
        writerId: function () { return live().lock.writerId(); },
        status: function () {
          const target = browserDraftTarget();
          return { off: browserDraftsOff, keyOnDisk: browserKeyOnDisk(), copy: !!browserCopyOf,
                   target: target ? { docId: target.docId, copy: target.copy } : null };
        },
        useIndexedDB: function (factory: unknown) {
          useBrowserDraftFactory(factory);
          browserDraftsOff = false;
        }
      }
    },
    dispose: function () {
      if (ports !== mounted) return;
      schedule().cancel();
      schedule().cancelRetry();
      ports = null;
    }
  };
}
