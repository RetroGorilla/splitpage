import test from "node:test";
import assert from "node:assert/strict";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument, encodeSharedState, encodeSharedStateVector, observeSharedTransactions } from "../../../src/adapters/collab/document.ts";
import { collabState, SharedExecutionWriteError } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { prepareSharedMarkWrite } from "../../../src/adapters/collab/mark-plan.ts";
import { applySharedMarkWrite, readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { applySharedTextEdit } from "../../../src/adapters/collab/text-edit.ts";
import { applySharedTextAnchor } from "../../../src/adapters/collab/anchors.ts";
import { readSharedTextTarget } from "../../../src/adapters/collab/text-target.ts";
import { operation } from "./executor-support.ts";

for (const phase of ["idle", "prepare", "observer"] as const) for (const writer of ["text", "mark", "anchor"] as const) {
  test(`apply-phase ${writer} refuses ${phase} and leaves the handle usable`, () => {
    const handle = createMonitoredSharedDocument();
    try {
      hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
      const target = readSharedTextTarget({ owner: "R1", segment: "b:R1", field: "audioText" }); assert.ok(target);
      const prep = createSharedPreparation(handle), text = prep.view.text(["segments", "b:R1", "text"]); assert.ok(text);
      const plan = prepareSharedMarkWrite(text, Number(prep.view.writer), "probe", 0, 1, { type: "add", mark: { kind: "i", value: true } }); assert.ok(plan?.kind === "record"); prep.close();
      const attempt = (): void => {
        if (writer === "text") applySharedTextEdit(handle, { target, edit: { type: "text", at: 0, value: "X" }, marks: [] });
        else if (writer === "mark") applySharedMarkWrite(handle, { target, plan });
        else applySharedTextAnchor(handle, { target, index: 0, affinity: "after" });
      };
      registerSharedOperationHandlers(handle, { "record-delete": () => { attempt(); return { ok: false, reason: "unreachable" }; } });
      const ordinary = operation({ kind: "scalar", id: "ordinary", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });
      const custom = operation({ kind: "record-delete", id: "probe", by: "A", target: { collection: "people", record: "missing" } });
      const before = encodeSharedState(handle), vector = encodeSharedStateVector(handle);
      if (phase === "idle") assert.throws(attempt, SharedExecutionWriteError);
      else {
        if (phase === "observer") collabState(handle).doc.once("afterTransaction", attempt);
        assert.throws(() => executeSharedOperations(handle, [phase === "observer" ? ordinary : custom]), SharedExecutionWriteError);
      }
      if (phase !== "observer") { assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector); }
      assert.deepEqual(executeSharedOperations(handle, [ordinary]), { ok: true });
      assert.deepEqual(readSharedMarkCharacters(handle, target)?.map(char => [char.value, char.marks]), [["a", []], ["b", []], ["c", []], ["d", []]]);
    } finally { destroySharedDocument(handle); }
  });
}

test("fixed text, atom, deletion, mark and anchor descriptions apply mechanically in one transaction", () => {
  const handle = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "<i>abcd</i>" }] }));
    const target = readSharedTextTarget({ owner: "R1", segment: "b:R1", field: "audioText" }); assert.ok(target);
    let anchor: string | null = null;
    registerSharedOperationHandlers(handle, { "record-delete": (op, view) => {
      const text = view.text(["segments", "b:R1", "text"]); assert.ok(text);
      const writer = Number(view.writer), input = { length: 3, recordKeys: text.recordKeys };
      const birth = prepareSharedMarkWrite(input, writer, op.id, 1, 2, { type: "birth", observed: text.records.map(item => item.identity), born: "inserted" }); assert.ok(birth);
      const bold = prepareSharedMarkWrite(input, writer, op.id + ":bold", 1, 2, { type: "add", mark: { kind: "b", value: true }, born: "inserted" }); assert.ok(bold);
      const underline = prepareSharedMarkWrite(input, writer, op.id + ":underline", 0, 3, { type: "add", mark: { kind: "u", value: true } }); assert.ok(underline?.kind === "record");
      return { ok: true, writes: [], apply: current => {
        applySharedTextEdit(current, { target, edit: { type: "delete", from: 1, to: 3 }, marks: [] });
        applySharedTextEdit(current, { target, edit: { type: "atom", at: 1, value: { w: "Ada" } }, marks: [birth, bold] });
        applySharedMarkWrite(current, { target, plan: underline });
        anchor = applySharedTextAnchor(current, { target, index: 1, affinity: "after" });
      } };
    } });
    const origins: unknown[] = [], detach = observeSharedTransactions(handle, origin => origins.push(origin));
    assert.deepEqual(executeSharedOperations(handle, [operation({ kind: "record-delete", id: "fixed", by: "A", target: { collection: "people", record: "unused" } })]), { ok: true });
    detach(); assert.deepEqual(origins, ["local-command"]);
    assert.deepEqual(readSharedMarkCharacters(handle, target)?.map(char => [char.value, char.marks.map(group => group.kind)]), [["a", ["i", "u"]], ["\ufffc", ["b", "u"]], ["d", ["i", "u"]]]);
    const prep = createSharedPreparation(handle), text = prep.view.text(["segments", "b:R1", "text"]); assert.ok(text);
    assert.deepEqual(text.units[1]?.value, { w: "Ada" }); assert.deepEqual(text.resolveAnchor(anchor), { kind: "index", index: 1, affinity: "after" }); prep.close();
  } finally { destroySharedDocument(handle); }
});
