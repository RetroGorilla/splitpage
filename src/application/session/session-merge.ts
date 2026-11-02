import type { SessionMergeOwner, SessionMergeOwnerPorts, SessionMergePorts, SnapshotRestoreRequest, SnapshotRestoreResult } from "./session-merge-ports.ts";
import type { DocumentView } from "./document-session.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { OperationContext } from "./operation.ts";
import type { DestinationPort, DocumentDestination, HistoryPort } from "../transitions/ports.ts";
type SessionMergeCallable = (...args: never[]) => unknown;
import { STATE_FIELDS } from "../../core/merge/state-fields.ts";
import { mergeStates as mergeStatesWith } from "../../core/merge-states.ts";
import { isDocumentObject } from "../../core/migrate.ts";
import { textMergeContext as coreTextMergeContext } from "../../core/merge/text-field.ts";
import { cloneState } from "../../core/document/clone.ts";

function startSessionMerge(ports: SessionMergeOwnerPorts) {
  let active = true;
  const currentDocument = ports.document.current;
  const heldDocument = ports.session.held;
  const { holdMergeBase, noteAbsorbedDirty, noteDiskUpdate, noteMerged, noteRecovery } = ports.session;
  const migrateRows = ports.entry.migrate;
  const withDocumentPorts = ports.entry.withPorts;
  const fromHtml = ports.text.fromHtml;
  const randomIds = ports.ids;
  const systemClock = ports.clock;
  const nowIso = ports.clock.nowIso;
  const getEditorName = ports.preferences.editorName;
  const { captureSnapshot, getHistorySnapshot, protectHistorySnapshot } = ports.history;
  const { adoptRestoredState, noteMergedDocId } = ports.identity;
  const captureRestore = ports.recovery.capture;
  const stillRestoring = function (ctx: OperationContext) { return active && ports.recovery.stillOwns(ctx); };
  const saveChanges = ports.saving.changes;
  const confirmBaseline = ports.saving.confirmBaseline;
  const autoSavePolicy = function () { return ports.autoSave; };
  const setHome = ports.location.setHome;
  const mergeUndo = function () { return ports.undo; };
  const resetProductionPanelState = ports.production.reset;

function stampRow(row: Parameters<SessionMergeOwner["stampRow"]>[0]) {
  row.updatedAt = nowIso();
  row.updatedBy = getEditorName();
}

function pushSnapshot(label: string | undefined, snapshotState?: unknown) {
  return captureSnapshot(label, snapshotState || currentDocument(), { allowSeedSkip: !snapshotState });
}

let restoreInFlight = false;
const RESTORE_BACKUP_ATTEMPTS = 3;

async function restoreSnapshot(id: string, opts?: SnapshotRestoreRequest): Promise<SnapshotRestoreResult> {
  opts = opts || {};
  if (restoreInFlight) return "busy";
  if (!currentDocument()) return "missing";
  restoreInFlight = true;
  const docIdAtStart = (currentDocument() as DocumentView).docId;
  const ctx = captureRestore();
  const moved = function () { return !currentDocument() || !stillRestoring(ctx); };
  let releaseHold = function () {};
  try {
    releaseHold = protectHistorySnapshot({ docId: opts.older ? null : docIdAtStart, older: !!opts.older, id: id });

    const snap = await getHistorySnapshot({ docId: opts.older ? null : docIdAtStart, older: !!opts.older, id: id });
    if (moved()) return "changed";
    if (!snap) return "missing";
    let parsed: unknown = null;
    try { parsed = JSON.parse(snap.stateJson as string); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { rows?: unknown }).rows)) return "corrupt";

    let stored = false;
    for (let attempt = 0; attempt < RESTORE_BACKUP_ATTEMPTS; attempt++) {
      const stateAtCapture = currentDocument();
      const seqAtCapture = saveChanges();
      const ticket = captureSnapshot("Before restoring an earlier version", currentDocument(), { allowSeedSkip: false });
      if (!ticket) { stored = false; break; }
      const result = await ticket.done;
      if (moved()) return "changed";
      stored = !!(result && result.stored);
      if (currentDocument() === stateAtCapture && saveChanges() === seqAtCapture) break;
      stored = false;
    }
    if (!stored && !opts.force) return "no-backup";

    resetProductionPanelState();
    adoptRestoredState(parsed);
    noteAbsorbedDirty("recovery");
    ports.onRestored(snap, opts);
    if (!opts.local) autoSavePolicy().dueNow();
    return "restored";
  } finally {
    releaseHold();
    restoreInFlight = false;
  }
}

function textMergeContext(base: Parameters<SessionMergeOwner["textMergeContext"]>[0], mine: Parameters<SessionMergeOwner["textMergeContext"]>[1], theirs: Parameters<SessionMergeOwner["textMergeContext"]>[2], mergedTags?: Parameters<SessionMergeOwner["textMergeContext"]>[3]) {
  return coreTextMergeContext(fromHtml, base, mine, theirs, mergedTags);
}

function mergeStates(base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) {
  return withDocumentPorts(STATE_FIELDS, function (migrate) {
    return mergeStatesWith(base, mine, theirs, {
      decode: fromHtml,
      ids: randomIds,
      clock: systemClock,
      editor: getEditorName,
      fields: STATE_FIELDS,
      migrate: migrate
    });
  });
}

function sessionMergePorts() {
  const api: SessionMergePorts = {
    states: mergeStates,
    entry: function (raw, lines) { return migrateRows(cloneState(raw), lines); },
    isDocument: function (raw) { return isDocumentObject(raw); },
    snapshot: function (label, doc) { return pushSnapshot(label, doc); },
    current: function () { return heldDocument(); },
    adopt: function (kind, next, merged) {
      if (merged) next = noteMerged(kind, next);
      else next = kind === "recovery" ? noteRecovery(next) : noteDiskUpdate(next);
      return next;
    },
    documentId: function (doc) { return (doc as NonNullable<typeof doc>).docId; },
    noteHistoryFrom: function (prevDocId) { noteMergedDocId(prevDocId); },
    armUndo: function (record) { mergeUndo().arm(record); },
    setBase: function (next, why) { setBaseState(next, why); },
    capture: function () { return captureRestore(); },
    stillOwns: function (ctx) { return stillRestoring(ctx); }
  };
  Object.keys(api).forEach(function (key) {
    const call = (api as unknown as Record<string, SessionMergeCallable>)[key] as SessionMergeCallable;
    (api as unknown as Record<string, SessionMergeCallable>)[key] = function (...args: never[]) {
      if (!active) throw new Error("The session merge is not started yet");
      return call(...args);
    };
  });
  return api;
}

let baseStateWhy = "";

function setBaseState(next: ValidatedDocument | null, why: string) {
  baseStateWhy = String(why || "");
  holdMergeBase(confirmBaseline(next));
  return next;
}

const documentDestinationPort = Object.freeze<DestinationPort<DocumentDestination>>({
  set: function (destination) { setHome(destination.kind, destination.fields); },
  confirm: function (baseline, why) { setBaseState(baseline ? cloneState(baseline) : null, why); }
});

const documentHistoryPort = Object.freeze<HistoryPort>({
  keep: function (label, doc) { return pushSnapshot(label, doc); }
});

function baseStateReason() {
  return baseStateWhy;
}

function restoreMergeSnapshot(id: string, request?: SnapshotRestoreRequest) {
  return restoreSnapshot(id, request);
}


  return { stampRow, sessionMergePorts, setBaseState, baseStateReason, textMergeContext, restoreMergeSnapshot, documentDestinationPort, documentHistoryPort, dispose: function () { active = false; } };
}

export function createSessionMergeOwner(): SessionMergeOwner {
  let started: ReturnType<typeof startSessionMerge> | null = null;
  function running() {
    if (!started) throw new Error("The session merge is not started yet");
    return started;
  }
  return {
    startSessionMerge: function (ports) {
      if (started) throw new Error("The session merge is already started; stop it first");
      const mine = startSessionMerge(ports);
      started = mine;
      return function () { if (started === mine) { started = null; mine.dispose(); } };
    },
    stampRow: function (...args) { return running().stampRow(...args); },
    sessionMergePorts: function (...args) { return running().sessionMergePorts(...args); },
    setBaseState: function (...args) { return running().setBaseState(...args); },
    baseStateReason: function (...args) { return running().baseStateReason(...args); },
    textMergeContext: function (...args) { return running().textMergeContext(...args); },
    restoreMergeSnapshot: function (...args) { return running().restoreMergeSnapshot(...args); },
    documentDestinationPort: Object.freeze<DestinationPort<DocumentDestination>>({
      set: function (...args) { return running().documentDestinationPort.set(...args); },
      confirm: function (...args) { return running().documentDestinationPort.confirm(...args); }
    }),
    documentHistoryPort: Object.freeze<HistoryPort>({ keep: function (...args) { return running().documentHistoryPort.keep(...args); } })
  };
}
