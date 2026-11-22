import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionChange } from "../../../src/application/session/change-set.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { replicas } from "./executor-support.ts";
import { nativeText } from "./incremental-support.ts";
import { sharedCommand, sharedHarness } from "../../application/session/shared-session-support.ts";

const ROWS = { whole: false, added: [], removed: [], moved: [], changed: [], fields: [] };

function operation(value: unknown): SharedOperation {
  const read = readOperation(value);
  assert.ok(read);
  return read;
}

const LENGTH = operation({ kind: "scalar", id: "o1", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });

test("over the adapter the session's document and report come from the incremental projector: untouched rows are the same frozen objects", () => {
  const run = replicas(2, { title: "Script", rows: [{ id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }, { id: "R3", audioText: "three" }] });
  const work: string[] = [], replica = createSharedReplica(run.a, (kind, key) => work.push(kind + ":" + key));
  const entered: { rows: unknown[] }[] = [];
  const h = sharedHarness({ ...replica, project: () => { const document = replica.project() as { rows: unknown[] }; entered.push(document); return document; } });
  const told: [SessionChange["kind"], unknown][] = [];
  h.session.subscribeRows((rows, change) => { told.push([change.kind, rows]); });
  try {
    assert.equal(h.session.read(doc => doc?.rows.length), 3);
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R2").insert(3, "!"));
    assert.equal(h.session.run(sharedCommand("length", [LENGTH])).kind, "applied");
    transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R3").insert(0, "+"));
    run.queue.flush("dup");
    assert.equal(entered.length, 4);
    assert.ok(entered.every(document => Object.isFrozen(document) && Object.isFrozen(document.rows[0])));
    assert.deepEqual(entered.slice(1).map((document, at) => document.rows.map((row, index) => row === entered[at]?.rows[index])),
      [[true, false, true], [false, true, true], [true, true, false]]);
    assert.deepEqual(work, [
      "segment:b:R2", "group:R2", "broll-scan:[\"R2\",\"audioText\"]", "cell:[\"R2\",\"audioText\"]", "compare-row:R2", "compare-field:comments",
      "fields:R1", "group:R1", "compare-row:R1", "compare-field:comments",
      "segment:b:R3", "group:R3", "broll-scan:[\"R3\",\"audioText\"]", "cell:[\"R3\",\"audioText\"]", "compare-row:R3", "compare-field:comments"
    ]);
    assert.deepEqual(told, [
      ["edit", { ...ROWS, changed: [{ id: "R2", fields: ["audioText"] }] }],
      ["edit", { ...ROWS, changed: [{ id: "R1", fields: ["lengthSeconds"] }] }],
      ["remote", { ...ROWS, changed: [{ id: "R3", fields: ["audioText"] }] }]
    ]);
    assert.deepEqual(h.published.slice(-3).map(change => change.changes.cells), [
      [{ rowId: "R2", field: "audioText" }], [{ rowId: "R1", field: "lengthSeconds" }], [{ rowId: "R3", field: "audioText" }]
    ]);
    assert.deepEqual(h.session.read(doc => doc?.rows.map(row => row.audioText)), ["one", "two!", "+three"]);
    assert.equal(h.session.revision(), collabState(run.a).revision);
  } finally { h.session.dispose(); replica.dispose(); run.close(); }
});
