import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";
import { collabState, SharedExecutionWriteError } from "../../../src/adapters/collab/state.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, encodeSharedStateVector, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { createCollabText, collabTextTarget } from "../../../src/adapters/collab/text-target.ts";
import { insertSharedHtml } from "../../../src/adapters/collab/text-import.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { execute, operation, ref, replicas } from "./executor-support.ts";
import { validatedFixture } from "./helpers.ts";
import { holdSharedBuffer } from "../../../src/adapters/collab/ingress.ts";

for (const [phase, reasons, action, refusal] of [
  ["preparation", [], "arrival", SharedExecutionWriteError],
  ["preparation", [], "buffer acquisition", SharedExecutionWriteError],
  ["preparation", ["delivering"], "arrival", SharedExecutionWriteError],
  ["preparation", ["delivering"], "buffer acquisition", SharedExecutionWriteError],
  ["preparation", ["buffer"], "arrival", SharedExecutionWriteError],
  ["preparation", ["buffer"], "buffer acquisition", SharedExecutionWriteError],
  ["preparation", ["delivering", "buffer"], "arrival", SharedExecutionWriteError],
  ["preparation", ["delivering", "buffer"], "buffer acquisition", SharedExecutionWriteError],
  ["application", [], "arrival", SharedExecutionWriteError],
  ["application", [], "buffer acquisition", SharedExecutionWriteError],
  ["application", ["delivering"], "arrival", SharedExecutionWriteError],
  ["application", ["delivering"], "buffer acquisition", SharedExecutionWriteError],
  ["application", ["buffer"], "arrival", SharedExecutionWriteError],
  ["application", ["buffer"], "buffer acquisition", SharedExecutionWriteError],
  ["application", ["delivering", "buffer"], "arrival", SharedExecutionWriteError],
  ["application", ["delivering", "buffer"], "buffer acquisition", SharedExecutionWriteError]
] as const) {
  test(`${phase}, reasons ${reasons.join("+") || "none"}: ${action} is refused independently of gate reasons`, () => {
    const run = replicas(), state = collabState(run.a);
    try {
      execute(run.b, { kind: "scalar", id: "incoming", by: "Bob", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 99 });
      const incoming = encodeSharedState(run.b), before = encodeSharedState(run.a), vector = encodeSharedStateVector(run.a);
      for (const reason of reasons) state.ingress.holds.add(reason);
      state.execution = { applying: phase === "application" };
      assert.throws(() => action === "arrival" ? applySharedUpdate(run.a, incoming) : holdSharedBuffer(run.a), refusal);
      assert.deepEqual(encodeSharedState(run.a), before);
      assert.deepEqual(encodeSharedStateVector(run.a), vector);
      assert.equal(state.ingress.held.length, 0);
    } finally { state.execution = null; state.ingress.holds.clear(); run.close(); }
  });
}

for (const buffered of [false, true]) for (const phase of ["prepare", "apply", "observer"] as const) for (const writer of ["entry", "transaction", "update", "hydration", "text-create", "html-import", "mark-write", "destroy", "buffer"] as const) {
  // why: A received update that arrives in a command's notifications is held, not refused; ingress-gate.test.ts pins it.
  if (phase === "observer" && (writer === "update" || writer === "buffer")) continue;
  test(`${writer} cannot reenter from ${phase}, and the guard clears after the error${buffered ? " with a dirty buffer" : ""}`, () => {
    const run = replicas();
    try {
      const release = buffered ? holdSharedBuffer(run.a) : () => {};
      const target = { scope: "beat" as const, record: "R1" };
      const nested = operation({ kind: "status", id: "reserved", by: "A", target, value: "ready", parents: [] });
      const ordinary = operation({ kind: "scalar", id: "ordinary", by: "A", target, field: "lengthSeconds", value: 7 });
      const custom = operation({ kind: "record-delete", id: "custom", by: "A", target: { collection: "people", record: "P" } });
      const textTarget = { segment: ref("b:R1"), owner: ref("R1"), field: "audioText" as const };
      const text = collabTextTarget(run.a, textTarget)?.text; assert.ok(text);
      execute(run.b, { kind: "scalar", id: "remote", by: "B", target, field: "lengthSeconds", value: 99 });
      const incoming = encodeSharedState(run.b), source = validatedFixture({ title: "nested", rows: [] });
      const attempt = (): void => {
        if (writer === "entry") executeSharedOperations(run.a, [nested]);
        else if (writer === "transaction") transactSharedDocument(run.a, "local-command", () => collabState(run.a).roots.meta.set("nested", true));
        else if (writer === "update") applySharedUpdate(run.a, incoming);
        else if (writer === "hydration") hydrateSharedDocument(run.a, source);
        else if (writer === "text-create") createCollabText(run.a, collabState(run.a).roots.meta, true);
        else if (writer === "html-import") insertSharedHtml(run.a, textTarget, text, "nested", [], "nested");
        else if (writer === "mark-write") writeSharedMarkRecord(run.a, textTarget, "nested", null);
        else if (writer === "buffer") holdSharedBuffer(run.a);
        else destroySharedDocument(run.a);
      };
      let updates = 0;
      collabState(run.a).doc.on("update", () => { updates++; });
      registerSharedOperationHandlers(run.a, { "record-delete": () => {
        if (phase === "prepare") attempt();
        return { ok: true, writes: [], apply: () => { if (phase === "apply") attempt(); } };
      } });
      if (phase === "observer") collabState(run.a).doc.once("afterTransaction", attempt);
      const before = encodeSharedState(run.a), vector = encodeSharedStateVector(run.a);
      assert.throws(() => executeSharedOperations(run.a, phase === "observer" ? [ordinary] : [custom, nested]), SharedExecutionWriteError);
      assert.equal(collabState(run.a).roots.statusEvents.size, 0);
      assert.equal(collabState(run.a).roots.meta.has("nested"), false);
      assert.equal(text.toString(), "abZ");
      assert.equal(updates, phase === "observer" ? 1 : 0);
      if (phase !== "observer") { assert.deepEqual(encodeSharedState(run.a), before); assert.deepEqual(encodeSharedStateVector(run.a), vector); }
      assert.deepEqual(executeSharedOperations(run.a, [ordinary]), { ok: true });
      release();
    } finally { run.close(); }
  });
}

test("a prepare that catches a nested entry defect and refuses changes no bytes, clocks or updates", () => {
  const run = replicas();
  try {
    let updates = 0;
    collabState(run.a).doc.on("update", () => { updates++; });
    registerSharedOperationHandlers(run.a, { "record-delete": () => {
      assert.throws(() => execute(run.a, { kind: "scalar", id: "nested", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 9 }), SharedExecutionWriteError);
      return { ok: false, reason: "outer-refused" };
    } });
    const before = encodeSharedState(run.a), vector = encodeSharedStateVector(run.a);
    const result = executeSharedOperations(run.a, [operation({ kind: "record-delete", id: "outer", by: "A", target: { collection: "people", record: "P" } })]);
    assert.ok(!result.ok); assert.equal(result.reason, "outer-refused");
    assert.deepEqual(encodeSharedState(run.a), before); assert.deepEqual(encodeSharedStateVector(run.a), vector); assert.equal(updates, 0);
    execute(run.a, { kind: "scalar", id: "after", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });
  } finally { run.close(); }
});

test("undefined prepared sets are caller defects before any apply, and non-map keys are frozen", () => {
  const run = replicas();
  try {
    let applied = false;
    registerSharedOperationHandlers(run.a, { "record-delete": () => ({ ok: true,
      writes: [{ kind: "set", path: ["meta", "bad"], value: undefined }], apply: () => { applied = true; } }) });
    const before = encodeSharedState(run.a), vector = encodeSharedStateVector(run.a);
    assert.throws(() => execute(run.a, { kind: "scalar", id: "good", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 8 },
      { kind: "record-delete", id: "bad", by: "A", target: { collection: "people", record: "P" } }), /undefined/);
    assert.equal(applied, false); assert.deepEqual(encodeSharedState(run.a), before); assert.deepEqual(encodeSharedStateVector(run.a), vector);
    const keys = createSharedPreparation(run.a).view.keys(["people", "missing"]);
    assert.ok(Object.isFrozen(keys)); assert.throws(() => (keys as string[]).push("bad"), TypeError);
    execute(run.a, { kind: "scalar", id: "after", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 9 });
  } finally { run.close(); }
});
