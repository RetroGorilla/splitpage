import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { harness } from "../session-fakes.ts";

const LONG = 300000;

function failing(size: number, fault: "apply" | "reconcile") {
  const h = harness(undefined, {
    reconcile: doc => { if (fault !== "reconcile") return 0; doc.comments.length = 0; throw new Error("reconcile fault"); }
  });
  const rows = Array.from({ length: size }, (_, index) => ({ id: "R" + index, audioText: "a" }));
  const comments = Array.from({ length: size }, (_, index) => ({ id: "c" + index, rowId: "R0", field: "audioText", body: "x", replies: [] }));
  h.session.adopt({ title: "Long", docId: "d" + "1".repeat(32), rows, comments });
  const outcome = h.session.run({ name: "insert", needs: "edit", plan: () => ({ changes: changeSet({ rowsInserted: ["N"] }), apply: doc => {
    doc.rows.reverse(); doc.rows.push({ id: "N", audioText: "" } as ValidatedDocument["rows"][number]);
    doc.comments.reverse(); doc.comments.pop();
    if (fault === "apply") throw new Error("apply fault");
  } }) });
  return [outcome.kind, h.session.read(doc => [doc?.rows.map(row => row.id), doc?.comments.map(comment => comment.id)])];
}
const expected = (size: number) => ["failed", [Array.from({ length: size }, (_, index) => "R" + index),
  Array.from({ length: size - 1 }, (_, index) => "c" + (size - 1 - index))]];

test("a failed command puts back 300,000 rows in their order as it puts back 3", () => {
  assert.deepEqual(failing(3, "apply"), expected(3));
  assert.deepEqual(failing(LONG, "apply"), expected(LONG));
});

test("a failed anchor reconciliation puts back 300,000 comments as they stood after the edit, and the rows, as it does 3", () => {
  assert.deepEqual(failing(3, "reconcile"), expected(3));
  assert.deepEqual(failing(LONG, "reconcile"), expected(LONG));
});
