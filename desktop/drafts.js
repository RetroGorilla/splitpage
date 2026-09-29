"use strict";

const TAB_ID_RE = /^[0-9a-f]{32}$/;
const BASE_FILE_RE = /^base-[0-9a-f]{12}\.json$/;
const CORRUPT_ENTRY_RE = /^([0-9a-f]{32})-(\d+)(?:-\d+)?$/;

const DRAFT_FORMAT = "splitpage-draft";
const BASE_FORMAT = "splitpage-draft-base";
const FORMAT_VERSION = 1;
const SESSION_FORMAT_VERSION = 1;

const MAX_BODY_BYTES = 256 * 1024 * 1024;

const CORRUPT_KEEP_NEWEST = 10;
const CORRUPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const HEADER_READ_LIMIT = 4 * 1024 * 1024;

const WRITE_ERROR_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EBUSY", "EIO"]);
const SESSION_STATES = new Set(["running", "clean-exit", "session-end"]);

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

// Sync sleep: renames must stay in one synchronous tick
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
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
      try { fs.closeSync(fd); } catch (_) { }
    }
    try { fs.unlinkSync(tmp); } catch (_) { }
    throw err;
  }
}

function writeFileDurableSync(file, text) {
  durableWriteSync(require("fs"), require("path"), require("crypto"), file, text);
}

function createDraftStore(opts) {
  const o = opts || {};
  const { dir, fs, fsp, path, crypto } = o;
  if (typeof dir !== "string" || !dir) throw new TypeError("createDraftStore: dir is required");
  if (!fs || !fsp || !path || !crypto) throw new TypeError("createDraftStore: fs, fsp, path and crypto are required");
  const appVersion = typeof o.appVersion === "string" ? o.appVersion : "";
  const hooks = o.testHooks && typeof o.testHooks === "object" ? o.testHooks : null;

  const sessionFile = path.join(dir, "session.json");
  const corruptDir = path.join(dir, "corrupt");

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
    try { fs.unlinkSync(p); } catch (_) { }
  }

  function rmQuiet(p) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

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
      try { fs.closeSync(fd); } catch (_) { }
    }
  }

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
      await fh.sync();
      closed = true;
      await fh.close();
    } catch (err) {
      if (!closed) await fh.close().catch(noop);
      throw err;
    }
  }

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

    // Held tab refuses writes until its on-disk draft is gone
    if (holdAtCall !== null && rec.held && rec.holdGen === holdAtCall) {
      if (fs.existsSync(currentPath) || fs.existsSync(previousPath)) return fail("HELD");
      rec.held = false;
    }

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

    // Temps live in drafts root, not tab folder (Windows)
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
        pendingTmps.length = 0;
        try { if (typeof hooks.onKill === "function") hooks.onKill(); } catch (_) { }
        return fail("EIO");
      }

      if (tombstones.has(tabId)) {
        cleanupTmps();
        return fail("DISCARDED");
      }
      // Re-check after awaits: tab may have navigated or been discarded
      if (rec.epoch !== epoch || !(seq > rec.floor)) {
        cleanupTmps();
        return fail("STALE_SEQ");
      }

      fs.mkdirSync(folder, { recursive: true });
      if (baseTmp) {
        renameSyncRetry(fs, baseTmp, path.join(folder, baseRef.file));
        pendingTmps.splice(pendingTmps.indexOf(baseTmp), 1);
      }
      // Order matters: base, then current->previous, then new current
      const currentExisted = fs.existsSync(currentPath);
      const headerThatBecamePrevious = currentExisted ? rec.lastHeader : null;
      forgetDiskState(rec);
      if (currentExisted) renameSyncRetry(fs, currentPath, previousPath);
      renameSyncRetry(fs, stateTmp, currentPath);
      pendingTmps.length = 0;

      rec.floor = seq;
      rec.lastSeq = seq;
      rec.lastBase = baseRef;
      rec.lastHeader = finalHeader;
      stats.writes++;

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
    const holdAtCall = rec.held ? rec.holdGen : null;
    const base = baseJson === undefined ? null : baseJson;
    return enqueue(tabId, () => doWrite(tabId, rec, epoch, holdAtCall, header, stateJson, base, seq));
  }

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

  // Only explicit user choice deletes drafts; tombstone survives restart
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

  // take never deletes or releases the hold
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
    if (cur.unsupported || prev.unsupported || cur.bad || prev.bad) return;
    const keep = [];
    if (cur.header && cur.header.base) keep.push(cur.header.base.file);
    if (prev.header && prev.header.base) keep.push(prev.header.base.file);
    pruneBases(folder, keep);
    if (cur.missing && prev.missing) {
      try { fs.rmdirSync(folder); } catch (_) { }
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

  function init() {
    fs.mkdirSync(dir, { recursive: true });
    const prior = readSessionSync();
    previousSession = prior && SESSION_STATES.has(prior.state) ? prior.state : "none";
    const priorTombstones = prior && Array.isArray(prior.discardedTabIds) ? prior.discardedTabIds.filter(validTabId) : [];

    const entries = readdirSafe(dir);
    for (const name of entries) {
      if (name.startsWith(".tmp-") || name.startsWith(".trash-")) rmQuiet(path.join(dir, name));
    }

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
