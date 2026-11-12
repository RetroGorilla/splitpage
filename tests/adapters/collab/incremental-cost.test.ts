import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBenchmarkDocument, typeBenchmarkCharacter } from "../../collab/benchmark-document.ts";
import { measureLibraryReads } from "../../collab/library-read-counts.ts";
import { measureSharedReads } from "../../../src/adapters/collab/read-counts.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { assertIncremental, captureIncrementalReplica } from "./incremental-support.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { nativeText } from "./incremental-support.ts";

test("incremental typing reads zero unrelated texts, mark entries and records with 0, 299 and 10000 unrelated beats", t => {
  const readings: unknown[] = [];
  for (const [beats, editedBeats] of [[1, 1], [300, 300], [10001, 1]] as const) {
    const run = buildBenchmarkDocument({ beats, editedBeats });
    const work: string[] = [], { projector, docs } = captureIncrementalReplica(run.a, (kind, key) => work.push(kind + ":" + key));
    try {
      const before = projector.read().document.rows[1];
      const preparation = createSharedPreparation(run.a); preparation.view.text(["segments", "b:R0", "text"]); preparation.close();
      work.length = 0;
      const measured = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => typeBenchmarkCharacter(run.a, "R0", 2, "z", "measured-incremental-type")), docs);
      readings.push({ beats, totals: measured.totals, unrelated: measured.unrelated, rules: measured.result.counts, work });
      t.diagnostic(JSON.stringify(readings.at(-1)));
      assert.deepEqual(measured.totals, { texts: 5, markEntries: 19, records: 0, statusEntries: 0, orderEntries: 0 });
      assert.deepEqual(measured.unrelated, { texts: 0, markEntries: 0, records: 0, statusEntries: 0, orderEntries: 0 });
      assert.deepEqual(measured.result.counts, { texts: 1, identities: 70, markRecords: 1, markAnchors: 36, markChecks: beats === 300 ? 69 : 53, statusEvents: 0 });
      assert.deepEqual(work, ["segment:b:R0", "group:R0", "cell:[\"R0\",\"audioText\"]", "compare-row:R0", "compare-field:comments"]);
      assert.equal(projector.read().document.rows[1], before);
      assertIncremental(run.a, projector);
      if (beats === 300) {
        const full = measureLibraryReads(run.a, "R0", () => projectSharedDocumentWithRecovery(run.a));
        assert.deepEqual(full.totals, { texts: 2251, markEntries: 10202, records: 18308, statusEntries: 1200, orderEntries: 660 });
        t.diagnostic(JSON.stringify({ baseline: "full assembly", totals: full.totals, unrelated: full.unrelated }));
      }
    } finally { projector.dispose(); run.close(); }
  }
});

test("incremental typing into an empty beat retains zero unrelated reads", () => {
  const run = buildBenchmarkDocument({ beats: 300, rounds: 0 });
  try {
    transactSharedDocument(run.a, "local-command", () => { const text = nativeText(run.a, "b:R0"); text.delete(0, text.length); });
    const { projector, docs } = captureIncrementalReplica(run.a);
    try {
      const preparation = createSharedPreparation(run.a); preparation.view.text(["segments", "b:R0", "text"]); preparation.close();
      const measured = measureLibraryReads(run.a, "R0", () => typeBenchmarkCharacter(run.a, "R0", 0, "x", "empty-incremental-type"), docs);
      assert.deepEqual(measured.unrelated, { texts: 0, markEntries: 0, records: 0, statusEntries: 0, orderEntries: 0 });
      assert.equal(projector.read().document.rows[0]?.audioText, "x");
      assertIncremental(run.a, projector);
    } finally { projector.dispose(); }
  } finally { run.close(); }
});
