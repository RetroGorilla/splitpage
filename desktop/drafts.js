"use strict";
/* ---------------------------------------------------------------------
 * desktop/drafts.js: the crash-safe draft store.
 *
 * Every tab of the desktop app periodically hands its unsaved document to
 * the main process, which stores it here, under <userData>/drafts/<tabId>/.
 * After a crash, a kill, a power cut or a renderer loss the next launch finds
 * the draft and the tab gets its work back (HANDOFF invariants #40 and #41).
 *
 * This module is plain CommonJS with every dependency injected (fs, fsp,
 * path, crypto). It never requires 'electron', so desktop/test/drafts.test.mjs
 * can drive it from plain Node against a temp folder, and main.js decides
 * where the folder lives and which test hooks apply (only under
 * SPLITPAGE_TEST=1).
 *
 * On-disk layout (dir = <userData>/drafts):
 *   session.json                  {formatVersion:1, state, pid, startedAt,
 *                                  appVersion, discardedTabIds}
 *   <tabId>/current.draft         line 1 DraftHeader JSON, then the state JSON
 *   <tabId>/previous.draft        the generation before current
 *   <tabId>/base-<sha12>.json     line 1 {format:'splitpage-draft-base',
 *                                  formatVersion:1, bytes, sha256}, then the
 *                                  base JSON (the document as last loaded or
 *                                  saved, which the restore merges against)
 *   corrupt/<tabId>-<ts>/         a tab folder whose drafts both failed their
 *                                  checksum, moved aside and never unlinked
 *   .tmp-*  .trash-*              transient; swept by init()
 *
 * WHY NOTHING IMPLICIT DELETES. A draft exists to survive the things the user
 * did not choose: a crash, a kill, a renderer loss, a Windows session end, a
 * restore that went wrong. So nothing here deletes a draft as a side effect of
 * reading it (take), listing it, restoring it, finding it damaged (that
 * quarantines, which is a rename) or the app quitting. A draft is removed only
 * when its tab reported itself clean (discardClean, which the renderer or main
 * asks for explicitly) or on the user's explicit decision to throw the work
 * away (discardForUserDecision: Leave / Close / Quit without saving). The only
 * other deletions are of things that are provably not user work: temp files,
 * already-renamed trash, base files no generation references, folders the
 * user already discarded (tombstoned), and quarantined entries past their
 * retention.
 * ------------------------------------------------------------------- */

const TAB_ID_RE = /^[0-9a-f]{32}$/;
const BASE_FILE_RE = /^base-[0-9a-f]{12}\.json$/;
const CORRUPT_ENTRY_RE = /^([0-9a-f]{32})-(\d+)(?:-\d+)?$/;

const DRAFT_FORMAT = "splitpage-draft";
const BASE_FORMAT = "splitpage-draft-base";
const FORMAT_VERSION = 1;
const SESSION_FORMAT_VERSION = 1;

/* The cap per body (state or base). A document this large is not a document
   anyone types; refusing it keeps one runaway tab from filling the disk. */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/* Quarantined entries: the newest 10 are always kept; older ones go once they
   are more than 30 days old. They exist so a damaged draft can still be
   inspected by hand; they should not grow without bound either. */
const CORRUPT_KEEP_NEWEST = 10;
const CORRUPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/* A header is a few hundred bytes. The limit only stops a damaged file with no
   newline from being read whole just to find line 1. */
const HEADER_READ_LIMIT = 4 * 1024 * 1024;

const WRITE_ERROR_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EBUSY", "EIO"]);
const SESSION_STATES = new Set(["running", "clean-exit", "session-end"]);

/* Codes a Windows rename returns when the destination is transiently held open
   by an antivirus scan, the search indexer or a sync client. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

/* A synchronous sleep. The renames below must stay inside one synchronous
   tick (see doWrite), so a retry cannot await a timer; Atomics.wait blocks the
   thread for a few milliseconds instead, at most ~80 ms in the worst case. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    /* Atomics.wait is unavailable only on a browser main thread; not here. */
  }
}

function renameSyncRetry(fs, from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !err || !RENAME_RETRY_CODES.has(err.code)) throw err;
      sleepSync(RENAME_RETRY_MS);
    }
  }
}

function sha256Hex(crypto, data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/* The one durable small-file write: a temp file in the same folder, fsync,
   then rename over the target.

   WHY FSYNC. atomicWrite in main.js (temp + rename) protects against a crash
   of the app, but not against a power cut: without fsync the rename can reach
   the disk before the file's data does, and after the power returns the target
   is a zero-length or garbage file. The decision for drafts names power loss
   explicitly, so every durable write here flushes the data to disk before the
   rename makes it visible. (A directory cannot be fsynced on Windows, so the
   rename itself is as durable as NTFS's journal makes it.)

   The temp name starts with ".tmp-" so the drafts init() sweep recognises it
   if the process dies between write and rename. */
function durableWriteSync(fs, path, crypto, file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}-${path.basename(file)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx");
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), "utf8");
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameSyncRetry(fs, tmp, file);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* already failing */ }
    }
    try { fs.unlinkSync(tmp); } catch (_) { /* never created, or already renamed */ }
    throw err;
  }
}

/* Exported for main.js (desktop-state.json v2) as well as used for
   session.json here. */
function writeFileDurableSync(file, text) {
  durableWriteSync(require("fs"), require("path"), require("crypto"), file, text);
}

function createDraftStore(opts) {
  const o = opts || {};
  const { dir, fs, fsp, path, crypto } = o;
  if (typeof dir !== "string" || !dir) throw new TypeError("createDraftStore: dir is required");
  if (!fs || !fsp || !path || !crypto) throw new TypeError("createDraftStore: fs, fsp, path and crypto are required");
  const appVersion = typeof o.appVersion === "string" ? o.appVersion : "";
  /* testHooks are passed by main.js only under SPLITPAGE_TEST=1. */
  const hooks = o.testHooks && typeof o.testHooks === "object" ? o.testHooks : null;

  const sessionFile = path.join(dir, "session.json");
  const corruptDir = path.join(dir, "corrupt");

  /* Per-tab runtime record. Nothing in it is persisted; after a relaunch every
     tab starts fresh (floor -Infinity, no known base), so the first write of a
     tab in a process must carry its base (NEED_BASE otherwise). */
  const tabs = new Map();
  const queues = new Map();
  let tombstones = new Set();
  let previousSession = "none";
  let session = {
    formatVersion: SESSION_FORMAT_VERSION,
    state: "running",
    pid: process.pid,
    startedAt: Date.now(),
    appVersion,
    discardedTabIds: [],
  };
  const stats = { writes: 0, failures: 0 };
  let writesReachedRename = 0;
  let failNextCode = null;
  let failNextRemaining = 0;
  if (hooks && hooks.failNext && typeof hooks.failNext.code === "string") {
    failNextCode = hooks.failNext.code;
    failNextRemaining = Number.isInteger(hooks.failNext.count) && hooks.failNext.count > 0 ? hooks.failNext.count : 1;
  }

  function tabRec(tabId) {
    let rec = tabs.get(tabId);
    if (!rec) {
      rec = { floor: -Infinity, epoch: 0, lastBase: null, lastHeader: null, held: false, holdGen: 0, lastSeq: null };
      tabs.set(tabId, rec);
    }
    return rec;
  }

  function validTabId(tabId) {
    return typeof tabId === "string" && TAB_ID_RE.test(tabId);
  }

  function tabDir(tabId) {
    return path.join(dir, tabId);
  }

  /* Per-tab serial queue. Writes, clean discards and takes of one tab run one
     after another, so a slow write of seq 7 can never land after seq 8 and a
     take never reads a half-rotated pair. Different tabs do not wait on each
     other. discardForUserDecision is deliberately NOT queued: it must win even
     against a write that is stuck on a slow disk (see doWrite). */
  function enqueue(tabId, task) {
    const prev = queues.get(tabId) || Promise.resolve();
    const run = prev.then(task);
    const tail = run.then(noop, noop);
    queues.set(tabId, tail);
    tail.then(() => {
      if (queues.get(tabId) === tail) queues.delete(tabId);
    });
    return run;
  }

  function noop() {}

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function persistSession() {
    fs.mkdirSync(dir, { recursive: true });
    durableWriteSync(fs, path, crypto, sessionFile, JSON.stringify(session));
  }

  function readSessionSync() {
    try {
      const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function readdirSafe(folder) {
    try {
      return fs.readdirSync(folder);
    } catch (_) {
      return [];
    }
  }

  function isDirSafe(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch (_) {
      return false;
    }
  }

  function unlinkQuiet(p) {
    try { fs.unlinkSync(p); } catch (_) { /* best effort */ }
  }

  function rmQuiet(p) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /* Removes a tab folder: rename it to .trash-* first, then delete. The rename
     is one atomic step, so the draft disappears from hasDraft/list/take at
     once even if the recursive delete is slow or fails halfway (an AV lock on
     one file); init() sweeps the leftover .trash-*. Returns false only if the
     folder is still there under its own name. */
  function removeTabFolder(tabId) {
    const folder = tabDir(tabId);
    if (!fs.existsSync(folder)) return true;
    const trash = path.join(dir, `.trash-${tabId}-${crypto.randomBytes(6).toString("hex")}`);
    try {
      renameSyncRetry(fs, folder, trash);
    } catch (_) {
      rmQuiet(folder);
      return !fs.existsSync(folder);
    }
    rmQuiet(trash);
    return true;
  }

  /* Header checks shared by list(), init() and take(). A newer formatVersion is
     reported as unsupported before anything else is checked, because a newer
     app may have changed every other field; such a draft is left untouched
     for the app version that wrote it. */
  function classifyDraftHeader(h, tabId) {
    if (!isPlainObject(h) || h.format !== DRAFT_FORMAT || typeof h.formatVersion !== "number") return { bad: true };
    if (h.formatVersion > FORMAT_VERSION) return { unsupported: true };
    if (h.formatVersion !== FORMAT_VERSION) return { bad: true };
    if (h.tabId !== tabId) return { bad: true };
    const s = h.state;
    if (!isPlainObject(s) || !Number.isInteger(s.bytes) || s.bytes < 0 || typeof s.sha256 !== "string") return { bad: true };
    if (h.base !== null && h.base !== undefined) {
      const b = h.base;
      if (!isPlainObject(b) || typeof b.file !== "string" || !BASE_FILE_RE.test(b.file) ||
          !Number.isInteger(b.bytes) || b.bytes < 0 || typeof b.sha256 !== "string") return { bad: true };
    }
    return { header: h };
  }

  /* Reads only line 1 of a draft file, synchronously (list() and hasDraft()
     back sendSync handlers in main, and a body can be tens of MB). No checksum
     here; take() does the full verification. */
  function readHeaderSync(file, tabId) {
    let fd;
    try {
      fd = fs.openSync(file, "r");
    } catch (err) {
      return err && err.code === "ENOENT" ? { missing: true } : { bad: true, unreadable: true };
    }
    try {
      const chunks = [];
      const chunk = Buffer.alloc(64 * 1024);
      let pos = 0;
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
        if (n <= 0) return { bad: true };
        const piece = chunk.subarray(0, n);
        const nl = piece.indexOf(0x0a);
        if (nl >= 0) {
          chunks.push(Buffer.from(piece.subarray(0, nl)));
          break;
        }
        chunks.push(Buffer.from(piece));
        pos += n;
        if (pos > HEADER_READ_LIMIT) return { bad: true };
      }
      let header;
      try {
        header = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (_) {
        return { bad: true };
      }
      return classifyDraftHeader(header, tabId);
    } catch (_) {
      return { bad: true, unreadable: true };
    } finally {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }

  /* Reads and fully verifies one generation (length and sha256 of the body). */
  async function readGeneration(tabId, name) {
    let buf;
    try {
      buf = await fsp.readFile(path.join(tabDir(tabId), name));
    } catch (err) {
      return err && err.code === "ENOENT" ? { missing: true } : { bad: true, unreadable: true };
    }
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { bad: true };
    let header;
    try {
      header = JSON.parse(buf.subarray(0, nl).toString("utf8"));
    } catch (_) {
      return { bad: true };
    }
    const c = classifyDraftHeader(header, tabId);
    if (!c.header) return c;
    const body = buf.subarray(nl + 1);
    if (body.length !== header.state.bytes || sha256Hex(crypto, body) !== header.state.sha256) return { bad: true };
    return { ok: true, header, stateJson: body.toString("utf8") };
  }

  async function readBase(tabId, ref) {
    if (!ref) return { baseJson: null, baseProblem: null };
    let buf;
    try {
      buf = await fsp.readFile(path.join(tabDir(tabId), ref.file));
    } catch (err) {
      return { baseJson: null, baseProblem: err && err.code === "ENOENT" ? "missing" : "corrupt" };
    }
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { baseJson: null, baseProblem: "corrupt" };
    let meta;
    try {
      meta = JSON.parse(buf.subarray(0, nl).toString("utf8"));
    } catch (_) {
      return { baseJson: null, baseProblem: "corrupt" };
    }
    const body = buf.subarray(nl + 1);
    if (!isPlainObject(meta) || meta.format !== BASE_FORMAT || meta.formatVersion !== FORMAT_VERSION ||
        meta.bytes !== ref.bytes || meta.sha256 !== ref.sha256 ||
        body.length !== ref.bytes || sha256Hex(crypto, body) !== ref.sha256) {
      return { baseJson: null, baseProblem: "corrupt" };
    }
    return { baseJson: body.toString("utf8"), baseProblem: null };
  }

  /* Moves a tab folder whose drafts both failed verification to
     corrupt/<tabId>-<ts>/. A rename, never an unlink: a damaged draft may
     still hold most of someone's work and can be recovered by hand. */
  function quarantine(tabId) {
    try {
      fs.mkdirSync(corruptDir, { recursive: true });
      const ts = Date.now();
      let dest = path.join(corruptDir, `${tabId}-${ts}`);
      for (let i = 1; fs.existsSync(dest); i++) dest = path.join(corruptDir, `${tabId}-${ts}-${i}`);
      renameSyncRetry(fs, tabDir(tabId), dest);
      return true;
    } catch (_) {
      return false;
    }
  }

  function forgetDiskState(rec) {
    rec.lastBase = null;
    rec.lastHeader = null;
  }

  function tooLarge(str) {
    const cap = hooks && Number.isFinite(hooks.maxBodyBytes) ? hooks.maxBodyBytes : MAX_BODY_BYTES;
    /* A string's UTF-8 length is never shorter than its UTF-16 length, so the
       cheap check first avoids scanning a giant string. */
    if (str.length > cap) return true;
    return Buffer.byteLength(str, "utf8") > cap;
  }

  function errorCode(err) {
    const code = err && err.code;
    return WRITE_ERROR_CODES.has(code) ? code : "EIO";
  }

  function consumeInjectedFailure() {
    if (!failNextCode || failNextRemaining <= 0) return null;
    failNextRemaining--;
    return failNextCode;
  }

  async function writeFileDurable(file, buffers, injectCode) {
    const fh = await fsp.open(file, "wx");
    let closed = false;
    try {
      if (injectCode) throw Object.assign(new Error(`injected ${injectCode}`), { code: injectCode });
      for (const b of buffers) {
        let off = 0;
        while (off < b.length) {
          const { bytesWritten } = await fh.write(b, off, b.length - off, null);
          off += bytesWritten;
        }
      }
      /* WHY: see durableWriteSync. The data reaches the disk before the rename
         can make this file the current draft. */
      await fh.sync();
      closed = true;
      await fh.close();
    } catch (err) {
      if (!closed) await fh.close().catch(noop);
      throw err;
    }
  }

  /* Returns the base files the previous generation needs, or null when that
     cannot be known (a damaged or newer-format previous.draft), in which case
     no base is pruned. */
  function previousBaseRefs(folder, tabId, headerThatBecamePrevious, currentExisted) {
    if (currentExisted && headerThatBecamePrevious) {
      return headerThatBecamePrevious.base ? [headerThatBecamePrevious.base.file] : [];
    }
    const prev = readHeaderSync(path.join(folder, "previous.draft"), tabId);
    if (prev.missing) return [];
    if (!prev.header) return null;
    return prev.header.base ? [prev.header.base.file] : [];
  }

  function pruneBases(folder, keepFiles) {
    const keep = new Set(keepFiles);
    for (const name of readdirSafe(folder)) {
      if (BASE_FILE_RE.test(name) && !keep.has(name)) unlinkQuiet(path.join(folder, name));
    }
  }

  async function doWrite(tabId, rec, epoch, holdAtCall, header, stateJson, baseJson, seq) {
    const fail = (code) => {
      /* After anything but a complete success the renderer's idea of "the base
         I already sent" may be ahead of the disk, so forget the base: the next
         write without one gets NEED_BASE and resends it. */
      rec.lastBase = null;
      if (code !== "NEED_BASE" && code !== "STALE_SEQ" && code !== "DISCARDED" && code !== "HELD") stats.failures++;
      return { ok: false, code };
    };

    if (tombstones.has(tabId)) return fail("DISCARDED");
    if (!isPlainObject(header) || typeof stateJson !== "string" ||
        (baseJson !== null && typeof baseJson !== "string") ||
        typeof seq !== "number" || !Number.isFinite(seq)) return fail("BAD_PAYLOAD");
    if (tooLarge(stateJson) || (baseJson !== null && tooLarge(baseJson))) return fail("TOO_LARGE");
    if (rec.epoch !== epoch || !(seq > rec.floor)) return fail("STALE_SEQ");

    const folder = tabDir(tabId);
    const currentPath = path.join(folder, "current.draft");
    const previousPath = path.join(folder, "previous.draft");

    /* WHY A HOLD REFUSES WRITES. A held tab has a draft on disk that has not
       been restored: the work from before a crash. Every successful write
       rotates current.draft to previous.draft, so two writes would push that
       work off the disk with no clean report and no user decision (invariant
       #40), while isHeld still counts it as unsaved. That happens as soon as a
       restore settles as 'failed' (the hold is kept; take() found the files
       locked by AV or a sync client, say) and the user types in the tab. So a
       write called while the hold was in force is refused as HELD and the held
       generations stay byte-identical until the hold is released
       (draft-restore-done with a non-failed outcome) or the user throws the
       work away (discardForUserDecision); an unreleased hold restores again at
       the next launch.

       Two cases are deliberately not refused:
       - A write called BEFORE the hold (holdAtCall is null, or an older hold
         generation). It came from a page that was still alive when main
         learned of its crash, so it is the newest crash work, not something
         that would bury it; it rotates like any write and keeps the previous
         generation as the fallback. For the same reason the rename tick below
         does not re-check the hold: a hold set during this write's awaits is
         exactly that case.
       - A held tab with no draft on disk at all (the renderer crashed before
         its first write; main holds on every crash). Nothing unrestored exists
         to protect, and the reloaded page never sends draft-restore-done
         because it has nothing to restore, so keeping the hold would pause
         crash recovery for that tab for the rest of the session. The hold is
         released and the write proceeds. The per-tab queue guarantees no other
         write or take of this tab runs between this check and the rename. */
    if (holdAtCall !== null && rec.held && rec.holdGen === holdAtCall) {
      if (fs.existsSync(currentPath) || fs.existsSync(previousPath)) return fail("HELD");
      rec.held = false;
    }

    /* A draft written by a newer app version is left untouched (it would be
       rotated out by two writes otherwise). There is no dedicated code for it
       in WriteResult; EPERM ("not permitted") pauses crash recovery for this
       tab with an honest reason. Checked only when this process has not
       written the tab yet, since after that current.draft is our own. */
    if (!rec.lastHeader) {
      const cur = readHeaderSync(currentPath, tabId);
      if (cur.unsupported || readHeaderSync(previousPath, tabId).unsupported) return fail("EPERM");
    }

    let baseRef;
    let baseBuf = null;
    if (baseJson === null) {
      if (!rec.lastBase || !fs.existsSync(path.join(folder, rec.lastBase.file))) return fail("NEED_BASE");
      baseRef = rec.lastBase;
    } else {
      baseBuf = Buffer.from(baseJson, "utf8");
      const sha = sha256Hex(crypto, baseBuf);
      baseRef = { file: `base-${sha.slice(0, 12)}.json`, bytes: baseBuf.length, sha256: sha };
    }

    const stateBuf = Buffer.from(stateJson, "utf8");
    const finalHeader = Object.assign(
      { format: DRAFT_FORMAT, formatVersion: FORMAT_VERSION, tabId },
      header,
      {
        format: DRAFT_FORMAT,
        formatVersion: FORMAT_VERSION,
        tabId,
        writtenAt: Date.now(),
        appVersion,
        seq,
        state: { bytes: stateBuf.length, sha256: sha256Hex(crypto, stateBuf) },
        base: { file: baseRef.file, bytes: baseRef.bytes, sha256: baseRef.sha256 },
      }
    );
    let headerLine;
    try {
      headerLine = JSON.stringify(finalHeader);
    } catch (_) {
      return fail("BAD_PAYLOAD");
    }

    /* Temp files live in the drafts root, not in the tab folder: on Windows a
       folder cannot be renamed while a file inside it is open, and
       discardForUserDecision must be able to rename the tab folder away while
       a write is still streaming its temp file. */
    const rand = crypto.randomBytes(6).toString("hex");
    const stateTmp = path.join(dir, `.tmp-${tabId}-state-${rand}`);
    const baseTmp = baseBuf ? path.join(dir, `.tmp-${tabId}-base-${rand}`) : null;
    const pendingTmps = [];
    const cleanupTmps = () => {
      for (const t of pendingTmps.splice(0)) unlinkQuiet(t);
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
      pendingTmps.push(stateTmp);
      await writeFileDurable(stateTmp, [Buffer.from(headerLine + "\n", "utf8"), stateBuf], consumeInjectedFailure());
      if (baseTmp) {
        pendingTmps.push(baseTmp);
        const meta = { format: BASE_FORMAT, formatVersion: FORMAT_VERSION, bytes: baseRef.bytes, sha256: baseRef.sha256 };
        await writeFileDurable(baseTmp, [Buffer.from(JSON.stringify(meta) + "\n", "utf8"), baseBuf], null);
      }
      if (hooks && Number.isFinite(hooks.writeDelayMs) && hooks.writeDelayMs > 0) await delay(hooks.writeDelayMs);

      writesReachedRename++;
      if (hooks && Number.isInteger(hooks.killBeforeRenameAt) && hooks.killBeforeRenameAt === writesReachedRename) {
        /* In the app onKill SIGKILLs the process right here: both temp files
           are complete and fsynced but not renamed. If it returns (the unit
           test), the write is abandoned exactly as a kill would leave it. */
        pendingTmps.length = 0;
        try { if (typeof hooks.onKill === "function") hooks.onKill(); } catch (_) { /* abandoned either way */ }
        return fail("EIO");
      }

      /* ---- ONE SYNCHRONOUS TICK from here to the return. ----
         WHY. discardForUserDecision is synchronous and JavaScript runs one
         thing at a time, so it either ran completely before this point (the
         tombstone is set, and this write gives up and removes its temp files)
         or it runs completely after it (and renames away the folder this write
         just completed). There is no await between the tombstone check and
         the renames, so a discard can never slip in between them, and a late
         write can never bring back work the user threw away. */
      if (tombstones.has(tabId)) {
        cleanupTmps();
        return fail("DISCARDED");
      }
      if (rec.epoch !== epoch || !(seq > rec.floor)) {
        cleanupTmps();
        return fail("STALE_SEQ");
      }

      fs.mkdirSync(folder, { recursive: true });
      if (baseTmp) {
        renameSyncRetry(fs, baseTmp, path.join(folder, baseRef.file));
        pendingTmps.splice(pendingTmps.indexOf(baseTmp), 1);
      }
      /* WHY TWO GENERATIONS. fsync + rename make each file whole, but a disk
         can still hand back a damaged file (a bad sector, a sync client or AV
         touching it, a filesystem that lied about the flush). Rotating the old
         current to previous.draft before the new one takes its place means a
         draft that fails its checksum at restore still has the one before it
         to fall back on: the user loses at most one interval of typing, not
         the whole document. */
      const currentExisted = fs.existsSync(currentPath);
      const headerThatBecamePrevious = currentExisted ? rec.lastHeader : null;
      /* If a rename below throws, the disk no longer matches what this record
         believes; forget it first so the next write re-reads. */
      forgetDiskState(rec);
      if (currentExisted) renameSyncRetry(fs, currentPath, previousPath);
      renameSyncRetry(fs, stateTmp, currentPath);
      pendingTmps.length = 0;

      rec.floor = seq;
      rec.lastSeq = seq;
      rec.lastBase = baseRef;
      rec.lastHeader = finalHeader;
      stats.writes++;

      /* Bases are kept while either generation references them; dropping the
         previous generation's base would make its fallback restore an
         ancestor-less merge. */
      const prevRefs = previousBaseRefs(folder, tabId, headerThatBecamePrevious, currentExisted);
      if (prevRefs) pruneBases(folder, [baseRef.file].concat(prevRefs));

      return { ok: true, seq, bytes: stateBuf.length };
    } catch (err) {
      cleanupTmps();
      forgetDiskState(rec);
      return fail(errorCode(err));
    }
  }

  function write(tabId, header, stateJson, baseJson, seq) {
    if (!validTabId(tabId)) return Promise.resolve({ ok: false, code: "NO_TAB" });
    const rec = tabRec(tabId);
    const epoch = rec.epoch;
    /* Captured when the write arrives, not when it runs: see the hold check in
       doWrite for why a write from before the hold must still land. */
    const holdAtCall = rec.held ? rec.holdGen : null;
    const base = baseJson === undefined ? null : baseJson;
    return enqueue(tabId, () => doWrite(tabId, rec, epoch, holdAtCall, header, stateJson, base, seq));
  }

  /* The tab reported itself clean at `seq` (main passes Infinity when a clean
     tab closes). Refused while the tab is held: a held tab has a draft that
     has not been restored yet, or a renderer that crashed, and its "clean" may
     just mean "has not loaded the draft". Refused as STALE_SEQ when a write
     newer than `seq` already landed. On success no write at or below `seq`
     can land afterwards. */
  function discardClean(tabId, seq) {
    if (!validTabId(tabId)) return Promise.resolve({ ok: false, code: "NO_TAB" });
    const rec = tabRec(tabId);
    const epoch = rec.epoch;
    return enqueue(tabId, async () => {
      if (typeof seq !== "number" || Number.isNaN(seq)) return { ok: false, code: "BAD_PAYLOAD" };
      if (rec.held) return { ok: false, code: "HELD" };
      if (rec.epoch !== epoch || seq < rec.floor) return { ok: false, code: "STALE_SEQ" };
      rec.floor = seq;
      forgetDiskState(rec);
      const removed = removeTabFolder(tabId);
      return removed ? { ok: true } : { ok: false, code: "EBUSY" };
    });
  }

  /* The user chose to throw the work away (Leave / Close / Quit without
     saving). Synchronous and un-queued on purpose; see the tick comment in
     doWrite. Order: tombstone in memory → session.json durably → rename the
     folder to .trash-* → delete. The persisted tombstone makes the next init()
     finish the job if the delete fails halfway, so a discarded draft never
     comes back at relaunch.

     If session.json cannot be written (disk full), the folders are still
     removed: the in-memory tombstone already blocks every late write of this
     process, and leaving the folders would bring the discarded draft back at
     the next launch with certainty. */
  function discardForUserDecision(tabIds, reason) {
    const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).filter(validTabId);
    for (const id of ids) {
      tombstones.add(id);
      const rec = tabRec(id);
      rec.held = false;
      forgetDiskState(rec);
    }
    session.discardedTabIds = Array.from(tombstones);
    let persisted = true;
    try {
      persistSession();
    } catch (_) {
      persisted = false;
    }
    const failed = [];
    for (const id of ids) {
      if (!removeTabFolder(id)) failed.push(id);
    }
    return { ok: failed.length === 0, persisted, failed, reason: typeof reason === "string" ? reason : null };
  }

  /* take never deletes and never releases a hold. It returns the newest
     generation that verifies, falls back to previous.draft, quarantines the
     folder when both exist-or-not and neither verifies, and reports a newer
     format as unsupported without touching it. */
  function take(tabId) {
    if (!validTabId(tabId)) return Promise.resolve(null);
    return enqueue(tabId, async () => {
      if (tombstones.has(tabId)) return null;
      const cur = await readGeneration(tabId, "current.draft");
      if (cur.unsupported) return { unsupported: true };
      let chosen = cur.ok ? cur : null;
      let usedPrevGeneration = false;
      if (!chosen) {
        const prev = await readGeneration(tabId, "previous.draft");
        if (prev.unsupported) return { unsupported: true };
        if (prev.ok) {
          chosen = prev;
          usedPrevGeneration = true;
        } else {
          if (cur.missing && prev.missing) return null;
          /* A file that could not be opened (locked by AV or a sync client) is
             not proven damaged; report it as corrupt for this restore but do
             not move it, so a later launch can still read it. */
          if (!cur.unreadable && !prev.unreadable && !tombstones.has(tabId)) {
            forgetDiskState(tabRec(tabId));
            quarantine(tabId);
          }
          return { corrupt: true };
        }
      }
      const base = await readBase(tabId, chosen.header.base);
      const writtenAt = chosen.header.writtenAt;
      return {
        header: chosen.header,
        stateJson: chosen.stateJson,
        baseJson: base.baseJson,
        baseProblem: base.baseProblem,
        ageMs: Number.isFinite(writtenAt) ? Math.max(0, Date.now() - writtenAt) : null,
        previousSession,
        usedPrevGeneration,
      };
    });
  }

  function hasDraft(tabId) {
    if (!validTabId(tabId) || tombstones.has(tabId)) return false;
    const folder = tabDir(tabId);
    return fs.existsSync(path.join(folder, "current.draft")) || fs.existsSync(path.join(folder, "previous.draft"));
  }

  /* DraftListing: {tabId, status:'ok'|'corrupt'|'unsupported',
     generation:'current'|'previous'|null, header|null, title, writtenAt, seq,
     docId, originKind, filePath, placement}. Header line only, no checksum;
     main uses it at launch for titles, placement and path indexing. */
  function listingFor(tabId) {
    const folder = tabDir(tabId);
    const cur = readHeaderSync(path.join(folder, "current.draft"), tabId);
    let chosen = null;
    let generation = null;
    let status;
    if (cur.unsupported) {
      status = "unsupported";
    } else if (cur.header) {
      chosen = cur.header;
      generation = "current";
      status = "ok";
    } else {
      const prev = readHeaderSync(path.join(folder, "previous.draft"), tabId);
      if (prev.unsupported) {
        status = "unsupported";
      } else if (prev.header) {
        chosen = prev.header;
        generation = "previous";
        status = "ok";
      } else if (cur.missing && prev.missing) {
        return null;
      } else {
        status = "corrupt";
      }
    }
    const h = chosen || {};
    const origin = isPlainObject(h.origin) ? h.origin : null;
    return {
      tabId,
      status,
      generation,
      header: chosen,
      title: typeof h.title === "string" ? h.title : "",
      writtenAt: Number.isFinite(h.writtenAt) ? h.writtenAt : null,
      seq: Number.isFinite(h.seq) ? h.seq : null,
      docId: typeof h.docId === "string" ? h.docId : null,
      originKind: origin && typeof origin.kind === "string" ? origin.kind : null,
      filePath: origin && typeof origin.filePath === "string" ? origin.filePath : null,
      placement: isPlainObject(h.placement) ? h.placement : null,
    };
  }

  function list() {
    const out = [];
    for (const name of readdirSafe(dir)) {
      if (!TAB_ID_RE.test(name) || tombstones.has(name) || !isDirSafe(path.join(dir, name))) continue;
      const listing = listingFor(name);
      if (listing) out.push(listing);
    }
    out.sort((a, b) => (b.writtenAt || 0) - (a.writtenAt || 0));
    return out;
  }

  function sweepTabFolder(tabId) {
    const folder = tabDir(tabId);
    for (const name of readdirSafe(folder)) {
      if (name.startsWith(".tmp-")) rmQuiet(path.join(folder, name));
    }
    const cur = readHeaderSync(path.join(folder, "current.draft"), tabId);
    const prev = readHeaderSync(path.join(folder, "previous.draft"), tabId);
    /* A newer format is left untouched; a damaged generation might still need
       a base that its unreadable header would have named, so take() decides
       what to do with that folder, not the sweep. */
    if (cur.unsupported || prev.unsupported || cur.bad || prev.bad) return;
    const keep = [];
    if (cur.header && cur.header.base) keep.push(cur.header.base.file);
    if (prev.header && prev.header.base) keep.push(prev.header.base.file);
    pruneBases(folder, keep);
    if (cur.missing && prev.missing) {
      try { fs.rmdirSync(folder); } catch (_) { /* not empty: something we do not own */ }
    }
  }

  function pruneCorrupt() {
    const now = Date.now();
    const entries = readdirSafe(corruptDir)
      .map((name) => {
        const m = CORRUPT_ENTRY_RE.exec(name);
        return m ? { name, ts: Number(m[2]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.ts - a.ts);
    for (const e of entries.slice(CORRUPT_KEEP_NEWEST)) {
      if (now - e.ts > CORRUPT_MAX_AGE_MS) rmQuiet(path.join(corruptDir, e.name));
    }
  }

  /* Called once by main before any window exists. Synchronous. */
  function init() {
    fs.mkdirSync(dir, { recursive: true });
    const prior = readSessionSync();
    previousSession = prior && SESSION_STATES.has(prior.state) ? prior.state : "none";
    const priorTombstones = prior && Array.isArray(prior.discardedTabIds) ? prior.discardedTabIds.filter(validTabId) : [];

    const entries = readdirSafe(dir);
    for (const name of entries) {
      if (name.startsWith(".tmp-") || name.startsWith(".trash-")) rmQuiet(path.join(dir, name));
    }

    /* Folders the user discarded last session whose delete did not finish (or
       that something recreated) are removed now; a tombstone is pruned once its
       folder is really gone, so the same tabId can hold a new draft later (a
       file tab reopens with its old tabId after Quit without saving). */
    const remaining = [];
    for (const id of new Set(priorTombstones)) {
      if (!removeTabFolder(id)) remaining.push(id);
    }
    tombstones = new Set(remaining);

    for (const name of entries) {
      if (TAB_ID_RE.test(name) && !tombstones.has(name) && isDirSafe(path.join(dir, name))) sweepTabFolder(name);
    }
    pruneCorrupt();

    tabs.clear();
    session = {
      formatVersion: SESSION_FORMAT_VERSION,
      state: "running",
      pid: process.pid,
      startedAt: Date.now(),
      appVersion,
      discardedTabIds: Array.from(tombstones),
    };
    let sessionWritten = true;
    try {
      persistSession();
    } catch (_) {
      sessionWritten = false;
    }
    return { previousSession, drafts: list(), sessionWritten };
  }

  function markSession(state) {
    session.state = state;
    session.discardedTabIds = Array.from(tombstones);
    try {
      persistSession();
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    init,
    write,
    discardClean,
    discardForUserDecision,
    take,
    hasDraft,
    list,
    /* A new generation starts only when the tab was not already held, so a
       second hold of the same unrestored draft (relaunch hold, then a crash
       of the restoring page) still refuses the writes called under the
       first. */
    hold(tabId) {
      if (!validTabId(tabId)) return;
      const rec = tabRec(tabId);
      if (!rec.held) {
        rec.held = true;
        rec.holdGen++;
      }
    },
    release(tabId) {
      if (validTabId(tabId)) tabRec(tabId).held = false;
    },
    isHeld(tabId) {
      return validTabId(tabId) && tabs.has(tabId) && tabs.get(tabId).held;
    },
    /* The tab's renderer navigated (reload after a crash): its seq counter
       starts again, and writes still queued from the old page must not land. */
    resetSeq(tabId) {
      if (!validTabId(tabId)) return;
      const rec = tabRec(tabId);
      rec.epoch++;
      rec.floor = -Infinity;
      rec.lastBase = null;
    },
    markCleanExit() {
      return markSession("clean-exit");
    },
    markSessionEnd() {
      return markSession("session-end");
    },
    /* For main's TEST_MODE splitpage:test-draft-status. */
    status(tabId) {
      const rec = validTabId(tabId) ? tabs.get(tabId) : null;
      return {
        tabId: validTabId(tabId) ? tabId : null,
        hasDraft: hasDraft(tabId),
        held: !!(rec && rec.held),
        lastSeq: rec ? rec.lastSeq : null,
        tombstoned: validTabId(tabId) && tombstones.has(tabId),
        previousSession,
        writes: stats.writes,
        failures: stats.failures,
      };
    },
  };
}

module.exports = { createDraftStore, writeFileDurableSync, TAB_ID_RE, MAX_BODY_BYTES };
