"use strict";
/* ---------------------------------------------------------------------
 * desktop/history-fs-backend.js: the desktop's storage for version history
 * (issue #83) — the backend shared/history-store.js runs over in main.
 *
 * shared/history-store.js decides WHAT is kept (put-if-absent, the stamp,
 * the trim, the cap, Older, holds, which bodies are unreferenced). This file
 * only keeps it on disk, behind the store's backend interface (read the
 * store's header): exclusive(fn, {write}), and a tx with list / get / put /
 * commit.
 *
 * Plain CommonJS with every dependency injected (fs, fsp, path, crypto),
 * never 'electron' — the shape of desktop/drafts.js and desktop/blob-store.js,
 * so desktop/test/history-fs-backend.test.mjs drives it from plain Node
 * against a temp folder and main.js decides where the folder lives.
 *
 * On-disk layout (dir = <userData>/history):
 *   FORMAT                    "2". A HIGHER number is a newer build's folder:
 *                             this one then goes read-only (reads work,
 *                             every write answers 'read-only').
 *   index.json                the current generation:
 *                               {formatVersion: 2,
 *                                buckets: {bucket: DocRecord},
 *                                trash: [sha],
 *                                migratedFrom?: 1}
 *                             (migratedFrom: written by 3.0.0's v1
 *                             migration; carried forward, never acted on)
 *                             DocRecord is the store's ({title,
 *                             lastOpenedAt, migratedAt?, expiresAt?,
 *                             snapshots: [meta + sha] oldest first}).
 *   index.prev.json           the generation before it
 *   index*.json.corrupt-<ts>  a generation that did not parse, moved aside
 *                             (never deleted: a person may want to look)
 *   .tmp-*                    an index write that died before its rename;
 *                             swept by open()
 *   bodies/                   the snapshot bodies: a createBlobStore folder
 *                             of its own (owner decision #83-1 — NOT the
 *                             image folder <userData>/blobs, because images
 *                             are never deleted (#82 D4) and history evicts).
 *                             Its own FORMAT "1", sha256/<aa>/<sha>.
 *   docs/, older/             the v1 layout (before #83), left DORMANT:
 *                             never read, written, moved or deleted here
 *                             (see "A RAW v1 TREE" below)
 *   v1-backup/                where 3.0.0's one-time migration put v1's
 *                             docs/ and older/; main deletes it at launch
 *                             (removeHistoryV1Backup), never this file
 *
 * THE INDEX is read once (open()) and kept in memory; main is its single
 * writer (the single-instance lock). Totals are never stored — the store
 * sums sizeBytes over the index. Bodies are never scanned: the index is the
 * whole truth, and a body it does not name is simply not history.
 *
 * DURABLE, TWO GENERATIONS (drafts.js's pattern). A commit writes the new
 * index to a temp file, fsyncs it, renames index.json → index.prev.json,
 * then the temp file → index.json, then fsyncs the folder. So:
 *   - a kill before the first rename leaves the old index.json (and a temp
 *     file the next open() sweeps);
 *   - a kill between the renames leaves no index.json and the old one as
 *     index.prev.json, which open() loads;
 *   - an index.json that does not parse (a disk that lied about the flush)
 *     is moved to .corrupt-<ts> and index.prev.json is loaded instead;
 *   - both bad → both moved aside, history starts empty. Nothing is deleted.
 *
 * BODY BEFORE INDEX (#52). tx.put writes and fsyncs the body before the
 * store's commit names it. A kill between the two leaves a body nothing
 * names — harmless, the prior generation is intact.
 *
 * DEFERRED UNLINK: WHY `trash`. A body the new index stops naming cannot be
 * unlinked when that index lands: index.prev.json still names it, and prev
 * is exactly what a torn index.json falls back to. So a commit that drops
 * shas (generation N) lists them in N's `trash`, and they are unlinked only
 * once generation N+1 is durable — when N becomes prev — and only if N+1
 * does not name them again (the same content can come back). A sha stays in
 * `trash` until an unlink of it has been seen to succeed, so a kill between
 * a durable index and its unlinks leaves them listed for the next commit to
 * finish. Bodies a failed job wrote but no index ever named join `trash` at
 * the next commit the same way.
 *
 * A MISSING BODY (someone deleted a file) is tx.get → null; the store then
 * drops every entry naming it (self-healing, no fsck). A body that is there
 * but cannot be read (a scanner holding it) is an 'io' error instead, never
 * null, or a transient lock would delete history.
 *
 * A RAW v1 TREE. 3.0.0 moved the v1 layout (FORMAT "1", docs/d-<docId>/
 * and older/ with .snap files) into v2 once and put it in v1-backup/; that
 * migrator is gone (#100). A folder that still has docs/ or older/ and no
 * index.json belongs to someone who skipped 3.0.0. It is opened like an
 * empty folder: no index → an empty history, FORMAT rewritten to "2", and
 * the first commit starts index.json beside the v1 folders. Nothing here
 * can reach them — sweepTemps() unlinks only top-level `.tmp-*` files,
 * moveAsideCorrupt() only renames index*.json, and every body lives under
 * bodies/ — so that history stays on disk untouched rather than destroyed.
 * If open() fails (a full disk), every job rejects with its code for the
 * rest of this process — the store answers it, the renderer keeps its
 * entries pending, and the next launch tries again.
 *
 * ONE QUEUE. exclusive() runs jobs strictly one after another — the
 * process-wide history queue (the store's rule: fn awaits only tx.* calls).
 * main creates exactly one backend per folder.
 * ------------------------------------------------------------------- */

const { createBlobStore, isSha256 } = require("./blob-store.js");

const FORMAT_VERSION = 2;
const INDEX_FILE = "index.json";
const PREV_FILE = "index.prev.json";
const BODIES_DIR = "bodies";

/* The same cap as a history body always had on the desktop (HISTORY-IPC). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

function noop() {}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* A blob-store write refusal → the store's codes. */
function bodyErrorCode(code) {
  if (code === "ENOSPC" || code === "EDQUOT") return "enospc";
  if (code === "READ_ONLY") return "read-only";
  return "io";
}

function snapshotsOf(rec) {
  return rec && Array.isArray(rec.snapshots) ? rec.snapshots : [];
}

function namedShas(buckets) {
  const named = new Set();
  for (const b of Object.keys(buckets)) {
    for (const s of snapshotsOf(buckets[b])) if (s && typeof s.sha === "string") named.add(s.sha);
  }
  return named;
}

/* A parsed index file → the document this backend works with, or null when
   it is not one (which is what "torn" means here: truncated JSON does not
   parse, and a parse that yields the wrong shape is no better). Entries
   without a usable sha are dropped: they could never be read. */
function cleanIndexDoc(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.buckets)) return null;
  const formatVersion = Number(raw.formatVersion);
  if (!Number.isFinite(formatVersion)) return null;
  const buckets = {};
  for (const b of Object.keys(raw.buckets)) {
    const rec = raw.buckets[b];
    if (!isPlainObject(rec) || !Array.isArray(rec.snapshots)) continue;
    const snaps = rec.snapshots.filter((s) => isPlainObject(s) && typeof s.id === "string" && isSha256(s.sha));
    if (!snaps.length) continue;
    buckets[b] = snaps.length === rec.snapshots.length ? rec : Object.assign({}, rec, { snapshots: snaps });
  }
  const trash = Array.isArray(raw.trash) ? raw.trash.filter(isSha256) : [];
  const doc = { formatVersion, buckets, trash };
  if (Number.isFinite(Number(raw.migratedFrom)) && raw.migratedFrom != null) doc.migratedFrom = Number(raw.migratedFrom);
  return doc;
}

function emptyDoc() {
  return { formatVersion: FORMAT_VERSION, buckets: {}, trash: [] };
}

function createHistoryFsBackend(opts) {
  const o = opts || {};
  const { dir, fs, fsp, path, crypto } = o;
  if (typeof dir !== "string" || !dir) throw new TypeError("createHistoryFsBackend: dir is required");
  if (!fs || !fsp || !path || !crypto) throw new TypeError("createHistoryFsBackend: fs, fsp, path and crypto are required");
  const now = typeof o.now === "function" ? o.now : Date.now;
  /* testHooks (unit tests; main passes them only under SPLITPAGE_TEST=1):
       afterBodyPut(sha)     a body is durable, the index does not name it
       beforeIndexWrite()    a commit is about to write its generation
       afterIndexTmp(tmp)    the temp file is written and fsynced
       afterIndexRotate()    index.json has become index.prev.json; the new
                             one is not in place yet
       beforeUnlink(sha)     the generation is durable; a trashed body is
                             about to go
     A hook may be async. A hook that THROWS IS A KILL: the backend stops
     where it stands — no temp file removed, nothing rolled back — and
     refuses every later job, exactly as a process that died there would
     leave the disk. The test then opens a new backend on the folder. */
  const hooks = isPlainObject(o.testHooks) ? o.testHooks : null;

  const indexPath = path.join(dir, INDEX_FILE);
  const prevPath = path.join(dir, PREV_FILE);
  const formatPath = path.join(dir, "FORMAT");
  const bodies = createBlobStore({
    dir: path.join(dir, BODIES_DIR), fs, fsp, path, crypto,
    maxBytes: Number.isInteger(o.maxBodyBytes) && o.maxBodyBytes > 0 ? o.maxBodyBytes : MAX_BODY_BYTES
  });

  let state = "idle";          /* idle | opening | ready | failed | dead */
  let readOnly = false;
  let openPromise = null;
  let openError = null;
  let loadedFrom = null;       /* "current" | "prev" | "empty" */
  let doc = emptyDoc();        /* the cached current generation */
  /* shas whose unlink succeeded after the last durable write; the next
     commit leaves them out of `trash`. */
  let gone = new Set();
  /* bodies written by a job that never committed, not named by the index */
  const orphans = new Set();
  let chain = Promise.resolve();
  let dead = false;
  const counts = { exclusive: 0, commit: 0, put: 0, unlinked: 0 };

  async function hook(name, ...args) {
    if (!hooks || typeof hooks[name] !== "function") return;
    try {
      await hooks[name](...args);
    } catch (err) {
      dead = true;
      state = "dead";
      throw err;
    }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function renameRetry(from, to) {
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(from, to);
        return;
      } catch (err) {
        if (attempt >= RENAME_ATTEMPTS || !err || !RENAME_RETRY_CODES.has(err.code)) throw err;
        await sleep(RENAME_RETRY_MS);
      }
    }
  }

  async function fsyncDirBestEffort(d) {
    let fh = null;
    try {
      fh = await fsp.open(d, "r");
      await fh.sync();
    } catch (_) {
      /* Windows cannot fsync a folder; NTFS journals the rename anyway */
    } finally {
      if (fh) { try { await fh.close(); } catch (_) { /* ignore */ } }
    }
  }

  async function exists(p) {
    try { await fsp.lstat(p); return true; } catch (err) {
      if (err && err.code === "ENOENT") return false;
      throw err;
    }
  }

  function tmpName(base) {
    return path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}-${base}`);
  }

  async function writeTmpDurable(tmp, text) {
    const buf = Buffer.from(text, "utf8");
    const fh = await fsp.open(tmp, "wx");
    let closed = false;
    try {
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await fh.write(buf, off, buf.length - off, null);
        off += bytesWritten;
      }
      await fh.sync();
      closed = true;
      await fh.close();
    } catch (err) {
      if (!closed) await fh.close().catch(noop);
      throw err;
    }
  }

  /* One durable generation: tmp + fsync, index.json → index.prev.json,
     tmp → index.json, fsync the folder. */
  async function writeGeneration(next) {
    const text = JSON.stringify(next);
    const tmp = tmpName(INDEX_FILE);
    try {
      await writeTmpDurable(tmp, text);
      await hook("afterIndexTmp", tmp);
      if (await exists(indexPath)) await renameRetry(indexPath, prevPath);
      await hook("afterIndexRotate");
      await renameRetry(tmp, indexPath);
    } catch (err) {
      if (dead) throw err;
      await fsp.unlink(tmp).catch(noop);
      throw err;
    }
    await fsyncDirBestEffort(dir);
  }

  /* A small durable file (FORMAT): tmp, fsync, rename. */
  async function writeSmallDurable(file, text) {
    const tmp = tmpName(path.basename(file));
    try {
      await writeTmpDurable(tmp, text);
      await renameRetry(tmp, file);
    } catch (err) {
      await fsp.unlink(tmp).catch(noop);
      throw err;
    }
    await fsyncDirBestEffort(dir);
  }

  /* → {doc} | {missing:true} | {bad:true}. A read error other than "not
     there" is thrown: a file a scanner holds is not a corrupt file, and
     moving it aside would lose a good generation. */
  async function readIndexFile(file) {
    let text;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return { missing: true };
      throw err;
    }
    let raw;
    try { raw = JSON.parse(text); } catch (_) { return { bad: true }; }
    const d = cleanIndexDoc(raw);
    return d ? { doc: d } : { bad: true };
  }

  async function moveAsideCorrupt(file) {
    if (readOnly) return;
    let dest = `${file}.corrupt-${now()}`;
    for (let n = 1; await exists(dest); n++) dest = `${file}.corrupt-${now()}-${n}`;
    await renameRetry(file, dest).catch(noop);
  }

  async function readFormat() {
    try {
      return (await fsp.readFile(formatPath, "utf8")).trim();
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
  }

  /* Leftover temp files from a write that died before its rename. Only
     this backend's own `.tmp-` prefix, only in its own folder. */
  async function sweepTemps() {
    let names;
    try { names = await fsp.readdir(dir); } catch (_) { return; }
    for (const name of names) {
      if (name.startsWith(".tmp-")) await fsp.unlink(path.join(dir, name)).catch(noop);
    }
  }

  async function loadIndex() {
    const cur = await readIndexFile(indexPath);
    if (cur.doc) { loadedFrom = "current"; return cur.doc; }
    const prev = await readIndexFile(prevPath);
    if (cur.bad) await moveAsideCorrupt(indexPath);
    if (prev.doc) { loadedFrom = "prev"; return prev.doc; }
    if (prev.bad) await moveAsideCorrupt(prevPath);
    loadedFrom = "empty";
    return emptyDoc();
  }

  async function doOpen() {
    state = "opening";
    await fsp.mkdir(dir, { recursive: true });
    let fmt = await readFormat();
    let n = fmt == null ? null : parseInt(fmt, 10);
    /* A number that cannot be read at all is treated as ours (v1's rule);
       a HIGHER one is a newer build's folder. */
    readOnly = Number.isFinite(n) && n > FORMAT_VERSION;
    if (!readOnly) {
      await sweepTemps();
      if (bodies.init().readOnly) readOnly = true;
    }
    doc = await loadIndex();
    if (Number(doc.formatVersion) > FORMAT_VERSION) readOnly = true;
    if (!readOnly) {
      fmt = await readFormat();
      n = fmt == null ? null : parseInt(fmt, 10);
      if (!(Number.isFinite(n) && n >= FORMAT_VERSION)) await writeSmallDurable(formatPath, FORMAT_VERSION + "\n");
    }
    state = "ready";
  }

  function open() {
    if (!openPromise) {
      openPromise = doOpen().then(() => ({ readOnly, loadedFrom }), (err) => {
        openError = err;
        if (!dead) state = "failed";
        throw err;
      });
      openPromise.catch(noop);
    }
    return openPromise;
  }

  /* ---- the transaction ---- */

  function makeTx(write) {
    let active = true;
    let commitCalled = false;
    let committed = false;       /* the generation landed */
    const putShas = [];

    function check(op, writes) {
      if (!active) throw codedError("io", `history: tx.${op} after its job finished (a non-tx await inside exclusive()?)`);
      if (dead) throw codedError("io", "history: the backend was killed (test hook)");
      if (writes) {
        if (!write) throw codedError("io", `history: tx.${op} in a read-only job`);
        if (readOnly) throw codedError("read-only", "history: the store is read-only");
      }
    }

    const tx = {
      list: async () => {
        check("list", false);
        return Object.assign({}, doc.buckets);
      },

      get: async (sha) => {
        check("get", false);
        if (!isSha256(sha)) return null;
        const buf = await bodies.get(sha);
        if (buf) return buf.toString("utf8");
        /* null from the blob store is "not there" OR "could not read it" OR
           "damaged, deleted". Only a body that is really gone may answer
           null — that is what makes the store drop its entries. */
        try {
          await fsp.stat(bodies.pathFor(sha));
        } catch (err) {
          if (err && err.code === "ENOENT") return null;
          throw codedError("io", `history: body ${sha} unreadable (${err && err.code})`);
        }
        throw codedError("io", `history: body ${sha} unreadable`);
      },

      put: async (sha, text) => {
        check("put", true);
        if (!isSha256(sha) || typeof text !== "string") throw codedError("io", "history: bad body");
        counts.put++;
        const r = await bodies.put(sha, Buffer.from(text, "utf8"));
        if (!r.ok) throw codedError(bodyErrorCode(r.code), `history: body write failed (${r.code})`);
        putShas.push(sha);
        gone.delete(sha);
        await hook("afterBodyPut", sha);
      },

      commit: async (changes, dropped) => {
        check("commit", true);
        if (commitCalled) throw codedError("io", "history: commit called twice in one transaction");
        commitCalled = true;
        counts.commit++;
        const buckets = Object.assign({}, doc.buckets);
        for (const b of Object.keys(changes || {})) {
          if (changes[b]) buckets[b] = changes[b];
          else delete buckets[b];
        }
        const named = namedShas(buckets);
        /* Unlinkable once THIS generation is durable: the previous
           generation's trash (the one about to become prev never named
           them), unless named again now. */
        const eligible = doc.trash.filter((s) => !named.has(s) && !gone.has(s));
        const trash = [];
        const seen = new Set();
        const add = (s) => {
          if (!isSha256(s) || seen.has(s) || named.has(s) || gone.has(s)) return;
          seen.add(s);
          trash.push(s);
        };
        (Array.isArray(dropped) ? dropped : []).forEach(add);
        putShas.forEach((s) => { if (!named.has(s)) add(s); });
        doc.trash.forEach(add);
        orphans.forEach(add);
        const next = { formatVersion: FORMAT_VERSION, buckets, trash };
        if (doc.migratedFrom != null) next.migratedFrom = doc.migratedFrom;

        await hook("beforeIndexWrite");
        await writeGeneration(next);
        committed = true;
        doc = next;
        gone = new Set();
        orphans.clear();

        for (const s of eligible) {
          await hook("beforeUnlink", s);
          await bodies.delete(s);
          if (!(await bodies.has(s))) { gone.add(s); counts.unlinked++; }
        }
      }
    };

    return {
      tx,
      finish() {
        active = false;
        if (committed || dead) return;
        /* A job that wrote bodies and never committed them (a failed
           commit, a store error after tx.put) leaves them for the next
           commit's trash. */
        const named = namedShas(doc.buckets);
        for (const s of putShas) if (!named.has(s)) orphans.add(s);
      }
    };
  }

  function exclusive(fn, xo) {
    const write = !(xo && xo.write === false);
    counts.exclusive++;
    const job = chain.then(async () => {
      await open();
      if (dead) throw codedError("io", "history: the backend was killed (test hook)");
      const t = makeTx(write);
      try {
        return await fn(t.tx);
      } finally {
        t.finish();
      }
    });
    chain = job.then(noop, noop);
    return job;
  }

  return {
    name: typeof o.name === "string" ? o.name : "desktop",
    persistent: true,
    get readOnly() { return readOnly; },
    /* "idle" | "opening" | "ready" | "failed" | "dead" */
    get state() { return state; },
    get openError() { return openError; },
    exclusive,
    open,
    counts,
    /* For tests and diagnostics: what open() found and the cached index.
       Never sent to a renderer. */
    inspect: () => ({
      state, readOnly, loadedFrom,
      index: JSON.parse(JSON.stringify(doc)),
      gone: [...gone],
      orphans: [...orphans]
    }),
    bodies,
    paths: { dir, index: indexPath, prev: prevPath, format: formatPath, bodies: path.join(dir, BODIES_DIR) }
  };
}

module.exports = {
  createHistoryFsBackend,
  cleanIndexDoc,
  FORMAT_VERSION,
  INDEX_FILE,
  PREV_FILE,
  BODIES_DIR,
  MAX_BODY_BYTES
};
