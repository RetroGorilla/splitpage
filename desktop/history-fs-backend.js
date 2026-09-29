"use strict";

const { createBlobStore, isSha256 } = require("./blob-store.js");

const FORMAT_VERSION = 2;
const INDEX_FILE = "index.json";
const PREV_FILE = "index.prev.json";
const BODIES_DIR = "bodies";

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
  const hooks = isPlainObject(o.testHooks) ? o.testHooks : null;

  const indexPath = path.join(dir, INDEX_FILE);
  const prevPath = path.join(dir, PREV_FILE);
  const formatPath = path.join(dir, "FORMAT");
  const bodies = createBlobStore({
    dir: path.join(dir, BODIES_DIR), fs, fsp, path, crypto,
    maxBytes: Number.isInteger(o.maxBodyBytes) && o.maxBodyBytes > 0 ? o.maxBodyBytes : MAX_BODY_BYTES
  });

  let state = "idle";
  let readOnly = false;
  let openPromise = null;
  let openError = null;
  let loadedFrom = null;
  let doc = emptyDoc();
  let gone = new Set();
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
    } finally {
      if (fh) { try { await fh.close(); } catch (_) { } }
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

  function makeTx(write) {
    let active = true;
    let commitCalled = false;
    let committed = false;
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
    get state() { return state; },
    get openError() { return openError; },
    exclusive,
    open,
    counts,
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
