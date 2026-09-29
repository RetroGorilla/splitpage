"use strict";

const SHA256_RE = /^[0-9a-f]{64}$/;
const FORMAT_VERSION = "1";

const MAX_BLOB_BYTES = 256 * 1024 * 1024;

const MAX_IMAGE_BLOB_BYTES = 16 * 1024 * 1024;

const MAX_MISSING_QUERY = 2000;

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

const WRITE_ERROR_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EBUSY", "EIO", "EROFS", "EDQUOT"]);

function isSha256(v) {
  return typeof v === "string" && SHA256_RE.test(v);
}

function sniffImageMime(bytes) {
  const b = bytes;
  if (!b || typeof b.length !== "number") return null;
  const at = (i) => b[i];
  if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
      at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 &&
      (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return "image/gif";
  if (b.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
      at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

function imageBlobRefusal(bytes) {
  if (!bytes || typeof bytes.length !== "number" || bytes.length === 0) return "EMPTY";
  if (bytes.length > MAX_IMAGE_BLOB_BYTES) return "TOO_LARGE";
  if (!sniffImageMime(bytes)) return "NOT_AN_IMAGE";
  return null;
}

function createBlobStore(opts) {
  const o = opts || {};
  const { dir, fs, fsp, path, crypto } = o;
  if (typeof dir !== "string" || !dir) throw new TypeError("createBlobStore: dir is required");
  if (!fs || !fsp || !path || !crypto) throw new TypeError("createBlobStore: fs, fsp, path and crypto are required");
  const maxBytes = Number.isInteger(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : MAX_BLOB_BYTES;
  const hooks = o.testHooks && typeof o.testHooks === "object" ? o.testHooks : null;

  const shaRoot = path.join(dir, "sha256");
  let readOnly = false;
  let initialised = false;

  const locks = new Map();
  function withLock(sha, fn) {
    const prev = locks.get(sha) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    locks.set(sha, tail);
    tail.then(() => { if (locks.get(sha) === tail) locks.delete(sha); });
    return run;
  }

  function hashHex(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  function shardDir(sha) {
    return path.join(shaRoot, sha.slice(0, 2));
  }

  function blobPath(sha) {
    return path.join(shardDir(sha), sha);
  }

  function toBuf(bytes) {
    if (Buffer.isBuffer(bytes)) return bytes;
    if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
    if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

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

  function writeSmallDurableSync(file, text) {
    const tmp = path.join(path.dirname(file), `.tmp-${crypto.randomBytes(6).toString("hex")}-${path.basename(file)}`);
    let fd = null;
    try {
      fd = fs.openSync(tmp, "wx");
      fs.writeSync(fd, Buffer.from(text, "utf8"));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, file);
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { } }
      try { fs.unlinkSync(tmp); } catch (_) { }
      throw err;
    }
  }

  function sweepTemps() {
    let removed = 0;
    const sweepIn = (d) => {
      let names;
      try { names = fs.readdirSync(d); } catch (_) { return; }
      for (const name of names) {
        if (!name.startsWith(".tmp-")) continue;
        try { fs.unlinkSync(path.join(d, name)); removed++; } catch (_) { }
      }
    };
    sweepIn(dir);
    let shards;
    try { shards = fs.readdirSync(shaRoot); } catch (_) { shards = []; }
    for (const s of shards) {
      if (/^[0-9a-f]{2}$/.test(s)) sweepIn(path.join(shaRoot, s));
    }
    return removed;
  }

  function init() {
    fs.mkdirSync(shaRoot, { recursive: true });
    const formatFile = path.join(dir, "FORMAT");
    let text;
    try { text = fs.readFileSync(formatFile, "utf8").trim(); } catch (_) { text = null; }
    if (text === null) {
      writeSmallDurableSync(formatFile, FORMAT_VERSION + "\n");
      readOnly = false;
    } else {
      readOnly = text !== FORMAT_VERSION;
    }
    const tempsRemoved = sweepTemps();
    initialised = true;
    return { readOnly, tempsRemoved };
  }

  function ensureInit() {
    if (!initialised) init();
  }

  async function statSize(file) {
    try {
      const st = await fsp.stat(file);
      return st.isFile() ? st.size : -1;
    } catch (_) {
      return -1;
    }
  }

  async function has(sha) {
    if (!isSha256(sha)) return false;
    return (await statSize(blobPath(sha))) >= 0;
  }

  function put(sha, bytes) {
    if (!isSha256(sha)) return Promise.resolve({ ok: false, code: "BAD_SHA" });
    const buf = toBuf(bytes);
    if (!buf) return Promise.resolve({ ok: false, code: "BAD_BYTES" });
    if (buf.length > maxBytes) return Promise.resolve({ ok: false, code: "TOO_LARGE" });
    if (hashHex(buf) !== sha) return Promise.resolve({ ok: false, code: "HASH_MISMATCH" });
    return withLock(sha, async () => {
      ensureInit();
      const target = blobPath(sha);
      if ((await statSize(target)) === buf.length) return { ok: true, stored: false };
      if (readOnly) return { ok: false, code: "READ_ONLY" };
      const shard = shardDir(sha);
      const tmp = path.join(shard, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
      let fh = null;
      try {
        await fsp.mkdir(shard, { recursive: true });
        fh = await fsp.open(tmp, "wx");
        let off = 0;
        while (off < buf.length) {
          const { bytesWritten } = await fh.write(buf, off, buf.length - off);
          off += bytesWritten;
        }
        await fh.sync();
        await fh.close();
        fh = null;
        if (hooks && typeof hooks.beforeRename === "function") await hooks.beforeRename(tmp);
        await renameRetry(tmp, target);
      } catch (err) {
        if (fh) { try { await fh.close(); } catch (_) { } }
        try { await fsp.unlink(tmp); } catch (_) { }
        if ((await statSize(target)) === buf.length) return { ok: true, stored: false };
        const code = err && WRITE_ERROR_CODES.has(err.code) ? err.code : "WRITE_FAILED";
        return { ok: false, code };
      }
      await fsyncDirBestEffort(shard);
      return { ok: true, stored: true };
    });
  }

  function get(sha) {
    if (!isSha256(sha)) return Promise.resolve(null);
    return withLock(sha, async () => {
      const file = blobPath(sha);
      let buf;
      try {
        buf = await fsp.readFile(file);
      } catch (_) {
        return null;
      }
      if (hashHex(buf) !== sha) {
        try { await fsp.unlink(file); } catch (_) { }
        return null;
      }
      return buf;
    });
  }

  async function missing(shas) {
    const out = [];
    const seen = new Set();
    for (const sha of Array.isArray(shas) ? shas : []) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (!(await has(sha))) out.push(sha);
    }
    return out;
  }

  async function list() {
    const out = [];
    let shards;
    try { shards = await fsp.readdir(shaRoot); } catch (_) { return out; }
    for (const s of shards) {
      if (!/^[0-9a-f]{2}$/.test(s)) continue;
      let names;
      try { names = await fsp.readdir(path.join(shaRoot, s)); } catch (_) { continue; }
      for (const n of names) if (isSha256(n) && n.slice(0, 2) === s) out.push(n);
    }
    return out;
  }

  function del(sha) {
    if (!isSha256(sha)) return Promise.resolve(false);
    return withLock(sha, async () => {
      try {
        await fsp.unlink(blobPath(sha));
        return true;
      } catch (_) {
        return false;
      }
    });
  }

  return {
    init,
    sweepTemps,
    has,
    put,
    get,
    missing,
    list,
    delete: del,
    get readOnly() { return readOnly; },
    pathFor: (sha) => (isSha256(sha) ? blobPath(sha) : null)
  };
}

module.exports = {
  createBlobStore,
  sniffImageMime,
  imageBlobRefusal,
  isSha256,
  SHA256_RE,
  MAX_BLOB_BYTES,
  MAX_IMAGE_BLOB_BYTES,
  MAX_MISSING_QUERY,
  FORMAT_VERSION
};
