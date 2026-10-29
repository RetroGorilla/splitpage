import { NO_DESTINATION } from "../transitions/ports.ts";
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
import {
  KEPT_NOTICE, RESTORE_FAILED_NOTICE, alreadySavedNotice, differentScriptCopy, draftMigrate as migrateDraft, draftReasonFor, draftRefId,
  hasHeader, importCopy, mergedFileNotice, missingFileCopy, missingFileName, restoredFileNotice, sameDocContent as sameDraftContent,
  serverCopy, takenDraftFate, unreadableFileCopy, untitledRestoredNotice
} from "./draft-restore.ts";
import { browserDraftOrigin, desktopDraftOrigin, draftOriginSignature, draftPayloadFor, draftRefsFor, draftRefusal } from "./draft-origin.ts";
import type { DraftOrigin, DraftPayload, DraftServer } from "./draft-origin.ts";
import type { DraftCopy, DraftRestoreOutcome, HeaderedDraft, TakenDraft, TakenOrigin } from "./draft-restore.ts";
import type { DraftFile, DraftFlush, DraftOpening, DraftParsedFile, DraftsMount, DraftsPorts } from "./drafts-ports.ts";

interface BrowserCapture {
  readonly base: string;
  readonly draft: DraftCapture;
}

interface BrowserCopy {
  readonly key: string | undefined;
  readonly docId: string;
  readonly server: DraftServer;
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

function draftOriginOf(): DraftOrigin {
  return runningOnDesktop() ? desktopDraftOrigin(fileHome(), importHome) : browserDraftOrigin(browserDraftTarget());
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
  const signature = draftOriginSignature(origin, currentDocument(), documentLocation().writtenOut());
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
  const payload = draftPayloadFor({
    seq: ++draftSeq,
    editSeq: editSeqAtCapture,
    doc: doc,
    writtenOut: documentLocation().writtenOut(),
    origin: origin,
    stateJson: stateJson,
    baseJson: sendBase ? baseTextFor() : null
  });

  const captured = runningOnDesktop() ? null : browserDraftCapture(origin.server);

  const draftRefs = draftRefsFor(doc, baseAtCapture, sendBase);

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

  const refusal = draftRefusal(code, runningOnDesktop());
  if (refusal === "stop") { draftStopped = true; return; }
  if (refusal === "browser-off") { browserDraftsOff = true; schedule().dropPending(); return; }

  if (refusal === "pause") showDraftPaused(code);

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

function draftMigrate(json: unknown): ValidatedDocument | null {
  return migrateDraft(json, migrateRows);
}

function sameDocContent(a: DocumentView | null | undefined, b: DocumentView | null | undefined): boolean {
  return sameDraftContent(a, b, migrateRows);
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

function recoverAsCopy(t: HeaderedDraft, copy: DraftCopy, mine: ValidatedDocument): DraftRestoreOutcome {
  recoverDraftAsUnsavedCopy(t, copy.notice, mine);
  return copy.outcome;
}

function keptForNextLaunch(): DraftRestoreOutcome {
  showToast(KEPT_NOTICE, "warn", true);
  return "kept";
}

async function restoreFileDraft(t: HeaderedDraft, mine: ValidatedDocument, base: ValidatedDocument | null, origin: TakenOrigin, ctx: OperationContext): Promise<DraftRestoreOutcome> {
  const missingName = missingFileName(mine, origin);

  if (!t.file) return recoverAsCopy(t, missingFileCopy(t, missingName), mine);

  const handle = makeDesktopHandle(t.file);
  let file: DraftFile | null;
  try { file = await handle.getFile(); } catch (e) { file = null; }
  const parsed = file ? await parseProjectFileState(file) : null;
  if (!stillRestoring(ctx)) return keptForNextLaunch();
  if (!file || !parsed || parsed.error) return recoverAsCopy(t, unreadableFileCopy(missingName), mine);

  const disk = parsed.state;
  const refId = draftRefId(mine, base);
  const different = differentScriptCopy(parsed, refId, missingName);
  if (different) return recoverAsCopy(t, different, mine);
  if (refId) disk.docId = refId;

  openDocument({ kind: "file", file: file, handle: handle, parsed: { state: disk, kind: parsed.kind }, options: { skipSnapshot: true, silent: true } });
  const diskCopy = cloneState(disk);

  if (sameDocContent(mine, disk)) {
    documentLocation().markWrittenOut(!!t.header.docIdWrittenOut);
    showToast(alreadySavedNotice(disk, file.name), "ok");
    return "nothing-unsaved";
  }

  if (sameDocContent(base, disk)) {
    documentTransitions().restore({ from: { document: mine } });
    documentLocation().markWrittenOut(!!t.header.docIdWrittenOut);
    noteAbsorbedDirty("recovery");
    showToast(restoredFileNotice(t, presentDocument().title, file.name), "ok", true);
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
      text: mergedFileNotice(file.name),
      tone: "warn",
      sticky: true
    }
  });
  if (merged && merged.replaced) return keptForNextLaunch();
  documentLocation().markWrittenOut(!!t.header.docIdWrittenOut);
  return "merged";
}

function adoptUntitledDraft(t: HeaderedDraft, mine: ValidatedDocument, base: ValidatedDocument | null): DraftRestoreOutcome {
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
  showToast(untitledRestoredNotice(t), "warn", true);
  return "applied";
}

async function runDraftRestore(t: TakenDraft | null | undefined): Promise<DraftRestoreOutcome> {
  const fate = takenDraftFate(t, migrateRows);
  if (fate.kind === "settled") {
    if (fate.notice !== null) showToast(fate.notice, "warn", true);
    return fate.outcome;
  }
  const ctx = captureRestore();
  const { draft, mine, base, origin } = fate;

  if (fate.route === "server") return recoverAsCopy(draft, serverCopy(mine), mine);
  if (fate.route === "file") return await restoreFileDraft(draft, mine, base, origin, ctx);
  if (fate.route === "import") return recoverAsCopy(draft, importCopy(origin), mine);
  return adoptUntitledDraft(draft, mine, base);
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
    showToast(RESTORE_FAILED_NOTICE, "warn", true);
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
