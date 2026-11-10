import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isProjectionEntry } from "../proj/entry.ts";
import type { PerfStructuralEvidence } from "./counts.ts";
import { perfSourceDigest, plannedPerfSetup, validatePerfSetup, validateTimedSource } from "./setup.ts";
import { generatePerfReport as generateTimingReport } from "./timing-report.ts";
import type { PerfEvidence } from "./run.ts";

export function readStructuralEvidence(): PerfStructuralEvidence {
  return JSON.parse(readFileSync(new URL("structural-results.json", import.meta.url), "utf8")) as PerfStructuralEvidence;
}

export function validateStructuralEvidence(evidence: PerfStructuralEvidence): void {
  assert.equal(evidence.version, 1);
  assert.equal(evidence.sourceDigest, perfSourceDigest());
  assert.equal(evidence.timingStatus, "not measured; deterministic structural counts only");
  assert.equal(evidence.instrumentation.length, 2);
  for (const source of evidence.instrumentation) assert.match(source.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(evidence.data.controls.map(control => [control.candidate, control.capture.relativeItems, control.lookup.absoluteItems, control.lookup.relativeItems, control.lookup.projectedSpans, control.lookup.storeProbes]), [["A", 8, 3, 4, 2, 6], ["B", 2, 0, 1, 1, 8]]);
  assert.equal(evidence.data.rows.length, 6);
  for (const fixture of ["largest canonical", "large", "near 2 MiB"]) {
    const rows = evidence.data.rows.filter(row => row.fixture === fixture);
    assert.deepEqual(rows.map(row => row.candidate), ["A", "B"]);
    assert.equal(rows[0]?.fileBytes, rows[1]?.fileBytes);
    for (const row of rows) {
      assert.match(row.inputSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(row.checkpoints.map(point => point.operations), fixture === "large" ? [0, 10020, 25050, 50100] : [0]);
      for (const point of row.checkpoints) {
        assert.equal(point.gc, true);
        assert.ok(point.encodedBytes > 0);
        assert.equal(point.identities.publicCaptureCalls, point.identities.characters);
        assert.ok(point.identities.capture.relativeItems >= point.identities.characters);
        assert.equal(point.identities.resolved.offset, point.identities.characters - 1);
      }
      if (fixture === "large") {
        const last = row.checkpoints.at(-1);
        assert.equal(last?.counts.beats, 800);
        assert.equal(last?.counts.removedBeats, 100);
        assert.equal(last?.counts.removalRecords, 600);
        assert.equal(last?.counts.retiredJoins, 500);
        assert.equal(last?.counts.statusEvents, 1000);
      }
    }
  }
}

function difference(a: number, b: number): string {
  return a === b ? "equal" : `${a < b ? "A" : "B"} fewer by ${Math.abs(a - b)} (${(100 * Math.abs(a - b) / Math.max(a, b)).toFixed(2)}%)`;
}

export function generateStructuralReport(evidence: PerfStructuralEvidence): string {
  validateStructuralEvidence(evidence);
  const setup = plannedPerfSetup();
  const lines = ["# Incremental projection performance: prepared experiment and structural evidence", "",
    "**No valid timing measurement set has been run.** The PC's owner was playing a game that took about 3 GB of RAM and a varying share of CPU. The coordinator stopped measurements, then authorized one guarded set after this non-measurement PR is opened, as the owner switches to a lighter game. All earlier partial and void timing attempts are labelled void in `src/perf/void-*.json`; none appears in a result table or establishes a budget. No scheduled measurement remains. This initial PR prepares the experiment and reports deterministic counts only; it selects no schema.", "",
    `Current reviewed source SHA-256: **${evidence.sourceDigest}**. The source-hash list covers every src/perf TypeScript module, every src/proj module, schema/model/structure/status helpers and the prototype lockfile. setup.json fixes Node ${setup.node}, Yjs ${setup.yjs}, five alternating paired runs, three warm-up operations per case and eleven samples per run. The recorded timed source is identified separately below; the source audit verifies that reporting/test edits changed no timed implementation.`, "",
    "## What is implemented", "",
    "Both incremental projectors import the existing fromDocument/toDocument implementation. The only src/proj change is two added lines: ProjectionOptions.blocks accepts a subset of existing blocks, and toDocument uses it instead of scanning every block. No app code, buffer, slice, structure, marks, service, local or app-binding file changes.", "",
    "A caches the document-wide delta, applies Yjs retain/delete/insert/format events, and walks its boundary chunks to find changed beats. A change at a late offset still processes the preceding cached sequence; it does not run a fresh full Y.Text.toDelta. B caches each segment's delta and parsed boundary list. A changed segment invalidates that list, and the order array supplies global position. Splits remain inner embeds in their original segment under the merged B mechanism, so B's locality is by segment rather than necessarily by beat. Both reuse unchanged projected beat objects, including across no-op or duplicate updates. The common text-to-span index makes reverse lookup local to a B segment; A's flow contains all spans.", "",
    "Metadata events invalidate affected beat records. Gallery/visual ownership changes include both old and new owners. A tag-registry change or comment anchorId change conservatively reprojects all beats. Comment bodies and status events do not require rebuilding narration. Anchors derive from cached affected blocks and retained per-beat anchors. The full plain document remains equal to src/proj/toDocument; the common structural probe additionally reads joins, retired joins, soft removal and causal status events. That probe does not supply full gallery folding, split-descendant recovery attribution, crossing-mark resolution or app derivations. No new integrated structural/mark trace pass is claimed.", "",
    "### Implementation size", "", "| Source counted in each candidate | A lines | B lines |", "| --- | ---: | ---: |"];
  let total = 0;
  for (const file of ["delta.ts", "blocks.ts", "incremental.ts", "operations.ts"]) {
    const count = readFileSync(new URL(file, import.meta.url), "utf8").trimEnd().split("\n").length;
    total += count;
    lines.push(`| ${file} (shared) | ${count} | ${count} |`);
  }
  lines.push(`| Total physical lines, including blanks | ${total} | ${total} |`, "",
    "The same implementation is instantiated for either candidate. The stream-selection branch in blocks.ts is one line for A and five for B; shared lines are counted for each, rather than inventing two independent implementations. The layout makes A's ordering simple but changed-range attribution global. B directly identifies the changed segment but must recover each beat's position within a split segment and the segment's position in global order.", "",
    "## Deterministic fixtures and encoded sizes", "",
    "The largest canonical fixture is the long demo. large repeats it ten times using the recorder's SCALE id/mark retargeting, with people/tags shared; tests compare the generator with the existing projection lane's generator. Near-limit is the greatest whole number of copies fitting 2 MiB encoded state under both candidates. These are exact byte counts, independent of CPU load; binary blobs are absent.", "",
    "| Fixture | Copies / beats | Plain file bytes | A encoded bytes | B encoded bytes | A/B | Cheaper | A / B import ratios | Fresh ≤3x plain and ≤2 MiB |", "| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |");
  for (const fixture of ["largest canonical", "large", "near 2 MiB"]) {
    const a = evidence.data.rows.find(row => row.fixture === fixture && row.candidate === "A");
    const b = evidence.data.rows.find(row => row.fixture === fixture && row.candidate === "B");
    assert.ok(a && b);
    const left = a.checkpoints[0], right = b.checkpoints[0];
    assert.ok(left && right);
    const pass = (value: number) => value <= 3 * a.fileBytes && value <= 2 * 1024 ** 2 ? "yes" : "no";
    lines.push(`| ${fixture} | ${a.copies} / ${left.counts.beats} | ${a.fileBytes} | ${left.encodedBytes} | ${right.encodedBytes} | ${(left.encodedBytes / right.encodedBytes).toFixed(4)}x | ${difference(left.encodedBytes, right.encodedBytes)} | ${(left.encodedBytes / a.fileBytes).toFixed(3)}x / ${(right.encodedBytes / b.fileBytes).toFixed(3)}x | ${pass(left.encodedBytes)} / ${pass(right.encodedBytes)} |`);
  }
  lines.push("", "## Identity work, counted without a clock", "",
    "An item visit is one iteration over a Yjs linked-list item, including formatting and deleted items; it is not one character. The counts describe this implementation's public capture/resolve calls. A production binding using those same calls would retain the repeated scans, but an identity index or batched traversal could reduce A's work. This is not an unavoidable production gap or a latency result.", "",
    "The public relative-position API is used by the projector. To count its actual work, counts.ts builds an ephemeral copy of pinned Yjs source with counters in createRelativePositionFromTypeIndex's forward loop, createAbsolutePositionFromRelativePosition's backward loop, and the struct-store binary-search probes. Original package files are untouched. Instrumented source hashes are committed; exact source needles must match once. This is a diagnostic dependency on pinned library internals, not a private API dependency in the projector. Counters do not establish elapsed time. The two-row literal control requires A capture 8 forward visits and lookup 3 backward + 4 forward verification visits over 2 spans; B requires 2 capture visits and lookup 0 backward + 1 forward verification visit over 1 span. Removing or misplacing a counter fails these controls.", "",
    "The painted target is the longest live beat in the last quarter of live beat order (ties choose the later beat). Every UTF-16 position/content atom is captured with one public call. Lookup targets the last captured identity, resolves it through the public API, searches its containing text's span list, and verifies that the live identity still matches. Struct probes count the library's actual array reads, including its initial pivot read. These counts include work hidden by the public call, rather than assuming A scans and B does not.", "");
  for (const fixture of ["largest canonical", "large", "near 2 MiB"]) {
    const a = evidence.data.rows.find(row => row.fixture === fixture && row.candidate === "A");
    const b = evidence.data.rows.find(row => row.fixture === fixture && row.candidate === "B");
    assert.ok(a && b);
    for (let index = 0; index < a.checkpoints.length; index++) {
      const left = a.checkpoints[index], right = b.checkpoints[index];
      assert.ok(left && right);
      lines.push(`### ${fixture}, ${left.operations} history operations`, "",
        `Target A/B: ${left.identities.target} / ${right.identities.target}; ${left.identities.characters} / ${right.identities.characters} identities.`, "",
        "| Work | A | B | A/B | Cheaper |", "| --- | ---: | ---: | ---: | --- |");
      for (const [label, av, bv] of [
        ["Public capture calls", left.identities.publicCaptureCalls, right.identities.publicCaptureCalls],
        ["Capture forward item visits", left.identities.capture.relativeItems, right.identities.capture.relativeItems],
        ["Lookup backward item visits", left.identities.lookup.absoluteItems, right.identities.lookup.absoluteItems],
        ["Lookup live-verification forward visits", left.identities.lookup.relativeItems, right.identities.lookup.relativeItems],
        ["Lookup struct-store probes", left.identities.lookup.storeProbes, right.identities.lookup.storeProbes],
        ["Lookup projected spans searched", left.identities.lookup.projectedSpans, right.identities.lookup.projectedSpans]
      ] as const) lines.push(`| ${label} | ${av} | ${bv} | ${bv ? (av / bv).toFixed(3) + "x" : av ? "B has zero" : "equal"} | ${difference(av, bv)} |`);
      lines.push("");
    }
  }
  lines.push("## Retained writing history", "",
    "500 writing cycles from fresh large, 50,100 public operations: 37,500 one-character inserts (typing/retyping), 7,500 one-character deletes, 500 splits, 500 joins, 500 semantic join retirements, 600 observed removals, 500 restores, 1,000 causal status writes and 1,500 comment revisions. Per cycle: 60 typing inserts, 15 deletes, 15 retyping inserts, split/join/retire/remove/restore once each, two status writes and three comment changes. Every fifth cycle adds a second removal before restoring the first; 100 beats remain soft-removed. The 300 original beats are visited cyclically. This synthetic mix favors writing and revision while repeatedly exercising retained structures; it is not user telemetry. Default gc=true works for both merged soft-removal mechanisms. No UndoManager retains deleted text; production undo retention adds a cost not represented here.", "",
    "Each checkpoint is encoded and reloaded into a fresh initialized replica; counts must agree after transfer. The plain denominator removes soft-removed rows from src/proj/toDocument, but keeps comment/registry records. It is a conservative row-filtered file-size proxy, not a fully integrated app export/recovery policy. The hard 2 MiB state cap is directly comparable regardless of that denominator.", "");
  const a = evidence.data.rows.find(row => row.fixture === "large" && row.candidate === "A");
  const b = evidence.data.rows.find(row => row.fixture === "large" && row.candidate === "B");
  assert.ok(a && b);
  for (let index = 0; index < a.checkpoints.length; index++) {
    const left = a.checkpoints[index], right = b.checkpoints[index];
    assert.ok(left && right);
    lines.push(`### Checkpoint ${left.operations}`, "", "| Count | A | B | A/B | Cheaper |", "| --- | ---: | ---: | ---: | --- |");
    for (const [label, av, bv] of [
      ["Encoded bytes", left.encodedBytes, right.encodedBytes], ["Beat records", Number(left.counts.beats), Number(right.counts.beats)],
      ["Soft-removed beats", Number(left.counts.removedBeats), Number(right.counts.removedBeats)], ["Removal records", Number(left.counts.removalRecords), Number(right.counts.removalRecords)],
      ["Join entries", Number(left.counts.joinEntries), Number(right.counts.joinEntries)], ["Retired join ids", Number(left.counts.retiredJoins), Number(right.counts.retiredJoins)],
      ["Status events", Number(left.counts.statusEvents), Number(right.counts.statusEvents)], ["Active plain bytes proxy", Number(left.counts.activeFileBytes), Number(right.counts.activeFileBytes)]
    ] as const) lines.push(`| ${label} | ${av} | ${bv} | ${bv ? (av / bv).toFixed(4) + "x" : "equal"} | ${difference(av, bv)} |`);
    const ratioA = left.encodedBytes / Number(left.counts.activeFileBytes), ratioB = right.encodedBytes / Number(right.counts.activeFileBytes);
    lines.push("", `State / active-file proxy: A ${ratioA.toFixed(3)}x, B ${ratioB.toFixed(3)}x. ${index ? "Edited 10x proxy cap" : "Fresh 3x cap"}: A ${ratioA <= (index ? 10 : 3) ? "within" : "over"}, B ${ratioB <= (index ? 10 : 3) ? "within" : "over"}. Hard 2 MiB cap: A ${left.encodedBytes <= 2 * 1024 ** 2 ? "within" : "over"}, B ${right.encodedBytes <= 2 * 1024 ** 2 ? "within" : "over"}.`, "");
  }
  lines.push("These growth conclusions hold for this synthetic workload with undo retention omitted. They do not establish general growth behaviour.", "",
    "## Predictions and budgets", "",
    "Artifact 8 Y1 / A-H7 / B-H5: the traversal-locality prediction is directly tested by the item counts above. A's public identity pass repeatedly traverses preceding document-wide items; B's pass traverses the target segment. These structural counts alone do not assess elapsed time or the input budget; see the guarded Node follow-up for component timings. They are not app latency results.", "",
    "A-H2 / Y8 / Y9 and the soft-removal growth open question: both use gc=true and retain soft-removed text and retirement metadata. The encoded checkpoints show that neither mechanism keeps this 50,100-operation history below the provisional 2 MiB bound. This refutes sufficiency of the existing retention mechanisms for that hard cap on this bounded workload; it does not refute correctness of soft removal. test/perf/history.test.ts checks the exact retained counts and encoded reload with default GC. No unbounded-growth or compaction claim is inferred from one history.", "",
    "Artifact 7 fresh-import 3x and retained-state 2 MiB byte caps can be assessed directly above. These deterministic tables contain no latency or heap result; the guarded Node follow-up below supplies those component measurements. App input/message-to-frame, complete join, reconnect and receipt budgets remain unestablished. The optional Edge attempt imported the slice driver unchanged and held perf/smoke locks, but its CPU guard exceeded 35%, so it was voided and not repeated; no browser timing conclusion is retained. Paint, app derivations, real network and blobs are absent from the Node component measurements.", "",
    "## Validation and prepared method", "",
    "Correctness tests cover three literal randomized seeds (240 transactions each per candidate), exact full-document agreement after every transaction, unchanged-row identity, duplicate/reverse delivery, split/restore/deleted-identity controls, 100 versus one projection for unbatched/batched delivery, history counts and fresh encoded reload. The source-hash/method checker validates setup and structural evidence without a timing threshold. Structural-count generation checks the literal instrumented control before accepting its output.", "",
    "The coordinator has authorized one timed set only after this non-measurement PR is opened. The owner will still be playing a lighter game; the timed report must state that and include each accepted run's background CPU before/after. Keep the ≥3 GiB RAM and ≤35% CPU guards, stop after three consecutive refusals, and allow 30 seconds between retries rather than a tight loop. The source-hashed run will retain all samples/voids, alternate candidates, and apply artifact 7's fixed tolerance. Its timed report is generated separately by timing-report.ts; invalid files are never its default input.", "",
    "```powershell", "node prototypes/collab/src/perf/setup.ts --check", "node prototypes/collab/src/perf/run.ts --check", "node prototypes/collab/src/perf/report.ts --check", "```", "");
  return lines.join("\n");
}

export function generateCurrentPerfReport(): string {
  const structural = generateStructuralReport(readStructuralEvidence());
  if (!existsSync(new URL("results.json", import.meta.url))) return structural;
  const timings = JSON.parse(readFileSync(new URL("results.json", import.meta.url), "utf8")) as PerfEvidence;
  validateTimedSource(timings.sourceHead, timings.sourceDigest);
  const generated = generateTimingReport(timings);
  const originalStatus = structural.split("\n")[2];
  assert.ok(originalStatus);
  const updated = structural.replace(originalStatus, "The initial PR contained deterministic structural evidence only; its earlier game-session timing attempts remain void. The guarded timed follow-up below was run only after the coordinator authorized it and after the initial PR opened. A game was running during the accepted set; each run's recorded RAM and background CPU is disclosed below. No schema is selected.");
  return updated + `\n## Review controls\n\nThe four literal visuals/gallery ownership-transfer controls cover A and B, both affected rows and an unchanged row. Removing old-owner invalidation makes all four fail; restoring it makes all four pass. test/perf/ownership-mutation.json retains the actual mutation output. Two additional controls verify that a one-character projection consumes events without rereading narration streams.\n\n## Guarded timed follow-up\n\nTimed head: ${timings.sourceHead}; prepared SHA-256: ${timings.sourceDigest}. Post-run changes add controls, reporting corrections and source-audit checks. Machine identifiers and local paths were redacted after the run; no measured value changed. timed-source.json retains original implementation hashes and explicitly verifies the hostname-only metadata changes in the perf and projection cost recorders; all editing case/projection logic remains byte-identical. No case was retimed after review.\n\n` + generated.split("\n").slice(2).join("\n");
}

if (isProjectionEntry(import.meta.url)) {
  validatePerfSetup(JSON.parse(readFileSync(new URL("setup.json", import.meta.url), "utf8")) as ReturnType<typeof plannedPerfSetup>);
  const report = generateCurrentPerfReport();
  const path = new URL("../../perf-results.md", import.meta.url);
  if (process.argv.includes("--write")) writeFileSync(path, report);
  if (process.argv.includes("--check")) assert.equal(readFileSync(path, "utf8"), report);
}
