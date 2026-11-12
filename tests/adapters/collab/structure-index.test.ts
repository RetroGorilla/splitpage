import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, ref, operation } from "./executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { encodeSharedState, encodeSharedStateVector, readSharedRevision, transactSharedDocument, applySharedUpdate, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { observeSharedStructureIdentities } from "../../../src/adapters/collab/structure-reservations.ts";
import { sharedEmbedChangeReader } from "../../../src/adapters/collab/embed-changes.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

function reading(handle: SharedDocumentHandle) {
  const prep = createSharedPreparation(handle);
  try { return {
    owners: ["R1", "R2"].map(id => prep.view.resolveOwner(id, "audioText")),
    painted: ["R1", "R2"].map(id => readSharedPaintedText(handle, { owner: ref(id), segment: ref(id), field: "audioText" })?.text ?? null),
    rows: projectSharedDocument(handle).rows.map(row => ({ id: row.id, text: row.audioText }))
  }; } finally { prep.close(); }
}
function addBeat(handle: SharedDocumentHandle): void {
  const roots = collabState(handle).roots, beat = new Y.Map<unknown>();
  beat.set("id", "R2"); beat.set("segment", "b:R1"); roots.beats.set("R2", beat);
}

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
  test(`head plus boundary insertion and deletion patch reused metadata on live and encoded copies: ${copies} ${order}`, () => {
    const set = replicas(copies, { rows: [{ id: "R1", audioText: "abcd" }] }), handles = [set.a, set.b, set.c].slice(0, copies);
    try {
      const segment = collabState(set.a).roots.segments.get("b:R1") as Y.Map<unknown>, text = segment.get("text") as Y.Text;
      transactSharedDocument(set.a, "local-command", () => { addBeat(set.a); segment.set("head", { b: "R1" }); text.insertEmbed(2, { b: "R2" }); });
      set.queue.flush(order);
      agree("mixed head/boundary insert", order, handles, reading, {
        owners: [{ owner: "R1", segment: "b:R1" }, { owner: "R2", segment: "b:R1" }], painted: ["ab", "cd"],
        rows: [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]
      });
      transactSharedDocument(set.a, "local-command", () => { segment.set("head", { b: "R1" }); text.delete(2, 1); }); set.queue.flush(order);
      agree("mixed head/boundary delete", order, handles, handle => {
        const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
        const result = executeSharedOperations(handle, [operation({ kind: "scalar", id: "phantom", by: "Writer", target: { scope: "beat", record: "R2" }, field: "lengthSeconds", value: 9 })]);
        assert.ok(!result.ok); assert.equal(result.reason, "missing-target");
        assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(readSharedRevision(handle), revision);
        return reading(handle);
      }, { owners: [{ owner: "R1", segment: "b:R1" }, null], painted: ["abcd", null], rows: [{ id: "R1", text: "abcd" }] });
    } finally { set.close(); }
  });

test("seeded mixed head/embed transactions keep live ownership equal to an encoded fresh index at every checkpoint", t => {
  const declaredLimits: readonly string[] = [], violations = new Set<string>(), covered = new Set<string>();
  let seed = 0x14741, histories = 0, commands = 0, checkpoints = 0, comparisons = 0;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const checkpoint = (handles: readonly SharedDocumentHandle[]) => {
    checkpoints++;
    for (const handle of handles) {
      const fresh = createMonitoredSharedDocument();
      try {
        assert.ok(applySharedUpdate(fresh, encodeSharedState(handle)).ok);
        try { assertReplicasAgree("mixed metadata checkpoint", [{ order: "D1", replica: "A", output: reading(handle) }, { order: "late-C", replica: "C", output: reading(fresh) }]); }
        catch { violations.add("live structural metadata differs from an encoded fresh index"); }
        comparisons++;
      } finally { destroySharedDocument(fresh); }
    }
  };
  for (let sample = 0; sample < 8; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const set = replicas(copies, { rows: [{ id: "R1", audioText: "abcd" }] }), handles = [set.a, set.b, set.c].slice(0, copies);
    try {
      transactSharedDocument(set.a, "local-command", () => { addBeat(set.a); ((collabState(set.a).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text).insertEmbed(2, { b: "R2" }); }); set.queue.flush(order);
      for (let step = 0; step < 6; step++) {
        const writer = handles[random(copies)]; assert.ok(writer);
        transactSharedDocument(writer, "local-command", () => {
          const segment = collabState(writer).roots.segments.get("b:R1") as Y.Map<unknown>, text = segment.get("text") as Y.Text;
          segment.set("head", { b: random(2) ? "R1" : "R2" });
          if (step % 3 === 0) { covered.add("head plus insert"); text.insertEmbed(random(text.length + 1), { b: "R2" }); }
          if (step % 3 === 1) {
            covered.add("head plus delete"); let offset = 0;
            for (const delta of text.toDelta() as { insert: unknown }[]) { if (typeof delta.insert !== "string") { text.delete(offset, 1); break; } offset += delta.insert.length; }
          }
          if (step % 3 === 2) { covered.add("head plus create/delete"); text.insertEmbed(0, { b: "R2" }); text.delete(0, 1); }
        }); commands++; checkpoint(handles);
      }
      set.queue.flush(order); checkpoint(handles); agree("mixed metadata delivery", order, handles, reading); histories++;
    } finally { set.close(); }
  }
  assert.deepEqual([...violations], declaredLimits); assert.equal(covered.size, 3);
  assert.deepEqual({ histories, commands, checkpoints, comparisons }, { histories: 48, commands: 288, checkpoints: 336, comparisons: 840 });
  t.diagnostic(JSON.stringify({ seed: 0x14741, histories, commands, checkpoints, comparisons, covered: [...covered], declaredLimits, violations: [...violations] }));
});

test("a throwing inspection consumer is surfaced after both indexes publish the transaction", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    transactSharedDocument(set.a, "local-command", () => addBeat(set.a));
    const failure = new Error("inspection failed"), reserved = observeSharedStructureIdentities(set.a, () => { throw failure; }); let inspected = 0;
    sharedEmbedChangeReader(set.a, () => { inspected++; });
    const text = (collabState(set.a).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
    assert.throws(() => transactSharedDocument(set.a, "local-command", () => { text.insertEmbed(2, { b: "R2" }); text.insertEmbed(3, { k: "NativeShot", label: "Shot" }); }),
      error => error instanceof AggregateError && error.errors.length === 2 && error.errors.every(value => value === failure));
    assert.equal(inspected, 2); assert.equal(reserved.has("NativeShot"), true);
    const fresh = createMonitoredSharedDocument();
    try {
      assert.ok(applySharedUpdate(fresh, encodeSharedState(set.a)).ok);
      const a = createSharedPreparation(set.a), b = createSharedPreparation(fresh);
      try { assert.deepEqual(a.view.resolveOwner("R2", "audioText"), { owner: "R2", segment: "b:R1" }); assert.deepEqual(a.view.resolveOwner("R2", "audioText"), b.view.resolveOwner("R2", "audioText")); }
      finally { a.close(); b.close(); }
      assert.equal(observeSharedStructureIdentities(fresh).has("NativeShot"), true);
    } finally { destroySharedDocument(fresh); }
  } finally { set.close(); }
});
