import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { IdentityBook, checkModel } from "../../collab/checker.ts";
import type { CollabCharacter, CollabModel, CollabRow } from "../../collab/checker.ts";
import { beatOracles } from "../../collab/oracles/structure-oracles.ts";
import { assertIncremental, captureIncrementalReplica } from "./incremental-support.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const source = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }], sections: [{ id: "H1", name: "In", firstSceneId: "R1" }] };
const removal = "structure_1_0075006e0068006500610064_removal_0";
const unheading = (newBeat: string | null) => ({ kind: "heading-remove", id: "unhead", by: "Alice", heading: "H1",
  observed: [flowBaseReference("H1", "heading", 0, 2)], newBeat, nextBeat: newBeat ? "R1" : null });
const type = (owner: string, field: "heading" | "audioText", offset: number, value: string) => ({ kind: "text-insert", id: "type" + value, by: "Bob",
  target: { owner, segment: (field === "heading" ? "h:" : "b:") + owner, field }, at: offset ? { left: flowBaseReference(owner, field, offset - 1), right: null, affinity: "after" }
    : { left: null, right: flowBaseReference(owner, field, 0), affinity: "before" }, content: [{ value, marks: [] }] });
function send(handle: SharedDocumentHandle, ...ops: unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function setup(copies: 2 | 3) {
  const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
  for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedTextOperationHandlers(handle); }
  return { set, handles };
}
function visible(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { rows: document.rows.map(row => [row.id.startsWith("structure_") ? "Rn" : row.id, row.audioText, row.paragraphStart === true]),
    sections: ((document.sections ?? []) as { id: string; name: string; firstSceneId: string }[]).map(scene => [scene.id, scene.name, scene.firstSceneId.startsWith("structure_") ? "Rn" : scene.firstSceneId]),
    recovery: recovery.map(entry => entry.kind === "removed-heading" ? [entry.kind, entry.heading.id, entry.heading.name] : [entry.kind]) };
}

for (const order of ["D1", "rev", "dup"] as const) test(`Stage 1 T08 remove: demotion keeps heading and narration typing with literal identities: ${order}`, () => {
  const { set, handles } = setup(2), book = new IdentityBook();
  try {
    let number = 0;
    for (const key of ["b:R0", "h:H1", "b:R1"]) {
      const text = (collabState(set.a).roots.segments.get(key) as Y.Map<unknown>).get("text") as Y.Text;
      for (let offset = 0; offset < text.length; offset++) { const id = Y.createRelativePositionFromTypeIndex(text, offset).item; assert.ok(id); book.bind("s" + ++number, id); }
    }
    const anchor = createSharedAnchor(set.a, "h:H1", 0, "before"); assert.ok(anchor);
    send(set.b, type("H1", "heading", 2, "Z"), type("R1", "audioText", 2, "Y"));
    for (const [key, offset, name] of [["h:H1", 2, "b1"], ["b:R1", 2, "b2"]] as const) {
      const id = Y.createRelativePositionFromTypeIndex((collabState(set.b).roots.segments.get(key) as Y.Map<unknown>).get("text") as Y.Text, offset).item; assert.ok(id); book.bind(name, id);
    }
    send(set.a, unheading("Rn"), { kind: "scalar", id: "para", by: "Alice", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true });
    set.queue.flush(order);
    agree("T08 remove", order, handles, handle => {
      const roots = collabState(handle).roots, owned = new Map<string, CollabCharacter[]>(), places = new Map<string, { beat: string; offset: number }[]>();
      for (const key of roots.order.toArray()) {
        const segment = roots.segments.get(key) as Y.Map<unknown>, text = segment.get("text") as Y.Text, head = segment.get("head") as { b?: string; h?: string };
        let owner = head.b ?? head.h ?? "", offset = 0; owned.set(owner, []); const positions = [{ beat: owner, offset: 0 }]; places.set(key, positions);
        for (const delta of text.toDelta() as { insert: unknown }[]) {
          if (typeof delta.insert !== "string") { owner = "Rn"; owned.set(owner, []); offset++; positions.push({ beat: owner, offset: 0 }); continue; }
          for (const value of delta.insert) {
            const identity = Y.createRelativePositionFromTypeIndex(text, offset++).item, row = owned.get(owner); assert.ok(identity && row);
            row.push({ identity: { client: identity.client, clock: identity.clock }, notation: book.notation(identity), value, marks: {}, beat: owner });
            positions.push({ beat: owner, offset: row.length });
          }
        }
      }
      const projected = projectSharedDocumentWithRecovery(handle), resolved = resolveSharedAnchor(handle, anchor); assert.ok(resolved !== "gone");
      const rows: CollabRow[] = projected.document.rows.map(row => {
        const id = row.id.startsWith("structure_") ? "Rn" : row.id, characters = owned.get(id) ?? [];
        assert.equal(row.audioText, characters.map(char => char.value).join(""));
        return { id, characters, ...(row.paragraphStart ? { paragraphStart: true } : {}) };
      });
      const shown = new Set(rows.map(row => row.id)), sequence = [...owned.keys()], place = places.get(resolved.segment)?.[resolved.offset]; assert.ok(place);
      const caret = shown.has(place.beat) ? place : { beat: sequence.slice(sequence.indexOf(place.beat)).find(id => shown.has(id)) ?? "", offset: 0 };
      const model: CollabModel = { rows, carets: { A: caret }, recovery: [] }, oracle = beatOracles["T08 remove"]; assert.ok(oracle);
      assert.deepEqual([projected.document.sections ?? [], projected.recovery], [[], []]);
      checkModel(model, oracle, book, order); return model;
    });
  } finally { set.close(); }
});

const discard = {
  removed: { rows: [["R0", "x", false], ["R1", "abY", false]], sections: [], recovery: [["removed-heading", "H1", "InZ"]] },
  restored: { rows: [["R0", "x", false], ["R1", "abY", false]], sections: [["H1", "InZ", "R1"]], recovery: [] }
};
for (const copies of [2, 3] as const) for (const order of ["D1", "rev", "dup"] as const) test(`discarding a heading while another writer types in it and the following narration: ${copies}/${order}`, () => {
  const { set, handles } = setup(copies);
  try {
    const { projector } = captureIncrementalReplica(set.a);
    send(set.b, type("R1", "audioText", 2, "Y"), type("H1", "heading", 2, "Z"));
    send(set.a, unheading(null)); assertIncremental(set.a, projector);
    set.queue.flush(order); assertIncremental(set.a, projector);
    agree("discarded", order, handles, visible, discard.removed);
    const prep = createSharedPreparation(set.a);
    try { assert.equal(prep.view.resolveOwner("H1", "heading"), null); } finally { prep.close(); }
    send(set.b, { kind: "restore", id: "back", by: "Bob", removals: [removal] }); set.queue.flush(order); assertIncremental(set.a, projector);
    agree("restored", order, handles, visible, discard.restored);
  } finally { set.close(); }
});

const demotion = {
  Alice: { rows: [["R0", "x", false], ["Rn", "QIn", false], ["R1", "abY", true]], sections: [], recovery: [] },
  Bob: { rows: [["R0", "x", false], ["Rn", "In", false], ["R1", "abY", true]], sections: [], recovery: [["removed-heading", "H1", "Q"]] }
};
for (const first of ["Alice", "Bob"] as const) for (const order of ["D1", "rev", "dup"] as const) test(`demotion against typing at the heading start and in the following narration, lower writer ${first}: ${order}`, () => {
  const { set, handles } = setup(2), [alice, bob] = first === "Alice" ? [set.a, set.b] : [set.b, set.a];
  try {
    send(bob, type("H1", "heading", 0, "Q"), type("R1", "audioText", 2, "Y"));
    send(alice, unheading("Rn"), { kind: "scalar", id: "para", by: "Alice", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true });
    set.queue.flush(order);
    agree("demoted", order, handles, visible, demotion[first]);
  } finally { set.close(); }
});

test("concurrent identical heading removals are one removal; restoring either restores it, an older restore leaves a fresh removal", () => {
  const { set, handles } = setup(3);
  try {
    send(set.a, unheading(null)); send(set.b, unheading(null)); set.queue.flush("D1");
    send(set.c, { kind: "restore", id: "back", by: "Carol", removals: ["structure_2_0075006e0068006500610064_removal_0"] });
    set.queue.flush("D1");
    agree("one removal", "D1", handles, visible, { rows: [["R0", "x", false], ["R1", "ab", false]], sections: [["H1", "In", "R1"]], recovery: [] });
    send(set.a, { ...unheading(null), id: "again" }); send(set.b, { kind: "restore", id: "late", by: "Bob", removals: [removal] }); set.queue.flush("rev");
    send(set.c, { kind: "restore", id: "stale", by: "Carol", removals: [removal] }); set.queue.flush("rev");
    agree("fresh removal", "rev", handles, visible, { rows: [["R0", "x", false], ["R1", "ab", false]], sections: [], recovery: [["removed-heading", "H1", "In"]] });
  } finally { set.close(); }
});

test("removed headings refuse typing, a second removal and a heading inside a joined row; refusals leave bytes, vector and revision", () => {
  const { set } = setup(2);
  try {
    registerSharedJoinHandlers(set.b);
    const refuse = (handle: SharedDocumentHandle, op: unknown, reason: string) => {
      const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
      const result = executeSharedOperations(handle, [operation(op)], { base: revision }); assert.ok(!result.ok); assert.equal(result.reason, reason);
      assert.deepEqual([encodeSharedState(handle), encodeSharedStateVector(handle), readSharedRevision(handle)], [bytes, vector, revision]);
    };
    send(set.b, { kind: "join", id: "glue", by: "Bob", from: "R1", into: "R0", glue: " " });
    refuse(set.b, { ...unheading("Rn"), by: "Bob" }, "joined-heading");
    send(set.a, unheading(null));
    refuse(set.a, type("H1", "heading", 2, "Z"), "missing-target");
    refuse(set.a, { ...unheading(null), id: "twice" }, "missing-target");
  } finally { set.close(); }
});
