import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { beatReport } from "../src/structure-report.ts";
import { runGlueRewrite, runIneffectiveUndo, runStructure, structureTraces } from "./structure-runner.ts";
import { ReplicaHarness } from "../src/delivery.ts";
import { checkModel } from "../src/model.ts";
import { readStructure } from "../src/structure-reader.ts";
import { captureStructuralRange, replaceStructuralRange, structuralCaret, undoStructuralRange } from "../src/structure-selection.ts";
import { seedJoinMetadata, structureManager } from "../src/structure.ts";
import { beatOracles } from "./structure-oracles.ts";
import { joinOracle } from "./oracles.ts";

for (const [trace, orders] of Object.entries(structureTraces)) {
  for (const candidate of ["A", "B"] as const) {
    for (const order of orders) {
      test(`${candidate}: full ${trace} ${order}, including specified undo`, () => {
        const result = runStructure(trace, candidate, order);
        assert.equal(result.failure, null, result.history.join("\n"));
        assert.ok(result.checks >= 2);
      });
    }
  }
}

for (const candidate of ["A", "B"] as const) {
  test(`${candidate}: T09 undo must reanchor its captured selection to restored identities`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abc" }, { id: "R2", text: "de" }, { id: "R3", text: "fgh" }]);
    const manager = structureManager(harness.alice);
    try {
      const capture = captureStructuralRange(harness.alice, "R1", 1, "R3", 2);
      harness.bob.insert("R1", 2, "W", ["b1"]);
      harness.bob.insert("R2", 1, "X", ["b2"]);
      harness.bob.insert("R3", 2, "Y", ["b3"]);
      harness.queue.flush("D3");
      replaceStructuralRange(harness.alice, capture, "Z", ["a1"], "Alice");
      const restored = undoStructuralRange(harness.alice, manager, capture);
      harness.queue.flush("D3");
      const oracle = beatOracles["T09 undo"];
      assert.ok(oracle);
      for (const replica of harness.replicas) {
        checkModel(readStructure(replica.doc, candidate, harness.identities, new Map([["A", restored]])), oracle, harness.identities, "restored");
        assert.throws(() => checkModel(readStructure(replica.doc, candidate, harness.identities, new Map([["A", capture.selection]])), oracle, harness.identities, "stale"), /stale.carets.A/);
      }
    } finally {
      manager.destroy();
      harness.destroy();
    }
  });
  test(`${candidate}: full T06 checker rejects an omitted visual separator`, () => {
    const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]);
    try {
      seedJoinMetadata(harness.alice);
      harness.alice.format("R1", 0, 2, { b: true });
      harness.queue.flush("D2");
      const carets = new Map([["A", { position: structuralCaret(harness.alice, "R2", 0) }], ["B", { position: structuralCaret(harness.bob, "R2", 0) }]]);
      harness.alice.join("R2", "R1", "jA");
      harness.bob.join("R2", "R1", "jB");
      harness.queue.flush("D1");
      for (const replica of harness.replicas) {
        const model = readStructure(replica.doc, candidate, harness.identities, carets);
        checkModel(model, joinOracle, harness.identities, "visual");
        const row = model.rows[0];
        assert.ok(row);
        row.visualText = "vw";
        assert.throws(() => checkModel(model, joinOracle, harness.identities, "visual"), /visual.rows\[0\].visualText/);
      }
    } finally {
      harness.destroy();
    }
  });
  test(`${candidate}: top-item-only undo preserves an earlier insertion when a remotely overwritten map step is ineffective`, () => {
    const isolated = runIneffectiveUndo(candidate, true);
    assert.equal(isolated.failure, null, isolated.history.join("\n"));
    const plain = runIneffectiveUndo(candidate, false);
    assert.match(plain.failure ?? "", /characters\[2\]/);
  });
  test(`${candidate}: join cancellation still unjoins after Bob rewrites Alice's glue, preserving her earlier edit`, () => {
    assert.equal(runGlueRewrite(candidate).failure, null);
  });
  for (const swapped of [false, true]) {
    test(`${candidate}: plain per-writer join undo fails T06${swapped ? " swapped clientIDs" : ""}`, () => {
      const result = runStructure("T06", candidate, "D1", true, swapped);
      assert.match(result.failure ?? "", /T06 Alice undo\/client\d.rows\[0\].characters\[2\]/);
    });
    test(`${candidate}: semantic join undo passes T06${swapped ? " swapped clientIDs" : ""}`, () => {
      const result = runStructure("T06", candidate, "late-C", false, swapped);
      assert.equal(result.failure, null, result.history.join("\n"));
    });
  }
}

test("structural results and retained failure histories reproduce exactly", () => {
  const report = beatReport();
  assert.equal(report.runs.length, 94);
  for (const [path, content] of report.files) assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), content, path);
});
