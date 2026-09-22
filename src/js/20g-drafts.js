import { S } from "./_state.js";
import { conn, fileHome, home, importHome, setHome } from "./_home.js";
import { SCHEMA_VERSION } from "./00-prelude.js";
import { migrateRows } from "./02-state.js";
import {
  copyDocHistorySafe,
  mintDocId,
  normalizeDocId,
  noteMergedDocId,
  syncDocIdentity
} from "./02b-doc-id.js";
import { cloneState, pushSnapshot, reportMerge, updateIdentityChip } from "./03-sync.js";
import { render } from "./05-render.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { onServerDoc } from "./13-hosted.js";
import { applyStashedWork } from "./14-export.js";
import {
  adoptProjectState,
  parseProjectFileState,
  updateFileChip
} from "./18-local-files.js";
import { makeDesktopHandle, notifyDesktopDocumentState } from "./20f-desktop.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
export var draftRestorePending;
var draftOnDisk;

/* ================= crash-safe drafts (desktop only) =================

   Everything typed since the last save lives in one place: this page. Close
   it the ordinary way and the app asks first; lose it to a crash, a kill, a
   power cut or a Windows sign-out and there is nothing to ask. So a copy of
   the document goes to disk behind the typing — never to the user's own
   file (invariant #41: Splitpage does not write that by itself) but to the
   tab's own folder under the app's data directory, written by the main
   process with fsync and two generations (desktop/drafts.js).

   Two halves:

   THE WRITER. noteDraftChange() is called from the one save-state funnel
   (12-dirty-toast.js) on every edit. It only moves a timer. When the timer
   fires, the document is stringified once and sent over IPC with a header
   of scalars — the main process builds the real header, including any file
   path, from its own records (invariant #34: no path ever leaves this
   page). A clean document has nothing to protect, so it asks for its draft
   to be deleted instead; that, and an explicit user decision, are the only
   two things that ever delete one (invariant #40).

   THE RESTORE. At launch main tells the tab whether it is holding a draft
   (TAB-BOOT-SYNC). If it is, this page boots without the usual server
   detect, takes the draft back, and works out what to do with it by
   comparing it against what is on disk or on the server NOW — by content,
   never by timestamp, because sync clients rewrite timestamps as they
   please. The possible answers are the outcomes of applyTakenDraft():
   'applied' (the file is untouched, the edits go back on top), 'merged'
   (the file moved on, three-way merge, no save), 'nothing-unsaved' (it was
   already saved after all), 'untitled-copy' / 'server-copy' (the home is
   gone, so the work opens as an unsaved copy with its own identity),
   'server-resumed', 'unreadable', or 'failed' — the one outcome that makes
   main KEEP the draft, so an unrestorable draft is never thrown away.

   The whole file is inert in the browser build: every entry point returns
   at once when DESKTOP is null, and nothing outside this file calls one
   without that gate. */

/* DRAFT-IPC-AND-SHAPES, "Renderer timing". Quiet enough that typing never
   waits on the disk, short enough that a crash costs seconds of work. The
   slow figure takes over for a document big enough that writing it every
   five seconds would be the loudest thing the app does. */
var draftTiming = {
  idle: 1500,
  max: 5000,
  slow: 15000,
  largeBytes: 8 * 1024 * 1024,
  slowStringifyMs: 50,
  backoffMin: 5000,
  backoffMax: 60000,
  /* How long a recovered server document waits for its server before the
     page offers to open the work as a local copy instead. */
  serverWait: 20000
};

/* Strictly increasing for the life of this page. The store refuses a write
   whose seq is not above the last one it accepted, which is what keeps a
   write that was already in flight when the user discarded (or when a newer
   page took over the tab) from landing afterwards. */
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
/* The sticky toast currently saying WHY recovery is paused, so it can be
   taken back down. A sticky toast has no timer — only a click removes it —
   so without a handle the warning outlived the condition it reported. */
var draftPausedToast = null;
/* The last capture that the store ACCEPTED: nothing is sent again until one
   of the three actually differs. `baseState` and the origin are in there
   because a Save As, an open or a reconnect changes what the draft is a
   draft OF without necessarily touching editSeq. */
var draftSentEditSeq = -1;
var draftSentBase = {};          /* a sentinel no baseState can equal */
var draftSentSignature = "";
var draftStats = { writes: 0, failures: 0, discards: 0, lastCode: null };

/* Set while a recovered server document is waiting for its server, so the
   banner's button knows which draft it is offering to open as a copy. */
var draftPendingFor = null;
/* {promise, settle} — how the restore learns which way resumeServerDoc()
   went (13-hosted.js). */
var draftServerSettle = null;

function draftWriterLive() {
  return !!(S.DESKTOP && typeof S.DESKTOP.writeDraft === "function" && !draftStopped);
}

/* ---- the writer ---- */

/* O(1) on purpose: it is called from markDirty(), i.e. on every keystroke
   that changes the document. All it does is move two timers. */
export function noteDraftChange() {
  if (!draftWriterLive()) return;
  draftChangePending = true;
  /* Backing off after a refusal: the retry already has an appointment, and
     moving the idle timer would only make it write sooner than the backoff
     says it may. */
  if (draftBackoffTimer) return;
  scheduleDraftCapture();
}

function scheduleDraftCapture() {
  var idle = draftSlow ? draftTiming.slow : draftTiming.idle;
  var max = draftSlow ? draftTiming.slow : draftTiming.max;
  if (draftIdleTimer) clearTimeout(draftIdleTimer);
  draftIdleTimer = setTimeout(runDraftTimer, idle);
  /* The idle timer alone would never fire during continuous typing, which
     is exactly when there is most to lose. The max timer is not reset by
     further edits, so a long stretch of typing still lands regularly. */
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

/* What the draft is a draft OF. Only scalars: the main process turns the
   fileId back into a path from its own registry, and a PIN, a token or a
   path never travels in either direction (invariant #34, #41). */
function draftOriginOf() {
  var origin = {
    kind: "untitled", fileId: null, fileKind: null, importName: null,
    baseLastModified: null, baseSize: null, server: null
  };
  if (onServerDoc()) {
    origin.kind = "server";
    /* The server the document was opened through — this tab's own (#11).
       The address only: draftServerOrigin (main.js) keeps origin+pathname
       and drops anything else, and the token is never offered. */
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
  /* A foreign file opened for round-trip export is not a home the draft can
     be restored INTO — importing it again would redo the lossy conversion —
     so its draft recovers as an unsaved copy, but naming the file it came
     from is the difference between "some recovered work" and "the script I
     was working on this morning". */
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

/* → Promise<WriteResult | {ok:true} | null>. null means "nothing to do". */
function captureAndSendDraft() {
  clearDraftTimers();
  if (!draftWriterLive() || !S.state) return Promise.resolve(null);
  /* The restore owns the tab's draft until it settles: main is holding it,
     so a write now would be refused HELD and would put a "crash recovery is
     paused" toast on screen during the one moment the user is being told
     their work came back. The restore's own finally calls noteDraftChange()
     when it is done. */
  if (draftRestorePending) { draftChangePending = true; return Promise.resolve(null); }
  /* One write at a time. The store serializes per tab anyway; queueing here
     as well means the page never holds two copies of a large document in
     memory at once. */
  if (draftInFlight) { draftChangePending = true; return draftInFlight; }

  if (!S.dirty) {
    draftChangePending = false;
    if (!draftOnDisk || typeof S.DESKTOP.discardDraft !== "function") return Promise.resolve(null);
    /* Saved, so the draft has nothing left to protect — one of the only two
       ways a draft is ever deleted (invariant #40). The seq comes from the
       same counter as the writes, so a write still in flight cannot land
       after it. */
    var discardSeq = ++draftSeq;
    draftOnDisk = false;
    draftStats.discards++;
    return Promise.resolve().then(function () {
      return S.DESKTOP.discardDraft(discardSeq);
    }).then(function (r) {
      if (r && r.ok === false) {
        draftStats.lastCode = r.code || "error";
        /* A refused discard leaves the draft where it is; it is stale, not
           dangerous, and the next save discards it again. */
        draftOnDisk = true;
      }
      return r || null;
    }, function () { draftOnDisk = true; return null; });
  }

  var origin = draftOriginOf();
  var signature = draftOriginSignature(origin);
  if (S.editSeq === draftSentEditSeq && S.baseState === draftSentBase && signature === draftSentSignature) {
    draftChangePending = false;
    return Promise.resolve(null);
  }

  var startedAt = Date.now();
  var stateJson;
  try {
    stateJson = JSON.stringify(S.state);
  } catch (e) {
    /* RangeError — a document of pasted images too big for one string.
       Nothing can be written, and saying so once is more honest than
       retrying every few seconds for the rest of the session. */
    draftStopped = true;
    showDraftPaused("TOO_LARGE");
    return Promise.resolve({ ok: false, code: "TOO_LARGE" });
  }
  var elapsed = Date.now() - startedAt;
  draftSlow = stateJson.length > draftTiming.largeBytes || elapsed > draftTiming.slowStringifyMs;

  /* The ancestor the merge at restore time needs. It changes only on a save
     or an open — never on an edit — so it is stringified and sent only when
     the reference itself is a different object, and otherwise referenced by
     the copy the store already holds. That is the difference between
     writing one document per burst of typing and two. "null" is a real
     answer here (a document that has never been saved has no ancestor) and
     keeps the store from asking for a base it is never going to get. */
  var editSeqAtCapture = S.editSeq;
  var baseAtCapture = S.baseState;
  var sendBase = S.baseState !== draftSentBase;
  var baseTextCache = null;
  function baseTextFor() {
    if (baseTextCache === null) baseTextCache = baseAtCapture ? JSON.stringify(baseAtCapture) : "null";
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

  draftChangePending = false;
  draftInFlight = sendDraftPayload(payload, baseTextFor, false).then(function (r) {
    draftInFlight = null;
    if (r && r.ok) {
      draftStats.writes++;
      draftStats.lastCode = null;
      draftOnDisk = true;
      draftSentEditSeq = editSeqAtCapture;
      draftSentBase = baseAtCapture;
      draftSentSignature = signature;
      draftBackoffMs = 0;
      if (draftPausedReason) {
        draftPausedReason = "";
        /* Take the warning down BEFORE saying it is over: the "working
           again" toast clears itself after 2.6 s, and leaving the sticky
           "paused" one behind made that the last word on screen. */
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
    /* A rejected bridge call is a refusal like any other; anything else
       thrown here is a bug in this file and must be loud rather than
       quietly reported as "the disk said no". */
    if (window.console && window.console.error) window.console.error(err);
    noteDraftWriteRefused("offline");
    return { ok: false, code: "offline" };
  });
  return draftInFlight;
}

function sendDraftPayload(payload, baseTextFor, retriedWithBase) {
  return Promise.resolve().then(function () {
    return S.DESKTOP.writeDraft(payload);
  }).then(function (r) {
    /* The store forgets the base it holds after any failed write, so the
       very next write is told to send it again. That is a handshake, not a
       failure: it does not count, it does not back off, and it does not
       reach the user. */
    if (r && r.ok === false && r.code === "NEED_BASE" && !retriedWithBase) {
      var again = {};
      for (var k in payload) { if (Object.prototype.hasOwnProperty.call(payload, k)) again[k] = payload[k]; }
      again.seq = ++draftSeq;
      again.baseJson = baseTextFor();
      return sendDraftPayload(again, baseTextFor, true);
    }
    return r;
  });
}

/* Why crash recovery stopped, in words that say what is actually wrong.
   Every one of these is a real answer from desktop/drafts.js. */
function draftReasonFor(code) {
  switch (code) {
    /* Not a disk failure at all: this tab's crash work has not been
       restored, so the store is refusing to rotate it off the disk
       (DRAFT-STORE, overrides §2b). Saying "the disk is full" here would be
       a lie, and saying nothing would leave the user believing their typing
       is being protected when it is not. */
    case "HELD": return "the changes recovered from the last session are being kept";
    case "ENOSPC": return "this disk is full";
    case "EACCES":
    case "EPERM": return "this computer would not let Splitpage write it";
    case "EBUSY": return "another program is using the file";
    case "EIO": return "the disk reported an error";
    case "TOO_LARGE": return "this document is too large to copy";
    case "offline": return "the app did not answer";
    default: return "the copy was refused";
  }
}

/* Removes the sticky "paused" toast, if it is still there. Safe to call
   when there is none, and when the user already clicked it away. */
function clearDraftPausedToast() {
  var el = draftPausedToast;
  draftPausedToast = null;
  if (!el) return;
  if (typeof el.dismiss === "function") el.dismiss();
  else if (el.parentNode) el.parentNode.removeChild(el);
}

function showDraftPaused(code) {
  var reason = draftReasonFor(code);
  /* A reason that CHANGED is re-posted, not swallowed: a tab refused
     ENOSPC and later refused HELD kept saying "this disk is full", which is
     exactly the lie draftReasonFor's HELD case exists to avoid. Only an
     unchanged reason is left alone, so a run of refusals does not stack a
     toast per attempt. */
  if (draftPausedReason === reason) return;
  clearDraftPausedToast();
  draftPausedReason = reason;
  draftPausedToast = showToast("Crash recovery is paused — " + draftPausedReason, "warn", true);
}

function noteDraftWriteRefused(code) {
  draftStats.lastCode = code;
  /* HELD is not a failure of the draft store — it is the store doing its
     job — so it is not counted as one, on either side of the IPC. */
  if (code !== "HELD") draftStats.failures++;

  /* Nothing left to write to. DISCARDED means the user chose to throw this
     tab's work away; NO_TAB means there is no slot for it at all. Retrying
     either forever would be noise, and a toast about a discard the user
     just asked for would be worse than noise. */
  if (code === "DISCARDED" || code === "NO_TAB") { draftStopped = true; return; }

  /* A stale seq means a newer page of this tab already wrote. Ours is the
     older copy; it is not an error and there is nothing to tell anyone. */
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

/* → Promise<{ok, code?}>. Answers main's splitpage:draft-flush, which it
   sends before anything that could end this page: a close, a quit, a tab
   moving to another window. Main waits for the answer rather than assuming
   the last timer fired in time. */
export function flushDraftNow() {
  if (!S.DESKTOP) return Promise.resolve({ ok: true });
  clearDraftTimers();
  if (draftBackoffTimer) { clearTimeout(draftBackoffTimer); draftBackoffTimer = null; }
  return Promise.resolve(draftInFlight).then(function () {
    return captureAndSendDraft();
  }).then(function (r) {
    return r || { ok: true };
  }, function (err) {
    if (window.console && window.console.error) window.console.error(err);
    return { ok: false, code: "EIO" };
  });
}

/* ---- the restore ---- */

function draftParse(json) {
  if (typeof json !== "string") return null;
  try { return JSON.parse(json); } catch (e) { return null; }
}

function draftMigrate(json) {
  var raw = draftParse(json);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rows)) return null;
  return migrateRows(raw);
}

/* JSON with every object's keys in sorted order, so two documents that hold
   the same thing compare equal however their fields happened to be ordered
   — one came off disk through a parser, the other out of a live editor. */
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

/* "Is this the same document?" for restore purposes. rev, who last saved it
   and when are bookkeeping a save writes, not content anybody typed, and the
   identity is compared separately and by its own rules — a legacy file with
   no embedded id derives a different one the moment its bytes change, which
   is exactly the case this comparison exists to see through. */
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

/* previousSession is what the store found written in session.json when it
   started: 'running' means the last session never got to say goodbye. */
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
      /* Disarm first: the PIN dialog may still be open behind this, and a
         resume that ran afterwards would merge the same work a second time,
         into a document this copy has already been detached from. */
      S.draftServerResume = null;
      hideDraftPendingBanner();
      recoverDraftAsUnsavedCopy(waiting,
        "These recovered changes are open here as an unsaved copy — the server document they came " +
        "from was not reached. Save them wherever you want them.");
      if (draftServerSettle) draftServerSettle.settle("server-copy");
    });
  }
}

/* The home is gone (the file was deleted or replaced, the server document is
   not there, or it was an import that cannot be written back), so the work
   opens as a document in its own right.

   It gets its own identity unless it never had another one. Keeping the old
   id would mean two documents sharing one version history — and if this copy
   is later saved next to the original, two files claiming to be the same
   document (invariant #36). The history written under the old id is copied
   across, because it IS this script's history; docIdWrittenOut goes false,
   since this new id has never been anywhere. */
function recoverDraftAsUnsavedCopy(t, reasonText, mine) {
  if (!S.DESKTOP || !t || !t.header) return false;
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
  /* Never saved anywhere, so there is no ancestor: the next merge this
     document is in starts from nothing rather than from a version of some
     other file. */
  S.baseState = null;
  setHome("none");
  resetProductionPanelState();
  S.docIdWrittenOut = wasUntitled ? !!t.header.docIdWrittenOut : false;
  render();
  updateIdentityChip();
  updateFileChip();
  syncDocIdentity();
  /* Unsaved by definition — this copy exists nowhere but on screen. */
  markDirty();
  showToast(reasonText, "warn", true);
  return true;
}

/* Armed before detectServer() runs at boot, so resumeServerDoc() finds the
   draft rather than (or as well as) a lapsed-sign-in stash. Doing it this
   way round is the only way the merge can be certain to happen after the
   boot state has been assigned: resumeServerDoc assigns `state` itself. */
export function armServerDraftResume(t) {
  if (!S.DESKTOP || !t || !t.header) return;
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
  /* detectServer() was started by init() a moment ago and is not awaited by
     anyone — wait for its answer rather than racing it. */
  await draftWaitForServerDetect();

  /* Pointed at a different server than the one these edits came from. The
     document id means nothing over there, so merging would be merging into
     a stranger's script. */
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
    /* Adam's default (overrides §2): show the work straight away as an
       unsaved local copy rather than leaving it on disk until some later
       launch happens to reach the server. Work you cannot see is work you
       cannot rely on. Change this one branch to keep it waiting instead. */
    S.draftServerResume = null;
    if (draftServerSettle) draftServerSettle.settle("server-copy");
    recoverDraftAsUnsavedCopy(t,
      "These recovered changes belong to “" + title + "” on a server this copy can't reach — they " +
      "are open here as an unsaved copy.", mine);
    return "server-copy";
  }

  /* Normally armed before detectServer() ran (21-events.js). Arming again
     here costs one parse and covers a caller that came straight to this
     function, so the work can never be stranded for want of a promise. */
  if (!draftServerSettle) armServerDraftResume(t);
  if (!draftServerSettle) {
    recoverDraftAsUnsavedCopy(t,
      "The changes recovered from the last session are open here as an unsaved copy — the server " +
      "document they came from could not be identified.", mine);
    return "server-copy";
  }

  /* Waiting for the PIN is a normal thing to be doing, not a failure, so the
     banner goes up at once and the work stays available behind its button.
     Everything else gets a bounded wait first — a resume that answers is the
     common case, and a banner that flashes up and vanishes is worse than no
     banner. */
  var waitMs = (S.serverMode.authRequired && !conn.token) ? 0 : draftTiming.serverWait;
  var outcome = await draftRaceTimeout(draftServerSettle.promise, waitMs);
  if (outcome === null) {
    showDraftPendingBanner(t, title);
    outcome = await draftServerSettle.promise;
  }

  hideDraftPendingBanner();
  if (outcome === "server-resumed") return "server-resumed";
  if (outcome === "server-copy") return "server-copy";
  /* 'not-found' — the document was deleted from the server while this copy
     was down. Nothing to merge into; the work is all there is. */
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
  /* THE docIdEmbedded RULE. A file that carries its own id and now carries a
     DIFFERENT one is a different script in the same place: something else
     was saved over it. Anything else — above all a legacy file whose id is
     derived from its bytes, and whose bytes have changed — is still the same
     file, so the disk copy is lined up with the draft's own identity before
     anything is compared or merged. Without this, mergedDocId would take the
     disk's freshly derived id and split the document's history in two. */
  var refId = normalizeDocId((base && base.docId) || mine.docId);
  if (parsed.docIdEmbedded && refId && normalizeDocId(disk.docId) !== refId) {
    recoverDraftAsUnsavedCopy(t,
      "A different script has been saved as " + missingName + " — the changes recovered from the " +
      "last session are open here as an unsaved copy.", mine);
    return "untitled-copy";
  }
  if (refId) disk.docId = refId;

  /* Adopt the file first, silently: it makes this the document's home again
     (handle, kind, chips, panels) with one funnel rather than six
     assignments, and whatever is decided below replaces only `state`. */
  adoptProjectState(disk, file, handle, parsed.kind, { skipSnapshot: true, silent: true });
  var diskCopy = cloneState(disk);

  if (sameDocContent(mine, disk)) {
    S.docIdWrittenOut = !!t.header.docIdWrittenOut;
    showToast("Opened " + (disk.title || file.name) + " — the changes from the last session were already saved", "ok");
    return "nothing-unsaved";
  }

  if (sameDocContent(base, disk)) {
    /* Nobody touched the file while this app was down, so the recovered
       version simply goes back on top of it — no merge, nothing to review,
       and nothing written until the user saves. */
    S.state = mine;
    S.baseState = diskCopy;
    render();
    updateIdentityChip();
    updateFileChip();
    S.docIdWrittenOut = !!t.header.docIdWrittenOut;
    markDirty();
    showToast("Restored your unsaved changes to " + (S.state.title || file.name) +
      (draftWhenText(t) ? " " + draftWhenText(t) : ""), "ok", true);
    return "applied";
  }

  /* The file moved on while this app was down (a sync client, another
     editor, another copy of Splitpage). Three-way merge, the same one a save
     conflict uses, with the draft's own base as the ancestor. */
  var r = applyStashedWork(disk, { base: base, mine: mine });
  if (r.snapshot && r.snapshot.done) {
    /* The undo point has to be ON DISK before the merged version replaces
       what the user can see — the one place a snapshot is waited for
       (invariant #39). */
    try { await r.snapshot.done; } catch (e) {}
  }
  /* And the recovered version itself, so "the draft" is a version in the
     history rather than something that existed only during this function. */
  pushSnapshot("Your unsaved changes, recovered", mine);

  S.state = r.state;
  S.baseState = diskCopy;
  render();
  updateIdentityChip();
  updateFileChip();
  S.docIdWrittenOut = !!t.header.docIdWrittenOut;
  if (r.report) reportMerge(r.report, { noAutoSave: true });
  else markDirty();
  /* If the disk copy's id won the merge, the history written under the
     draft's id follows the document to it. */
  noteMergedDocId(mine.docId);
  showToast((file.name || "That file") + " had changed since the last session — your recovered " +
    "changes were merged into it. Nothing has been saved yet.", "warn", true);
  return "merged";
}

function adoptUntitledDraft(t, mine, base) {
  S.state = mine;
  S.baseState = base || null;
  setHome("none");
  resetProductionPanelState();
  /* A never-saved document keeps exactly what it had: its id has been
     nowhere, which is what lets the first Save As take it along instead of
     forking a new one. */
  S.docIdWrittenOut = !!t.header.docIdWrittenOut;
  render();
  updateIdentityChip();
  updateFileChip();
  syncDocIdentity();
  markDirty();
  showToast("Restored your unsaved script" + (draftWhenText(t) ? " " + draftWhenText(t) : "") +
    " — it has never been saved, so save it somewhere.", "warn", true);
  return "applied";
}

async function runDraftRestore(t) {
  if (!t) return "nothing-unsaved";
  /* Written by a newer version of Splitpage than this one. 'failed' keeps
     main's hold, so the newer version still finds it (DRAFT-STORE). */
  if (t.unsupported) {
    showToast("The changes recovered from the last session were saved by a newer version of " +
      "Splitpage — they have been kept, untouched.", "warn", true);
    return "failed";
  }
  /* Damaged, or locked by antivirus or a sync client. The store cannot tell
     those apart, and 'failed' is the safe answer for both: it keeps the
     draft for the next launch rather than letting the next write rotate it
     away. */
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

/* → Promise<outcome>. Never rejects: whatever happens, main is told exactly
   one outcome, because that is what releases (or keeps) the hold on the
   tab's draft, and a restore that threw without answering would leave the
   tab permanently unable to write a new one. */
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
  /* The tab has been counting as unsaved and as not pristine for the whole
     restore; now that it is over, main needs the truth for its window title,
     its close prompt and its "can this tab be reused?" test. */
  if (typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  /* And the writer takes over: the restored document is either dirty (write
     a draft) or clean (discard the one that was just restored). */
  noteDraftChange();
  return outcome;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* True for the whole restore, from boot until applyTakenDraft() settles.
     While it is true the document on screen is not yet the document the user
     left behind, so the tab counts as unsaved and as not pristine
     (20f-desktop.js), and no draft is written — main is holding this tab's
     draft until draft-restore-done, and every write until then would be
     refused HELD anyway (DRAFT-STORE). */
  draftRestorePending = !!(S.DESKTOP && S.DESKTOP.hasDraftToRestore);

  /* Something is on disk for this tab that a clean document should ask to
     have removed. True at launch when main says this tab has a draft. */
  draftOnDisk = !!(S.DESKTOP && S.DESKTOP.hasDraftToRestore);

  /* ---- flush on the way out ----
     Leaving the window and hiding the page are the two moments a crash is
     most likely to be the next thing that happens, and they cost nothing to
     hear about.

     WHY not gated on `if (DESKTOP)`: DESKTOP is a module-scope var captured
     once, at load, from window.splitpageDesktop (00-prelude.js) — null for
     the whole life of a browser-build page. A real desktop build never
     changes it either way, so gating here costs it nothing; but
     window.__desktopTest.setBackend() (20f-desktop.js) reassigns DESKTOP
     well AFTER this file's top-level code has already run once with it
     null, so a gate here would mean these listeners are NEVER wired in the
     one build that tests them (T3's "visibilitychange hidden flushes"
     case). flushDraftNow() already no-ops when DESKTOP is null
     (`if (!DESKTOP) return Promise.resolve({ok:true})`), so the listeners
     are harmless to keep unconditional. */
  window.addEventListener("blur", function () { flushDraftNow(); });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushDraftNow();
  });

  /* ---- test hook ----
     Hangs off the object 20f-desktop.js already put on window (this fragment
     is concatenated after it, so the object exists). Same rule as every other
     hook here: it exists in both builds and does nothing unless a test calls
     it (FAKE-DESKTOP-BACKEND). */
  if (window.__desktopTest) {
    window.__desktopTest.drafts = {
      flushNow: function () { return flushDraftNow(); },
      status: function () {
        return {
          seq: draftSeq,
          writes: draftStats.writes,
          /* HELD is never counted, here or in the store. */
          failures: draftStats.failures,
          discards: draftStats.discards,
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
      /* Drives a restore exactly as boot does, including the arming that has
         to happen before detectServer() (21-events.js). */
      applyForTest: function (taken) {
        draftRestorePending = true;
        armServerDraftResume(taken);
        return applyTakenDraft(taken);
      },
      noteChange: function () { noteDraftChange(); },
      sameDocContent: sameDocContent
    };
  }
}
