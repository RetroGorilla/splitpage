import { S } from "./_state.js";
import { conn, fileHome, home, importHome, setHome, stillOnServer } from "./_home.js";
import { migrateRows } from "./02-state.js";
import { inlineStateJson, persist } from "./02c-blobs.js";
import { refsIn } from "../../shared/blob-policy.js";
import {
  copyDocHistorySafe,
  mintDocId,
  normalizeDocId,
  syncDocIdentity
} from "./02b-doc-id.js";
import { cloneState, setBaseState, updateIdentityChip } from "./03-sync.js";
import { renderAbsorbed } from "./05-render.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import { markAbsorbedDirty, showToast } from "./12-dirty-toast.js";
import { onServerDoc, reviewMode } from "./13-hosted.js";
import { DRAFT_LIMITS, browserDraftKey, draftBaseOf } from "../adapters/storage/draft-store-idb.ts";
import { browserDrafts, desktopDrafts, recoveryStarted, useBrowserDraftFactory } from "../legacy/recovery-bridge.ts";
import { applyStashedWork } from "./14-export.js";
import {
  adoptProjectState,
  parseProjectFileState,
  updateFileChip
} from "./18-local-files.js";
import { makeDesktopHandle, notifyDesktopDocumentState } from "./20f-desktop.js";
import { SCHEMA_VERSION } from "../core/document/fields.ts";

export var draftRestorePending;
var draftOnDisk;

var draftTiming = {
  idle: 1500,
  max: 5000,
  slow: 15000,
  largeBytes: 8 * 1024 * 1024,
  slowStringifyMs: 50,
  backoffMin: 5000,
  backoffMax: 60000,
  serverWait: 20000
};

var draftSeq = 0;
var draftIdleTimer = null;
var draftMaxTimer = null;
var draftBackoffTimer = null;
var draftInFlight = null;
var draftChangePending = false;
var draftSlow = false;
var draftStopped = false;
var draftBackoffMs = 0;
var draftPausedReason = "";
var draftPausedToast = null;
var draftSentEditSeq = -1;
var draftSentBase = {};
var draftSentSignature = "";
var draftStats = { writes: 0, failures: 0, discards: 0, obsolete: 0, lastCode: null };

var draftPendingFor = null;
var draftServerSettle = null;

var browserWriterId = (function () {
  var bytes = new Uint8Array(16);
  try { crypto.getRandomValues(bytes); } catch (e) {
    for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.prototype.map.call(bytes, function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
})();
var BROWSER_DRAFT_LOCK = "splitpage-draft-writer-";
var browserDraftsOff = false;
var browserCopyOf = null;

export function draftRecoveryPorts() {
  var factory;
  try { factory = window.indexedDB || null; } catch (e) { factory = null; }
  return {
    indexedDB: factory,
    limits: DRAFT_LIMITS,
    now: function () { return Date.now(); },
    writerId: browserWriterId,
    desktop: function () { return S.DESKTOP; }
  };
}

function browserDraftStore() {
  return browserDrafts().store;
}

function browserKeyOnDisk() {
  return recoveryStarted() ? browserDrafts().writer.tracked() : null;
}

function browserDraftTarget() {
  if (S.DESKTOP || browserDraftsOff) return null;
  if (onServerDoc()) {
    if (reviewMode()) return null;
    return { base: (home.conn && home.conn.serverUrl) || "", docId: String(home.id), rev: home.rev || 0, copy: false };
  }
  if (browserCopyOf && home.kind === "none" && S.state && S.state.docId === browserCopyOf.docId) {
    return { base: browserCopyOf.server.base, docId: browserCopyOf.server.docId, rev: browserCopyOf.server.rev, copy: true };
  }
  browserCopyOf = null;
  return null;
}

function browserDraftCapture(server) {
  var base = server ? draftBaseOf(server.base, location.href) : "";
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
  if (S.DESKTOP) return desktopDrafts().write(payload);
  return browserWriteDraft(payload, captured);
}

function draftBackendCanDiscard() {
  if (S.DESKTOP) return desktopDrafts().canDiscard();
  return !!browserKeyOnDisk();
}

function draftBackendDiscard(seq) {
  if (S.DESKTOP) return desktopDrafts().discard(seq);
  return browserDiscardDraft();
}

function draftWriterLive() {
  if (draftStopped) return false;
  if (S.DESKTOP) return typeof S.DESKTOP.writeDraft === "function";
  return !browserDraftsOff && (!!browserKeyOnDisk() || !!browserDraftTarget());
}

var browserLockRelease = null;
var browserLockWanted = false;

function holdBrowserWriterLock() {
  if (S.DESKTOP || browserLockWanted) return;
  browserLockWanted = true;
  try {
    if (!navigator.locks || typeof navigator.locks.request !== "function") return;
    navigator.locks.request(BROWSER_DRAFT_LOCK + browserWriterId, function () {
      if (!browserLockWanted) return null;
      return new Promise(function (resolve) { browserLockRelease = resolve; });
    }).then(null, function () {});
  } catch (e) {}
}

function releaseBrowserWriterLock() {
  browserLockWanted = false;
  var release = browserLockRelease;
  browserLockRelease = null;
  if (release) release();
}

function browserWriterIsLive(writerId) {
  if (!writerId) return Promise.resolve(false);
  if (writerId === browserWriterId) return Promise.resolve(true);
  try {
    if (!navigator.locks || typeof navigator.locks.query !== "function") return Promise.resolve(false);
    return navigator.locks.query().then(function (s) {
      return ((s && s.held) || []).some(function (l) { return l && l.name === BROWSER_DRAFT_LOCK + writerId; });
    }, function () { return false; });
  } catch (e) { return Promise.resolve(false); }
}

export function noteDraftChange() {
  if (!draftWriterLive()) return;
  draftChangePending = true;
  if (draftBackoffTimer) return;
  scheduleDraftCapture();
}

function scheduleDraftCapture() {
  var idle = draftSlow ? draftTiming.slow : draftTiming.idle;
  var max = draftSlow ? draftTiming.slow : draftTiming.max;
  if (draftIdleTimer) clearTimeout(draftIdleTimer);
  draftIdleTimer = setTimeout(runDraftTimer, idle);
  if (!draftMaxTimer) draftMaxTimer = setTimeout(runDraftTimer, max);
}

function clearDraftTimers() {
  if (draftIdleTimer) { clearTimeout(draftIdleTimer); draftIdleTimer = null; }
  if (draftMaxTimer) { clearTimeout(draftMaxTimer); draftMaxTimer = null; }
}

function runDraftTimer() {
  clearDraftTimers();
  captureAndSendDraft();
}

function draftOriginOf() {
  var origin = {
    kind: "untitled", fileId: null, fileKind: null, importName: null,
    baseLastModified: null, baseSize: null, server: null
  };
  if (!S.DESKTOP) {
    var target = browserDraftTarget();
    if (target) {
      origin.kind = "server";
      origin.server = { base: target.base, docId: target.docId, rev: target.rev, copy: target.copy };
    }
    return origin;
  }
  if (onServerDoc()) {
    origin.kind = "server";
    origin.server = { base: home.conn.serverUrl || "", docId: home.id, rev: home.rev || 0 };
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
    (S.state && S.state.docId) || "", S.docIdWrittenOut ? "1" : "0"
  ].join("|");
}

function captureAndSendDraft(keepClean) {
  clearDraftTimers();
  if (!draftWriterLive() || !S.state) return Promise.resolve(null);
  if (draftRestorePending) { draftChangePending = true; return Promise.resolve(null); }
  if (draftInFlight) { draftChangePending = true; return draftInFlight; }

  var keepCleanFile = !S.dirty && keepClean === true && !!S.DESKTOP && draftOriginOf().kind === "file";
  if (!S.dirty && !keepCleanFile) {
    draftChangePending = false;
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
  if (!S.DESKTOP && origin.kind !== "server") {
    draftChangePending = false;
    return Promise.resolve(null);
  }
  var signature = draftOriginSignature(origin);
  if ((draftOnDisk || !keepCleanFile) &&
      S.editSeq === draftSentEditSeq && draftSentBase === S.baseState && signature === draftSentSignature) {
    draftChangePending = false;
    return Promise.resolve(null);
  }

  var startedAt = Date.now();
  var stateJson;
  try {
    stateJson = JSON.stringify(S.state);
  } catch (e) {
    draftStopped = true;
    showDraftPaused("TOO_LARGE");
    return Promise.resolve({ ok: false, code: "TOO_LARGE" });
  }
  var elapsed = Date.now() - startedAt;
  draftSlow = stateJson.length > draftTiming.largeBytes || elapsed > draftTiming.slowStringifyMs;

  var editSeqAtCapture = S.editSeq;
  var baseAtCapture = S.baseState;
  var sendBase = S.baseState !== draftSentBase;
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
    title: (S.state.title || ""),
    docId: normalizeDocId(S.state.docId) || null,
    docIdWrittenOut: !!S.docIdWrittenOut,
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

  var captured = S.DESKTOP ? null : browserDraftCapture(origin.server);

  var draftRefs = refsIn(S.state);
  if (sendBase && baseAtCapture) {
    refsIn(baseAtCapture).forEach(function (sha) { if (draftRefs.indexOf(sha) === -1) draftRefs.push(sha); });
  }

  draftChangePending = false;
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
        draftChangePending = true;
      } else {
        draftOnDisk = true;
        draftSentEditSeq = editSeqAtCapture;
        draftSentBase = baseAtCapture;
        draftSentSignature = signature;
      }
      draftBackoffMs = 0;
      if (draftPausedReason) {
        draftPausedReason = "";
        clearDraftPausedToast();
        showToast("Crash recovery is working again", "ok");
      }
    } else {
      noteDraftWriteRefused((r && r.code) || "error");
    }
    if (draftChangePending && !draftBackoffTimer) scheduleDraftCapture();
    return r;
  }, function (err) {
    draftInFlight = null;
    if (window.console && window.console.error) window.console.error(err);
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
  if (code === "UNAVAILABLE" && !S.DESKTOP) { browserDraftsOff = true; draftChangePending = false; return; }

  if (code !== "STALE_SEQ") showDraftPaused(code);

  draftChangePending = true;
  draftBackoffMs = draftBackoffMs
    ? Math.min(draftBackoffMs * 2, draftTiming.backoffMax)
    : draftTiming.backoffMin;
  if (draftBackoffTimer) clearTimeout(draftBackoffTimer);
  draftBackoffTimer = setTimeout(function () {
    draftBackoffTimer = null;
    captureAndSendDraft();
  }, draftBackoffMs);
}

export function flushDraftNow(opts) {
  if (!draftWriterLive()) return Promise.resolve({ ok: true });
  var keepClean = !!(opts && opts.keep === true);
  clearDraftTimers();
  if (draftBackoffTimer) { clearTimeout(draftBackoffTimer); draftBackoffTimer = null; }
  return Promise.resolve(draftInFlight).then(function () {
    return captureAndSendDraft(keepClean);
  }).then(function (r) {
    return r || { ok: true };
  }, function (err) {
    if (window.console && window.console.error) window.console.error(err);
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

function hideDraftPendingBanner() {
  var banner = document.getElementById("draft-pending-banner");
  if (banner) banner.hidden = true;
  draftPendingFor = null;
}

function showDraftPendingBanner(t, title) {
  var banner = document.getElementById("draft-pending-banner");
  var text = document.getElementById("draft-pending-text");
  var btn = document.getElementById("draft-pending-copy");
  if (!banner || !text) return;
  draftPendingFor = t;
  text.textContent = "Recovered changes to “" + title + "” are waiting for the server";
  banner.hidden = false;
  if (btn && !btn._draftWired) {
    btn._draftWired = true;
    btn.addEventListener("click", function () {
      var waiting = draftPendingFor;
      if (!waiting) { hideDraftPendingBanner(); return; }
      S.draftServerResume = null;
      hideDraftPendingBanner();
      recoverDraftAsUnsavedCopy(waiting,
        "These recovered changes are open here as an unsaved copy — the server document they came " +
        "from was not reached. Save them wherever you want them.");
      if (draftServerSettle) draftServerSettle.settle("server-copy");
    });
  }
}

function recoverDraftAsUnsavedCopy(t, reasonText, mine) {
  if (!t || !t.header) return false;
  mine = mine || draftMigrate(t.stateJson);
  if (!mine) return false;
  var origin = t.header.origin || {};
  var wasUntitled = origin.kind === "untitled";

  if (!wasUntitled) {
    var fromId = normalizeDocId(mine.docId);
    var newId = mintDocId();
    mine.docId = newId;
    copyDocHistorySafe(fromId, newId);
  }

  S.state = mine;
  setBaseState(null, "recoverDraftAsUnsavedCopy: a copy with no home has no ancestor");
  setHome("none");
  resetProductionPanelState();
  S.docIdWrittenOut = wasUntitled ? !!t.header.docIdWrittenOut : false;
  renderAbsorbed();
  updateIdentityChip();
  updateFileChip();
  syncDocIdentity();
  markAbsorbedDirty("recovery");
  showToast(reasonText, "warn", true);
  return true;
}

export function armServerDraftResume(t) {
  if (!t || !t.header) return;
  var origin = t.header.origin;
  if (!origin || origin.kind !== "server" || !origin.server || !origin.server.docId) return;
  var mine = draftMigrate(t.stateJson);
  if (!mine) return;
  var base = t.baseJson ? draftMigrate(t.baseJson) : null;

  var settled = false;
  var resolveSettle = null;
  var promise = new Promise(function (resolve) { resolveSettle = resolve; });
  draftServerSettle = {
    promise: promise,
    settle: function (outcome) {
      if (settled) return;
      settled = true;
      resolveSettle(outcome);
    }
  };
  S.draftServerResume = {
    id: String(origin.server.docId),
    rev: origin.server.rev || 0,
    base: base,
    mine: mine,
    at: t.header.writtenAt || 0,
    onDone: function (outcome) { draftServerSettle.settle(outcome); }
  };
}

function draftNormalizeBase(v) {
  var s = String(v == null ? "" : v).trim();
  if (!s) return "";
  try {
    var u = new URL(s, location.href);
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch (e) { return s.replace(/\/+$/, ""); }
}

function draftWaitForServerDetect() {
  var deadline = Date.now() + draftTiming.serverWait;
  return new Promise(function (resolve) {
    (function tick() {
      if (S.serverMode.checked || Date.now() > deadline) { resolve(); return; }
      setTimeout(tick, 50);
    })();
  });
}

function draftRaceTimeout(promise, ms) {
  if (ms <= 0) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
    promise.then(function (v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    });
  });
}

async function restoreServerDraft(t, mine, origin) {
  var server = origin.server || {};
  var title = draftTitleOf(mine, server.docId);
  await draftWaitForServerDetect();

  var headerBase = draftNormalizeBase(server.base);
  if (headerBase && headerBase !== draftNormalizeBase(conn.serverUrl)) {
    S.draftServerResume = null;
    if (draftServerSettle) draftServerSettle.settle("server-copy");
    recoverDraftAsUnsavedCopy(t,
      "These recovered changes came from a document on another server — they are open here as an " +
      "unsaved copy. Save them wherever you want them.", mine);
    return "server-copy";
  }

  if (S.serverMode.checked && !S.serverMode.available) {
    S.draftServerResume = null;
    if (draftServerSettle) draftServerSettle.settle("server-copy");
    recoverDraftAsUnsavedCopy(t,
      "These recovered changes belong to “" + title + "” on a server this copy can't reach — they " +
      "are open here as an unsaved copy.", mine);
    return "server-copy";
  }

  if (!draftServerSettle) armServerDraftResume(t);
  if (!draftServerSettle) {
    recoverDraftAsUnsavedCopy(t,
      "The changes recovered from the last session are open here as an unsaved copy — the server " +
      "document they came from could not be identified.", mine);
    return "server-copy";
  }

  var waitMs = (S.serverMode.authRequired && !conn.token) ? 0 : draftTiming.serverWait;
  var outcome = await draftRaceTimeout(draftServerSettle.promise, waitMs);
  if (outcome === null) {
    showDraftPendingBanner(t, title);
    outcome = await draftServerSettle.promise;
  }

  hideDraftPendingBanner();
  if (outcome === "server-resumed") return "server-resumed";
  if (outcome === "server-copy") return "server-copy";
  S.draftServerResume = null;
  recoverDraftAsUnsavedCopy(t,
    "“" + title + "” is no longer on the server — the changes recovered from the last session are " +
    "open here as an unsaved copy.", mine);
  return "server-copy";
}

async function restoreFileDraft(t, mine, base, origin) {
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

  adoptProjectState(disk, file, handle, parsed.kind, { skipSnapshot: true, silent: true });
  var diskCopy = cloneState(disk);

  if (sameDocContent(mine, disk)) {
    S.docIdWrittenOut = !!t.header.docIdWrittenOut;
    showToast("Opened " + (disk.title || file.name) + " — the changes from the last session were already saved", "ok");
    return "nothing-unsaved";
  }

  if (sameDocContent(base, disk)) {
    S.state = mine;
    setBaseState(diskCopy, "restoreFileDraft: the file, untouched since the draft's own base");
    renderAbsorbed();
    updateIdentityChip();
    updateFileChip();
    S.docIdWrittenOut = !!t.header.docIdWrittenOut;
    markAbsorbedDirty("recovery");
    showToast("Restored your unsaved changes to " + (S.state.title || file.name) +
      (draftWhenText(t) ? " " + draftWhenText(t) : ""), "ok", true);
    return "applied";
  }

  await applyStashedWork(disk, { base: base, mine: mine }, {
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
  S.docIdWrittenOut = !!t.header.docIdWrittenOut;
  return "merged";
}

function adoptUntitledDraft(t, mine, base) {
  S.state = mine;
  setBaseState(base || null, "adoptUntitledDraft: the draft's own base, if it had one");
  setHome("none");
  resetProductionPanelState();
  S.docIdWrittenOut = !!t.header.docIdWrittenOut;
  renderAbsorbed();
  updateIdentityChip();
  updateFileChip();
  syncDocIdentity();
  markAbsorbedDirty("recovery");
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

  if (origin.kind === "server") return await restoreServerDraft(t, mine, origin);
  if (origin.kind === "file") return await restoreFileDraft(t, mine, base, origin);
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
      origin: { kind: "server", server: { base: conn.serverUrl || "", docId: String(rec.docId), rev: rec.rev || 0 } },
      writtenAt: at,
      title: rec.title || "",
      docIdWrittenOut: !!rec.docIdWrittenOut
    },
    stateJson: rec.stateJson,
    baseJson: rec.baseJson,
    ageMs: at ? Math.max(0, Date.now() - at) : undefined,
    browserKey: key
  };
}

function browserDraftRestoreDone(t, outcome) {
  if (outcome !== "server-resumed" && outcome !== "server-copy") return;
  var key = t.browserKey;
  if (outcome === "server-copy") {
    var server = t.header.origin.server;
    browserCopyOf = home.kind === "none" && S.state
      ? { key: key, docId: S.state.docId, server: { base: server.base, docId: server.docId, rev: server.rev } }
      : null;
  }
  draftOnDisk = true;
  browserDrafts().writer.take(key);
}

export function armBrowserServerDraft(docId) {
  if (S.DESKTOP || browserDraftsOff || !docId || draftRestorePending || S.draftServerResume) return Promise.resolve(false);
  if (conn.role === "review") return Promise.resolve(false);
  var base = draftBaseOf(conn.serverUrl, location.href);
  if (!base) return Promise.resolve(false);
  var key = browserDraftKey(base, docId);
  var via = conn;
  return browserDraftStore().get(key).then(function (rec) {
    if (!rec) return false;
    return browserWriterIsLive(rec.writerId).then(function (live) {
      if (live || !stillOnServer(via) || draftRestorePending || S.draftServerResume) return false;
      var t = takenFromBrowserDraft(rec, key);
      armServerDraftResume(t);
      if (!S.draftServerResume) return false;
      draftRestorePending = true;
      applyTakenDraft(t);
      return true;
    });
  }).then(null, function () { return false; });
}

export function offerBrowserDraftAfterLinkOff(docId) {
  if (S.DESKTOP || browserDraftsOff || draftRestorePending || onServerDoc() || S.dirty) return Promise.resolve(false);
  var base = draftBaseOf(conn.serverUrl, location.href);
  if (!base) return Promise.resolve(false);
  var store = browserDraftStore();
  return store.list().then(function (metas) {
    var here = metas.filter(function (m) { return m.base === base; })
      .sort(function (a, b) { return b.writtenAt - a.writtenAt; });
    if (docId) {
      here = here.filter(function (m) { return m.docId === String(docId); })
        .concat(here.filter(function (m) { return m.docId !== String(docId); }));
    }
    return (function next(i) {
      if (i >= here.length) return null;
      return browserWriterIsLive(here[i].writerId).then(function (live) {
        return live ? next(i + 1) : here[i];
      });
    })(0);
  }).then(function (pick) {
    return pick ? store.get(pick.key) : null;
  }).then(function (rec) {
    if (!rec || onServerDoc() || S.dirty || draftRestorePending) return false;
    var mine = draftMigrate(rec.stateJson);
    if (!mine) return false;
    var t = takenFromBrowserDraft(rec, rec.key);
    var when = draftWhenText(t);
    var ok = recoverDraftAsUnsavedCopy(t,
      "Your unsaved changes to “" + draftTitleOf(mine, rec.docId) + "” were kept in this browser" +
      (when ? " " + when : "") + " — they are open here as an unsaved copy. Save a copy… to keep them.", mine);
    if (ok) browserDraftRestoreDone(t, "server-copy");
    noteDraftChange();
    return ok;
  }).then(null, function () { return false; });
}

export async function applyTakenDraft(t) {
  var outcome;
  try {
    outcome = await runDraftRestore(t);
  } catch (e) {
    if (window.console && window.console.error) window.console.error(e);
    outcome = "failed";
    showToast("Could not restore the changes from the last session — they have been kept for the " +
      "next launch.", "warn", true);
  }
  draftRestorePending = false;
  if (S.DESKTOP && typeof S.DESKTOP.draftRestoreDone === "function") {
    try { S.DESKTOP.draftRestoreDone(outcome); } catch (e2) {}
  }
  if (!S.DESKTOP && t && t.browserKey) browserDraftRestoreDone(t, outcome);
  if (typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  noteDraftChange();
  return outcome;
}

export function __init() {
  draftRestorePending = !!(S.DESKTOP && S.DESKTOP.hasDraftToRestore);

  draftOnDisk = !!(S.DESKTOP && S.DESKTOP.hasDraftToRestore);

  window.addEventListener("blur", function () { flushDraftNow(); });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushDraftNow();
  });
  window.addEventListener("pagehide", function () {
    flushDraftNow();
    releaseBrowserWriterLock();
  });
  window.addEventListener("pageshow", function (e) {
    if (e && e.persisted) holdBrowserWriterLock();
  });
  holdBrowserWriterLock();

  if (window.__desktopTest) {
    window.__desktopTest.drafts = {
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
          pending: draftChangePending,
          onDisk: draftOnDisk,
          stopped: draftStopped,
          slow: draftSlow,
          restorePending: draftRestorePending
        };
      },
      setTiming: function (t) {
        if (!t) return;
        for (var k in t) {
          if (Object.prototype.hasOwnProperty.call(t, k) &&
              Object.prototype.hasOwnProperty.call(draftTiming, k)) draftTiming[k] = t[k];
        }
      },
      restorePending: function () { return draftRestorePending; },
      applyForTest: function (taken) {
        draftRestorePending = true;
        armServerDraftResume(taken);
        return applyTakenDraft(taken);
      },
      noteChange: function () { noteDraftChange(); },
      sameDocContent: sameDocContent,
      browser: {
        list: function () { return browserDraftStore().list(); },
        get: function (docId, serverUrl) {
          var base = draftBaseOf(serverUrl === undefined ? conn.serverUrl : serverUrl, location.href);
          return browserDraftStore().get(browserDraftKey(base, docId));
        },
        all: function () {
          var store = browserDraftStore();
          return store.list().then(function (metas) {
            return Promise.all(metas.map(function (m) { return store.get(m.key); }));
          });
        },
        writerId: function () { return browserWriterId; },
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
    };
  }
}
