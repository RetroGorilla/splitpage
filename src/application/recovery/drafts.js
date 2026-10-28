import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { refsIn } from "../../../shared/blob-policy.js";
import { NO_DESTINATION } from "../transitions/ports.ts";
import { SCHEMA_VERSION } from "../../core/document/fields.ts";
import { createCaptureSchedule } from "./capture-schedule.ts";
import { cloneState } from "../../core/document/clone.ts";

var ports = null;

function runningOnDesktop() { return ports.running(); }
function currentDocument() { return ports.document.current(); }
function mergeBase() { return ports.session.mergeBase(); }
function noteAbsorbedDirty(reason) { ports.session.noteAbsorbedDirty(reason); }
function currentHome() { return ports.place.home(); }
function fileHome() { return ports.place.fileHome(); }
function importHome() { return ports.place.importHome(); }
function documentLocation() { return { writtenOut: ports.place.writtenOut, markWrittenOut: ports.markWrittenOut }; }
function migrateRows(raw) { return ports.entry.migrate(raw); }
function persist(refs) { return ports.pictures.persist(refs); }
function inlineStateJson(json, failed) { return ports.pictures.inline(json, failed); }
function copyDocHistorySafe(fromId, toId) { ports.identity.copyHistory(fromId, toId); }
function syncDocIdentity() { ports.identity.sync(); }
function resetProductionPanelState() { ports.resetProductionPanel(); }
function showToast(message, kind, sticky) { return ports.notices.show(message, kind, sticky); }
function browserDraftKey(base, docId) { return ports.browserDraft.key(base, docId); }
function draftBaseOf(serverUrl) { return ports.browserDraft.base(serverUrl); }
function browserWriterIsLive(writerId) { return ports.lock.isLive(writerId); }
function holdWriterLock() { ports.lock.hold(); }
function releaseBrowserWriterLock() { ports.lock.release(); }
function applyStashedWork(disk, work, options) { return ports.recovery.applyStashedWork(disk, work, options); }
function browserDrafts() { return ports.recovery.browserDrafts(); }
function captureRestore() { return ports.recovery.captureRestore(); }
function desktopDrafts() { return ports.recovery.desktopDrafts(); }
function draftResume() { return ports.recovery.draftResume(); }
function recoveryStarted() { return ports.recovery.started(); }
function stillRestoring(ctx) { return ports.recovery.stillRestoring(ctx); }
function useBrowserDraftFactory(factory) { return ports.recovery.useBrowserDraftFactory(factory); }
function documentTransitions() { return ports.transitions; }
function openDocument(opening) { return ports.documents.open(opening); }
function saveChanges() { return ports.saves.editSeq(); }
function unsavedChanges() { return ports.saves.unsaved(); }
function parseProjectFileState(file) { return ports.files.parse(file); }
function makeDesktopHandle(entry) { return ports.files.handle(entry); }
function notifyDesktopDocumentState() { ports.documentState.notify(); }
function now() { return ports.clock.now(); }
function setTimer(run, ms) { return ports.timers.set(run, ms); }
function clearTimer(handle) { ports.timers.clear(handle); }
function reportError(error) { ports.report(error); }

var draftOnDisk;

var draftTiming = {
  idle: 1500,
  max: 5000,
  slow: 15000,
  largeBytes: 8 * 1024 * 1024,
  slowStringifyMs: 50,
  backoffMin: 5000,
  backoffMax: 60000
};

var draftSchedule = createCaptureSchedule({
  timing: function () { return draftTiming; },
  timers: {
    set: function (run, ms) { return setTimer(run, ms); },
    clear: function (handle) { clearTimer(handle); }
  },
  capture: function () { captureAndSendDraft(); }
});

var draftSeq = 0;
var draftInFlight = null;
var draftStopped = false;
var draftPausedReason = "";
var draftPausedToast = null;
var draftSentEditSeq = -1;
var draftSentBase = {};
var draftSentSignature = "";
var draftStats = { writes: 0, failures: 0, discards: 0, obsolete: 0, lastCode: null };

var browserDraftsOff = false;
var browserCopyOf = null;

function browserDraftStore() {
  return browserDrafts().store;
}

function browserKeyOnDisk() {
  return recoveryStarted() ? browserDrafts().writer.tracked() : null;
}

function browserDraftTarget() {
  if (runningOnDesktop() || browserDraftsOff) return null;
  if (browserCopyOf && currentHome().kind === "none" && currentDocument() && currentDocument().docId === browserCopyOf.docId) {
    return { base: browserCopyOf.server.base, docId: browserCopyOf.server.docId, rev: browserCopyOf.server.rev, copy: true };
  }
  browserCopyOf = null;
  return null;
}

function browserDraftCapture(server) {
  var base = server ? draftBaseOf(server.base) : "";
  if (!server || !base || !server.docId) return null;
  return { base: base, draft: browserDrafts().writer.capture(browserDraftKey(base, server.docId)) };
}

function browserWriteDraft(payload, captured) {
  var server = payload.server;
  if (!captured) return Promise.resolve({ ok: false, code: "UNAVAILABLE" });
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

function browserDiscardDraft() {
  return browserDrafts().writer.discard().then(function () { return { ok: true }; });
}

function draftBackendWrite(payload, captured) {
  if (runningOnDesktop()) return desktopDrafts().write(payload);
  return browserWriteDraft(payload, captured);
}

function draftBackendCanDiscard() {
  if (runningOnDesktop()) return desktopDrafts().canDiscard();
  return !!browserKeyOnDisk();
}

function draftBackendDiscard(seq) {
  if (runningOnDesktop()) return desktopDrafts().discard(seq);
  return browserDiscardDraft();
}

function draftWriterLive() {
  if (draftStopped) return false;
  if (runningOnDesktop()) return desktopDrafts().writable();
  return !browserDraftsOff && (!!browserKeyOnDisk() || !!browserDraftTarget());
}

function holdBrowserWriterLock() {
  if (runningOnDesktop()) return;
  holdWriterLock();
}

function noteDraftChange() {
  if (!draftWriterLive()) return;
  draftSchedule.noteChange();
}

function draftOriginOf() {
  var origin = {
    kind: "untitled", fileId: null, fileKind: null, importName: null,
    baseLastModified: null, baseSize: null, server: null
  };
  if (!runningOnDesktop()) {
    var target = browserDraftTarget();
    if (target) {
      origin.kind = "server";
      origin.server = { base: target.base, docId: target.docId, rev: target.rev, copy: target.copy };
    }
    return origin;
  }
  var file = fileHome();
  var fileId = (file && file.handle && file.handle._desktopId) || null;
  if (fileId) {
    origin.kind = "file";
    origin.fileId = fileId;
    origin.fileKind = file.format;
    origin.baseLastModified = file.lastModified || null;
    return origin;
  }
  var imported = importHome();
  if (imported) {
    origin.kind = "import";
    origin.importName = imported.name;
    origin.baseLastModified = imported.lastModified || null;
    return origin;
  }
  return origin;
}

function draftOriginSignature(origin) {
  return [
    origin.kind, origin.fileId || "", origin.fileKind || "", origin.importName || "",
    origin.server ? (origin.server.docId + "@" + origin.server.rev + "@" + origin.server.base) : "",
    (currentDocument() && currentDocument().docId) || "", documentLocation().writtenOut() ? "1" : "0"
  ].join("|");
}

function captureAndSendDraft(keepClean) {
  draftSchedule.cancel();
  if (!draftWriterLive() || !currentDocument()) return Promise.resolve(null);
  if (draftResume().restorePending()) { draftSchedule.keepPending(); return Promise.resolve(null); }
  if (draftInFlight) { draftSchedule.keepPending(); return draftInFlight; }

  var unsaved = unsavedChanges();
  var keepCleanFile = !unsaved && keepClean === true && runningOnDesktop() && draftOriginOf().kind === "file";
  if (!unsaved && !keepCleanFile) {
    draftSchedule.dropPending();
    if (!draftOnDisk || !draftBackendCanDiscard()) return Promise.resolve(null);
    var discardSeq = ++draftSeq;
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

  var origin = draftOriginOf();
  if (!runningOnDesktop() && origin.kind !== "server") {
    draftSchedule.dropPending();
    return Promise.resolve(null);
  }
  var signature = draftOriginSignature(origin);
  if ((draftOnDisk || !keepCleanFile) &&
      saveChanges() === draftSentEditSeq && draftSentBase === mergeBase() && signature === draftSentSignature) {
    draftSchedule.dropPending();
    return Promise.resolve(null);
  }

  var startedAt = now();
  var stateJson;
  try {
    stateJson = JSON.stringify(currentDocument());
  } catch (e) {
    draftStopped = true;
    showDraftPaused("TOO_LARGE");
    return Promise.resolve({ ok: false, code: "TOO_LARGE" });
  }
  var elapsed = now() - startedAt;
  draftSchedule.setSlow(stateJson.length > draftTiming.largeBytes || elapsed > draftTiming.slowStringifyMs);

  var editSeqAtCapture = saveChanges();
  var baseAtCapture = mergeBase();
  var sendBase = mergeBase() !== draftSentBase;
  var baseTextCache = null;
  var inlineFailed = null;
  function baseTextFor() {
    if (baseTextCache === null) {
      baseTextCache = baseAtCapture ? JSON.stringify(baseAtCapture) : "null";
      if (inlineFailed) baseTextCache = inlineStateJson(baseTextCache, inlineFailed);
    }
    return baseTextCache;
  }
  var payload = {
    seq: ++draftSeq,
    editSeq: editSeqAtCapture,
    title: (currentDocument().title || ""),
    docId: normalizeDocId(currentDocument().docId) || null,
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

  var captured = runningOnDesktop() ? null : browserDraftCapture(origin.server);

  var draftRefs = refsIn(currentDocument());
  if (sendBase && baseAtCapture) {
    refsIn(baseAtCapture).forEach(function (sha) { if (draftRefs.indexOf(sha) === -1) draftRefs.push(sha); });
  }

  draftSchedule.dropPending();
  var sent = draftRefs.length
    ? persist(draftRefs).then(function (failed) {
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
        draftSchedule.keepPending();
      } else {
        draftOnDisk = true;
        draftSentEditSeq = editSeqAtCapture;
        draftSentBase = baseAtCapture;
        draftSentSignature = signature;
      }
      draftSchedule.landed();
      if (draftPausedReason) {
        draftPausedReason = "";
        clearDraftPausedToast();
        showToast("Crash recovery is working again", "ok");
      }
    } else {
      noteDraftWriteRefused((r && r.code) || "error");
    }
    draftSchedule.resume();
    return r;
  }, function (err) {
    draftInFlight = null;
    reportError(err);
    noteDraftWriteRefused("offline");
    return { ok: false, code: "offline" };
  });
  return draftInFlight;
}

function sendDraftPayload(payload, captured, baseTextFor, retriedWithBase) {
  return Promise.resolve().then(function () {
    return draftBackendWrite(payload, captured);
  }).then(function (r) {
    if (r && r.ok === false && r.code === "NEED_BASE" && !retriedWithBase) {
      var again = {};
      for (var k in payload) { if (Object.prototype.hasOwnProperty.call(payload, k)) again[k] = payload[k]; }
      again.seq = ++draftSeq;
      again.baseJson = baseTextFor();
      return sendDraftPayload(again, captured, baseTextFor, true);
    }
    return r;
  });
}

function draftReasonFor(code) {
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

function clearDraftPausedToast() {
  var el = draftPausedToast;
  draftPausedToast = null;
  if (!el) return;
  if (typeof el.dismiss === "function") el.dismiss();
  else if (el.parentNode) el.parentNode.removeChild(el);
}

function showDraftPaused(code) {
  var reason = draftReasonFor(code);
  if (draftPausedReason === reason) return;
  clearDraftPausedToast();
  draftPausedReason = reason;
  draftPausedToast = showToast("Crash recovery is paused — " + draftPausedReason, "warn", true);
}

function noteDraftWriteRefused(code) {
  draftStats.lastCode = code;
  if (code !== "HELD") draftStats.failures++;

  if (code === "DISCARDED" || code === "NO_TAB") { draftStopped = true; return; }
  if (code === "UNAVAILABLE" && !runningOnDesktop()) { browserDraftsOff = true; draftSchedule.dropPending(); return; }

  if (code !== "STALE_SEQ") showDraftPaused(code);

  draftSchedule.refused();
}

function flushDraftNow(opts) {
  if (!draftWriterLive()) return Promise.resolve({ ok: true });
  var keepClean = !!(opts && opts.keep === true);
  draftSchedule.cancel();
  draftSchedule.cancelRetry();
  return Promise.resolve(draftInFlight).then(function () {
    return captureAndSendDraft(keepClean);
  }).then(function (r) {
    return r || { ok: true };
  }, function (err) {
    reportError(err);
    return { ok: false, code: "EIO" };
  });
}

function draftParse(json) {
  if (typeof json !== "string") return null;
  try { return JSON.parse(json); } catch (e) { return null; }
}

function draftMigrate(json) {
  var raw = draftParse(json);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rows)) return null;
  return migrateRows(raw);
}

function draftStableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) {
    var items = v.map(function (x) { return draftStableJson(x); });
    return "[" + items.join(",") + "]";
  }
  var keys = Object.keys(v).sort();
  var parts = keys.map(function (k) {
    return JSON.stringify(k) + ":" + draftStableJson(v[k]);
  });
  return "{" + parts.join(",") + "}";
}

function sameDocContent(a, b) {
  if (!a || !b) return false;
  function normalized(s) {
    var c = migrateRows(cloneState(s));
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

function draftAgeText(ageMs) {
  if (typeof ageMs !== "number" || !isFinite(ageMs) || ageMs < 0) return "";
  var mins = Math.round(ageMs / 60000);
  if (mins < 1) return "from a moment ago";
  if (mins < 60) return "from " + mins + " minute" + (mins === 1 ? "" : "s") + " ago";
  var hours = Math.round(mins / 60);
  if (hours < 24) return "from " + hours + " hour" + (hours === 1 ? "" : "s") + " ago";
  var days = Math.round(hours / 24);
  return "from " + days + " day" + (days === 1 ? "" : "s") + " ago";
}

function draftWhenText(t) {
  var age = draftAgeText(t && t.ageMs);
  var why = "";
  if (t && t.previousSession === "running") why = "before Splitpage closed unexpectedly";
  else if (t && t.previousSession === "session-end") why = "before Windows signed you out";
  else if (t && t.previousSession === "clean-exit") why = "before Splitpage closed";
  if (age && why) return age + ", " + why;
  return age || why;
}

function draftTitleOf(s, fallback) {
  return (s && s.title) || fallback || "this script";
}

function recoverDraftAsUnsavedCopy(t, reasonText, mine) {
  if (!t || !t.header) return false;
  mine = mine || draftMigrate(t.stateJson);
  if (!mine) return false;
  var origin = t.header.origin || {};
  var wasUntitled = origin.kind === "untitled";

  resetProductionPanelState();
  var arrived = documentTransitions().recover({
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

function restoreServerDraft(t, mine) {
  recoverDraftAsUnsavedCopy(t,
    "Your unsaved changes to “" + draftTitleOf(mine) + "” were recovered. It was a document on a " +
    "Splitpage server, which this version no longer opens, so they are open here as an unsaved copy. " +
    "Save them wherever you want them.", mine);
  return "untitled-copy";
}

function keptForNextLaunch() {
  showToast("Another script was opened while the changes from the last session were being restored — " +
    "they have been kept for the next launch.", "warn", true);
  return "kept";
}

async function restoreFileDraft(t, mine, base, origin, ctx) {
  var title = draftTitleOf(mine, origin.fileName);
  var missingName = origin.fileName || title;

  if (!t.file) {
    var gone = t.fileProblem === "unreadable"
      ? "couldn't be read"
      : "isn't where it was";
    recoverDraftAsUnsavedCopy(t,
      "The file these recovered changes belong to (" + missingName + ") " + gone +
      " — they are open here as an unsaved copy.", mine);
    return t.fileProblem === "unreadable" ? "unreadable" : "untitled-copy";
  }

  var handle = makeDesktopHandle(t.file);
  var file;
  try { file = await handle.getFile(); } catch (e) { file = null; }
  var parsed = file ? await parseProjectFileState(file) : null;
  if (!stillRestoring(ctx)) return keptForNextLaunch();
  if (!parsed || parsed.error) {
    recoverDraftAsUnsavedCopy(t,
      "The file these recovered changes belong to (" + missingName + ") could not be read — they " +
      "are open here as an unsaved copy.", mine);
    return "unreadable";
  }

  var disk = parsed.state;
  var refId = normalizeDocId((base && base.docId) || mine.docId);
  if (parsed.docIdEmbedded && refId && normalizeDocId(disk.docId) !== refId) {
    recoverDraftAsUnsavedCopy(t,
      "A different script has been saved as " + missingName + " — the changes recovered from the " +
      "last session are open here as an unsaved copy.", mine);
    return "untitled-copy";
  }
  if (refId) disk.docId = refId;

  openDocument({ kind: "file", file: file, handle: handle, parsed: { state: disk, kind: parsed.kind }, options: { skipSnapshot: true, silent: true } });
  var diskCopy = cloneState(disk);

  if (sameDocContent(mine, disk)) {
    documentLocation().markWrittenOut(!!t.header.docIdWrittenOut);
    showToast("Opened " + (disk.title || file.name) + " — the changes from the last session were already saved", "ok");
    return "nothing-unsaved";
  }

  if (sameDocContent(base, disk)) {
    documentTransitions().restore({ from: { document: mine } });
    documentLocation().markWrittenOut(!!t.header.docIdWrittenOut);
    noteAbsorbedDirty("recovery");
    showToast("Restored your unsaved changes to " + (currentDocument().title || file.name) +
      (draftWhenText(t) ? " " + draftWhenText(t) : ""), "ok", true);
    return "applied";
  }

  var merged = await applyStashedWork(disk, { base: base, mine: mine }, {
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

function adoptUntitledDraft(t, mine, base) {
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

async function runDraftRestore(t) {
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
  if (!t.header || typeof t.stateJson !== "string") return "failed";

  var mine = draftMigrate(t.stateJson);
  if (!mine) {
    showToast("The changes recovered from the last session couldn't be read — they have been kept " +
      "for the next launch.", "warn", true);
    return "failed";
  }
  var base = t.baseJson ? draftMigrate(t.baseJson) : null;
  var origin = t.header.origin || { kind: "untitled" };
  var ctx = captureRestore();

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

function takenFromBrowserDraft(rec, key) {
  var at = Number(rec.writtenAt) || 0;
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

function browserDraftRestoreDone(t, outcome) {
  if (outcome !== "untitled-copy") return;
  var key = t.browserKey;
  var server = t.header.origin.server;
  browserCopyOf = currentHome().kind === "none" && currentDocument()
    ? { key: key, docId: currentDocument().docId, server: { base: server.base, docId: server.docId, rev: server.rev } }
    : null;
  draftOnDisk = true;
  browserDrafts().writer.take(key);
}

function newestLeftoverBrowserDraft() {
  var store = browserDraftStore();
  return store.list().then(function (metas) {
    var newest = metas.slice().sort(function (a, b) { return b.writtenAt - a.writtenAt; });
    return (function next(i) {
      if (i >= newest.length) return null;
      return browserWriterIsLive(newest[i].writerId).then(function (live) {
        return live ? next(i + 1) : newest[i];
      });
    })(0);
  }).then(function (pick) {
    return pick ? store.get(pick.key) : null;
  }).then(function (rec) {
    return rec ? takenFromBrowserDraft(rec, rec.key) : null;
  }, function () { return null; });
}

function draftTaker() {
  if (!runningOnDesktop()) return browserDraftsOff ? null : newestLeftoverBrowserDraft;
  var take = desktopDrafts().taker();
  if (!(take && draftResume().restorePending())) return null;
  return take;
}

async function applyTakenDraft(t) {
  var resume = draftResume();
  var outcome;
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
  if (!runningOnDesktop() && t && t.browserKey) browserDraftRestoreDone(t, outcome);
  if (typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  noteDraftChange();
  return outcome;
}

export function startDrafts(given) {
  ports = given;
  var mounted = given;
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
          pending: draftSchedule.pending(),
          onDisk: draftOnDisk,
          stopped: draftStopped,
          slow: draftSchedule.slow(),
          restorePending: draftResume().restorePending()
        };
      },
      setTiming: function (t) {
        if (!t) return;
        for (var k in t) {
          if (Object.prototype.hasOwnProperty.call(t, k) &&
              Object.prototype.hasOwnProperty.call(draftTiming, k)) draftTiming[k] = t[k];
        }
      },
      restorePending: function () { return draftResume().restorePending(); },
      applyForTest: function (taken) {
        draftResume().setRestorePending(true);
        return applyTakenDraft(taken);
      },
      noteChange: function () { noteDraftChange(); },
      sameDocContent: sameDocContent,
      browser: {
        list: function () { return browserDraftStore().list(); },
        get: function (docId, serverUrl) {
          var base = draftBaseOf(serverUrl === undefined ? "" : serverUrl);
          return browserDraftStore().get(browserDraftKey(base, docId));
        },
        all: function () {
          var store = browserDraftStore();
          return store.list().then(function (metas) {
            return Promise.all(metas.map(function (m) { return store.get(m.key); }));
          });
        },
        writerId: function () { return ports.lock.writerId(); },
        status: function () {
          var target = browserDraftTarget();
          return { off: browserDraftsOff, keyOnDisk: browserKeyOnDisk(), copy: !!browserCopyOf,
                   target: target ? { docId: target.docId, copy: target.copy } : null };
        },
        useIndexedDB: function (factory) {
          useBrowserDraftFactory(factory);
          browserDraftsOff = false;
        }
      }
    },
    dispose: function () {
      if (ports !== mounted) return;
      draftSchedule.cancel();
      draftSchedule.cancelRetry();
      ports = null;
    }
  };
}
