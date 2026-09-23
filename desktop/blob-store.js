"use strict";
/* ---------------------------------------------------------------------
 * desktop/blob-store.js: the content-addressed blob folder (issue #82).
 *
 * Images leave the document state and live here instead, keyed by the
 * SHA-256 of their bytes. A row carries {sha256, width, height, mime}; the
 * bytes are fetched from this folder by that sha when the page needs them.
 * The browser keeps the same thing in IndexedDB (src/js/02c-blobs.js); this
 * is the desktop app's store for it, under <userData>/blobs, outside the
 * Chromium profile for the same reason version history is: a user can find
 * it, back it up and see what it costs.
 *
 * Plain CommonJS with every dependency injected (fs, fsp, path, crypto),
 * never 'electron' — the same shape as desktop/drafts.js, so
 * desktop/test/blob-store.test.mjs drives it from plain Node against a temp
 * folder, and main.js decides where the folder lives.
 *
 * On-disk layout (dir = <userData>/blobs):
 *   FORMAT                  "1"
 *   sha256/<aa>/<sha64>     the raw bytes, nothing else; <aa> is the sha's
 *                           first two hex digits (256 shards at most)
 *   sha256/<aa>/.tmp-*      transient; swept by init()
 *
 * The store knows nothing about WHAT the bytes are. It is a content-addressed
 * folder and its layout says only "sha256 of these bytes"; #83 means to keep
 * history snapshot bodies here too. What may be stored through a given door
 * is that door's business: splitpage:blob-put (main.js) accepts images only,
 * through imageBlobRefusal() below, which is exported from here only so the
 * IPC layer and this file's unit test share one copy of the rule.
 *
 * INTEGRITY. A file's name IS its checksum. put() refuses bytes that do not
 * hash to the sha they are offered under; get() hashes what it read and,
 * when it no longer matches (a torn write from before this store existed, a
 * disk that flipped a bit, a hand edit), deletes the file and answers null.
 * Deleting is safe here in a way it never is for a draft: the file is
 * provably NOT the bytes anyone asked for, and anything that still has the
 * real bytes (a document file inlines them, #82 D1) can put them back.
 *
 * NOTHING ELSE DELETES. #82 D4: no garbage collection in this issue. list()
 * and delete() exist for a later collector and for tests; no IPC channel
 * reaches delete().
 * ------------------------------------------------------------------- */

const SHA256_RE = /^[0-9a-f]{64}$/;
const FORMAT_VERSION = "1";

/* The store's own ceiling, for any caller. The image door is much tighter
   (MAX_IMAGE_BLOB_BYTES); this only stops something runaway from filling
   the disk through a door that forgot its own cap. */
const MAX_BLOB_BYTES = 256 * 1024 * 1024;

/* One image, as splitpage:blob-put accepts it. A pasted photo is a few MB;
   16 MiB is room for a large PNG screenshot and not much more. */
const MAX_IMAGE_BLOB_BYTES = 16 * 1024 * 1024;

/* The most shas one splitpage:blob-missing call may ask about. */
const MAX_MISSING_QUERY = 2000;

/* Codes a Windows rename returns when the destination is transiently held
   open by an antivirus scan, the search indexer or a sync client (the same
   set drafts.js retries). */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

/* Write failures a caller could recover from by trying again later. Anything
   else is still answered with a code, never an exception's text. */
const WRITE_ERROR_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EBUSY", "EIO", "EROFS", "EDQUOT"]);

function isSha256(v) {
  return typeof v === "string" && SHA256_RE.test(v);
}

/* ---- the image rule (the IPC layer's, not the store's) ----------------

   Magic numbers only, the four raster types the app renders: PNG, JPEG,
   GIF, WebP. Never SVG — an SVG is a document that can carry script, and
   nothing about "it hashed right" makes it safe to hand back to a page. */
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

/* null when `bytes` may go through the image door, else the code it is
   refused with. Size first, so an oversized upload is not sniffed at all. */
function imageBlobRefusal(bytes) {
  if (!bytes || typeof bytes.length !== "number" || bytes.length === 0) return "EMPTY";
  if (bytes.length > MAX_IMAGE_BLOB_BYTES) return "TOO_LARGE";
  if (!sniffImageMime(bytes)) return "NOT_AN_IMAGE";
  return null;
}

/* ---- the store ------------------------------------------------------- */

function createBlobStore(opts) {
  const o = opts || {};
  const { dir, fs, fsp, path, crypto } = o;
  if (typeof dir !== "string" || !dir) throw new TypeError("createBlobStore: dir is required");
  if (!fs || !fsp || !path || !crypto) throw new TypeError("createBlobStore: fs, fsp, path and crypto are required");
  const maxBytes = Number.isInteger(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : MAX_BLOB_BYTES;
  /* testHooks: {beforeRename(tmpPath)} lets the unit test stop a put
     between its fsync and its rename — the moment a power cut leaves a
     .tmp- file behind. Nothing in main.js passes it. */
  const hooks = o.testHooks && typeof o.testHooks === "object" ? o.testHooks : null;

  const shaRoot = path.join(dir, "sha256");
  let readOnly = false;
  let initialised = false;

  /* One operation per sha at a time. Without it a get() that found a damaged
     file could unlink the good copy a concurrent put() had just renamed into
     its place. Different shas never wait for each other. */
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

  /* Best effort: makes the rename itself durable on POSIX. Windows cannot
     open a directory for fsync (EPERM/EISDIR) and NTFS journals the rename
     anyway, so any failure here is ignored. */
  async function fsyncDirBestEffort(d) {
    let fh = null;
    try {
      fh = await fsp.open(d, "r");
      await fh.sync();
    } catch (_) {
      /* not supported here */
    } finally {
      if (fh) { try { await fh.close(); } catch (_) { /* ignore */ } }
    }
  }

  /* A small durable sync write for FORMAT — the drafts.js pattern: temp
     file in the same folder, write, fsync, rename. */
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
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* already failing */ } }
      try { fs.unlinkSync(tmp); } catch (_) { /* never created */ }
      throw err;
    }
  }

  /* Leftover temp files: a put that died between its write and its rename.
     They are never anyone's data (the rename is what publishes a blob), so
     they are deleted. Runs from init(), before any put of this process can
     have a temp file of its own in flight. */
  function sweepTemps() {
    let removed = 0;
    const sweepIn = (d) => {
      let names;
      try { names = fs.readdirSync(d); } catch (_) { return; }
      for (const name of names) {
        if (!name.startsWith(".tmp-")) continue;
        try { fs.unlinkSync(path.join(d, name)); removed++; } catch (_) { /* locked by a scanner: next launch */ }
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

  /* Creates the folder and FORMAT if they are missing, and sweeps temps.
     A FORMAT that is not ours means a newer app wrote this folder: this
     one still READS (every file is checked against its own name, whatever
     wrote it) but writes nothing into a layout it does not know. */
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

  /* Stores `bytes` under `sha`. Answers {ok:true, stored:true} when it wrote
     the file, {ok:true, stored:false} when it was already there, and
     {ok:false, code} otherwise — never throws for anything a caller sent.

     "Already there" is judged by size, not by re-hashing the stored file:
     re-putting a known image is the common case and should cost a stat.
     A same-size damaged file is caught by get(), which deletes it, and the
     next put writes it back. */
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
        if (fh) { try { await fh.close(); } catch (_) { /* already failing */ } }
        try { await fsp.unlink(tmp); } catch (_) { /* never created, or already renamed */ }
        /* A rename that lost to a locked target can still have lost to an
           identical file: the name is the content, so an intact one there
           is success. */
        if ((await statSize(target)) === buf.length) return { ok: true, stored: false };
        const code = err && WRITE_ERROR_CODES.has(err.code) ? err.code : "WRITE_FAILED";
        return { ok: false, code };
      }
      await fsyncDirBestEffort(shard);
      return { ok: true, stored: true };
    });
  }

  /* The bytes stored under `sha` as a Buffer, or null when there are none
     or what is there no longer hashes to its name (then it is deleted). */
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
        try { await fsp.unlink(file); } catch (_) { /* a scanner holds it: get() will try again */ }
        return null;
      }
      return buf;
    });
  }

  /* The shas of `shas` this store does not hold, first-seen order, no
     duplicates. A string that is not a sha is "missing" too: it certainly
     is not here. */
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

  /* Every sha stored, in no particular order. Only files whose name is a sha
     AND sits in the shard its first two digits name are counted — anything
     else in the folder is not a blob of this store. */
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

  /* Removes one blob. true when a file was removed. Not reachable over IPC
     (#82 D4); here for a later collector and the tests. */
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
    /* For tests and diagnostics only: where a sha's bytes live. Never sent
       to a renderer (invariant #28 — the page names blobs by sha alone). */
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
