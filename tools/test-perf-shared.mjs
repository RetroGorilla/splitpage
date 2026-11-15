import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { abbaOrder, passOrder, parseArgs, placeTools, sharedSummary, toolRevision, tracingNoise, waitForMemory, writeRecord } from "./perf-ab.mjs";
import { parsePairedArgs, pairedSummary, parseRound } from "./measure-shared-paired.mjs";
import { KEY_GAP_MS, PROBE, TYPED, parsePerf } from "./perf-record.mjs";
import { EARLIER_RECORDS, PERCENTILE_RULE, latencyFigures, median, nearestRank } from "./perf-stats.mjs";
import { ENTRY_CEILING_BYTES, GROUP_NAMES, PAGE, REMOTE_RATES, SEAMS, attachTraces, caseList, dataFixtures, entryOutcome, expectedKeys, parseShared, parseSharedArgs,
  prepareData, sharedProblems, sharedRecord, sharedReport, sharedRows, sharedSuiteText, traceFile, tracedCase } from "./perf-shared.mjs";
import { TASK_RECORD, TRACE_CATEGORIES, traceRecords } from "./perf-trace.mjs";

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
  assert.deepEqual(GROUP_NAMES, Object.keys(groups));
  assert.throws(() => traceRecords([...sampleTrace(), ...span("render", 200, 201)]), /outside every task record/);
  assert.throws(() => traceRecords([...sampleTrace(), ...span("render", 17, 17.5)]), /A timing mark lies outside every script record/);
  assert.throws(() => traceRecords(sampleTrace().filter((event) => !event.name.startsWith("measure:"))), /no measure: mark/);
  assert.deepEqual(SEAMS.filter((seam) => {
    try { traceRecords([record(TASK_RECORD, 0, 10), record("FunctionCall", 1, 8), ...span(seam, 2, 3)]); return false; } catch { return true; }
  }), [], "every seam belongs to a part");
  assert.deepEqual(TRACE_CATEGORIES.filter((category) => category.startsWith("disabled-by-default")), [], "the trace stays off the costly categories");
  const problem = tracedCase(() => { throw new Error("no file"); });
  assert.deepEqual(problem, { keys: [], groups: null, problem: "no file" });
});

test("a receive or drain span is no boundary of its own: marks with no browser script record around them are refused", () => {
  assert.throws(() => traceRecords([record(TASK_RECORD, 0, 10), dispatch("keydown", 1, 1), ...span("receive", 3, 5), ...span("trial", 3.5, 4.5)]), /outside every script record/);
  assert.throws(() => traceRecords([record(TASK_RECORD, 0, 10), dispatch("keydown", 1, 1), ...span("drain", 3, 5), ...span("live-apply", 3.5, 4.5)]), /outside every script record/);
  assert.equal(traceRecords([record(TASK_RECORD, 0, 10), dispatch("keydown", 1, 1), record("TimerFire", 2.5, 3), ...span("receive", 3, 5), ...span("trial", 3.5, 4.5)]).groups.validation, 1,
    "the same marks inside a script record are measured");
});

test("the cases cover typing on both surfaces at every rate, undo, peer and own structural edits, both backlog shapes and refusals", () => {
  const cases = caseList(), labels = cases.map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const surface of ["split", "writer"]) for (const rate of REMOTE_RATES) assert.ok(labels.includes(`${surface} typing, remote ${rate}/s`));
  assert.deepEqual(cases.filter((c) => c.kind === "backlog").map((c) => c.order), ["forward", "catch-up"]);
  assert.deepEqual(cases.filter((c) => c.kind === "structural").map((c) => c.surface), ["split", "writer"]);
  assert.deepEqual(cases.filter((c) => c.kind === "undo").map((c) => c.surface), ["split", "writer"]);
  assert.equal(cases.at(-1).kind, "refused");
  assert.ok(REMOTE_RATES.includes(1));
  assert.deepEqual(cases.filter((c) => c.kind === "own-structural").map((c) => [c.surface, c.rate]), [["split", 1]]);
  assert.equal(expectedKeys({ kind: "typing" }), TYPED.length);
  assert.equal(expectedKeys({ kind: "undo" }), 20);
  assert.equal(expectedKeys({ kind: "own-structural" }), 10);
});

test("the suite enters from the stored state, warms up once, switches to the Writer once and ends every case", () => {
  const data = { name: "short", state: "AAAA", stateBytes: 3, rows: 2, replay: ["AQ==", "Ag=="], filler: "x".repeat(150000) };
  const text = sharedSuiteText(data), lines = text.trim().split("\n");
  const chunks = lines.filter((l) => l.startsWith("eval window.__perfShared.chunk(")).map((l) => JSON.parse(l.slice("eval window.__perfShared.chunk(".length, -1)));
  assert.ok(chunks.length > 1);
  assert.deepEqual(JSON.parse(chunks.join("")), data);
  assert.ok(lines.indexOf("eval window.__perfShared.enter()") > lines.findLastIndex((l) => l.startsWith("eval window.__perfShared.chunk(")));
  const ends = lines.filter((l) => l.startsWith("eval window.__perfShared.end("));
  assert.deepEqual(ends.map((l) => JSON.parse(l.slice("eval window.__perfShared.end(".length, -1))), ["warm-up (discarded)", ...caseList().map((c) => c.label)]);
  assert.equal(lines.filter((l) => l === "click #btn-write").length, 1);
  assert.ok(lines.indexOf("click #btn-write") > lines.indexOf(ends[caseList().findIndex((c) => c.surface === "writer")]));
  const presses = TYPED.match(/ ?[^ ]/g).length, undos = caseList().filter((c) => c.kind === "undo").length;
  const own = caseList().filter((c) => c.kind === "own-structural").length;
  assert.equal(lines.filter((l) => l === `sleep ${KEY_GAP_MS}`).length, (caseList().length + 1 - undos - own) * presses + undos * 20 + own * 10);
  assert.equal(lines.filter((l) => l === "key ctrl Enter").length, own * 10);
  assert.doesNotThrow(() => new Function(`return ${PAGE};`));
  assert.equal(lines.filter((l) => l.startsWith("trace ")).length, 0, "an untraced pass records no trace");
  assert.equal(lines.filter((l) => l === "eval window.__perfShared.stop()").length, caseList().length + 1, "both passes stop the feed the same way");
  const traced = sharedSuiteText(data, "traces").trim().split("\n"), starts = traced.filter((l) => l === `trace start ${TRACE_CATEGORIES.join(",")}`);
  assert.equal(starts.length, caseList().length, "every case but the warm-up is traced");
  caseList().forEach((spec, index) => {
    const stop = traced.indexOf(`trace stop ${traceFile("traces", index)}`), ended = traced.indexOf(`eval window.__perfShared.end(${JSON.stringify(spec.label)})`);
    const begun = traced.findLastIndex((l, at) => at < stop && l.startsWith("eval window.__perfShared.begin("));
    assert.ok(stop > 0 && stop === ended - 1 && traced[begun - 1] === starts[0], `${spec.label}: the trace starts just before begin and stops just before end`);
    assert.equal(traced[stop - 1], "eval window.__perfShared.stop()", `${spec.label}: the remote feed and timers stop before the trace does`);
  });
});

test("a run is refused when keys go missing, a trace cannot be read, refusals are not refused or the backlog never lands", () => {
  const trace = (spec) => ({ keys: Array.from({ length: expectedKeys(spec) }, () => ({})), groups: Object.fromEntries(GROUP_NAMES.map((g) => [g, 1])), problem: null });
  const good = (spec) => ({ kind: "case", label: spec.label, keys: expectedKeys(spec), trace: trace(spec),
    replayed: spec.rate ? { source: "remote", delivered: 3, refused: 0, recovered: 0 } : null,
    events: spec.kind === "backlog" ? [{ release: spec.order, updates: 200, ms: 4 }]
      : spec.kind === "refused" ? [{ refused: "throws", ok: false, reason: "invalid-update" }, { refused: "zero-length", ok: false, reason: "invalid-update" }, { refused: "queue-full", ok: true, reason: null }] : [] });
  const entry = { kind: "entry", label: "short entry", fixture: "short", beats: 2, stateBytes: 3, ms: 5, browser: "Edg/1" };
  const rows = [entry, { kind: "case", label: "warm-up (discarded)", keys: 1, events: [] }, ...caseList().map(good)];
  assert.deepEqual(sharedProblems(rows, "short"), []);
  const untraced = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([name]) => name !== "trace")));
  assert.deepEqual(sharedProblems(untraced, "short"), [], "an untraced pass has no trace to check");
  const broken = rows.map((r) => r.label === "split typing, remote 1/s" ? { ...r, keys: 3 }
    : r.label === "split typing, remote 10/s" ? { ...r, trace: { keys: [], groups: null, problem: "Unclosed timing mark: render" } }
      : r.label === "split typing, remote 0/s" ? { ...r, trace: { ...r.trace, keys: [{}] } } : r);
  assert.deepEqual(sharedProblems(broken, "short"), ["split typing, remote 0/s: 1 traced keys, expected " + TYPED.length, "split typing, remote 1/s: 3 key samples, expected " + TYPED.length,
    "split typing, remote 10/s: Unclosed timing mark: render"]);
  const refused = rows.map((r) => r.events?.some((e) => e.refused) ? { ...r, events: [{ refused: "throws", ok: true, reason: null }] } : r);
  assert.equal(sharedProblems(refused, "short").length, 3);
  const unreleased = rows.map((r) => r.events?.some((e) => e.release) ? { ...r, events: [] } : r);
  assert.equal(sharedProblems(unreleased, "short").length, 2);
  assert.equal(sharedProblems(rows.filter((r) => r.kind !== "entry"), "short").length, 1);
  const kept = sharedRows(rows, "short");
  assert.equal(kept.length, caseList().length + 1);
  assert.ok(kept.every((r) => r.kind === "entry" || (r.label.startsWith("short ") && r.traced && r.groups.unattributed === 1 && r.keyRecords.length === r.keys && !("trace" in r))));
  assert.ok(sharedRows(untraced, "short").every((r) => r.kind === "entry" || (!r.traced && r.groups === null && r.keyRecords === null)));
  assert.match(sharedReport(sharedRows(untraced, "short")), /Untraced pass: latency and long tasks only/);
  assert.match(sharedReport(kept, true), new RegExp(`Traced pass \\(categories ${TRACE_CATEGORIES.join(", ")}\\)`));
  const attached = attachTraces([entry, { kind: "case", label: caseList()[2].label }], (index) => { assert.equal(index, 2); return sampleTrace(); });
  assert.deepEqual([attached[0], attached[1].trace.problem, attached[1].trace.keys.length], [entry, null, 2]);
  assert.deepEqual(parseShared('pressed a\nPERF {"kind":"entry"}\n'), [{ kind: "entry" }]);
});

test("arguments: perf-shared, the shared comparison and the paired adapter rerun", () => {
  assert.equal(parseSharedArgs(["--prepare", "x.json", "--only", "short"]).only[0], "short");
  assert.deepEqual([parseSharedArgs(["--data", "x.json"]).trace, parseSharedArgs(["--data", "x.json", "--trace"]).trace], [false, true]);
  for (const args of [[], ["--data"], ["--prepare", "x", "--only", "huge"], ["--data", "x", "--only", "short,short"], ["--bogus"], ["--prepare", "x", "--trace"]]) assert.ok(parseSharedArgs(args).error);
  assert.match(dataFixtures({ fixtures: { short: {} } }, ["huge"]).error, /the data file has no huge fixture/, "a measuring run refuses a fixture its data file lacks");
  const shared = parseArgs(["base", "--shared"]);
  assert.deepEqual([shared.rounds, shared.only, shared.dryRun, shared.minFreeMb, shared.out], [5, "short,long,large,edited", false, 3000, null]);
  assert.equal(parseArgs(["base", "--shared", "--rounds", "1", "--only", "short", "--dry-run"]).rounds, 1);
  for (const args of [["base", "--shared", "--rounds", "4"], ["base", "--shared", "--only", "images"], ["base", "--dry-run"], ["base", "--out", "x.json"], ["base", "--shared", "--min-free-mb", "0"]]) {
    assert.throws(() => parseArgs(args));
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

test("every p50 is the median, the mean of the two middle values for an even count, and p95 is the nearest rank, in the shared and standalone tools", () => {
  const latencies = Array.from({ length: 20 }, (_, i) => 20 - i);
  const [shared] = parseShared(`PERF ${JSON.stringify({ kind: "case", label: "x", latencies })}\n`);
  assert.deepEqual([shared.keys, shared.p50, shared.p95, shared.max], [20, 10.5, 19, 20]);
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
  for (const [name, source] of [["shared", PAGE], ["standalone", PROBE]]) {
    const field = /latencies: ([^,}]+)[,}]/.exec(source);
    assert.ok(field, `${name}: the page returns its latencies`);
    assert.deepEqual(new Function("lat", `return ${field[1]};`)([1.0496]), [1.0496], `${name}: the page passes each sample through as measured`);
  }
  const [row] = parseShared(`PERF ${JSON.stringify({ kind: "case", label: "x", latencies: [1.0496] })}\n`);
  assert.deepEqual([row.p50, row.p95, row.max], [1, 1, 1]);
});

test("every record carries the percentile rule and says earlier standalone figures are not comparable", () => {
  const direct = sharedRecord([], true);
  assert.equal(direct.percentiles, PERCENTILE_RULE);
  assert.equal(direct.earlierRecords, EARLIER_RECORDS);
  assert.deepEqual(direct.traceCategories, TRACE_CATEGORIES);
  assert.equal(sharedRecord([], false).traceCategories, null);
  assert.match(EARLIER_RECORDS, /p50 the upper middle value, p95 the largest of 20 samples\) and are not comparable/);
  assert.ok(sharedReport([], false).includes(EARLIER_RECORDS), "the direct report says so too");
});

test("both trees measure with the running checkout's tools, and a real run refuses tools with local changes", async () => {
  const git = (status) => async (command, args) => args[0] === "status" ? status : "d".repeat(40) + "\n";
  assert.deepEqual(await toolRevision(git(""), ["tools"], false), { commit: "d".repeat(40), changed: false });
  assert.deepEqual(await toolRevision(git(" M tools/perf-shared.mjs\n"), ["tools"], true), { commit: "d".repeat(40), changed: true });
  await assert.rejects(toolRevision(git(" M tools/perf-shared.mjs\n?? tools/new.mjs\n"), ["tools"], false), /commit the measuring tools before a real run; changed: 2 path\(s\) under tools/);
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

test("summaries report base, head and the difference per case, mark a dry run as not evidence, and take the budget figures from the untraced pass only when tracing moved them past the noise rule", () => {
  const groups = Object.fromEntries(GROUP_NAMES.map((g) => [g, 1]));
  const row = (p50, traced) => ({ kind: "case", label: "short split typing, remote 1/s", p50, p95: p50 * 2, longTaskMs: 0, groups: traced ? groups : null });
  const revisions = { tool: { commit: "c".repeat(40), changed: false }, base: { commit: "a".repeat(40) }, head: { commit: "b".repeat(40) } };
  const both = (side, p50, shift) => [{ side, pass: "untraced", rows: [row(p50, false)] }, { side, pass: "traced", rows: [row(p50 + shift, true)] }];
  const record = (shift) => ({ dryRun: true, revisions, rounds: [...both("base", 10, shift), ...both("head", 12, shift), ...both("head", 14, shift), ...both("base", 20, shift)] });
  const quiet = sharedSummary(record(0.25));
  assert.match(quiet, /^Dry run: pipeline check only, not evidence\./);
  assert.match(quiet, /one traced pass serves both/);
  assert.match(quiet, /\| short split typing, remote 1\/s \| 15\.25 \/ 13\.25 \/ -2 \| 30\.5 \/ 26\.5 \/ -4 \| 0 \/ 0 \/ \+0 \| 1 \/ 1 \/ \+0 \|/);
  const loud = sharedSummary(record(40));
  assert.match(loud, /budget figures \(p50, p95, long tasks\) come from the untraced pass/);
  assert.match(loud, /\| short split typing, remote 1\/s \| 15 \/ 13 \/ -2 \| 30 \/ 26 \/ -4 \| 0 \/ 0 \/ \+0 \| 1 \/ 1 \/ \+0 \|/);
  assert.match(loud, /\| base \| short split typing, remote 1\/s \| p50 \| 15 \| 55 \| 10 \| no \|/);
  const noise = tracingNoise(record(1.6));
  assert.deepEqual(noise.rows.map((r) => [r.side, r.measure, r.allowed, r.within]), [["base", "p50", 10, true], ["base", "p95", 20, true], ["head", "p50", 2, true], ["head", "p95", 4, true]],
    "allowed is the larger of the untraced range, 15 % of its median and the floor");
  assert.equal(tracingNoise(record(-2.5)).within, false, "a traced pass faster by more than the allowance is outside the noise too");
  assert.deepEqual(passOrder(1), ["untraced", "traced"]);
  assert.deepEqual(passOrder(2), ["traced", "untraced"]);
  assert.doesNotMatch(sharedSummary({ ...record(0), dryRun: false }), /Dry run/);
  const run = (p50) => ({ current: { single: { p50, p95: p50 }, 1000: { total: p50 } }, direct: { single: { p50 }, 1000: { total: p50 } } });
  const parts = (validation, rebuild) => ({ validation: { p50: validation, total: validation * 500 }, rebuild: { p50: 0, total: rebuild } });
  const paired = pairedSummary({ dryRun: false, revisions, rounds: [
    { side: "base", rows: [{ name: "short", phase: "fresh", trial: "copy per update", run: run(1), parts: parts(0.5, 0) }] },
    { side: "head", rows: [{ name: "short", phase: "fresh", trial: "standing replica", run: run(2), parts: parts(0.25, 3) }] }] });
  assert.match(paired, /\| short \/ fresh \| 1 \/ 2 \/ \+1 \|/);
  assert.match(paired, /\| 0\.5 \/ 0\.25 \/ -0\.25 \| 250 \/ 125 \/ -125 \| 0 \/ 3 \/ \+3 \|$/m, "validation and the rebuild are their own columns");
  assert.match(paired, /Trial before admission: base copy per update, head standing replica\. Tools from cccccccc in both trees\./);
  assert.match(sharedSummary(record(0)), /tools from cccccccc in both trees/);
  for (const summary of [paired, sharedSummary(record(0))]) assert.ok(summary.includes(PERCENTILE_RULE), "each summary states the percentile rule");
  assert.deepEqual(parseRound('noise\nROUND [{"name":"short"}]\n'), [{ name: "short" }]);
  assert.throws(() => parseRound("nothing"));
});

test("a state file is named on the command line, belongs to the preparation and joins the fixtures", () => {
  const prepared = parseSharedArgs(["--prepare", "x.json", "--state", "day-30=day.bin"]);
  assert.deepEqual([prepared.error, prepared.only, prepared.states.map((s) => s.name)], [null, ["short", "long", "large", "edited", "day-30"], ["day-30"]]);
  assert.ok(isAbsolute(prepared.states[0].file) && prepared.states[0].file.endsWith("day.bin"), "the file is resolved before the tool changes directory");
  assert.deepEqual(parseSharedArgs(["--prepare", "x.json", "--state", "day-30=day.bin", "--only", "day-30"]).only, ["day-30"]);
  for (const args of [["--prepare", "x", "--state"], ["--prepare", "x", "--state", "Day=x"], ["--prepare", "x", "--state", "short=x"], ["--prepare", "x", "--state", "a="],
    ["--prepare", "x", "--state", "a=x", "--state", "a=y"], ["--data", "x", "--state", "a=x"]]) assert.ok(parseSharedArgs(args).error, args.join(" "));
  assert.deepEqual(parseSharedArgs(["--data", "x.json", "--only", "day-30"]).only, ["day-30"], "a measuring run takes the fixtures its data file holds");
  assert.deepEqual(dataFixtures({ fixtures: { short: {}, "day-30": {} } }, null), { names: ["short", "day-30"], error: null });
  assert.equal(parseArgs(["base", "--shared", "--state", "day-30=day.bin"]).only, "short,long,large,edited,day-30");
  assert.equal(parseArgs(["base", "--shared", "--state", "day-30=day.bin", "--only", "day-30", "--rounds", "1", "--dry-run"]).states[0].name, "day-30");
  assert.throws(() => parseArgs(["base", "--state", "day-30=day.bin"]), /belong to --shared/);
  assert.equal(parsePairedArgs(["base", "--state", "day-30=day.bin"]).only, "short,long,large,day-30");
  assert.throws(() => parsePairedArgs(["base", "--state", "large=day.bin"]), /already a fixture/);
});

async function stateFiles() {
  const { fixtures, open } = await import("../tests/collab/measure/run.mjs");
  const { createSharedDocument, destroySharedDocument, encodeSharedState } = await import("../src/adapters/collab/document.ts");
  const { hydrateSharedDocument } = await import("../src/adapters/collab/hydrate.ts");
  const { enterSharedDocument } = await import("../src/core/migrate.ts");
  const short = fixtures().find((f) => f.name === "short");
  const encode = (handle, document = short.document) => {
    try { hydrateSharedDocument(handle, enterSharedDocument(structuredClone(document))); return encodeSharedState(handle); } finally { destroySharedDocument(handle); }
  };
  return { short, own: encode(createSharedDocument()), fixed: encode(open()), single: encode(createSharedDocument(), { ...short.document, rows: short.document.rows.slice(0, 1), comments: [], brollShots: [] }) };
}

test("a state file is projected for its beats, plain document and hash, and refused when the tools' own client ids wrote it or it holds one beat", async () => {
  const { stateFixture } = await import("../tests/collab/measure/run.mjs");
  const { short, own, fixed, single } = await stateFiles();
  const fixture = stateFixture("day-30", own);
  assert.deepEqual(fixture.document.rows.map((r) => r.id), short.document.rows.map((r) => r.id));
  assert.equal(fixture.sha256, createHash("sha256").update(own).digest("hex"));
  assert.ok(fixture.plain > 0);
  assert.throws(() => stateFixture("day-30", fixed), /written with the measurement's fixed client ids \(0x81234567\)/);
  assert.throws(() => stateFixture("day-30", single), /holds 1 beat\(s\); the measurement needs at least two/);
});

test("a prepared state file carries its size and hash, never its path, and the remote and local beats come from the state", async () => {
  const { short, own } = await stateFiles();
  const work = mkdtempSync(join(tmpdir(), "perf-shared-state-")), file = join(work, "day.bin");
  try {
    writeFileSync(file, own);
    const data = await prepareData(["day-30"], [{ name: "day-30", file }]);
    const day = data.fixtures["day-30"];
    assert.deepEqual([day.stateBytes, day.stateSha256, day.rows, day.remoteRow, day.localRow, day.replay.length],
      [own.length, createHash("sha256").update(own).digest("hex"), short.document.rows.length, short.document.rows[0].id, short.document.rows[1].id, 400]);
    assert.equal(Buffer.from(day.state, "base64").equals(Buffer.from(own)), true);
    assert.equal(data.entryCeilingBytes, ENTRY_CEILING_BYTES);
    assert.ok(!JSON.stringify(data).includes(work) && !JSON.stringify(data).includes("day.bin"), "no path reaches the data");
    const { prepare } = await import("../tests/collab/measure/paired.mjs");
    const paired = prepare(["day-30"], [{ name: "day-30", file }]);
    assert.deepEqual(paired.fixtures.map((f) => [f.name, Object.keys(f.states), f.updates.length, f.document.rows.length]), [["day-30", ["state"], 1000, short.document.rows.length]],
      "the paired rerun measures a state file as one phase of its own, with its update stream generated against it");
    assert.ok(!JSON.stringify(paired).includes(work), "no path reaches the paired data either");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("an entry the app refuses is reported with its distance from the 2 MiB ceiling, and its cases are skipped rather than failed", () => {
  const lines = sharedSuiteText({ name: "day-30", state: "AAAA", stateBytes: 3, rows: 2, replay: [] }).trim().split("\n");
  assert.equal(lines[lines.indexOf("eval window.__perfShared.enter()") + 1], "stop-unless window.__perfShared.entered()", "the script ends at a refused entry");
  const over = { kind: "entry", fixture: "day-30", stateBytes: ENTRY_CEILING_BYTES + 10, refused: "enter-failed", beats: null, ms: null, browser: "Edg/1" };
  assert.equal(entryOutcome(over), "refused at entry (enter-failed), 10 bytes over the 2 MiB ceiling");
  assert.equal(entryOutcome({ ...over, stateBytes: ENTRY_CEILING_BYTES - 4 }), "refused at entry (enter-failed), 4 bytes under the 2 MiB ceiling");
  assert.equal(entryOutcome({ ...over, refused: null, ms: 12.5 }), "12.5 ms");
  assert.match(sharedReport([over]), /\| day-30 \| — \| 2097162 \| — \| — \| refused at entry \(enter-failed\), 10 bytes over the 2 MiB ceiling \| Edg\/1 \|/);
  const revisions = { tool: { commit: "c".repeat(40) }, base: { commit: "a".repeat(40) }, head: { commit: "b".repeat(40) } };
  const summary = sharedSummary({ dryRun: false, revisions, rounds: [{ side: "head", pass: "untraced", rows: [over] }] });
  assert.match(summary, /Entries refused, their cases not run: head day-30: refused at entry \(enter-failed\), 10 bytes over the 2 MiB ceiling\./);
});
