import { createRequire } from "node:module";


const require = createRequire(import.meta.url);
const blobs = require("../server/blobs.js");

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + " — got " + a + ", expected " + e);
  console.log("  FAIL " + name + " — got " + a + ", expected " + e);
}

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const MB = 1024 * 1024;

function bytes(list, size) {
  const buf = Buffer.alloc(size || 12);
  list.forEach((v, i) => { buf[i] = v; });
  return buf;
}

function onDisk(shas) {
  const calls = [];
  const fn = async (sha) => { calls.push(sha); return shas.includes(sha); };
  fn.calls = calls;
  return fn;
}

function counted(value) {
  const fn = async () => { fn.calls++; return value; };
  fn.calls = 0;
  return fn;
}

eq("a sha is 64 lowercase hex characters", [blobs.isSha(A), blobs.isSha(A.toUpperCase()), blobs.isSha(A.slice(1)), blobs.isSha(A + "0"), blobs.isSha(null)], [true, false, false, false, false]);

eq("png, jpeg, gif and webp are recognised by their magic bytes", [
  blobs.sniffImageMime(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  blobs.sniffImageMime(bytes([0xff, 0xd8, 0xff])),
  blobs.sniffImageMime(Buffer.from("GIF89a......")),
  blobs.sniffImageMime(Buffer.from("GIF87a......")),
  blobs.sniffImageMime(Buffer.from("RIFF....WEBP"))
], ["image/png", "image/jpeg", "image/gif", "image/gif", "image/webp"]);
eq("short, empty and unknown buffers are not images", [
  blobs.sniffImageMime(bytes([0xff, 0xd8, 0xff], 11)),
  blobs.sniffImageMime(null),
  blobs.sniffImageMime(Buffer.from("<svg></svg>!")),
  blobs.sniffImageMime(Buffer.from("RIFF....WAVE"))
], ["", "", "", ""]);

eq("image refs and data-blob attributes are both references", [...blobs.refsIn({
  rows: [{ imageRef: { sha256: A }, visualText: '<p><img data-blob="' + B + '"></p>' }],
  title: { imageValue: { sha256: C } }
})].sort(), [A, B, C]);
eq("a sha under any other key or an invalid sha is not a reference", [...blobs.refsIn({
  rows: [{ other: { sha256: A }, imageRef: { sha256: "nope" }, visualText: '<img data-blob="xyz">' }]
})], []);
eq("a data-blob in text or a closing tag is not a reference", [...blobs.refsIn({ a: "data-blob=" + A, b: "</img data-blob=\"" + A + "\">" })], []);
eq("references nested deeper than 64 levels are not followed", (() => {
  const deep = (n) => { let v = { imageRef: { sha256: A } }; for (let i = 0; i < n; i++) v = [v]; return v; };
  return [blobs.refsIn(deep(62)).size, blobs.refsIn(deep(64)).size];
})(), [1, 0]);
eq("html refs read data-blob from open tags and ignore non-strings", [
  [...blobs.htmlRefs('<span data-blob="' + A + '"></span><b data-blob=\'' + B + "'>")].sort(),
  blobs.htmlRefs(undefined).size,
  blobs.htmlRefs("<p>plain</p>").size
], [[A, B], 0, 0]);

const results = [];

results.push((async () => {
  const has = onDisk([A, B]);
  eq("a blob is unavailable when the session cannot see it or it is not on disk",
    await blobs.unavailableBlobs([A, B, C], (sha) => sha !== B, has), [B, C]);
  eq("an invisible blob is not looked up on disk", has.calls, [A, C]);
  eq("without a visibility rule only the disk decides", await blobs.unavailableBlobs([A, C], null, onDisk([A])), [C]);
})());

results.push((async () => {
  const has = onDisk([]);
  const stored = counted(new Set([A]));
  eq("a write without references is never refused", await blobs.refusedRefs(new Set(), { hasBlob: has, storedRefs: stored }), []);
  eq("an empty write reads neither disk nor the stored document", [has.calls.length, stored.calls], [0, 0]);
})());

results.push((async () => {
  const stored = counted(new Set([A]));
  eq("a write whose blobs are all present is accepted", await blobs.refusedRefs(new Set([A, B]), { hasBlob: onDisk([A, B]), storedRefs: stored }), []);
  eq("the stored document is not read when nothing is missing", stored.calls, 0);
})());

results.push((async () => {
  const stored = counted(new Set([A]));
  const refused = await blobs.refusedRefs(new Set([A, B, C, D]), {
    hasBlob: onDisk([]),
    acceptMissing: [C, "bad", 7],
    storedRefs: stored
  });
  eq("a missing blob is excused by acceptMissing or by the stored document", refused, [B, D]);
  eq("the stored document is read once", stored.calls, 1);
})());

results.push((async () => {
  eq("a non-array acceptMissing excuses nothing", await blobs.refusedRefs(new Set([A]), { hasBlob: onDisk([]), acceptMissing: A }), [A]);
  eq("a missing stored document excuses nothing", await blobs.refusedRefs(new Set([A]), { hasBlob: onDisk([]), storedRefs: async () => null }), [A]);
  eq("a blob on disk but invisible to a link session is refused unless the document has it",
    await blobs.refusedRefs(new Set([A, B]), { visible: () => false, hasBlob: onDisk([A, B]), storedRefs: async () => new Set([A]) }), [B]);
})());

results.push((async () => {
  const visibility = counted(null);
  const r = await blobs.commentRefsRefused("<p>no images</p>", { visibility, hasBlob: onDisk([]), storedRefs: counted(null) });
  eq("a comment without images is accepted without a visibility check", [r.refs.size, r.missing, visibility.calls], [0, [], 0]);
})());

results.push((async () => {
  const stored = counted(new Set([B]));
  const html = '<img data-blob="' + A + '"><img data-blob="' + B + '"><img data-blob="' + C + '"><img data-blob="' + D + '">';
  const r = await blobs.commentRefsRefused(html, {
    visibility: async () => (sha) => sha !== D,
    hasBlob: onDisk([A]),
    storedRefs: stored
  });
  eq("a comment image is refused when invisible, or absent and not in the document", [[...r.refs], r.missing], [[A, B, C, D], [C, D]]);
  eq("a comment reads the stored document at most once", stored.calls, 1);
})());

results.push((async () => {
  const r = await blobs.commentRefsRefused('<img data-blob="' + A + '">', { visibility: async () => null, hasBlob: onDisk([]), storedRefs: async () => null });
  eq("a comment image missing everywhere is refused", r.missing, [A]);
})());

let now = 1000;
const clock = () => now;
const limits = { reviewBudget: 20 * MB, linkEditBudget: 100 * MB, maxBlobBytes: 8 * MB, clock };
const review = { role: "review", scope: "doc", token: "rt" };
const linkEdit = { role: "edit", scope: "doc", token: "et" };
const owner = { role: "edit", scope: "", token: "" };

eq("review links, edit links and the owner get their own budgets", (() => {
  const b = blobs.createBlobBudgets(limits);
  return [b.budgetOf(review), b.budgetOf(linkEdit), b.budgetOf(owner)];
})(), [20 * MB, 100 * MB, 0]);

eq("an unbudgeted session is never refused and charges nothing", (() => {
  const b = blobs.createBlobBudgets(limits);
  const hold = b.reserve(owner, 50 * MB);
  hold.settle(A, 50 * MB);
  hold.release();
  return [hold.refused, b.bytesUsed("", now)];
})(), [false, 0]);

eq("a charge is at least 4 KB", [blobs.blobCharge(1), blobs.blobCharge(4096), blobs.blobCharge(5000)], [4096, 4096, 5000]);

eq("a reservation charges the declared size, or the blob limit when unknown", (() => {
  const b = blobs.createBlobBudgets(limits);
  b.reserve(review, 10);
  const small = b.bytesUsed("rt", now);
  b.reserve(linkEdit, NaN);
  b.reserve(linkEdit, -1);
  return [small, b.bytesUsed("et", now)];
})(), [4096, 16 * MB]);

eq("a reservation that exactly fills the budget is allowed and the next is refused", (() => {
  const b = blobs.createBlobBudgets(limits);
  const first = b.reserve(review, 12 * MB);
  const second = b.reserve(review, 8 * MB);
  const third = b.reserve(review, 1);
  return [first.refused, second.refused, third.refused, b.bytesUsed("rt", now)];
})(), [false, false, true, 20 * MB]);

eq("a refused reservation charges nothing", (() => {
  const b = blobs.createBlobBudgets(limits);
  b.reserve(review, 21 * MB).release();
  return b.bytesUsed("rt", now);
})(), 0);

eq("settling replaces the reservation with the real size and marks the upload", (() => {
  const b = blobs.createBlobBudgets(limits);
  const hold = b.reserve(review, NaN);
  const before = [b.bytesUsed("rt", now), b.uploaded("rt", A)];
  hold.settle(A, 6000);
  hold.release();
  return [before, b.bytesUsed("rt", now), b.uploaded("rt", A), b.uploaded("et", A)];
})(), [[8 * MB, false], 6000, true, false]);

eq("releasing an unsettled reservation returns its budget", (() => {
  const b = blobs.createBlobBudgets(limits);
  const kept = b.reserve(review, MB);
  kept.settle(A, MB);
  const dropped = b.reserve(review, 2 * MB);
  dropped.release();
  dropped.release();
  return b.bytesUsed("rt", now);
})(), MB);

eq("charges and uploads expire after the one-hour window", (() => {
  now = 1000;
  const b = blobs.createBlobBudgets(limits);
  b.reserve(review, 20 * MB).settle(A, 20 * MB);
  const full = b.reserve(review, 1).refused;
  now += blobs.BUDGET_WINDOW_MS - 1;
  const stillFull = [b.reserve(review, 1).refused, b.uploaded("rt", A)];
  now += 1;
  const after = [b.bytesUsed("rt", now), b.uploaded("rt", A), b.reserve(review, 1).refused];
  now = 1000;
  return [full, stillFull, after];
})(), [true, [true, true], [0, false, false]]);

eq("an expired reservation released late does not touch newer entries", (() => {
  now = 1000;
  const b = blobs.createBlobBudgets(limits);
  const stale = b.reserve(review, MB);
  now += blobs.BUDGET_WINDOW_MS;
  b.reserve(review, 2 * MB).settle(B, 2 * MB);
  stale.release();
  const used = b.bytesUsed("rt", now);
  now = 1000;
  return used;
})(), 2 * MB);

eq("a link session sees blobs its document references or it uploaded", (() => {
  const b = blobs.createBlobBudgets(limits);
  b.reserve(review, 10).settle(B, 10);
  const visible = b.visibleTo(review, new Set([A]));
  const other = b.visibleTo({ role: "review", scope: "doc", token: "x" }, new Set());
  return [visible(A), visible(B), visible(C), other(B)];
})(), [true, true, false, false]);

await Promise.all(results);

if (failures.length) {
  console.log("\n" + failures.length + " FAILED");
  process.exit(1);
}
console.log("\nALL PASS - " + passed + " server blob checks");
