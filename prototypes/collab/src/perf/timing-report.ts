import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { isProjectionEntry } from "../proj/entry.ts";
import { perfCases, percentile } from "./measure.ts";
import type { PerfEvidence, PerfRun } from "./run.ts";
import { validateTimedSource } from "./setup.ts";

export function validateEvidence(evidence: PerfEvidence): void {
  assert.equal(evidence.version, 1);
  assert.equal(evidence.machine.node, "v24.22.1");
  assert.equal(evidence.machine.yjs, "13.6.33");
  validateTimedSource(evidence.sourceHead, evidence.sourceDigest);
  assert.ok(evidence.machine.cpu && evidence.machine.platform && evidence.machine.osRelease && evidence.sourceHead);
  assert.equal(Object.hasOwn(evidence.machine, "hostname"), false);
  assert.equal(evidence.method.rounds, 5);
  assert.equal(evidence.method.warmup, 3);
  assert.equal(evidence.method.samplesPerCase, 11);
  assert.equal(evidence.method.historyCycles, 500);
  assert.deepEqual(evidence.method.locks, ["perf", "smoke"]);
  assert.equal(evidence.fixtures.length, 3);
  assert.deepEqual(evidence.fixtures.map(input => input.name), ["largest canonical", "large", "near 2 MiB"]);
  for (const fixture of evidence.fixtures) {
    assert.match(fixture.sha256, /^[0-9a-f]{64}$/);
    for (const candidate of ["A", "B"]) {
      const runs = evidence.runs.filter(run => run.valid && run.fixture === fixture.name && run.candidate === candidate);
      assert.equal(runs.length, 5);
      assert.deepEqual(runs.map(run => run.round), [0, 1, 2, 3, 4]);
    }
  }
  for (const run of evidence.runs) {
    assert.ok(Number.isFinite(run.condition.freeMemoryBytes) && run.condition.freeMemoryBytes >= 3 * 1024 ** 3);
    assert.ok(run.condition.cpuBefore <= 35 && run.condition.cpuBefore >= 0);
    assert.equal(run.condition.forbiddenProcesses.length, 0);
    assert.ok(run.cpuAfter >= 0 && Number.isFinite(run.cpuAfter));
    assert.equal(run.valid, run.cpuAfter <= 35);
    for (const cases of [run.edits, ...(run.fixture === "large" ? [run.afterHistory] : [])]) {
      assert.deepEqual(cases.map(item => item.name), [...perfCases]);
      for (const item of cases) {
        assert.equal(item.samples.length, 11);
        assert.equal(item.projectedBeats.length, 11);
        assert.equal(item.projectionCommits.length, 11);
        assert.ok(item.targetBeat && item.targetCharacters > 0);
        assert.ok(item.projectionCommits.every(count => count === (item.name.includes("identit") ? 0 : item.name === "remote burst 100 individual transactions" ? 100 : 1)));
        assert.ok(item.samples.every(sample => Number.isFinite(sample) && sample >= 0));
        assert.equal(item.p50, percentile(item.samples, 0.5));
        assert.equal(item.p95, percentile(item.samples, 0.95));
        assert.equal(item.max, Math.max(...item.samples));
      }
    }
    if (run.fixture === "large") {
      assert.deepEqual(run.checkpoints.map(point => point.operations), [0, 10020, 25050, 50100]);
      for (const point of run.checkpoints) {
        assert.ok(point.encodedBytes > 0);
        assert.equal(point.load.gc, true);
        for (const number of Object.values(point.load).filter(value => typeof value === "number")) assert.ok(Number.isFinite(number) && number >= 0);
      }
      const last = run.checkpoints.at(-1);
      assert.equal(last?.counts.beats, 800);
      assert.equal(last?.counts.retiredJoins, 500);
      assert.equal(last?.counts.removedBeats, 100);
    } else {
      assert.equal(run.checkpoints.length, 1);
      assert.equal(run.checkpoints[0]?.operations, 0);
    }
  }
  const valid = evidence.runs.filter(run => run.valid);
  for (let round = 0; round < 5; round++) for (const fixture of evidence.fixtures) {
    assert.deepEqual(valid.filter(run => run.round === round && run.fixture === fixture.name).map(run => run.candidate), round % 2 ? ["B", "A"] : ["A", "B"]);
  }
}

function summary(samples: number[]) {
  return { median: percentile(samples, 0.5), min: Math.min(...samples), max: Math.max(...samples) };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Incomplete measurement evidence");
  return value;
}

function format(samples: number[], digits = 3): string {
  const value = summary(samples);
  return `${value.median.toFixed(digits)} [${value.min.toFixed(digits)}–${value.max.toFixed(digits)}]`;
}

export function comparePerf(a: number[], b: number[], floor = 0.5, fraction = 0.15): string {
  const left = summary(a), right = summary(b);
  const tolerance = Math.max(left.max - left.min, fraction * left.median, floor, right.max - right.min, fraction * right.median);
  const difference = left.median - right.median;
  return Math.abs(difference) <= tolerance ? `no difference beyond noise (T=${tolerance.toFixed(3)})` : `${difference > 0 ? "B" : "A"} cheaper by ${Math.abs(difference).toFixed(3)} (${(100 * Math.abs(difference) / Math.max(left.median, right.median)).toFixed(1)}%)`;
}

export function generatePerfReport(evidence: PerfEvidence): string {
  validateEvidence(evidence);
  const lines = ["# Incremental projection and retained-state performance", "",
    "Generated by `node src/perf/report.ts --write`. PERF evidence compares the two implementations; it selects no schema.", "",
    `Machine: ${evidence.machine.cpu?.trim()}, ${evidence.machine.platform} ${evidence.machine.osRelease}, ${evidence.machine.architecture}, ${(evidence.machine.totalMemoryBytes / 1024 ** 3).toFixed(2)} GiB RAM. Node ${evidence.machine.node}, Yjs ${evidence.machine.yjs}. Source base: ${evidence.sourceHead}; the committed source and raw results travel together.`, "",
    "Machine identifiers and local paths were redacted after the run. No measured value, sample, timestamp, load reading or count changed. The recorder now omits host names; transcript redaction emits repository-relative paths or placeholders. Preservation checks cover all 76 comparison rows and all 4,510 samples.", "",
    "## Method", "",
    "Five whole-fixture runs per candidate, alternating A/B then B/A each round. Each case warms up three operations and records eleven operations. Tables give the median of the five per-run p50s [minimum–maximum]; p95 is the median of the five per-run p95s. Every sample, projected-beat count, free-RAM reading, CPU reading and void run is in `src/perf/results.json`. No samples are dropped. Locks perf and smoke are held through the wrapper; no own tests run concurrently.", "",
    "The artifact 7 tolerance is max(base run range, 15% of base median, 0.5 ms). Candidate comparisons apply it in both directions and require a difference larger than both tolerances. Open/projection-load uses the 5 ms floor; heap uses 3% and 0.25 MiB. Byte differences are exact. The tolerance governs comparisons, never erases an absolute CPU budget failure. This is a candidate comparison, not a standalone base/head regression test; no shipping code changed.", "",
    evidence.method.otherLoad, "",
    `Free RAM before accepted runs: ${evidence.runs.filter(run => run.valid).map(run => (run.condition.freeMemoryBytes / 1024 ** 3).toFixed(2)).join(", ")} GiB. CPU before/after: ${evidence.runs.filter(run => run.valid).map(run => `${run.condition.cpuBefore.toFixed(1)}/${run.cpuAfter.toFixed(1)}`).join(", ")}%. Voids retained: ${evidence.runs.filter(run => !run.valid).length}; refused starts retained: ${evidence.refusedStarts.length}. Runs below 3 GiB or with invalid starting conditions are refused before measurement. Other machine load may affect every run.`, "",
    "## Fixtures", "", "| Fixture | Beats | Copies | Plain .splitpage bytes | SHA-256 of input |", "| --- | ---: | ---: | ---: | --- |"];
  for (const fixture of evidence.fixtures) lines.push(`| ${fixture.name} | ${fixture.beats} | ${fixture.copies} | ${fixture.fileBytes} | ${fixture.sha256} |`);
  lines.push("", "### Accepted-run background load", "", "A game was running throughout the accepted set. CPU is the one-second aggregate machine load sampled while the recorder waited, before and after each run; it does not isolate the game from other background processes.", "",
    "| Round | Fixture | Candidate | Free RAM GiB before | CPU % before | CPU % after |", "| ---: | --- | --- | ---: | ---: | ---: |");
  for (const run of evidence.runs.filter(run => run.valid)) lines.push(`| ${run.round + 1} | ${run.fixture} | ${run.candidate} | ${(run.condition.freeMemoryBytes / 1024 ** 3).toFixed(2)} | ${run.condition.cpuBefore.toFixed(1)} | ${run.cpuAfter.toFixed(1)} |`);
  lines.push("", "An item visit in the structural tables is a linked-list item iteration, including formatting/deleted items, rather than a character. The public-call scan difference belongs to this implementation; a binding using the same calls retains it, while an identity index or batched traversal could reduce A's repeated scans. It is not an unavoidable production gap.", "");
  lines.push("", "Largest canonical is the imported long demo; large repeats it ten times with the exact SCALE id/mark retargeting used by tools/perf-record.mjs (334,208 file bytes). Near 2 MiB is the greatest whole number of copies whose fresh encoded state fits the 2 MiB cap under both candidates. It is an encoded-state fixture, not a 2 MiB plain file. No binary assets are included.", "",
    "## Incremental mechanism", "",
    "Both import the existing fromDocument/toDocument implementation. The only src/proj change is an optional `ProjectionOptions.blocks` input (two lines), letting the same full projector render a supplied subset. A keeps the flow delta, applies the transaction's retain/delete/insert/format events, and walks the cached boundary chunks to identify changed beats. Offsets after the edit are rebuilt without reading all of Y.Text again. B keeps one delta and parsed boundary list per segment; a text event invalidates only its segment, while the order array supplies global order. A split stays inside its original segment under B, so segment-local work can grow with repeated splits. Both traverse the block index and reuse every unchanged projected beat object. Metadata roots invalidate their affected records; comment anchorId and tag registry changes conservatively render all beats.", "",
    "The common structural measurement pass reads the merged mechanisms' join/retirement/removal/status state and derives narration/visual groups and recovery membership. It includes status frontier scans via the existing statusValue. This pass is deliberately reported as a lower bound: it does not implement full gallery folding, split-descendant recovery attribution, mark crossing repair or the app's derivations. The full document stays equal to src/proj/toDocument, which itself does not integrate those trace readers. No full structural/mark trace pass is newly claimed.", "",
    "Correctness: test/perf/incremental.test.ts compares every one of 240 transactions for literal seeds 1376, 1306 and 3737844653 under both candidates, with duplicate delivery, marks, splits, comments, visuals, status, removals and joins. Unchanged complete rows must retain object identity. Literal identity/split/remove/restore/deletion controls additionally fail if identity lookup follows a deleted item as live. Existing independent trace checker remains unchanged.", "",
    "## Per-edit CPU time, milliseconds", "",
    "Timing starts immediately before local mutation or applyUpdate and ends after synchronous incremental projection and the structural measurement pass. Remote operation construction and encoding are excluded. Local mutation target lookup is prepared before timing, as it is for remote updates; identity capture and reverse lookup are separate cases. The target is the longest beat in the final quarter of the document (ties choose the later beat), a substantial painted beat at a late sequence offset. Identity capture uses its complete current UTF-16 contents, including content atoms, before split trials. Burst delivers 100 individually encoded remote character updates inside one receiving transaction and projects once. Each split trial has an untimed boundary undo so later trials still split substantial text; join undo uses retained cancellation ids. This is CPU work, not key/message-to-frame latency.", "");
  const runsFor = (fixture: string, candidate: string) => evidence.runs.filter(run => run.valid && run.fixture === fixture && run.candidate === candidate);
  lines.push("### Implementation size", "", "| Source | A physical lines | B physical lines |", "| --- | ---: | ---: |");
  for (const file of ["delta.ts", "blocks.ts", "incremental.ts", "operations.ts"]) {
    const count = readFileSync(new URL(file, import.meta.url), "utf8").trimEnd().split("\n").length;
    lines.push(`| Shared ${file} | ${count} | ${count} |`);
  }
  lines.push("", "Both instantiate the same implementation: A selects flow; B selects segments/order. A's stream-selection branch is one line; B's is five. These are physical lines including blanks; shared code is counted for each implementation, not presented as separate implementations. The index's public text-to-span map makes B reverse lookup segment-local; A searches the flow's spans after resolving the Yjs position.", "",
    "### Fresh state and load", "", "| Fixture / measure | A median [range] | B median [range] | A/B | Cheaper | Numeric budget comparison in Node |", "| --- | --- | --- | ---: | --- | --- |");
  for (const fixture of evidence.fixtures) {
    const a = runsFor(fixture.name, "A"), b = runsFor(fixture.name, "B");
    const measures: [string, (run: PerfRun) => number, number, number][] = [
      ["encoded bytes", run => required(run.checkpoints[0]).encodedBytes, 0, 0],
      ["load ms", run => required(run.checkpoints[0]).load.loadMs, 5, 0.15],
      ["first full projection ms", run => required(run.checkpoints[0]).load.firstProjectionMs, 5, 0.15],
      ["heap with projection MiB", run => required(run.checkpoints[0]).load.projectedHeapBytes / 1024 ** 2, 0.25, 0.03]
    ];
    for (const [label, get, floor, fraction] of measures) {
      const left = a.map(get), right = b.map(get);
      const difference = percentile(left, 0.5) - percentile(right, 0.5);
      const bytes = label === "encoded bytes";
      const limit = bytes ? Math.min(3 * fixture.fileBytes, 2 * 1024 ** 2) : label.includes("heap") ? (fixture.name === "largest canonical" ? 17.1 : 29.9) : label.includes("projection") ? 1000 : 3000;
      lines.push(`| ${fixture.name}: ${label} | ${format(left, bytes ? 0 : 3)} | ${format(right, bytes ? 0 : 3)} | ${(percentile(left, 0.5) / percentile(right, 0.5)).toFixed(3)}x | ${bytes ? `${difference > 0 ? "B" : "A"} by ${Math.abs(difference)} bytes` : comparePerf(left, right, floor, fraction)} | ${limit.toFixed(bytes ? 0 : 1)}: A ${percentile(left, 0.5) <= limit ? "within" : "over"}, B ${percentile(right, 0.5) <= limit ? "within" : "over"}${fixture.name === "near 2 MiB" && label.includes("heap") ? "; large heap context only, no near-limit heap cap" : ""} |`);
    }
  }
  lines.push("", "The load component is compared with the 3 s join p50 cap; full projection with its 1 s single-task cap. Neither includes the complete join. Heap totals are Node context against browser-session caps, not a shared-app heap pass. Byte caps apply directly.", "");
  const editTables = (fixture: string, afterHistory: boolean): void => {
    const a = runsFor(fixture, "A"), b = runsFor(fixture, "B");
    for (const name of perfCases) {
      const get = (run: PerfRun) => required((afterHistory ? run.afterHistory : run.edits).find(item => item.name === name));
      const left = a.map(run => get(run).p50), right = b.map(run => get(run).p50);
      const structural = name === "remote split" || name === "remote join";
      const limit = name === "local character" ? (fixture === "largest canonical" ? 5.8 : 8) : structural ? (fixture === "largest canonical" ? 45 : 300) : 30;
      const noLimit = name.includes("identit") || name.includes("100") || name.includes("status") || name.includes("comment");
      const p95A = percentile(a.map(run => get(run).p95), 0.5), p95B = percentile(b.map(run => get(run).p95), 0.5);
      const p95Limit = name === "remote character" ? 50 : name === "local character" ? (fixture === "largest canonical" ? 25 : 40) : undefined;
      const p95Budget = p95Limit === undefined ? "" : `; ${p95Limit} ms p95: A ${p95A <= p95Limit ? "within" : "over"}, B ${p95B <= p95Limit ? "within" : "over"}`;
      lines.push(`### ${fixture}${afterHistory ? " after 50,100 operations" : ""}: ${name}`, "",
        "| A p50 [range] | B p50 [range] | A/B | Comparison, ms | A p95 / B p95 | Artifact 7 CPU comparison |",
        "| --- | --- | ---: | --- | --- | --- |",
        `| ${format(left)} | ${format(right)} | ${(percentile(left, 0.5) / percentile(right, 0.5)).toFixed(3)}x | ${comparePerf(left, right)} | ${p95A.toFixed(3)} / ${p95B.toFixed(3)} | ${noLimit ? "No dedicated limit; 30 ms remote-character budget is context only" : `${limit} ms ${structural ? "structural" : name === "local character" ? "local input" : "remote character"}: A ${percentile(left, 0.5) <= limit ? "within" : "over"}, B ${percentile(right, 0.5) <= limit ? "within" : "over"}`}${p95Budget}${fixture === "near 2 MiB" ? "; extrapolated context, no fixture-specific edit cap" : ""} |`, "");
    }
  };
  for (const fixture of evidence.fixtures) editTables(fixture.name, false);
  editTables("large", true);
  const nearCapture = (candidate: string) => runsFor("near 2 MiB", candidate).map(run => required(run.edits.find(item => item.name === "capture identities")).p50);
  const nearA = nearCapture("A"), nearB = nearCapture("B");
  lines.push("### Identity prediction", "", `A-H7 / expected PERF failure under T02: the near-limit public capture pass is A ${format(nearA)} ms and B ${format(nearB)} ms; ${comparePerf(nearA, nearB)}. A's capture alone ${percentile(nearA, 0.5) > 8 ? "exceeds" : "does not exceed"} the existing 8 ms input ceiling as a CPU component. This corroborates the repeated-scan risk for these calls, not a production latency result; indexing or batching could change it. B-H5's locality is supported by the counted segment work, with elapsed candidate differences assessed only by the frozen tolerance.`, "");
  lines.push("## Growth, load and heap", "",
    "500 writing cycles on a fresh large import: 60 one-character typing inserts, 15 one-character deletes, 15 retyping inserts, one split, one join, one semantic join retirement, one removal, one restore, two status changes, three comment-body revisions per cycle. Every fifth cycle adds a second observed removal before undoing the first, leaving that beat soft-removed. Total 50,100 public operations: 37,500 inserts, 7,500 deletes, 500 splits, 500 joins, 500 retirements, 600 removals, 500 restores, 1,000 status writes and 1,500 comment revisions. This biases toward normal writing and revision, while exercising each retained mechanism repeatedly; it is a synthetic history, not a user telemetry claim. The original 300 beats are visited cyclically. No active UndoManager retains deleted text: both trace mechanisms work with default gc=true, soft removals keep live text and retirement flags keep join history. A future bounded undo stack adds memory not measured here.", "",
    "Each checkpoint encodes state then starts a fresh --expose-gc child. Load time is applyUpdate only; first full projection is the child's first toDocument (cold path). Heap is measured after two forced collections, both after replica load and after the plain projection. Total Node heap includes loaded modules; the incremental heap subtracts the child's pre-load module heap. No source/writer/remote replica lives in that child. The encoding buffer remains live. The parent runs no tests during measurements.", "");
  const a = runsFor("large", "A"), b = runsFor("large", "B");
  for (let index = 0; index < 4; index++) {
    lines.push(`### Checkpoint ${a[0]?.checkpoints[index]?.operations} operations`, "");
    const measures: [string, (run: PerfRun) => number, string, number, number][] = [
      ["Encoded bytes", run => required(run.checkpoints[index]).encodedBytes, "fresh ≤3x plain; edited ≤10x active plain and ≤2,097,152 bytes", 0, 0],
      ["Load ms", run => required(run.checkpoints[index]).load.loadMs, "join p50 3,000 ms / worst 5,000 ms; partial CPU only", 5, 0.15],
      ["First full projection ms", run => required(run.checkpoints[index]).load.firstProjectionMs, "same join budget; single-task context 1,000 ms", 5, 0.15],
      ["Heap after load MiB", run => required(run.checkpoints[index]).load.loadedHeapBytes / 1024 ** 2, "large session total ≤29.9 MiB; Node context only", 0.25, 0.03],
      ["Heap with projection MiB", run => required(run.checkpoints[index]).load.projectedHeapBytes / 1024 ** 2, "large session total ≤29.9 MiB; Node context only", 0.25, 0.03],
      ["Incremental heap MiB", run => required(run.checkpoints[index]).load.incrementalHeapBytes / 1024 ** 2, "no independent increment limit", 0.25, 0.03]
    ];
    for (const [label, measure, budget, floor, fraction] of measures) {
      const left = a.map(measure), right = b.map(measure);
      const byte = label === "Encoded bytes";
      const difference = percentile(left, 0.5) - percentile(right, 0.5);
      lines.push(`#### ${label}`, "", "| A median [range] | B median [range] | A/B | Cheaper | Budget / context |", "| --- | --- | ---: | --- | --- |",
        `| ${format(left, byte ? 0 : 3)} | ${format(right, byte ? 0 : 3)} | ${(percentile(left, 0.5) / percentile(right, 0.5)).toFixed(3)}x | ${byte ? `${difference > 0 ? "B" : "A"} by ${Math.abs(difference)} bytes (exact)` : comparePerf(left, right, floor, fraction)} | ${budget} |`, "");
    }
    lines.push("| Candidate | Active file bytes | State / active file | Growth cap met in Node | Soft-removed beats | Removal records | Joins / retired ids | Status events |", "| --- | ---: | ---: | --- | ---: | ---: | --- | ---: |");
    for (const [candidate, runs] of [["A", a], ["B", b]] as const) {
      const point = required(required(runs[0]).checkpoints[index]);
      const file = Number(point.counts.activeFileBytes);
      const cap = index === 0 ? 3 : 10;
      lines.push(`| ${candidate} | ${file} | ${(point.encodedBytes / file).toFixed(3)}x | ${point.encodedBytes <= 2 * 1024 ** 2 && point.encodedBytes <= cap * file ? "yes" : "no"} | ${point.counts.removedBeats} | ${point.counts.removalRecords} | ${point.counts.joinEntries} / ${point.counts.retiredJoins} | ${point.counts.statusEvents} |`);
    }
    lines.push("");
  }
  lines.push("These growth conclusions concern this synthetic workload with undo retention omitted; they do not establish general growth behaviour.", "",
    "## Predictions and practical limits", "",
    "Y1 / A-H7 and B-H5: public relative-position identity reads are measured as a whole painted-beat pass and one live identity-to-current-position lookup. The tables test the predicted document-wide versus segment-local traversal cost; no private Yjs item/store access is used. A scan is not assumed cheaper or more expensive. The 0.5 ms tolerance still applies even to microsecond operations. A-H2 / Y8 / Y9: soft removals preserve live text with gc=true. Checkpoint growth shows whether the 10x and 2 MiB limits survive this history; removal records and retired joins grow monotonically under both mechanisms, rather than being reclaimed by GC. Literal restore/identity and checkpoint-count tests fail if those mechanisms are removed. This bounded run cannot prove indefinitely bounded growth; there is no compactor in either implementation.", "",
    "Node CPU being within a numeric cap does not establish any message-to-frame or input budget. Paint, layout, focus/caret restoration, DOM rendering, the app's own derivations/publication, real network, server receipts, persistence, blobs and a real editor buffer are absent. The structural view omits gallery folding and full recovery/mark derivation. Status and comment measurements use merged state formats, but this is not a new concurrency oracle. Reconnect and receipt budgets are unmeasured. No standalone A/B was run because shipping code is unchanged. The browser check, if retained in browser-results.json, adds the same JavaScript workload in Edge only; it still omits all those application and rendering costs.", "",
    "## Reproduce", "", "Replace the temp and shared lane-tools placeholders with local directories.", "", "```powershell", "$env:TEMP = '<temp>/splitpage-lanes/s1a-perf'", "$env:TMP = $env:TEMP", "& '<lane-tools>/with-lock.ps1' -Lock perf,smoke -Owner s1a-perf -Command 'node --expose-gc prototypes/collab/src/perf/run.ts --write'", "node prototypes/collab/src/perf/run.ts --check", "node prototypes/collab/src/perf/report.ts --check", "node prototypes/collab/src/perf/privacy.ts --transcript '<temp>/mutation.log' '<temp>/mutation-redacted.log'", "```", "");
  return lines.join("\n");
}

if (isProjectionEntry(import.meta.url)) {
  const evidence = JSON.parse(readFileSync(new URL("results.json", import.meta.url), "utf8")) as PerfEvidence;
  const report = generatePerfReport(evidence);
  const path = new URL("../../perf-results.md", import.meta.url);
  if (process.argv.includes("--write")) writeFileSync(path, report);
  if (process.argv.includes("--check")) assert.equal(readFileSync(path, "utf8"), report);
}
