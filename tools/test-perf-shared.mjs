import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { abbaOrder, parseArgs, placeTools, toolRevision, waitForMemory, writeRecord } from "./perf-ab.mjs";
import { parsePairedArgs, pairedSummary, parseRound } from "./measure-shared-paired.mjs";
import { PROBE, parsePerf } from "./perf-record.mjs";
import { EARLIER_RECORDS, PERCENTILE_RULE, latencyFigures, median, nearestRank } from "./perf-stats.mjs";
import { TASK_RECORD, TRACE_CATEGORIES, traceRecords } from "./perf-trace.mjs";

const SEAMS = ["trial", "live-apply", "queue", "mirror-apply", "assembly", "projection-listeners", "session-receive", "document-entry", "render",
  "cell-refresh", "input-handler", "input-command", "input-write"];

const record = (name, at, dur, extra = {}) => ({ name, ph: "X", ts: at * 1000, dur: dur * 1000, pid: 1, tid: 1, cat: "devtools.timeline", ...extra });
const dispatch = (type, at, dur) => record("EventDispatch", at, dur, { args: { data: { type } } });
const mark = (seam, edge, at) => ({ name: `measure:${seam}:${edge}`, ph: "I", ts: at * 1000, pid: 1, tid: 1, cat: "blink.user_timing", args: { data: { startTime: at } } });
const span = (seam, from, to) => [mark(seam, "start", from), mark(seam, "end", to)];

function sampleTrace() {
  return [
    record(TASK_RECORD, 0, 20, { cat: "toplevel" }), dispatch("keydown", 1, 2), dispatch("keypress", 4, 8), dispatch("input", 6.5, 3),
    ...span("input-handler", 5, 11), ...span("input-command", 6, 10), ...span("input-write", 7, 9),
    record("FunctionCall", 13, 2), record("UpdateLayoutTree", 16, 1),
    record(TASK_RECORD, 30, 2, { cat: "toplevel" }), dispatch("keyup", 30.5, 1),
    record(TASK_RECORD, 39.5, 2, { cat: "toplevel" }), record("Paint", 40, 1), record("Layout", 40.5, 0.25),
    record(TASK_RECORD, 60, 10, { cat: "toplevel" }), record("FunctionCall", 60.5, 9), ...span("receive", 61, 69), ...span("trial", 62, 64), ...span("rebuild", 62.5, 63.5), ...span("live-apply", 65, 68),
    record(TASK_RECORD, 80, 5, { cat: "toplevel" }), record("FunctionCall", 80.5, 4),
    record(TASK_RECORD, 100, 10, { cat: "toplevel" }), dispatch("keydown", 101, 3), ...span("input-handler", 102, 103),
    record(TASK_RECORD, 249, 4, { cat: "toplevel" }), dispatch("keyup", 250, 2), ...span("input-handler", 250.5, 251.5),
    { ...record(TASK_RECORD, 0, 500, { cat: "toplevel" }), tid: 2 }, { ...record("FunctionCall", 1, 400), tid: 2 }
  ];
}

test("a trace gives each key the script time of its own tasks, its parts and the rest as unattributed, and its style, layout and paint up to the next key", () => {
  const { keys, groups } = traceRecords(sampleTrace());
  const zero = { validation: 0, apply: 0, projection: 0, rendering: 0, rebuild: 0 };
  assert.deepEqual(keys, [
    { at: 0, tasks: 2, script: 2 + 8 + 2 + 1, ...zero, input: 6, route: 2, plan: 2, write: 2, unattributed: 13 - 6, outer: 13, style: 1, layout: 0.25, paint: 1 },
    { at: 100, tasks: 2, script: 3 + 2, ...zero, input: 2, route: 2, plan: 0, write: 0, unattributed: 3, outer: 5, style: 0, layout: 0, paint: 0 }
  ], "the last key's window runs to the end of the case, so its delayed keyup is its own");
  assert.deepEqual(groups, { validation: 2, apply: 3, projection: 0, rendering: 0, input: 8, rebuild: 1, route: 4, plan: 2, write: 2,
    unattributed: 13 + 5 + 9 - 13, outer: 13 + 5 + 9, style: 1, layout: 0.25, paint: 1 }, "a task with neither a key nor a mark adds nothing, and another thread is ignored");
  assert.throws(() => traceRecords([record(TASK_RECORD, 0, 3), dispatch("keyup", 1, 1), record(TASK_RECORD, 5, 5), dispatch("keydown", 6, 2), ...span("input-handler", 6.5, 7.5)]),
    /before the first keydown/, "key work that would fall outside every key is refused");
  assert.throws(() => traceRecords([...sampleTrace(), ...span("render", 200, 201)]), /outside every task record/);
  assert.throws(() => traceRecords([...sampleTrace(), ...span("render", 17, 17.5)]), /A timing mark lies outside every script record/);
  assert.throws(() => traceRecords(sampleTrace().filter((event) => !event.name.startsWith("measure:"))), /no measure: mark/);
  assert.deepEqual(SEAMS.filter((seam) => {
    try { traceRecords([record(TASK_RECORD, 0, 10), record("FunctionCall", 1, 8), ...span(seam, 2, 3)]); return false; } catch { return true; }
  }), [], "every seam belongs to a part");
  assert.deepEqual(TRACE_CATEGORIES.filter((category) => category.startsWith("disabled-by-default")), [], "the trace stays off the costly categories");
});

test("a receive or drain span is no boundary of its own: marks with no browser script record around them are refused", () => {
  assert.throws(() => traceRecords([record(TASK_RECORD, 0, 10), dispatch("keydown", 1, 1), ...span("receive", 3, 5), ...span("trial", 3.5, 4.5)]), /outside every script record/);
  assert.throws(() => traceRecords([record(TASK_RECORD, 0, 10), dispatch("keydown", 1, 1), ...span("drain", 3, 5), ...span("live-apply", 3.5, 4.5)]), /outside every script record/);
  assert.equal(traceRecords([record(TASK_RECORD, 0, 10), dispatch("keydown", 1, 1), record("TimerFire", 2.5, 3), ...span("receive", 3, 5), ...span("trial", 3.5, 4.5)]).groups.validation, 1,
    "the same marks inside a script record are measured");
});


test("arguments: standalone and paired adapter comparisons", () => {
  for (const args of [["base", "--shared"], ["base", "--dry-run"], ["base", "--out", "x.json"]]) {
    assert.throws(() => parseArgs(args), /unknown option/);
  }
  assert.deepEqual(parseArgs(["base"]), { base: "base", head: "HEAD", rounds: 3, only: "short,long,images" });
  const paired = parsePairedArgs(["base"]);
  assert.deepEqual([paired.rounds, paired.only, paired.dryRun], [5, "short,long,large", false]);
  assert.equal(parsePairedArgs(["base", "head", "--rounds", "1", "--only", "short", "--dry-run"]).rounds, 1);
  for (const args of [[], ["base", "--rounds", "2"], ["base", "--only", "edited"], ["base", "--bogus"]]) assert.throws(() => parsePairedArgs(args));
});

test("both comparisons write their records into one results file, each under its own kind", () => {
  const work = mkdtempSync(join(tmpdir(), "perf-shared-test-")), file = join(work, "results.json");
  try {
    writeRecord(file, { kind: "shared-composed-editor", rounds: [1] });
    writeRecord(file, { kind: "shared-admission-paired", rounds: [2] });
    writeRecord(file, { kind: "shared-composed-editor", rounds: [1, 3] });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "shared-composed-editor": { kind: "shared-composed-editor", rounds: [1, 3] },
      "shared-admission-paired": { kind: "shared-admission-paired", rounds: [2] } });
    writeFileSync(file, "[]");
    assert.throws(() => writeRecord(file, { kind: "x" }), /results object/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("every p50 is the median, the mean of the two middle values for an even count, and p95 is the nearest rank, in the standalone tool", () => {
  const latencies = Array.from({ length: 20 }, (_, i) => 20 - i);
  const [standalone] = parsePerf(`PERF ${JSON.stringify({ label: "short typing", latencies, longTasks: 0 })}\n`);
  assert.deepEqual(standalone, { label: "short typing", keys: 20, p50: 10.5, p95: 19, max: 20, longTasks: 0 }, "the standalone row keeps its shape");
  assert.deepEqual(latencyFigures([4, 1, 3]), { keys: 3, p50: 3, p95: 4, max: 4 });
  assert.deepEqual(latencyFigures([]), { keys: 0, p50: null, p95: null, max: null });
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(nearestRank(Array.from({ length: 55 }, (_, i) => i + 1), 0.95), 53);
  assert.match(PERCENTILE_RULE, /p95 is the nearest rank, the ceil\(0\.95 n\)-th smallest value/);
});

test("the pages return their samples unrounded and only the final figures are rounded", () => {
  assert.deepEqual(latencyFigures([1.0496]), { keys: 1, p50: 1, p95: 1, max: 1 });
  const field = /latencies: ([^,}]+)[,}]/.exec(PROBE);
  assert.ok(field, "the page returns its latencies");
  assert.deepEqual(new Function("lat", `return ${field[1]};`)([1.0496]), [1.0496]);
});

test("both trees measure with the running checkout's tools, and a real run refuses tools with local changes", async () => {
  const git = (status) => async (command, args) => args[0] === "status" ? status : "d".repeat(40) + "\n";
  assert.deepEqual(await toolRevision(git(""), ["tools"], false), { commit: "d".repeat(40), changed: false });
  assert.deepEqual(await toolRevision(git(" M tools/perf-ab.mjs\n"), ["tools"], true), { commit: "d".repeat(40), changed: true });
  await assert.rejects(toolRevision(git(" M tools/perf-ab.mjs\n?? tools/new.mjs\n"), ["tools"], false), /commit the measuring tools before a real run; changed: 2 path\(s\) under tools/);
});

test("a revision without the standing trial replica gets the copy-per-update method module, one with it keeps the checkout's", () => {
  const root = mkdtempSync(join(tmpdir(), "perf-place-"));
  try {
    const measure = join("tests", "collab", "measure");
    const checkout = join(root, "checkout"), older = join(root, "older"), newer = join(root, "newer");
    for (const dir of [checkout, older, newer]) mkdirSync(join(dir, measure), { recursive: true });
    writeFileSync(join(checkout, measure, "trial-method.mjs"), "standing");
    writeFileSync(join(checkout, measure, "trial-method-copy.mjs"), "copy");
    mkdirSync(join(newer, "src", "adapters", "collab"), { recursive: true });
    writeFileSync(join(newer, "src", "adapters", "collab", "trial-replica.ts"), "");
    for (const dir of [older, newer]) placeTools(checkout, dir, ["tests/collab/measure"]);
    assert.equal(readFileSync(join(older, measure, "trial-method.mjs"), "utf8"), "copy");
    assert.equal(readFileSync(join(newer, measure, "trial-method.mjs"), "utf8"), "standing");
    assert.equal(readFileSync(join(checkout, measure, "trial-method.mjs"), "utf8"), "standing", "the checkout itself is never changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rounds run in ABBA order and wait for free memory before each one", async () => {
  assert.deepEqual([1, 2, 3, 4].map(abbaOrder), [["base", "head"], ["head", "base"], ["base", "head"], ["head", "base"]]);
  const seen = [2000, 2500, 3200];
  let slept = 0;
  assert.equal(await waitForMemory(3000, { free: () => seen.shift(), sleep: async () => { slept++; }, pollMs: 10, waitMs: 1000 }), 3200);
  assert.equal(slept, 2);
  await assert.rejects(waitForMemory(3000, { free: () => 100, sleep: async () => {}, pollMs: 10, waitMs: 30 }), /stayed under 3000 MB/);
});

test("the paired summary reports the base, head and difference per case", () => {
  const revisions = { tool: { commit: "c".repeat(40), changed: false }, base: { commit: "a".repeat(40) }, head: { commit: "b".repeat(40) } };
  const run = (p50) => ({ current: { single: { p50, p95: p50 }, 1000: { total: p50 } }, direct: { single: { p50 }, 1000: { total: p50 } } });
  const parts = (validation, rebuild) => ({ validation: { p50: validation, total: validation * 500 }, rebuild: { p50: 0, total: rebuild } });
  const paired = pairedSummary({ dryRun: false, revisions, rounds: [
    { side: "base", rows: [{ name: "short", phase: "fresh", trial: "copy per update", run: run(1), parts: parts(0.5, 0) }] },
    { side: "head", rows: [{ name: "short", phase: "fresh", trial: "standing replica", run: run(2), parts: parts(0.25, 3) }] }] });
  assert.match(paired, /\| short \/ fresh \| 1 \/ 2 \/ \+1 \|/);
  assert.match(paired, /\| 0\.5 \/ 0\.25 \/ -0\.25 \| 250 \/ 125 \/ -125 \| 0 \/ 3 \/ \+3 \|$/m, "validation and the rebuild are their own columns");
  assert.match(paired, /Trial before admission: base copy per update, head standing replica\. Tools from cccccccc in both trees\./);
  assert.ok(paired.includes(PERCENTILE_RULE), "the paired summary states the percentile rule");
  assert.deepEqual(parseRound('noise\nROUND [{"name":"short"}]\n'), [{ name: "short" }]);
  assert.throws(() => parseRound("nothing"));
});

