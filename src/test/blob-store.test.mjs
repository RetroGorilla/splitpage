/* The page's image registry (src/js/02c-blobs.js, issue #82 P1): intern
 * and its content addresses, the data: URI decoder, and the two async doors
 * — persist() and ensureBytes() — against the memory backend and against
 * scripted fakes that let a test decide when a write "lands".
 *
 * The IndexedDB backend is not here: jsdom has no IndexedDB and the repo
 * carries no shim, so browser suite 65-blobs drives it in a real Chromium
 * (intern, persist, reload, ensureBytes).
 *
 * The registry is module state, shared by every case in this file, so each
 * case uses images of its own (png(w, h) with distinct sizes) and installs
 * the backend it needs with setBackend().
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bytesForSync,
  createMemoryBackend,
  dataUrlForSync,
  ensureBytes,
  has,
  intern,
  internDataUrl,
  isDurableSync,
  persist,
  recordFor,
  revokeObjectUrls,
  setBackend,
  urlForSync,
  backendInfo
} from "../js/02c-blobs.js";

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/* A PNG header the sniffer and the measurer accept. The registry never
   decodes pixels, so a header is a whole image as far as it can tell. */
const png = (w, h) => new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
  ...be32(w), ...be32(h), 8, 6, 0, 0, 0, ...be32(0), ...be32(0), 0x49, 0x45, 0x4e, 0x44
]);
const jpeg = (w, h) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
  3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9
]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const b64 = (b) => Buffer.from(b).toString("base64");
const tick = () => new Promise((r) => setTimeout(r, 0));

/* A backend whose put()s wait until the test releases them. */
function gatedBackend(persistent) {
  const held = new Map();
  const gates = [];
  const b = {
    name: "gated",
    persistent,
    puts: [],
    gets: [],
    failNext: 0,
    get(s) { b.gets.push(s); return Promise.resolve(held.has(s) ? { bytes: held.get(s), mime: "image/png" } : null); },
    put(s, bytes) {
      b.puts.push(s);
      if (b.failNext > 0) { b.failNext--; return Promise.reject(new Error("disk full")); }
      return new Promise((resolve) => gates.push(() => { held.set(s, bytes); resolve(); }));
    },
    missing(shas) { return Promise.resolve(shas.filter((s) => !held.has(s))); },
    release() { while (gates.length) gates.shift()(); },
    held
  };
  return b;
}

/* ---- intern ---- */

test("intern: the record is the bytes' SHA-256, sniffed type and measured size", () => {
  setBackend(createMemoryBackend());
  const bytes = png(40, 30);
  const rec = intern(bytes);
  assert.deepEqual(rec, { sha256: sha(bytes), width: 40, height: 30, mime: "image/png" });
  assert.deepEqual(intern(png(40, 30)), rec, "the same bytes, the same record");
  assert.notEqual(intern(bytes), rec, "a fresh record object each time");
  assert.equal(has(rec.sha256), true);
  assert.deepEqual(recordFor(rec.sha256), rec);
  assert.deepEqual(intern(bytes.buffer.slice(0)), rec, "an ArrayBuffer is accepted too");
  assert.deepEqual(intern(jpeg(9, 7)), { sha256: sha(jpeg(9, 7)), width: 9, height: 7, mime: "image/jpeg" });
});

test("intern copies: a caller reusing its buffer cannot change what a sha names", () => {
  const bytes = png(41, 30);
  const rec = intern(bytes);
  bytes[20] = 0xff;
  assert.equal(sha(bytesForSync(rec.sha256)), rec.sha256);
  assert.deepEqual(recordFor(rec.sha256), rec);
});

test("intern refuses what is not a measurable raster image", () => {
  assert.equal(intern(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), null, "SVG");
  assert.equal(intern(png(0, 5)), null, "zero width");
  assert.equal(intern(png(42, 30).slice(0, 20)), null, "truncated header");
  assert.equal(intern(new Uint8Array(0)), null);
  assert.equal(intern([0x89, 0x50]), null, "a plain array is not bytes");
  assert.equal(intern(null), null);
  assert.equal(has("nope"), false);
  assert.equal(recordFor("a".repeat(64)), null);
  assert.equal(bytesForSync("a".repeat(64)), null);
});

/* ---- data: URIs ---- */

test("internDataUrl: the same picture is the same sha however its base64 is wrapped", () => {
  const bytes = png(50, 20); /* 45 bytes: base64 ends in one "=" */
  const clean = "data:image/png;base64," + b64(bytes);
  const rec = internDataUrl(clean);
  assert.equal(rec.sha256, sha(bytes));
  const body = b64(bytes);
  const variants = [
    "data:image/png;base64," + body.replace(/(.{8})/g, "$1\n"),
    "data:image/png;base64," + body.replace(/(.{10})/g, "$1\r\n"),
    "data:image/png;base64," + body.replace(/(.{4})/g, "$1 \t"),
    "data:image/png;base64,\f" + body + "\f",
    "data:image/png;base64," + body.replace(/=+$/, ""),        /* padding dropped */
    "data:image/png;base64," + body + "\u000b",                 /* trailing C0: the URL parser trims it */
    "data:image/jpg;base64," + body,                            /* the label is not the type */
    "data:image/gif;base64," + body
  ];
  for (const v of variants) assert.deepEqual(internDataUrl(v), rec, JSON.stringify(v.slice(22, 40)));
  assert.equal(rec.mime, "image/png", "sniffed, not taken from the label");
});

test("internDataUrl refuses what the browser would not decode, and what safeImageSrc refuses", () => {
  const body = b64(png(51, 20));
  const refused = [
    ["data:image/svg+xml;base64," + b64(new TextEncoder().encode("<svg/>")), "SVG is never admitted"],
    ["data:image/png," + body, "not base64"],
    ["data:image/png;base64," + body.slice(0, 20) + "\u00a0" + body.slice(20), "NBSP: \\s to a regex, not to base64"],
    ["data:image/png;base64," + body.slice(0, 20) + "\u000b" + body.slice(20), "an inner VT is not ASCII whitespace"],
    ["data:image/png;base64," + body.slice(0, 20) + "=" + body.slice(20), "= in the middle"],
    ["data:image/png;base64," + body + "A", "length % 4 == 1"],
    ["data:image/png;base64," + body + "===", "three pads"],
    ["data:image/png;base64,", "empty"],
    ["data:image/png;base64," + b64(new TextEncoder().encode("hello, world")), "not an image"],
    ["https://example.com/x.png", "not a data: URI"],
    [null, "null"]
  ];
  for (const [url, why] of refused) assert.equal(internDataUrl(url), null, why);
});

test("dataUrlForSync is canonical: sniffed type, unwrapped base64, the same sha back", () => {
  const bytes = jpeg(12, 34);
  const rec = internDataUrl("data:image/png;base64," + b64(bytes).replace(/(.{6})/g, "$1\n"));
  const url = dataUrlForSync(rec.sha256);
  assert.equal(url, "data:image/jpeg;base64," + b64(bytes));
  assert.deepEqual(internDataUrl(url), rec);
  /* Every tail length (0, 1 and 2 leftover bytes) encodes as node does. */
  for (const w of [60, 61, 62]) {
    const b = new Uint8Array([...png(w, 1), ...new Array(w - 60).fill(7)]);
    const r = intern(b);
    assert.equal(dataUrlForSync(r.sha256), "data:image/png;base64," + b64(b), "len " + b.length);
  }
  assert.equal(dataUrlForSync("f".repeat(64)), null);
});

test("urlForSync makes one object URL per blob and revokeObjectUrls lets it go", () => {
  const made = [], revoked = [];
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = (blob) => { made.push(blob); return "blob:test/" + made.length; };
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  try {
    const rec = intern(png(70, 7));
    const u = urlForSync(rec.sha256);
    assert.equal(u, "blob:test/" + made.length);
    assert.equal(made[made.length - 1].type, "image/png");
    assert.equal(urlForSync(rec.sha256), u, "reused, not re-made");
    revokeObjectUrls();
    assert.ok(revoked.includes(u));
    assert.notEqual(urlForSync(rec.sha256), u, "a new URL after a revoke");
    assert.equal(urlForSync("f".repeat(64)), null, "bytes not held");
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
  }
});

/* ---- persist ---- */

test("persist resolves only once the backend has stored the bytes", async () => {
  const backend = gatedBackend(true);
  setBackend(backend);
  const a = intern(png(80, 1)).sha256;
  const b = intern(png(81, 1)).sha256;
  let done = null;
  const p = persist([a, b, a]).then((failed) => { done = failed; });
  await tick();
  assert.deepEqual(backend.puts, [a, b], "one put per blob, duplicates folded");
  assert.equal(done, null, "not resolved while the writes are outstanding");
  assert.equal(isDurableSync(a), false);
  /* A second persist of a blob being written waits for that write. */
  let second = null;
  const p2 = persist([a]).then((failed) => { second = failed; });
  await tick();
  assert.deepEqual(backend.puts, [a, b], "no second put for an in-flight blob");
  assert.equal(second, null);
  backend.release();
  await p;
  await p2;
  assert.deepEqual(done, []);
  assert.deepEqual(second, []);
  assert.ok(backend.held.has(a) && backend.held.has(b));
  assert.equal(isDurableSync(a), true);
  /* Already durable: resolves without writing again. */
  assert.deepEqual(await persist([a]), []);
  assert.deepEqual(backend.puts, [a, b]);
  assert.deepEqual(backendInfo(), { name: "gated", persistent: true });
});

test("persist reports what it could not make durable, and a later call retries", async () => {
  const backend = gatedBackend(true);
  setBackend(backend);
  const a = intern(png(82, 1)).sha256;
  backend.failNext = 1;
  assert.deepEqual(await persist([a]), [a], "the put failed");
  assert.equal(isDurableSync(a), false);
  const p = persist([a]);
  await tick();
  backend.release();
  assert.deepEqual(await p, [], "retried and stored");
  /* Bytes this page never held: fine if the backend has them, reported if not. */
  const elsewhere = sha(png(83, 1));
  backend.held.set(elsewhere, png(83, 1));
  const nowhere = "9".repeat(64);
  assert.deepEqual(await persist([elsewhere, nowhere, "not-a-sha"]), [nowhere, "not-a-sha"]);
  assert.deepEqual(await persist([]), []);
});

test("memory backend: persist works, but nothing it holds counts as durable", async () => {
  setBackend(createMemoryBackend());
  const a = intern(png(84, 1)).sha256;
  assert.deepEqual(await persist([a]), []);
  assert.equal(isDurableSync(a), false, "memory does not survive the page");
  assert.deepEqual(backendInfo(), { name: "memory", persistent: false });
});

test("setBackend forgets what the previous backend held", async () => {
  const first = gatedBackend(true);
  setBackend(first);
  const a = intern(png(85, 1)).sha256;
  const p = persist([a]);
  await tick();
  first.release();
  assert.deepEqual(await p, []);
  const second = gatedBackend(true);
  setBackend(second);
  assert.equal(isDurableSync(a), false);
  const p2 = persist([a]);
  await tick();
  assert.deepEqual(second.puts, [a], "written again, to the new backend");
  second.release();
  assert.deepEqual(await p2, []);
});

/* ---- ensureBytes ---- */

test("ensureBytes reads what memory lacks from the backend and reports the rest", async () => {
  const backend = gatedBackend(true);
  setBackend(backend);
  const held = intern(png(90, 1)).sha256;
  const stored = png(91, 1);
  const storedSha = sha(stored);
  backend.held.set(storedSha, stored);
  const nowhere = "8".repeat(64);
  assert.equal(has(storedSha), false);
  const missing = await ensureBytes([held, storedSha, nowhere, storedSha, "junk", 42]);
  assert.deepEqual(missing, [nowhere, "junk"], "in order, deduped; non-strings ignored");
  assert.deepEqual(backend.gets, [storedSha, nowhere], "memory first: the held blob was never asked for");
  assert.equal(has(storedSha), true);
  assert.deepEqual(recordFor(storedSha), { sha256: storedSha, width: 91, height: 1, mime: "image/png" });
  assert.equal(isDurableSync(storedSha), true, "it came from the backend, so the backend has it");
  assert.deepEqual(await ensureBytes([held, storedSha]), []);
  assert.deepEqual(backend.gets, [storedSha, nowhere], "nothing re-read");
});

test("ensureBytes re-hashes what the backend returns and refuses a mismatch", async () => {
  const backend = gatedBackend(true);
  setBackend(backend);
  const claimed = "7".repeat(64);
  backend.held.set(claimed, png(92, 1)); /* stored under the wrong name */
  assert.deepEqual(await ensureBytes([claimed]), [claimed]);
  assert.equal(has(claimed), false);
  const garbage = sha(new Uint8Array([1, 2, 3]));
  backend.held.set(garbage, new Uint8Array([1, 2, 3]));
  assert.deepEqual(await ensureBytes([garbage]), [garbage], "not an image");
});

test("ensureBytes and persist never reject, even when the backend throws", async () => {
  setBackend({
    name: "broken",
    persistent: true,
    get() { throw new Error("sync throw"); },
    put() { return Promise.reject(new Error("no")); },
    missing() { return Promise.reject(new Error("no")); }
  });
  const a = intern(png(93, 1)).sha256;
  const nowhere = "6".repeat(64);
  assert.deepEqual(await ensureBytes([a, nowhere]), [nowhere]);
  assert.deepEqual(await persist([a, nowhere]), [a, nowhere]);
  setBackend(createMemoryBackend());
});
