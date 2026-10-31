import { STATE_FIELDS } from "../../core/merge/state-fields.ts";
import { mergeStates as mergeStatesWith } from "../../core/merge-states.ts";
import { isDocumentObject } from "../../core/migrate.ts";
import { textMergeContext as coreTextMergeContext } from "../../core/merge/text-field.ts";
import { cloneState } from "../../core/document/clone.ts";

function startSessionMerge(ports) {
  var active = true;
  var currentDocument = ports.document.current;
  var heldDocument = ports.session.held;
  var { holdMergeBase, noteAbsorbedDirty, noteDiskUpdate, noteMerged, noteRecovery } = ports.session;
  var migrateRows = ports.entry.migrate;
  var withDocumentPorts = ports.entry.withPorts;
  var fromHtml = ports.text.fromHtml;
  var randomIds = ports.ids;
  var systemClock = ports.clock;
  var nowIso = ports.clock.nowIso;
  var getEditorName = ports.preferences.editorName;
  var { captureSnapshot, getHistorySnapshot, protectHistorySnapshot } = ports.history;
  var { adoptRestoredState, noteMergedDocId } = ports.identity;
  var captureRestore = ports.recovery.capture;
  var stillRestoring = function (ctx) { return active && ports.recovery.stillOwns(ctx); };
  var saveChanges = ports.saving.changes;
  var confirmBaseline = ports.saving.confirmBaseline;
  var autoSavePolicy = function () { return ports.autoSave; };
  var setHome = ports.location.setHome;
  var mergeUndo = function () { return ports.undo; };
  var resetProductionPanelState = ports.production.reset;

function stampRow(row) {
  row.updatedAt = nowIso();
  row.updatedBy = getEditorName();
}

function pushSnapshot(label, snapshotState) {
  return captureSnapshot(label, snapshotState || currentDocument(), { allowSeedSkip: !snapshotState });
}

var restoreInFlight = false;
var RESTORE_BACKUP_ATTEMPTS = 3;

async function restoreSnapshot(id, opts) {
  opts = opts || {};
  if (restoreInFlight) return "busy";
  if (!currentDocument()) return "missing";
  restoreInFlight = true;
  var docIdAtStart = currentDocument().docId;
  var ctx = captureRestore();
  var moved = function () { return !currentDocument() || !stillRestoring(ctx); };
  var releaseHold = function () {};
  try {
    releaseHold = protectHistorySnapshot({ docId: opts.older ? null : docIdAtStart, older: !!opts.older, id: id });

    var snap = await getHistorySnapshot({ docId: opts.older ? null : docIdAtStart, older: !!opts.older, id: id });
    if (moved()) return "changed";
    if (!snap) return "missing";
    var parsed = null;
    try { parsed = JSON.parse(snap.stateJson); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rows)) return "corrupt";

    var stored = false;
    for (var attempt = 0; attempt < RESTORE_BACKUP_ATTEMPTS; attempt++) {
      var stateAtCapture = currentDocument();
      var seqAtCapture = saveChanges();
      var ticket = captureSnapshot("Before restoring an earlier version", currentDocument(), { allowSeedSkip: false });
      if (!ticket) { stored = false; break; }
      var result = await ticket.done;
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

function textMergeContext(base, mine, theirs, mergedTags) {
  return coreTextMergeContext(fromHtml, base, mine, theirs, mergedTags);
}

function mergeStates(base, mine, theirs) {
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
  var api = {
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
    documentId: function (doc) { return doc.docId; },
    noteHistoryFrom: function (prevDocId) { noteMergedDocId(prevDocId); },
    armUndo: function (record) { mergeUndo().arm(record); },
    setBase: function (next, why) { setBaseState(next, why); },
    capture: function () { return captureRestore(); },
    stillOwns: function (ctx) { return stillRestoring(ctx); }
  };
  Object.keys(api).forEach(function (key) {
    var call = api[key];
    api[key] = function (...args) {
      if (!active) throw new Error("The session merge is not started yet");
      return call(...args);
    };
  });
  return api;
}

var baseStateWhy = "";

function setBaseState(next, why) {
  baseStateWhy = String(why || "");
  holdMergeBase(confirmBaseline(next));
  return next;
}

var documentDestinationPort = Object.freeze({
  set: function (destination) { setHome(destination.kind, destination.fields); },
  confirm: function (baseline, why) { setBaseState(baseline ? cloneState(baseline) : null, why); }
});

var documentHistoryPort = Object.freeze({
  keep: function (label, doc) { return pushSnapshot(label, doc); }
});

function baseStateReason() {
  return baseStateWhy;
}

function restoreMergeSnapshot(id, request) {
  return restoreSnapshot(id, request);
}


  return { stampRow, sessionMergePorts, setBaseState, baseStateReason, textMergeContext, restoreMergeSnapshot, documentDestinationPort, documentHistoryPort, dispose: function () { active = false; } };
}

export function createSessionMergeOwner() {
  var started = null;
  function running() {
    if (!started) throw new Error("The session merge is not started yet");
    return started;
  }
  return {
    startSessionMerge: function (ports) {
      if (started) throw new Error("The session merge is already started; stop it first");
      var mine = startSessionMerge(ports);
      started = mine;
      return function () { if (started === mine) { started = null; mine.dispose(); } };
    },
    stampRow: function (...args) { return running().stampRow(...args); },
    sessionMergePorts: function (...args) { return running().sessionMergePorts(...args); },
    setBaseState: function (...args) { return running().setBaseState(...args); },
    baseStateReason: function (...args) { return running().baseStateReason(...args); },
    textMergeContext: function (...args) { return running().textMergeContext(...args); },
    restoreMergeSnapshot: function (...args) { return running().restoreMergeSnapshot(...args); },
    documentDestinationPort: Object.freeze({
      set: function (...args) { return running().documentDestinationPort.set(...args); },
      confirm: function (...args) { return running().documentDestinationPort.confirm(...args); }
    }),
    documentHistoryPort: Object.freeze({ keep: function (...args) { return running().documentHistoryPort.keep(...args); } })
  };
}
