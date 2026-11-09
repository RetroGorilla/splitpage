import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { crc32, inflateSync } from "node:zlib";
import { IMAGES, BEATS, MEMORY, SCALE, buildArgs, busyPercent, imageProblems, imageRows, loadProbe, parseArgs, parsePerf, parsePortBase, parseTrials, report, suiteText } from "./perf-record.mjs";

const { imageDims, sniffImageMime } = createRequire(import.meta.url)("../shared/blob-policy.ts");

let passed = 0;
const failures = [];

function boot(code) {
  const formats = { clone: (x) => JSON.parse(JSON.stringify(x)), state: () => ({ rows: [{ id: "r1" }], comments: [] }) };
  const window = { __splitpageFormats: formats, __blobsTest: {} };
  vm.runInNewContext(code, { window, btoa, File, performance, setTimeout, requestAnimationFrame: (f) => setTimeout(f, 0) });
  return window.__perfImg;
}

function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log("  ok   " + name); return; }
  const detail = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  failures.push(`${name} — ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}

const trial = (label, ms, extra) => ({ label, ms, pictures: 10, comments: 10, held: 10, durable: true, inline: false, known: 0, ...extra });
const good = [
  ...[1, 2, 3].map((i) => trial("images open", 300 + i, { opened: true })),
  ...[1, 2, 3].map((i) => trial("images load from IndexedDB", 100 + i, { comments: undefined, before: 0, missing: 0 })),
  ...[1, 2, 3].map((i) => trial("images merge", 400 + i, { pictures: 20, comments: 20, held: 20, done: true }))
];
function change(label, index, patch) {
  let seen = 0;
  return good.map((t) => (t.label === label && seen++ === index ? { ...t, ...patch } : t));
}

console.log("\nbuild selection:\n");

eq("test flag is used when supported", buildArgs('const TEST_BUILD = process.argv.includes("--test");'), ["build.mjs", "--test"]);
eq("single quoted flag is supported", buildArgs("process.argv.includes( '--test' )"), ["build.mjs", "--test"]);
eq("older builds use the plain command", buildArgs("const TEST_BUILD = false;"), ["build.mjs"]);

console.log("\nparseArgs():\n");

eq("no arguments run every fixture", parseArgs([]).only, ["short", "long", "images"]);
eq("--only picks fixtures", parseArgs(["--only", "images"]).only, ["images"]);
eq("--only takes a list", parseArgs(["--only", "long,images"]).only, ["long", "images"]);
eq("a path is the report file", parseArgs(["--only", "images", "out.md"]).out?.endsWith("out.md"), true);
eq("an unknown fixture is refused", parseArgs(["--only", "huge"]).error !== null, true);
eq("--only with nothing is refused", parseArgs(["--only"]).error !== null, true);
eq("the baseline fixtures run only when named", [parseArgs(["--only", "footprint,footprint-long,large"]).error, parseArgs([]).only.some((f) => f.startsWith("footprint") || f === "large")], [null, false]);

console.log("\nparsePortBase():\n");

eq("no variable gives the default", parsePortBase(undefined), { base: 18990, error: null });
eq("a valid base is taken", parsePortBase("50100"), { base: 50100, error: null });
eq("the highest base leaves room for the CDP port", parsePortBase("64535").error, null);
eq("a base above that is refused", parsePortBase("64536").error !== null, true);
eq("a typo is refused, not defaulted", [parsePortBase("5010o").error !== null, parsePortBase("50100.5").error !== null, parsePortBase("-1").error !== null, parsePortBase("0x10").error !== null], [true, true, true, true]);
eq("a privileged port is refused", parsePortBase("80").error !== null, true);

console.log("\nthe image trials:\n");

eq("trial lines are read from driver output", parseTrials('x\nTRIAL {"label":"a","ms":1}\nPERF {"label":"b"}\n'), [{ label: "a", ms: 1 }]);
eq("a clean set has no problems", imageProblems(good), []);
eq("a missing trial is named", imageProblems(good.slice(1)).length, 1);
eq("a picture left inline is named", imageProblems(change("images open", 1, { inline: true })).length, 1);
eq("a picture the registry lacks is named", imageProblems(change("images merge", 0, { held: 19 })).length, 1);
eq("a load that found the bytes in memory is named", imageProblems(change("images load from IndexedDB", 2, { before: 1 })).length, 1);
eq("a load that missed a picture is named", imageProblems(change("images load from IndexedDB", 0, { missing: 1 })).length, 1);
eq("a merge that did not take their pictures is named", imageProblems(change("images merge", 1, { comments: 10, pictures: 10, held: 10 })).length, 1);
eq("an open of pictures the registry already held is named", imageProblems(change("images open", 1, { known: 10 })).length, 1);
eq("a merge of pictures the registry already held is named", imageProblems(change("images merge", 2, { known: 1 })).length, 1);
eq("a trial that does not say what the registry held is named", imageProblems(change("images open", 0, { known: undefined })).length, 1);
eq("a merge that never finished is named", imageProblems(change("images merge", 0, { done: false })).length, 1);
eq("a merge that ran out the clock is named", imageProblems(change("images merge", 1, { ms: 25001.5 })).length, 1);
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

const environmentRecords = [["short", 6], ["long", 30]].flatMap(([fixture, count]) => {
  const probe = suiteText(fixture).split("\n").find((line) => line.includes("label: 'environment'"));
  const document = {
    querySelector: () => null,
    querySelectorAll: () => Array(count),
    createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 1 }) }) })
  };
  const output = vm.runInNewContext(probe.slice(5), { document, navigator: { userAgent: "test" }, innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1 });
  return parsePerf(output).map((record) => ({ ...record, fixture }));
});
const fixtureReport = report(environmentRecords, { platform: "p", cpu: "c", memoryGb: 1, node: "n" }, "2026-01-01");
eq("the report names both fixture row counts emitted by the environment probe", fixtureReport.includes("- Fixtures: short is the seed script (6 scenes); long is the long demo (30 scenes)"), true);

console.log("\nthe suite:\n");

const lines = suiteText("images").split("\n").filter(Boolean);
const count = (prefix) => lines.filter((l) => l.startsWith(prefix)).length;
eq("three opens, three loads, three merges", [count("eval window.__perfImg.open"), count("eval window.__perfImg.load"), count("eval window.__perfImg.merge")], [3, 3, 3]);
eq("every load and the merges follow a fresh page", count("goto /index.html"), 4);
eq("the driver sees an assertion", lines[lines.length - 1].startsWith("expect "), true);
eq("the loads read the sets the opens stored, in order", lines.filter((l) => l.startsWith("eval window.__perfImg.load")), ["0", "1", "2"].map((i) => `eval window.__perfImg.load(${i})`));

console.log("\nthe redraw scenes:\n");

const longLines = suiteText("long").split("\n").filter(Boolean);
const shortLines = suiteText("short").split("\n").filter(Boolean);
const at = (prefix) => longLines.findIndex((l) => l.startsWith(prefix));
eq("the long suite times stamp, hide and the display preference", ["stamp()", "hide()", "preference()"].map((n) => at(`eval window.__perfScene.${n}`) > 0), [true, true, true]);
eq("they run after the export timing, so the existing cases run first", longLines.findIndex((l) => l.includes("'long export'")) < longLines.findIndex((l) => l.includes("window.__perfScene)")), true);
eq("the preference is changed with the settings dialog open", longLines.indexOf("wait window.__settingsTest.isOpen()") > at("eval window.__perfScene.hide()") && longLines.indexOf("wait window.__settingsTest.isOpen()") < at("eval window.__perfScene.preference()"), true);
eq("the short suite has none of them", shortLines.some((l) => l.includes("__perfScene")), false);

const beatWindow = { __perf: { lat: [] }, __splitpageFormats: {} };
vm.runInNewContext(BEATS, { window: beatWindow, performance, setTimeout, requestAnimationFrame: (f) => setTimeout(f, 0) });
eq("the scenes install a stamp, a hide and a preference run", Object.keys(beatWindow.__perfScene), ["stamp", "hide", "preference"]);

function stampWorld(clicksWork) {
  const next = { todo: "ready", ready: "shot", shot: "todo" };
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `r${i + 1}`, status: i >= 2 && i < 8 ? "todo" : "shot", updatedAt: "start" }));
  let tick = 0;
  const document = {
    querySelector(selector) {
      const row = rows[Number(/nth-of-type\((\d+)\)/.exec(selector)[1]) - 1];
      return { getAttribute: () => row.id, click() { if (clicksWork) { row.status = next[row.status]; row.updatedAt = `t${tick++}`; } } };
    }
  };
  const window = { __perf: { lat: [], reset() {}, take: (label) => label }, __splitpageFormats: { state: () => ({ rows }) } };
  vm.runInNewContext(BEATS, { window, document, performance, setTimeout: (f) => setTimeout(f, 0), requestAnimationFrame: (f) => setTimeout(f, 0) });
  return window.__perfScene.stamp();
}

const stampRun = async (clicksWork) => stampWorld(clicksWork).then(() => "passed", (e) => e.message);
eq("a stamp run in which the clicks change the scenes passes", await stampRun(true), "passed");
eq("a stamp run in which every click does nothing is rejected, though 6 scenes are already shot", (await stampRun(false)).startsWith("perf scenes: "), true);

const OLD_HIDE = '#file-menu [data-file-action="toggle-hide-shot"]';
const NEW_HIDE = "#hide-shot-toggle";
function hideWorld(controls) {
  const clicked = [];
  let hiding = false;
  const document = {
    querySelector: (selector) => (controls.includes(selector) ? { click() { clicked.push(selector); hiding = !hiding; } } : null),
    querySelectorAll: () => ({ length: hiding ? 1 : 0 })
  };
  const window = { __perf: { lat: [], reset() {}, take: (label) => label } };
  vm.runInNewContext(BEATS.replace(/\n\s*/g, " "), { window, document, performance, setTimeout: (f) => setTimeout(f, 0), requestAnimationFrame: (f) => setTimeout(f, 0) });
  return { clicked, run: () => window.__perfScene.hide() };
}
const headerRun = hideWorld([NEW_HIDE]);
eq("a build with the header switch measures the hide run through it", await headerRun.run(), "long hide shot scenes");
eq("every hide click in that build is the header switch", headerRun.clicked.length > 0 && headerRun.clicked.every((s) => s === NEW_HIDE), true);
const menuRun = hideWorld([OLD_HIDE]);
eq("an older build with only the File menu item measures the same run through it", await menuRun.run(), "long hide shot scenes");
eq("every hide click in that build is the File menu item", menuRun.clicked.length > 0 && menuRun.clicked.every((s) => s === OLD_HIDE), true);
eq("both builds get the same number of hide clicks", menuRun.clicked.length, headerRun.clicked.length);

console.log("\nthe baseline fixtures:\n");

const perfLines = (fixture) => suiteText(fixture).split("\n").filter(Boolean);
const countIn = (list, prefix) => list.filter((l) => l.startsWith(prefix)).length;
const shortBase = perfLines("footprint");
const longBase = perfLines("footprint-long");
const largeBase = perfLines("large");
eq("the short baseline loads the page five times", countIn(shortBase, "goto /index.html"), 6);
eq("every load is timed with its own label", shortBase.filter((l) => l.includes("kind: 'load'")).length, 5);
eq("each baseline opens its script three times", [shortBase, longBase, largeBase].map((l) => countIn(l, "eval window.__perfScale.open(")), [3, 3, 3]);
eq("the long baseline starts on the long demo", longBase.slice(0, 5).map((l) => l.split(" ")[0]), ["open", "viewport", "wait", "click", "wait"]);
eq("the large script is ten copies of the long demo", largeBase.includes("wait document.querySelectorAll('#rows .row').length == 300"), true);
eq("no suite navigates after typing, which would meet the unsaved-work prompt", [shortBase, longBase, largeBase].map((l) => l.slice(l.findIndex((x) => x.startsWith("key end"))).some((x) => x.startsWith("goto ") || x.startsWith("open"))), [false, false, false]);
eq("each suite takes the heap after load before typing and again after it", [shortBase, longBase, largeBase].map((l) => l.findIndex((x) => x.includes("heap after load")) < l.findIndex((x) => x.startsWith("key end")) && l.findIndex((x) => x.startsWith("key end")) < l.findIndex((x) => x.includes("heap after typing"))), [true, true, true]);
eq("every baseline suite ends on an assertion the driver sees", [shortBase, longBase, largeBase].map((l) => l.some((x) => x.startsWith("expect ") || x.startsWith("wait "))), [true, true, true]);
eq("the short baseline ends on one, not only its startup waits", shortBase[shortBase.length - 1].startsWith("expect "), true);
eq("the existing suites do not touch the new probes", ["short", "long"].map((f) => perfLines(f).some((l) => l.includes("__perfMem") || l.includes("__perfScale"))), [false, false]);

function pageWorld(extra) {
  const rows = [
    { id: "r1", status: "todo", visualText: "<b>one</b>", audioText: "a <span class=\"cmt-anchor\" data-cmt=\"c1\">two</span>" },
    { id: "r2", status: "todo", visualText: "<span data-broll-id=\"bs1\">x</span>", audioText: "" }
  ];
  const state = { rows, comments: [{ id: "c1", rowId: "r1", anchorId: "c1" }], people: [], productionTags: [], brollShots: [{ id: "bs1" }] };
  const opened = [];
  const formats = {
    clone: (x) => JSON.parse(JSON.stringify(x)),
    state: () => state,
    buildSplitpage: (s) => JSON.stringify(s),
    buildMarkdown: (s) => JSON.stringify(s.rows),
    openFile: async (file) => { opened.push(JSON.parse(await file.text())); return true; }
  };
  const document = {
    createElement: () => { const el = { set innerHTML(v) { el.textContent = v.replace(/<[^>]*>/g, ""); } }; return el; },
    querySelectorAll: () => ({ length: 2 }),
    querySelector: () => ({})
  };
  const window = { __splitpageFormats: formats };
  vm.runInNewContext(extra.code, { window, document, performance: extra.performance ?? performance, Blob, File, setTimeout, requestAnimationFrame: (f) => setTimeout(f, 0), PerformanceObserver: extra.observer, gc: extra.gc });
  return { window, opened };
}

const world = pageWorld({ code: SCALE });
const grown = (await world.window.__perfScale.open("large open file", 3), world.opened[0]);
const rowIds = grown.rows.map((r) => r.id);
eq("a grown script has every copy's scenes, with no repeated id", [grown.rows.length, new Set(rowIds).size], [6, 6]);
eq("comments follow their copy's scene and anchor", grown.comments.map((c) => [c.id, c.rowId, c.anchorId]), [["c1", "r1", "c1"], ["c1-1", "r1-1", "c1-1"], ["c1-2", "r1-2", "c1-2"]]);
eq("the markup in a copy points at the copy's comment and shot", [grown.rows[2].audioText.includes("data-cmt=\"c1-1\""), grown.rows[3].visualText.includes("data-broll-id=\"bs1-1\""), grown.rows[0].audioText.includes("data-cmt=\"c1\"")], [true, true, true]);
eq("a grown script has a shot per copy", grown.brollShots.map((s) => s.id), ["bs1", "bs1-1", "bs1-2"]);
await world.window.__perfScale.open("large open file", 3);
eq("a second open reuses the first grown script", world.opened[1].rows.length, 6);
await world.window.__perfScale.open("short open file");
eq("an open without copies is the current script", world.opened[2].rows.length, 2);
const factsRecord = parsePerf(world.window.__perfScale.facts("short footprint"))[0];
eq("the footprint counts the script and measures its bytes", [factsRecord.kind, factsRecord.beats, factsRecord.comments, factsRecord.textChars, factsRecord.stateJsonBytes > 0, factsRecord.splitpageBytes > 0], ["footprint", 2, 1, 9, true, true]);
const openRecord = parsePerf(await world.window.__perfScale.open("short open file"))[0];
eq("an open reports its time, whether it opened and the scenes drawn", [openRecord.kind, openRecord.opened, openRecord.beats, openRecord.ms >= 0], ["open", true, 2, true]);

const entries = { navigation: [{ domInteractive: 10.04, domContentLoadedEventEnd: 20.04, loadEventEnd: 30.04 }], paint: [{ name: "first-paint", startTime: 5 }, { name: "first-contentful-paint", startTime: 12.34 }] };
const fakePerf = { getEntriesByType: (type) => entries[type] ?? [], memory: { usedJSHeapSize: 3 * 1024 * 1024 } };
const observer = function () { this.observe = () => {}; };
let collections = 0;
const loadWorld = pageWorld({ code: "window.out = " + loadProbe("short load"), performance: fakePerf, observer, gc: () => { collections++; } });
const loadRecord = parsePerf(await loadWorld.window.out)[0];
eq("the load probe reads the navigation entry and the paint timeline", [loadRecord.label, loadRecord.kind, loadRecord.domInteractive, loadRecord.domContentLoaded, loadRecord.loadEnd, loadRecord.firstPaint, loadRecord.editable], ["short load", "load", 10, 20, 30, 12.3, true]);
eq("the load probe collects before it reads the heap", [collections, loadRecord.heapMb, loadRecord.collected], [2, 3, true]);
const heapWorld = pageWorld({ code: MEMORY, performance: fakePerf });
eq("without gc the heap sample says it was not collected", parsePerf(await heapWorld.window.__perfMem.take("short heap after load"))[0], { label: "short heap after load", kind: "heap", heapMb: 3, collected: false });

const baseText = report([
  { label: "environment", fixture: "footprint", userAgent: "u", viewport: "1x1", devicePixelRatio: 1, cellFont: "F", firstFont: "F", firstFontRendered: true, scenes: 2 },
  { label: "short load", kind: "load", domInteractive: 1, domContentLoaded: 2, loadEnd: 3, firstPaint: 4, largestPaint: 5, editable: true, heapMb: 6, collected: true },
  { label: "short load", kind: "load", domInteractive: 3, domContentLoaded: 4, loadEnd: 5, firstPaint: null, largestPaint: 7, editable: true, heapMb: 8, collected: true },
  { label: "short open file", kind: "open", ms: 9, beats: 2 },
  { label: "short heap after typing", kind: "heap", heapMb: 10, collected: true },
  { label: "short footprint", kind: "footprint", beats: 2, sceneHeaders: 0, comments: 1, people: 0, tags: 0, textChars: 5, htmlChars: 6, splitpageBytes: 7, markdownBytes: 8, stateJsonBytes: 9 }
], { platform: "p", cpu: "c", memoryGb: 1, freeGb: 0.5, node: "n" }, "2026-01-01");
eq("the report has the load, open, heap and size tables", ["## Initial load (median of 2 navigations", "## Open a script", "| short heap after load | 2 | 7 |","| short heap after typing | 1 | 10 |", "| short | 2 | 0 | 1 | 0 | 0 | 5 | 6 | 7 | 8 | 9 |"].map((s) => baseText.includes(s)), [true, true, true, true, true]);
const evenText = report(["6.01", "6.02", "7", "9.5"].map((h) => ({ label: "x heap after typing", kind: "heap", heapMb: Number(h), collected: true })), { platform: "p", cpu: "c", memoryGb: 1, node: "n" }, "2026-01-01");
eq("an even sample count reports the mean of the middle pair, to two decimals", evenText.includes("| x heap after typing | 4 | 6.51 |"), true);
const recorderSource = readFileSync(new URL("./perf-record.mjs", import.meta.url), "utf8");
eq("free memory is read once, before the build and every fixture", [recorderSource.match(/freemem\(\)/g).length, recorderSource.indexOf("freemem() /") < recorderSource.indexOf("buildArgs(readFileSync")], [1, true]);
eq("the report names the free memory",baseText.includes("- Free memory at the start: 0.5 GB"), true);
eq("a null paint time is left out of the median", baseText.includes("| short load | 2 | 2 | 3 | 4 | 4 | 6 | yes |"), true);
eq("an older record has none of the new tables or the free-memory line", ["## Initial load", "## Open a script", "## JS heap", "## Script size", "Free memory"].some((s) => text.includes(s)), false);

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
