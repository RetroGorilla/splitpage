import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { abbaOrder, parseArgs, sharedSummary, waitForMemory, writeRecord } from "./perf-ab.mjs";
import { parsePairedArgs, pairedSummary, parseRound } from "./measure-shared-paired.mjs";
import { KEY_GAP_MS, TYPED } from "./perf-record.mjs";
import { GROUP_NAMES, PAGE, PENDING_CASES, REMOTE_RATES, SEAMS, caseList, expectedKeys, markGroups, markTotals, parseShared, parseSharedArgs,
  sharedProblems, sharedRows, sharedSuiteText } from "./perf-shared.mjs";

const mark = (name, startTime) => ({ name, startTime });

test("mark totals pair each start with its end and split nested time into inclusive and exclusive", () => {
  const totals = markTotals([
    mark("measure:live-apply:start", 0), mark("measure:mirror-apply:start", 1), mark("measure:mirror-apply:end", 3),
    mark("measure:projection-listeners:start", 3), mark("measure:session-receive:start", 4), mark("measure:render:start", 5),
    mark("measure:render:end", 8), mark("measure:session-receive:end", 9), mark("measure:projection-listeners:end", 9.5),
    mark("measure:live-apply:end", 10), mark("other", 11), mark("measure:trial:start", 12), mark("measure:trial:end", 13.5)
  ]);
  assert.deepEqual(totals.seams["live-apply"], { count: 1, inclusive: 10, exclusive: 1.5 });
  assert.deepEqual(totals.seams["session-receive"], { count: 1, inclusive: 5, exclusive: 2 });
  assert.deepEqual(totals.seams.render, { count: 1, inclusive: 3, exclusive: 3 });
  assert.deepEqual(totals.seams.trial, { count: 1, inclusive: 1.5, exclusive: 1.5 });
  assert.equal(totals.unmatched, 0);
  assert.equal(markTotals([mark("measure:render:start", 0), mark("measure:input-write:start", 1), mark("measure:render:end", 2)]).unmatched, 1);
  assert.equal(markTotals([mark("measure:render:end", 2)]).unmatched, 1);
  assert.equal(markTotals([mark("measure:render:start", 2)]).unmatched, 1);
});

test("mark groups name validation, projection, rendering and input from the seams", () => {
  const seams = Object.fromEntries(SEAMS.map((seam, index) => [seam, { count: 1, inclusive: 10 * (index + 1), exclusive: index + 1 }]));
  const groups = markGroups({ seams, unmatched: 0 });
  assert.deepEqual(Object.keys(groups), GROUP_NAMES);
  assert.equal(groups.validation, 10);
  assert.equal(groups.apply, 2);
  assert.equal(groups.projection, 30 + 40 + 5 + 6 + 70);
  assert.equal(groups.rendering, 80);
  assert.equal(groups.input, 9 + 10 + 11);
  assert.deepEqual([groups.route, groups.plan, groups.write], [9, 10, 11]);
  assert.equal(markGroups({ seams: {}, unmatched: 0 }).projection, 0);
});

test("the cases cover typing on both surfaces at every rate, undo, structural edits, both backlog shapes and refusals", () => {
  const cases = caseList(), labels = cases.map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const surface of ["split", "writer"]) for (const rate of REMOTE_RATES) assert.ok(labels.includes(`${surface} typing, remote ${rate}/s`));
  assert.deepEqual(cases.filter((c) => c.kind === "backlog").map((c) => c.order), ["forward", "catch-up"]);
  assert.deepEqual(cases.filter((c) => c.kind === "structural").map((c) => c.surface), ["split", "writer"]);
  assert.deepEqual(cases.filter((c) => c.kind === "undo").map((c) => c.surface), ["split", "writer"]);
  assert.equal(cases.at(-1).kind, "refused");
  assert.ok(REMOTE_RATES.includes(1));
  assert.deepEqual(PENDING_CASES, [{ label: "split person structural edits", waitsFor: "#1584" }]);
  assert.equal(expectedKeys({ kind: "typing" }), TYPED.length);
  assert.equal(expectedKeys({ kind: "undo" }), 20);
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
  assert.equal(lines.filter((l) => l === `sleep ${KEY_GAP_MS}`).length, (caseList().length + 1 - undos) * presses + undos * 20);
  assert.doesNotThrow(() => new Function(`return ${PAGE};`));
});

test("a run is refused when keys go missing, marks do not pair, refusals are not refused or the backlog never lands", () => {
  const good = (spec) => ({ kind: "case", label: spec.label, keys: expectedKeys(spec), marks: { seams: {}, unmatched: 0 },
    replayed: spec.rate ? { source: "remote", delivered: 3, refused: 0 } : null,
    events: spec.kind === "backlog" ? [{ release: spec.order, updates: 200, ms: 4 }]
      : spec.kind === "refused" ? [{ refused: "throws", ok: false, reason: "invalid-update" }, { refused: "zero-length", ok: false, reason: "invalid-update" }, { refused: "queue-full", ok: true, reason: null }] : [] });
  const entry = { kind: "entry", label: "short entry", fixture: "short", beats: 2, stateBytes: 3, ms: 5, browser: "Edg/1" };
  const rows = [entry, { kind: "case", label: "warm-up (discarded)", keys: 1, marks: { seams: {}, unmatched: 9 }, events: [] }, ...caseList().map(good)];
  assert.deepEqual(sharedProblems(rows, "short"), []);
  const broken = rows.map((r) => r.label === "split typing, remote 1/s" ? { ...r, keys: 3 } : r.label === "split typing, remote 10/s" ? { ...r, marks: { seams: {}, unmatched: 2 } } : r);
  assert.equal(sharedProblems(broken, "short").length, 2);
  const refused = rows.map((r) => r.events?.some((e) => e.refused) ? { ...r, events: [{ refused: "throws", ok: true, reason: null }] } : r);
  assert.equal(sharedProblems(refused, "short").length, 3);
  const unreleased = rows.map((r) => r.events?.some((e) => e.release) ? { ...r, events: [] } : r);
  assert.equal(sharedProblems(unreleased, "short").length, 2);
  assert.equal(sharedProblems(rows.filter((r) => r.kind !== "entry"), "short").length, 1);
  const kept = sharedRows(rows, "short");
  assert.equal(kept.length, caseList().length + 1);
  assert.ok(kept.every((r) => r.kind === "entry" || (r.label.startsWith("short ") && r.groups)));
  assert.deepEqual(parseShared('pressed a\nPERF {"kind":"entry"}\n'), [{ kind: "entry" }]);
});

test("arguments: perf-shared, the shared comparison and the paired adapter rerun", () => {
  assert.equal(parseSharedArgs(["--prepare", "x.json", "--only", "short"]).only[0], "short");
  for (const args of [[], ["--data"], ["--data", "x", "--only", "huge"], ["--data", "x", "--only", "short,short"], ["--bogus"]]) assert.ok(parseSharedArgs(args).error);
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

test("rounds run in ABBA order and wait for free memory before each one", async () => {
  assert.deepEqual([1, 2, 3, 4].map(abbaOrder), [["base", "head"], ["head", "base"], ["base", "head"], ["head", "base"]]);
  const seen = [2000, 2500, 3200];
  let slept = 0;
  assert.equal(await waitForMemory(3000, { free: () => seen.shift(), sleep: async () => { slept++; }, pollMs: 10, waitMs: 1000 }), 3200);
  assert.equal(slept, 2);
  await assert.rejects(waitForMemory(3000, { free: () => 100, sleep: async () => {}, pollMs: 10, waitMs: 30 }), /stayed under 3000 MB/);
});

test("summaries report base, head and the difference per case, and mark a dry run as not evidence", () => {
  const groups = Object.fromEntries(GROUP_NAMES.map((g) => [g, 1]));
  const row = (p50) => ({ kind: "case", label: "short split typing, remote 1/s", p50, p95: p50 * 2, longTaskMs: 0, groups });
  const revisions = { base: { commit: "a".repeat(40) }, head: { commit: "b".repeat(40) } };
  const record = { dryRun: true, revisions, rounds: [
    { side: "base", rows: [row(10)] }, { side: "head", rows: [row(12)] }, { side: "head", rows: [row(14)] }, { side: "base", rows: [row(20)] }] };
  const text = sharedSummary(record);
  assert.match(text, /^Dry run: pipeline check only, not evidence\./);
  assert.match(text, /\| short split typing, remote 1\/s \| 15 \/ 13 \/ -2 \| 30 \/ 26 \/ -4 \| 0 \/ 0 \/ \+0 \|/);
  assert.doesNotMatch(sharedSummary({ ...record, dryRun: false }), /Dry run/);
  const run = (p50) => ({ current: { single: { p50, p95: p50 }, 1000: { total: p50 } }, direct: { single: { p50 }, 1000: { total: p50 } } });
  const paired = pairedSummary({ dryRun: false, revisions, rounds: [{ side: "base", rows: [{ name: "short", phase: "fresh", run: run(1) }] }, { side: "head", rows: [{ name: "short", phase: "fresh", run: run(2) }] }] });
  assert.match(paired, /\| short \/ fresh \| 1 \/ 2 \/ \+1 \|/);
  assert.deepEqual(parseRound('noise\nROUND [{"name":"short"}]\n'), [{ name: "short" }]);
  assert.throws(() => parseRound("nothing"));
});
