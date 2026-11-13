import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { structureIdentityFixture } from "../../collab/structure-identity.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";

const runtime = createFlowLoadRuntime();
const source = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] };
const names = new Map([[structureIdentityFixture("1", "head", "heading"), "Ha"], [structureIdentityFixture("2", "head", "heading"), "Hb"],
  [structureIdentityFixture("1", "cut", "beat"), "Rs"], [structureIdentityFixture("2", "cut", "beat"), "Rt"]]);
const shown = (id: string) => names.get(id) ?? id;
const create = (by: string, first: string, name: string | null) => [{ kind: "heading-create", id: "head", by, segment: "Hn", heading: "Hn", firstBeat: first,
  at: { left: null, right: first, affinity: "before" } }, ...name === null ? [] : [{ kind: "text-insert", id: "name", by, target: { owner: "Hn", segment: "Hn", field: "heading" },
  at: { left: null, right: flowBaseReference("Hn", "heading", 0), affinity: "before" }, content: [{ value: name, marks: [] }] }]];
const type = (by: string, owner: string, offset: number, value: string) => ({ kind: "text-insert", id: "type" + value, by, target: { owner, segment: owner, field: "audioText" },
  at: offset ? { left: flowBaseReference(owner, "audioText", offset - 1), right: null, affinity: "after" } : { left: null, right: flowBaseReference(owner, "audioText", 0), affinity: "before" },
  content: [{ value, marks: [] }] });
const split = (by: string, owner: string, offset: number, beat: string) => ({ kind: "split", id: "cut", by, target: { owner, segment: owner, field: "audioText" },
  at: { left: flowBaseReference(owner, "audioText", offset - 1), right: null, affinity: "after" }, observed: [], boundary: beat, beat, fields: {} });

function send(handle: SharedDocumentHandle, ...ops: unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function setup(copies: 2 | 3) {
  const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
  for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); registerSharedHeadingHandlers(handle); }
  return { set, handles };
}
function visible(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle), loaded = runtime.load(document);
  return { rows: loaded.rows.map(row => [shown(row.id), row.audioText]),
    sections: ((loaded.sections ?? []) as DocumentScene[]).map(scene => [shown(scene.id), scene.name, shown(scene.firstSceneId)]),
    recovery: recovery.map(entry => entry.kind === "removed-heading" || entry.kind === "scene-with-no-beats" ? [entry.kind, shown(String(entry.heading.id)), entry.heading.name] : [entry.kind]) };
}

for (const copies of [2, 3] as const) for (const order of ["D1", "rev", "dup"] as const) test(`a heading created before a beat another writer types in: ${copies}/${order}`, () => {
  const { set, handles } = setup(copies);
  try {
    const { projector } = captureIncrementalReplica(set.b);
    send(set.b, type("Bob", "R1", 0, "Y"), type("Bob", "R1", 2, "Z")); assertIncremental(set.b, projector);
    send(set.a, ...create("Alice", "R1", "New"));
    set.queue.flush(order); assertIncremental(set.b, projector);
    agree("typed", order, handles, visible, { rows: [["R0", "x"], ["R1", "YabZ"], ["R2", "cd"]], sections: [["Ha", "New", "R1"]], recovery: [] });
  } finally { set.close(); }
});

const inline = {
  Alice: { rows: [["R0", "x"], ["R1", "a"], ["Rs", "Yb"], ["R2", "cd"]], sections: [["Ha", "NewW", "Rs"]], recovery: [] },
  Bob: { rows: [["R0", "x"], ["R1", "aW"], ["Rs", "Yb"], ["R2", "cd"]], sections: [["Ha", "New", "Rs"]], recovery: [] }
};
for (const lower of ["Alice", "Bob"] as const) for (const order of ["D1", "rev", "dup"] as const) test(`a heading before a split-off beat against typing on both sides of it, lower writer ${lower}: ${order}`, () => {
  const { set, handles } = setup(2), [alice, bob] = lower === "Alice" ? [set.a, set.b] : [set.b, set.a];
  try {
    send(alice, split("Alice", "R1", 1, "Rs")); set.queue.flush(order);
    const rs = structureIdentityFixture(lower === "Alice" ? "1" : "2", "cut", "beat");
    const { projector } = captureIncrementalReplica(bob);
    send(bob, type("Bob", rs, 0, "Y"), type("Bob", "R1", 1, "W"));
    send(alice, ...create("Alice", rs, "New"));
    set.queue.flush(order); assertIncremental(bob, projector);
    agree("inline", order, handles, handle => { const value = visible(handle); return JSON.parse(JSON.stringify(value).replaceAll('"Rt"', '"Rs"').replaceAll('"Hb"', '"Ha"')) as typeof value; }, inline[lower]);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a heading created while another writer splits or removes its first beat, then restores it: ${order}`, () => {
  const { set, handles } = setup(3);
  try {
    send(set.b, split("Bob", "R1", 1, "Rt")); send(set.a, ...create("Alice", "R1", "New")); set.queue.flush(order);
    agree("split", order, handles, visible, { rows: [["R0", "x"], ["R1", "a"], ["Rt", "b"], ["R2", "cd"]], sections: [["Ha", "New", "R1"]], recovery: [] });
    const { projector } = captureIncrementalReplica(set.c);
    send(set.c, { kind: "remove", id: "gone", by: "Carol", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 1)], boundaries: ["R1"], components: [], gallery: [], at: 1 });
    set.queue.flush(order); assertIncremental(set.c, projector);
    agree("removed", order, handles, visible, { rows: [["R0", "x"], ["Rt", "b"], ["R2", "cd"]], sections: [["Ha", "New", "Rt"]], recovery: [["removed-beat"]] });
    send(set.b, { kind: "restore", id: "back", by: "Bob", removals: ["structure_3_0067006f006e0065_removal_0"] }); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("restored", order, handles, visible, { rows: [["R0", "x"], ["R1", "a"], ["Rt", "b"], ["R2", "cd"]], sections: [["Ha", "New", "R1"]], recovery: [] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`two writers create a heading before the same beat at the same moment: ${order}`, () => {
  const { set, handles } = setup(3);
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.b, ...create("Bob", "R1", "Two")); send(set.a, ...create("Alice", "R1", "One")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("same place", order, handles, visible, { rows: [["R0", "x"], ["R1", "ab"], ["R2", "cd"]], sections: [["Hb", "Two", "R1"]], recovery: [["scene-with-no-beats", "Ha", "One"]] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a created heading removed by another writer and restored: ${order}`, () => {
  const { set, handles } = setup(3), heading = structureIdentityFixture("1", "head", "heading");
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, ...create("Alice", "R1", "New")); set.queue.flush(order); assertIncremental(set.c, projector);
    send(set.b, { kind: "heading-remove", id: "unhead", by: "Bob", heading, observed: [flowBaseReference(heading, "heading", 0, 3)], newBeat: null, nextBeat: null });
    set.queue.flush(order); assertIncremental(set.c, projector);
    agree("removed", order, handles, visible, { rows: [["R0", "x"], ["R1", "ab"], ["R2", "cd"]], sections: [], recovery: [["removed-heading", "Ha", "New"]] });
    send(set.c, { kind: "restore", id: "back", by: "Carol", removals: ["structure_2_0075006e0068006500610064_removal_0"] }); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("restored", order, handles, visible, { rows: [["R0", "x"], ["R1", "ab"], ["R2", "cd"]], sections: [["Ha", "New", "R1"]], recovery: [] });
  } finally { set.close(); }
});

test("heading creation refuses a later part of a joined row, a refused or missing name and an unknown beat; refusals leave bytes, vector and revision", () => {
  const { set } = setup(2);
  try {
    registerSharedJoinHandlers(set.a);
    const refuse = (ops: unknown[], reason: string, index: number) => {
      const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
      const result = executeSharedOperations(set.a, ops.map(operation), { base: revision }); assert.ok(!result.ok); assert.equal(result.reason, reason);
      assert.ok("index" in result); assert.equal(result.index, index);
      assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], [bytes, vector, revision]);
    };
    refuse(create("Alice", "R1", " \u0007 "), "invalid-heading-name", 0);
    refuse(create("Alice", "R1", null), "invalid-heading-name", 0);
    refuse(create("Alice", "R9", "New"), "missing-target", 0);
    send(set.a, { kind: "join", id: "glue", by: "Alice", from: "R2", into: "R1", glue: " " });
    refuse(create("Alice", "R2", "New"), "joined-heading", 0);
    send(set.a, ...create("Alice", "R1", "New"));
    assert.deepEqual(visible(set.a), { rows: [["R0", "x"], ["R1", "ab cd"]], sections: [["Ha", "New", "R1"]], recovery: [] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`declared limit: a name of half a surrogate pair is read as U+FFFD and accepted; every copy loads that scene, which the app drops: ${order}`, () => {
  const { set, handles } = setup(3);
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, ...create("Alice", "R0", "\uD800")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("lone half", order, handles, handle => {
      const document = projectSharedDocumentWithRecovery(handle).document, sections = (document.sections ?? []) as DocumentScene[];
      return { sections: sections.map(scene => [shown(scene.id), scene.name, shown(scene.firstSceneId)]), loaded: ((runtime.load(document).sections ?? []) as DocumentScene[]).map(scene => [shown(scene.id), scene.name]) };
    }, { sections: [["Ha", "\uFFFD", "R0"]], loaded: [["Ha", "\uFFFD"]] });
    assert.equal(runtime.load({ ...source, sections: [{ id: "Hn", name: "\uD800", firstSceneId: "R0" }] }).sections, undefined);
  } finally { set.close(); }
});

const joins = {
  head: { rows: [["R0", "x"], ["R1", "ab cd"]], sections: [], recovery: [["scene-with-no-beats", "Ha", "New"]] },
  inline: { rows: [["R0", "x"], ["R1", "a"], ["Rs", "b"], ["R2", "cd"]], sections: [["Ha", "New", "Rs"]], recovery: [] }
};
for (const place of ["head", "inline"] as const) for (const order of ["D1", "rev", "dup"] as const) test(`a heading created while another writer joins its first beat into the beat before, first beat ${place === "head" ? "heading its segment: the join wins and the name goes to recovery" : "inline: the join has no effect and leaves no recovery entry"}: ${order}`, () => {
  const { set, handles } = setup(3);
  try {
    registerSharedJoinHandlers(set.b);
    let first = "R2";
    if (place === "inline") { send(set.a, split("Alice", "R1", 1, "Rs")); set.queue.flush(order); first = structureIdentityFixture("1", "cut", "beat"); }
    const { projector } = captureIncrementalReplica(set.c);
    send(set.b, { kind: "join", id: "glue", by: "Bob", from: first, into: "R1", glue: place === "head" ? " " : "" }); send(set.a, ...create("Alice", first, "New"));
    set.queue.flush(order); assertIncremental(set.c, projector);
    agree("join " + place, order, handles, visible, joins[place]);
  } finally { set.close(); }
});
