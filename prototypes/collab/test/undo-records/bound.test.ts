import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as Y from "yjs";
import type { ReplicaHarness } from "../../src/delivery.ts";
import { IdentityBook, checkModel } from "../../src/model.ts";
import type { OracleCharacter, ScriptOracle } from "../../src/model.ts";
import { SchemaReplica } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import type { CommandRecord } from "../../src/undo-records/history.ts";
import { boundCounts, runBoundHistory } from "../../src/undo-records/measure.ts";
import { bindRestores } from "./runner.ts";

function boundOracle(dropInserts: readonly string[], bobInserts: readonly string[]): ScriptOracle {
  const plain = (name: string, value: string): OracleCharacter => [name, value, {}];
  return {
    rows: [
      { id: "R1", characters: [plain("s1", "a"), plain("s2", "b"), ...dropInserts.map(name => plain(name, "a"))] },
      { id: "R2", characters: [plain("s3", "c"), plain("s4", "d")], status: "todo" },
      { id: "R3", characters: [...bobInserts.map(name => plain(name, "B")), plain("s5", "e"), plain("s6", "f")] }
    ], carets: {}, recovery: []
  };
}

function undoAll(harness: ReplicaHarness, history: CommandHistory, deliver: () => void): void {
  for (let step = 1; step <= 200; step++) {
    const outcome = history.undo();
    bindRestores(harness, outcome);
    assert.equal(outcome.effective, true, `kept undo ${step} (${outcome.label ?? "none"}) changed nothing`);
    deliver();
  }
  const extra = history.undo();
  assert.equal(extra.label, null, "a dropped entry was still undoable");
}

test("a 200-entry bound drops only local records: every kept entry, the oldest included, still undoes", () => {
  const run = runBoundHistory();
  try {
    const counts = boundCounts(run);
    assert.equal(counts.kept, 200);
    assert.equal(counts.dropped, 50);
    assert.equal(run.bobInserts.length, 12);
    assert.deepEqual(run.droppedLabels, Array<string>(50).fill("insert"));
    assert.equal(run.history.undoStack[0]?.label, "status");
    undoAll(run.harness, run.history, () => run.harness.queue.flush("D2"));
    run.harness.lateJoin(run.harness.bob);
    for (const replica of run.harness.replicas) checkModel(readStructure(replica.doc, "B", run.harness.identities), boundOracle(run.dropInserts, run.bobInserts), run.harness.identities, `bound/client${replica.doc.clientID}`);
  } finally {
    run.harness.destroy();
  }
});

test("kept records are self-contained data: after a reload from encoded state they still undo every kept entry", () => {
  const run = runBoundHistory();
  const reloaded = new SchemaReplica("B", 7, run.harness.identities);
  try {
    Y.applyUpdate(reloaded.doc, Y.encodeStateAsUpdate(run.harness.alice.doc), "reload");
    const history = new CommandHistory(reloaded);
    history.undoStack.push(...JSON.parse(JSON.stringify(run.history.undoStack)) as CommandRecord[]);
    undoAll(run.harness, history, () => undefined);
    checkModel(readStructure(reloaded.doc, "B", run.harness.identities), boundOracle(run.dropInserts, run.bobInserts), run.harness.identities, "bound reload");
  } finally {
    reloaded.destroy();
    run.harness.destroy();
  }
});

test("the default route calls no library undo or redo; the capture route's managers only re-create deleted text, and only the library probes call the library", () => {
  const forbidden = /new Y\.UndoManager|\.undoManager\.(undo|redo)\(|\b(stopCapturing|structureManager|undoOne|undoJoin|undoStatus|undoCapturedMarks|undoStructuralRange|bindUndoRestores|captureUndoIdentities|undoManager)\(/;
  const folders = [new URL("../../src/undo-records/", import.meta.url), new URL("./", import.meta.url)];
  let scanned = 0;
  for (const folder of folders) {
    for (const name of readdirSync(folder).filter(file => file.endsWith(".ts") && !["bound.test.ts", "probes.ts"].includes(file))) {
      let source = readFileSync(new URL(name, folder), "utf8");
      if (name === "history.ts") {
        assert.equal(source.match(/new Y\.UndoManager\(/g)?.length, 1);
        assert.match(source, /deleteFilter: \(\) => false/);
        assert.equal(source.match(/\.undo\(\)/g)?.length, 1);
        assert.match(source, /capture\.manager\.undo\(\);/);
        source = source.replace("new Y.UndoManager(", "");
      }
      assert.doesNotMatch(source, forbidden, name);
      scanned++;
    }
  }
  assert.ok(scanned >= 10);
  const replica = new SchemaReplica("B", 1, new IdentityBook());
  try {
    assert.equal(new CommandHistory(replica).route, "items");
  } finally {
    replica.destroy();
  }
});
