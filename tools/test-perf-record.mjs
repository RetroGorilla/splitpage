import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import { crc32, inflateSync } from "node:zlib";
import { IMAGES, busyPercent, imageProblems, imageRows, parseArgs, parseTrials, report, suiteText } from "./perf-record.mjs";

const { imageDims, sniffImageMime } = createRequire(import.meta.url)("../shared/blob-policy.js");

let passed = 0;
const failures = [];

function boot(code) {
  const formats = { clone: (x) => JSON.parse(JSON.stringify(x)), state: () => ({ rows: [{ id: "r1" }], comments: [] }) };
  const window = { __splitpageFormats: formats, __blobsTest: {}, __hostedTest: {} };
  vm.runInNewContext(code, { window, btoa, File, performance, setTimeout, requestAnimationFrame: (f) => setTimeout(f, 0) });
  return window.__perfImg;
}

function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log("  ok   " + name); return; }
  const detail = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  failures.push(`${name} — ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}

const trial = (label, ms, extra) => ({ label, ms, pictures: 10, comments: 10, held: 10, durable: true, inline: false, ...extra });
const good = [
  ...[1, 2, 3].map((i) => trial("images open", 300 + i, { opened: true })),
  ...[1, 2, 3].map((i) => trial("images load from IndexedDB", 100 + i, { comments: undefined, before: 0, missing: 0 })),
  ...[1, 2, 3].map((i) => trial("images merge", 400 + i, { pictures: 20, comments: 20, held: 20 }))
];
function change(label, index, patch) {
  let seen = 0;
  return good.map((t) => (t.label === label && seen++ === index ? { ...t, ...patch } : t));
}

console.log("\nparseArgs():\n");

eq("no arguments run every fixture", parseArgs([]).only, ["short", "long", "images"]);
eq("--only picks fixtures", parseArgs(["--only", "images"]).only, ["images"]);
eq("--only takes a list", parseArgs(["--only", "long,images"]).only, ["long", "images"]);
eq("a path is the report file", parseArgs(["--only", "images", "out.md"]).out?.endsWith("out.md"), true);
eq("an unknown fixture is refused", parseArgs(["--only", "huge"]).error !== null, true);
eq("--only with nothing is refused", parseArgs(["--only"]).error !== null, true);

console.log("\nthe image trials:\n");

eq("trial lines are read from driver output", parseTrials('x\nTRIAL {"label":"a","ms":1}\nPERF {"label":"b"}\n'), [{ label: "a", ms: 1 }]);
eq("a clean set has no problems", imageProblems(good), []);
eq("a missing trial is named", imageProblems(good.slice(1)).length, 1);
eq("a picture left inline is named", imageProblems(change("images open", 1, { inline: true })).length, 1);
eq("a picture the registry lacks is named", imageProblems(change("images merge", 0, { held: 19 })).length, 1);
eq("a load that found the bytes in memory is named", imageProblems(change("images load from IndexedDB", 2, { before: 1 })).length, 1);
eq("a load that missed a picture is named", imageProblems(change("images load from IndexedDB", 0, { missing: 1 })).length, 1);
eq("a merge that did not take their pictures is named", imageProblems(change("images merge", 1, { comments: 10, pictures: 10, held: 10 })).length, 1);
eq("an open that failed is named", imageProblems(change("images open", 0, { opened: false })).length, 1);
eq("pictures not stored in time are named", imageProblems(change("images open", 2, { durable: false })).length, 1);
eq("a trial with no time is named", imageProblems(change("images merge", 2, { ms: 0 })).length, 1);

console.log("\nthe rows and the report:\n");

const rows = imageRows(good);
eq("each case keeps its trials in order, its first and its median", rows.map((r) => [r.label, r.trials, r.first, r.median]), [
  ["images open", [301, 302, 303], 301, 302],
  ["images load from IndexedDB", [101, 102, 103], 101, 102],
  ["images merge", [401, 402, 403], 401, 402]
]);
eq("the median is not the mean", imageRows([trial("images open", 10), trial("images open", 11), trial("images open", 500)])[0].median, 11);

const text = report(rows, { platform: "p", cpu: "c", memoryGb: 1, node: "n", busy: { before: 7, after: 9 } }, "2026-01-01");
eq("the report has the image table", text.includes("| images merge | 20 | 401, 402, 403 | 401 | 402 |"), true);
eq("the report names the load before and after", text.includes("7% of the CPU busy in the second before the run and 9% in the second after it"), true);
eq("the report has no latency or export table for an images-only run", text.includes("## Input latency") || text.includes("## Export"), false);
eq("busyPercent is the share not idle", busyPercent({ idle: 100, total: 200 }, { idle: 175, total: 300 }), 25);

console.log("\nthe suite:\n");

const lines = suiteText("images").split("\n").filter(Boolean);
const count = (prefix) => lines.filter((l) => l.startsWith(prefix)).length;
eq("three opens, three loads, three merges", [count("eval window.__perfImg.open"), count("eval window.__perfImg.load"), count("eval window.__perfImg.merge")], [3, 3, 3]);
eq("every load and the merges follow a fresh page", count("goto /index.html"), 4);
eq("the driver sees an assertion", lines[lines.length - 1].startsWith("expect "), true);
eq("the loads read the sets the opens stored, in order", lines.filter((l) => l.startsWith("eval window.__perfImg.load")), ["0", "1", "2"].map((i) => `eval window.__perfImg.load(${i})`));

console.log("\nthe pictures:\n");

const api = boot(IMAGES);
const urls = [...api.pictures(), ...api.pictures()];
const prefix = "data:image/png;base64,";
const bytes = urls.map((u) => Buffer.from(u.slice(prefix.length), "base64"));
eq("every picture is a data URL", urls.every((u) => u.startsWith(prefix)), true);
eq("there are ten to a call", urls.length, 20);
eq("each is exactly 1 MiB", bytes.map((b) => b.length).filter((n) => n !== 1024 * 1024), []);
eq("the app's own policy reads each as a PNG with dimensions", bytes.filter((b) => sniffImageMime(b) !== "image/png" || imageDims(b)?.width !== 1).length, 0);
eq("no two share a hash", new Set(bytes.map((b) => createHash("sha256").update(b).digest("hex"))).size, 20);

function chunks(b) {
  const out = [];
  for (let at = 8; at < b.length; at += 12 + b.readUInt32BE(at)) {
    const length = b.readUInt32BE(at);
    out.push({ type: b.toString("latin1", at + 4, at + 8), crcOk: crc32(b.subarray(at + 4, at + 8 + length)) === b.readUInt32BE(at + 8 + length), data: b.subarray(at + 8, at + 8 + length) });
  }
  return out;
}

const first = chunks(bytes[0]);
eq("the chunks run IHDR, a private chunk, IDAT, IEND", first.map((c) => c.type), ["IHDR", "prVt", "IDAT", "IEND"]);
eq("every chunk checksum holds", first.every((c) => c.crcOk), true);
eq("the pixel data inflates to one RGB pixel", inflateSync(first[2].data).length, 4);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
