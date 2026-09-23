/* desktop/test/blob-store.test.mjs: unit tests for desktop/blob-store.js.
 *
 * Node built-ins only, no Electron. Every case works in its own folder under
 * os.tmpdir() and the whole temp root is removed at the end. Prints ALL PASS
 * and exits 0, or lists the failures and exits 1.
 *
 * Run: node desktop/test/blob-store.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  createBlobStore, sniffImageMime, imageBlobRefusal, isSha256,
  MAX_IMAGE_BLOB_BYTES, MAX_MISSING_QUERY, FORMAT_VERSION
} = require(path.join(here, "..", "blob-store.js"));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-blobs-test-"));

let caseCounter = 0;
function freshDir() {
  return path.join(ROOT, `case-${++caseCounter}`, "blobs");
}

function makeStore(dir, extra) {
  return createBlobStore(Object.assign({ dir, fs, fsp, path, crypto }, extra || {}));
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* Real magic numbers, then a random tail so each fixture has its own sha. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function png(n = 64) {
  return Buffer.concat([Buffer.from(PNG_MAGIC), crypto.randomBytes(n)]);
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(32)]);
const gif = () => Buffer.concat([Buffer.from("GIF89a", "latin1"), crypto.randomBytes(32)]);
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 "), crypto.randomBytes(32)]);

function walk(dir) {
  const out = [];
  (function go(d) {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      out.push(path.relative(dir, p));
      if (fs.statSync(p).isDirectory()) go(p);
    }
  })(dir);
  return out.sort();
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ------------------------------------------------------------------ */

test("init creates FORMAT \"1\" and sha256/, and is repeatable", () => {
  const dir = freshDir();
  const s = makeStore(dir);
  const r = s.init();
  assert.deepEqual(r, { readOnly: false, tempsRemoved: 0 });
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8").trim(), FORMAT_VERSION);
  assert.equal(FORMAT_VERSION, "1");
  assert.ok(fs.statSync(path.join(dir, "sha256")).isDirectory());
  assert.deepEqual(makeStore(dir).init(), { readOnly: false, tempsRemoved: 0 });
  assert.deepEqual(walk(dir), ["FORMAT", "sha256"], "no temp file left by the FORMAT write");
});

test("put stores the raw bytes at sha256/<aa>/<sha>, atomically, and get returns them", async () => {
  const dir = freshDir();
  const s = makeStore(dir);
  s.init();
  const bytes = png();
  const h = sha(bytes);
  const r = await s.put(h, bytes);
  assert.deepEqual(r, { ok: true, stored: true });
  const file = path.join(dir, "sha256", h.slice(0, 2), h);
  assert.equal(s.pathFor(h), file);
  assert.ok(fs.readFileSync(file).equals(bytes), "the file is exactly the bytes");
  assert.deepEqual(walk(path.join(dir, "sha256")), [h.slice(0, 2), path.join(h.slice(0, 2), h)], "no temp file left behind");
  const got = await s.get(h);
  assert.ok(Buffer.isBuffer(got) && got.equals(bytes));
  assert.equal(await s.has(h), true);
});

test("a put accepts a Uint8Array view and an ArrayBuffer, not just a Buffer", async () => {
  const s = makeStore(freshDir());
  s.init();
  const a = png();
  const big = new Uint8Array(a.length + 10);
  big.set(a, 5);
  const view = big.subarray(5, 5 + a.length);
  assert.deepEqual(await s.put(sha(a), view), { ok: true, stored: true });
  const b = jpeg();
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  assert.deepEqual(await s.put(sha(b), ab), { ok: true, stored: true });
  assert.ok((await s.get(sha(a))).equals(a));
  assert.equal(await s.put(sha(a), "not bytes").then((r) => r.code), "BAD_BYTES");
});

test("re-putting a stored blob is a no-op (stored:false, file untouched)", async () => {
  const dir = freshDir();
  const s = makeStore(dir);
  s.init();
  const bytes = png();
  const h = sha(bytes);
  await s.put(h, bytes);
  const file = s.pathFor(h);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
  const before = fs.statSync(file).mtimeMs;
  assert.deepEqual(await s.put(h, bytes), { ok: true, stored: false });
  assert.equal(fs.statSync(file).mtimeMs, before, "not rewritten");
  /* Concurrent puts of one sha: one writes, the rest see it there. */
  const bytes2 = gif();
  const results = await Promise.all([1, 2, 3, 4].map(() => s.put(sha(bytes2), bytes2)));
  assert.equal(results.filter((r) => r.ok && r.stored).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.ok && !r.stored).length, 3);
});

test("a put whose bytes do not hash to the sha is refused and writes nothing", async () => {
  const dir = freshDir();
  const s = makeStore(dir);
  s.init();
  const bytes = png();
  const other = sha(png());
  assert.deepEqual(await s.put(other, bytes), { ok: false, code: "HASH_MISMATCH" });
  assert.deepEqual(walk(path.join(dir, "sha256")), []);
  assert.equal(await s.has(other), false);
});

test("a sha that is not 64 lowercase hex is refused everywhere, never turned into a path", async () => {
  const s = makeStore(freshDir());
  s.init();
  const bytes = png();
  const h = sha(bytes);
  for (const bad of [h.toUpperCase(), h.slice(1), h + "0", "../" + h.slice(3), "..", "", null, 42, {}]) {
    assert.deepEqual(await s.put(bad, bytes), { ok: false, code: "BAD_SHA" }, JSON.stringify(bad));
    assert.equal(await s.get(bad), null);
    assert.equal(await s.has(bad), false);
    assert.equal(await s.delete(bad), false);
    assert.equal(s.pathFor(bad), null);
  }
  assert.equal(isSha256(h), true);
  assert.equal(isSha256(h.toUpperCase()), false);
});

test("a stored file that no longer matches its name: get deletes it and returns null; a re-put heals it", async () => {
  const dir = freshDir();
  const s = makeStore(dir);
  s.init();
  const bytes = png();
  const h = sha(bytes);
  await s.put(h, bytes);
  const file = s.pathFor(h);
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] ^= 0xff;
  fs.writeFileSync(file, damaged);
  assert.equal(await s.get(h), null);
  assert.equal(fs.existsSync(file), false, "the damaged file is gone");
  assert.deepEqual(await s.missing([h]), [h]);
  assert.deepEqual(await s.put(h, bytes), { ok: true, stored: true });
  assert.ok((await s.get(h)).equals(bytes));
  /* A truncated (torn) file is shorter than the bytes, so even a re-put
     without a get in between rewrites it rather than trusting it. */
  fs.writeFileSync(file, bytes.subarray(0, 4));
  assert.deepEqual(await s.put(h, bytes), { ok: true, stored: true });
  assert.ok(fs.readFileSync(file).equals(bytes));
});

test("a put that dies between fsync and rename leaves only a .tmp- file, which the next init sweeps", async () => {
  const dir = freshDir();
  let seen = null;
  const s = makeStore(dir, { testHooks: { beforeRename(tmp) { seen = tmp; throw Object.assign(new Error("power cut"), { code: "EIO" }); } } });
  s.init();
  const bytes = png();
  const h = sha(bytes);
  const r = await s.put(h, bytes);
  assert.deepEqual(r, { ok: false, code: "EIO" });
  assert.ok(seen && path.basename(seen).startsWith(".tmp-"), "the temp file is named .tmp-*");
  assert.equal(path.dirname(seen), path.join(dir, "sha256", h.slice(0, 2)), "and it is in the shard folder");
  assert.equal(await s.has(h), false, "nothing was published");
  /* The in-process failure path already cleans up; simulate the case where
     the process itself died and nothing could. */
  const blob = jpeg();
  const s2 = makeStore(dir);
  s2.init();
  await s2.put(sha(blob), blob);
  fs.writeFileSync(path.join(dir, "sha256", h.slice(0, 2), ".tmp-deadbeef0000"), bytes);
  fs.writeFileSync(path.join(dir, ".tmp-abcdef-FORMAT"), "1\n");
  const r2 = makeStore(dir).init();
  assert.equal(r2.tempsRemoved, 2);
  const left = walk(dir).filter((p) => path.basename(p).startsWith(".tmp-"));
  assert.deepEqual(left, []);
  assert.equal(await makeStore(dir).has(sha(blob)), true, "a real blob is never swept");
});

test("missing() answers the shas not held, first-seen order, no duplicates", async () => {
  const s = makeStore(freshDir());
  s.init();
  const a = png(), b = jpeg(), c = webp();
  await s.put(sha(a), a);
  await s.put(sha(c), c);
  const want = [sha(b), sha(a), sha(b), sha(c), "f".repeat(64)];
  assert.deepEqual(await s.missing(want), [sha(b), "f".repeat(64)]);
  assert.deepEqual(await s.missing([]), []);
  assert.equal(MAX_MISSING_QUERY, 2000);
});

test("list() names every stored sha and nothing else; delete() removes one", async () => {
  const dir = freshDir();
  const s = makeStore(dir);
  s.init();
  const blobs = [png(), jpeg(), gif(), webp()];
  for (const b of blobs) await s.put(sha(b), b);
  /* Things in the folder that are not blobs of this store. */
  const stray = sha(png());
  fs.mkdirSync(path.join(dir, "sha256", "zz"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sha256", "zz", stray), "x");
  const wrongShard = stray.slice(0, 2) === "00" ? "01" : "00";
  fs.mkdirSync(path.join(dir, "sha256", wrongShard), { recursive: true });
  fs.writeFileSync(path.join(dir, "sha256", wrongShard, stray), "x");
  assert.deepEqual((await s.list()).sort(), blobs.map(sha).sort());
  assert.equal(await s.delete(sha(blobs[0])), true);
  assert.equal(await s.delete(sha(blobs[0])), false);
  assert.equal((await s.list()).length, 3);
});

test("a FORMAT this build does not know makes the store read-only, still readable", async () => {
  const dir = freshDir();
  const s = makeStore(dir);
  s.init();
  const held = png();
  await s.put(sha(held), held);
  fs.writeFileSync(path.join(dir, "FORMAT"), "2\n");
  const s2 = makeStore(dir);
  assert.equal(s2.init().readOnly, true);
  assert.equal(s2.readOnly, true);
  const fresh = jpeg();
  assert.deepEqual(await s2.put(sha(fresh), fresh), { ok: false, code: "READ_ONLY" });
  assert.ok((await s2.get(sha(held))).equals(held), "reads still work");
  assert.deepEqual(await s2.put(sha(held), held), { ok: true, stored: false }, "an already-held blob is still a success");
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8"), "2\n", "FORMAT is never rewritten");
});

test("a put over the store's own cap is refused", async () => {
  const s = makeStore(freshDir(), { maxBytes: 100 });
  s.init();
  const bytes = png(200);
  assert.deepEqual(await s.put(sha(bytes), bytes), { ok: false, code: "TOO_LARGE" });
});

test("a put before init() initialises the folder itself", async () => {
  const dir = freshDir();
  const s = makeStore(dir);
  const bytes = png();
  assert.deepEqual(await s.put(sha(bytes), bytes), { ok: true, stored: true });
  assert.equal(fs.readFileSync(path.join(dir, "FORMAT"), "utf8").trim(), "1");
});

test("a get racing a put of the same sha never loses the good copy", async () => {
  const s = makeStore(freshDir());
  s.init();
  const bytes = png(4096);
  const h = sha(bytes);
  await s.put(h, bytes);
  const damaged = Buffer.from(bytes);
  damaged[20] ^= 1;
  fs.writeFileSync(s.pathFor(h), damaged);
  /* The get sees the damaged file and deletes it; the put queued behind it
     then writes the good copy, which nothing deletes afterwards. */
  const [got, put] = await Promise.all([s.get(h), s.put(h, bytes)]);
  assert.equal(got, null);
  assert.deepEqual(put, { ok: true, stored: true });
  assert.ok((await s.get(h)).equals(bytes));
});

/* ---- the IPC door's image rule ---------------------------------------- */

test("sniffImageMime knows PNG, JPEG, GIF and WebP by their magic, and nothing else", () => {
  assert.equal(sniffImageMime(png()), "image/png");
  assert.equal(sniffImageMime(jpeg()), "image/jpeg");
  assert.equal(sniffImageMime(gif()), "image/gif");
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from("GIF87a"), crypto.randomBytes(8)])), "image/gif");
  assert.equal(sniffImageMime(webp()), "image/webp");
  assert.equal(sniffImageMime(new Uint8Array(png())), "image/png", "a plain Uint8Array too");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(sniffImageMime(svg), null, "SVG is never an image here");
  assert.equal(sniffImageMime(Buffer.from('<?xml version="1.0"?><svg/>')), null);
  assert.equal(sniffImageMime(Buffer.from("<html><body>hi</body></html>")), null);
  assert.equal(sniffImageMime(Buffer.from("RIFF\0\0\0\0WAVEfmt ")), null, "a RIFF that is not WebP");
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null, "a truncated PNG signature");
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  assert.equal(sniffImageMime(null), null);
});

test("imageBlobRefusal: empty, over 16 MiB, or not an image is refused; a real image passes", () => {
  assert.equal(MAX_IMAGE_BLOB_BYTES, 16 * 1024 * 1024);
  assert.equal(imageBlobRefusal(png()), null);
  assert.equal(imageBlobRefusal(webp()), null);
  assert.equal(imageBlobRefusal(Buffer.alloc(0)), "EMPTY");
  assert.equal(imageBlobRefusal(null), "EMPTY");
  assert.equal(imageBlobRefusal(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), "NOT_AN_IMAGE");
  assert.equal(imageBlobRefusal(Buffer.from("plain text")), "NOT_AN_IMAGE");
  const atCap = Buffer.alloc(MAX_IMAGE_BLOB_BYTES);
  Buffer.from(PNG_MAGIC).copy(atCap);
  assert.equal(imageBlobRefusal(atCap), null, "exactly 16 MiB is allowed");
  const over = Buffer.alloc(MAX_IMAGE_BLOB_BYTES + 1);
  Buffer.from(PNG_MAGIC).copy(over);
  assert.equal(imageBlobRefusal(over), "TOO_LARGE");
});

test("the store itself stores any bytes: the image rule is the IPC layer's, not the layout's", async () => {
  const s = makeStore(freshDir());
  s.init();
  const body = Buffer.from(JSON.stringify({ rows: [{ id: "r1" }] }));
  assert.deepEqual(await s.put(sha(body), body), { ok: true, stored: true });
  assert.ok((await s.get(sha(body))).equals(body));
});

/* ------------------------------------------------------------------ */

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failures.push(c.name);
    console.log(`FAIL - ${c.name}\n       ${String((err && err.stack) || err).split("\n").slice(0, 8).join("\n       ")}`);
  }
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases)`);
