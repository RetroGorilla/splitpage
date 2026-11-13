import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { captureIncrementalReplica, assertIncremental } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { IdentityBook, checkModel } from "../../collab/checker.ts";
import type { CollabCharacter, CollabModel, CollabRow } from "../../collab/checker.ts";
import { beatOracles } from "../../collab/oracles/structure-oracles.ts";
import { structureIdentityFixture } from "../../collab/structure-identity.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";

const runtime = createFlowLoadRuntime();
const headingA = structureIdentityFixture("1", "fin_o_0", "heading"), headingB = structureIdentityFixture("2", "fin_o_0", "heading");
const names = new Map([[headingA, "Ha"], [headingB, "Hb"], [structureIdentityFixture("3", "fin_o_0", "heading"), "Hc"], [structureIdentityFixture("2", "head", "heading"), "Hp"], [structureIdentityFixture("2", "cut", "beat"), "Rs"], [structureIdentityFixture("2", "unhead", "beat"), "Rn"]]);
const shown = (id: string) => names.get(id) ?? id;
const base = (owner: string, from: number, to = from) => flowBaseReference(owner, "audioText", from, to);
const tailed = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab<br>cd", paragraphStart: true }, { id: "R2", audioText: "ef" }] };
const whole = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab", paragraphStart: true }, { id: "R2", audioText: "ef", paragraphStart: true }] };
function finalize(by: string, owner: string, length: number, tail: string | null, follower: string, at = 1) {
  const keep = tail !== null, line = 2 + length;
  return [{ kind: "heading-finalize", id: "fin_o_0", by, target: { owner, segment: owner, field: "audioText" }, heading: "Hn", prefix: [base(owner, 0, 2)],
    name: [base(owner, 2, line)], separator: keep ? [base(owner, line, line + 1)] : [], retainedBeat: keep ? owner : follower, emptyBeat: null,
    tail: keep ? { left: null, right: base(owner, line + 1), affinity: "before" } : { left: base(owner, line - 1), right: null, affinity: "after" } },
  ...keep ? [] : [{ kind: "remove", id: "fin_o_1", by, removalKind: "became-heading", targets: [owner], observed: [base(owner, 0, line)], boundaries: [owner],
    components: [owner + ":visual"], gallery: [owner + ":gallery"], at }],
  { kind: "scalar", id: "fin:2", by, target: { scope: "beat", record: keep ? owner : follower }, field: "paragraphStart", clear: true }];
}
const type = (by: string, owner: string, offset: number, value: string) => ({ kind: "text-insert", id: "type" + value, by, target: { owner, segment: owner, field: "audioText" },
  at: offset ? { left: base(owner, offset - 1), right: null, affinity: "after" } : { left: null, right: base(owner, 0), affinity: "before" }, content: [{ value, marks: [] }] });

function send(handle: SharedDocumentHandle, ...ops: unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function setup(copies: 2 | 3, source: Record<string, unknown> = tailed) {
  const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
  for (const handle of handles) {
    registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle);
    registerSharedHeadingHandlers(handle); registerSharedJoinHandlers(handle); registerSharedRecordHandlers(handle);
  }
  return { set, handles };
}
function visible(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle), loaded = runtime.load(document);
  return { rows: loaded.rows.map(row => [shown(row.id), row.audioText, row.paragraphStart === true]),
    sections: ((loaded.sections ?? []) as DocumentScene[]).map(scene => [shown(scene.id), scene.name, shown(scene.firstSceneId)]),
    recovery: recovery.map(entry => entry.kind === "removed-heading" || entry.kind === "scene-with-no-beats" ? [entry.kind, shown(String(entry.heading.id)), entry.heading.name]
      : entry.kind === "removed-beat" ? [entry.kind, entry.row.audioText] : [entry.kind]) };
}

function stageOneModel(handle: SharedDocumentHandle, book: IdentityBook, caret: string | null, label: string) {
  const roots = collabState(handle).roots, owned = new Map<string, CollabCharacter[]>(), places = new Map<string, { beat: string; offset: number }[]>();
  for (const key of roots.order.toArray()) {
    const segment = roots.segments.get(key) as Y.Map<unknown>, text = segment.get("text") as Y.Text, head = segment.get("head") as { b?: string; h?: string };
    let owner = head.b ?? head.h ?? "", offset = 0; if (!owned.has(owner)) owned.set(owner, []); const positions = [{ beat: owner, offset: owned.get(owner)?.length ?? 0 }]; places.set(key, positions);
    for (const delta of text.toDelta() as { insert: unknown }[]) {
      if (typeof delta.insert !== "string") { const next = delta.insert as { b?: string; h?: string }; owner = next.b ?? next.h ?? ""; if (!owned.has(owner)) owned.set(owner, []); offset++; positions.push({ beat: owner, offset: owned.get(owner)?.length ?? 0 }); continue; }
      for (const value of delta.insert) {
        const identity = Y.createRelativePositionFromTypeIndex(text, offset++).item, row = owned.get(owner); assert.ok(identity && row);
        row.push({ identity: { client: identity.client, clock: identity.clock }, notation: book.notation(identity), value, marks: {}, beat: owner.startsWith("structure_") ? label : owner });
        positions.push({ beat: owner, offset: row.length });
      }
    }
  }
  const projected = projectSharedDocumentWithRecovery(handle), headings = new Map(((projected.document.sections ?? []) as DocumentScene[]).map(scene => [scene.firstSceneId, scene]));
  const rows: CollabRow[] = projected.document.rows.flatMap(row => {
    const scene = headings.get(row.id), characters = owned.get(row.id) ?? []; assert.equal(row.audioText, characters.map(char => char.value).join(""));
    const heading: CollabRow[] = scene ? [{ id: label, kind: "heading", characters: owned.get(scene.id) ?? [] }] : [];
    if (scene) assert.equal(scene.name, heading[0]?.characters.map(char => char.value).join(""));
    return [...heading, { id: row.id, characters, ...(row.paragraphStart ? { paragraphStart: true } : {}) }];
  });
  const carets: CollabModel["carets"] = {};
  if (caret) { const resolved = resolveSharedAnchor(handle, caret); assert.ok(resolved !== "gone"); const place = places.get(resolved.segment)?.[resolved.offset]; assert.ok(place); carets.A = place; }
  assert.deepEqual(projected.recovery, []);
  return { rows, carets, recovery: [] } satisfies CollabModel;
}
function bindAll(handle: SharedDocumentHandle, book: IdentityBook, keys: readonly string[], prefix: string, start = 0) {
  let number = start;
  for (const key of keys) {
    const text = (collabState(handle).roots.segments.get(key) as Y.Map<unknown>).get("text") as Y.Text;
    for (let offset = 0; offset < text.length; offset++) { const id = Y.createRelativePositionFromTypeIndex(text, offset).item; assert.ok(id); book.bind(prefix + ++number, id); }
  }
}
function bindAt(handle: SharedDocumentHandle, book: IdentityBook, key: string, offset: number, name: string) {
  const id = Y.createRelativePositionFromTypeIndex((collabState(handle).roots.segments.get(key) as Y.Map<unknown>).get("text") as Y.Text, offset).item; assert.ok(id); book.bind(name, id);
}

for (const order of ["D1", "rev", "dup"] as const) test(`Stage 1 T08 create: the name keeps its characters and typing at its end, the caret follows the next beat: ${order}`, () => {
  const { set, handles } = setup(2, { rows: [{ id: "R1", audioText: "x" }, { id: "R2", audioText: "# Ab", paragraphStart: true }, { id: "R3", audioText: "cd", paragraphStart: true }] }), book = new IdentityBook();
  try {
    bindAll(set.a, book, ["b:R1", "b:R2", "b:R3"], "s");
    const { projector } = captureIncrementalReplica(set.b);
    send(set.b, type("Bob", "R2", 4, "e"), type("Bob", "R3", 0, "Q")); bindAt(set.b, book, "b:R2", 4, "b1"); bindAt(set.b, book, "b:R3", 0, "b2");
    send(set.a, ...finalize("Alice", "R2", 2, null, "R3"));
    const caret = createSharedAnchor(set.a, "b:R3", 0, "after"); assert.ok(caret);
    set.queue.flush(order); assertIncremental(set.b, projector);
    agree("T08 create", order, handles, handle => { const model = stageOneModel(handle, book, caret, "H2"), oracle = beatOracles["T08 create"]; assert.ok(oracle); checkModel(model, oracle, book, order); return model; });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`Stage 1 T08 race: two writers finalize the same line; one heading holds the name, the tail keeps its beat: ${order}`, () => {
  const { set, handles } = setup(2, { rows: [{ id: "R1", audioText: "x" }, { id: "R2", audioText: "# Ab<br>rest", paragraphStart: true }] }), book = new IdentityBook();
  try {
    bindAll(set.a, book, ["b:R1", "b:R2"], "s");
    const { projector } = captureIncrementalReplica(set.a);
    send(set.a, ...finalize("Alice", "R2", 2, "rest", "")); send(set.b, ...finalize("Bob", "R2", 2, "rest", ""));
    set.queue.flush(order); assertIncremental(set.a, projector);
    agree("T08 race", order, handles, handle => { const model = stageOneModel(handle, book, null, "Hb"), oracle = beatOracles["T08 race"]; assert.ok(oracle);
      assert.deepEqual(((projectSharedDocumentWithRecovery(handle).document.sections ?? []) as DocumentScene[]).map(scene => shown(scene.id)), ["Hb"]);
      checkModel(model, oracle, book, order); return model; });
  } finally { set.close(); }
});


const split = (offset: number) => ({ kind: "split", id: "cut", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" }, at: { left: base("R1", offset - 1), right: null, affinity: "after" }, observed: [], boundary: "Rs", beat: "Rs", fields: {} });
const join = { kind: "join", id: "glue", by: "Bob", from: "R1", into: "R0", glue: " " };
const removal = (to: number) => ({ kind: "remove", id: "gone", by: "Bob", removalKind: "beat", targets: ["R1"], observed: [base("R1", 0, to)], boundaries: ["R1"], components: [], gallery: [], at: 1 });
const kept = (name: string, tail = "cd") => ({ rows: [["R0", "x", false], ["R1", tail, false], ["R2", "ef", false]], sections: [["Ha", name, "R1"]], recovery: [] });
const moved = (name: string, recovery: unknown[][] = []) => ({ rows: [["R0", "x", false], ["R2", "ef", false]], sections: [["Ha", name, "R2"]], recovery });
const concurrent: Record<string, { readonly source: Record<string, unknown>; readonly bob: readonly unknown[]; readonly tail: boolean; readonly expected: ReturnType<typeof visible> }> = {
  "types at the line start": { source: tailed, bob: [type("Bob", "R1", 0, "Z")], tail: true, expected: kept("ZAb") },
  "types inside the name": { source: tailed, bob: [type("Bob", "R1", 3, "Z")], tail: true, expected: kept("AZb") },
  "types at the end of the name": { source: tailed, bob: [type("Bob", "R1", 4, "Z")], tail: true, expected: kept("AbZ") },
  "types at the tail start": { source: tailed, bob: [type("Bob", "R1", 5, "Z")], tail: true, expected: kept("Ab", "Zcd") },
  "types at the start of a whole line": { source: whole, bob: [type("Bob", "R1", 0, "Z")], tail: false, expected: moved("ZAb") },
  "types at the end of a whole line": { source: whole, bob: [type("Bob", "R1", 4, "Z")], tail: false, expected: moved("AbZ") },
  "splits inside the name": { source: tailed, bob: [split(3)], tail: true, expected: { rows: [["R0", "x", false], ["Rs", "b", false], ["R1", "cd", false], ["R2", "ef", false]], sections: [["Ha", "A", "Rs"]], recovery: [] } },
  "splits the tail": { source: tailed, bob: [split(6)], tail: true, expected: { rows: [["R0", "x", false], ["R1", "c", false], ["Rs", "d", false], ["R2", "ef", false]], sections: [["Ha", "Ab", "R1"]], recovery: [] } },
  "joins the line into the beat above": { source: tailed, bob: [join], tail: true, expected: { rows: [["R0", "x cd", false], ["R2", "ef", false]], sections: [["Ha", "Ab", "R2"]], recovery: [] } },
  "joins a whole line into the beat above": { source: whole, bob: [join], tail: false, expected: moved("Ab") },
  "removes the line": { source: tailed, bob: [removal(7)], tail: true, expected: moved("Ab", [["removed-beat", "cd"]]) },
  "removes a whole line": { source: whole, bob: [removal(4)], tail: false, expected: moved("Ab") }
};
for (const [name, scenario] of Object.entries(concurrent)) for (const order of ["D1", "rev", "dup"] as const) test(`finalize while another writer ${name}: ${order}`, () => {
  const { set, handles } = setup(3, scenario.source);
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.b, ...scenario.bob); send(set.a, ...finalize("Alice", "R1", 2, scenario.tail ? "cd" : null, "R2")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree(name, order, handles, visible, scenario.expected);
  } finally { set.close(); }
});

const marked = { ...tailed, comments: [{ id: "C1", rowId: "R1", text: "note" }] };
const marking = [{ kind: "mark", id: "bold", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: [base("R1", 3, 4)], mark: { kind: "b", value: true } },
  { kind: "mark", id: "note", by: "Bob", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: [base("R1", 2, 4)], mark: { kind: "comment", id: "C1", value: true } }];
const demoted = (audio: string) => ({ rows: [["R0", "x", false], ["Rn", audio, false], ["R1", "cd", true], ["R2", "ef", false]], sections: [], recovery: [] });
const markedName = "<span class=\"cmt-anchor\" data-cmt=\"C1\">A<strong>b</strong></span>";
for (const order of ["D1", "rev", "dup"] as const) test(`marks and a comment made on the line while it is finalized stay on its characters, hidden in the name, and return when another writer demotes it; restore keeps the demotion: ${order}`, () => {
  const { set, handles } = setup(3, marked);
  try {
    const { projector } = captureIncrementalReplica(set.c), comments = (handle: SharedDocumentHandle) => (runtime.load(projectSharedDocumentWithRecovery(handle).document).comments ?? []).map(item => [item.id, item.anchorId, item.quotedText]);
    send(set.b, ...marking); send(set.a, ...finalize("Alice", "R1", 2, "cd", "")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("named", order, handles, handle => ({ ...visible(handle), comments: comments(handle) }), { ...kept("Ab"), comments: [["C1", "C1", ""]] });
    send(set.b, { kind: "heading-remove", id: "unhead", by: "Bob", heading: headingA, observed: [flowBaseReference(headingA, "heading", 0, 2)], newBeat: "Rn", nextBeat: "R1" },
      { kind: "scalar", id: "para", by: "Bob", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true });
    set.queue.flush(order); assertIncremental(set.c, projector);
    agree("demoted", order, handles, visible, demoted(markedName));
    send(set.c, { kind: "restore", id: "back", by: "Carol", removals: ["structure_2_0075006e0068006500610064_removal_0"] }); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("restored", order, handles, visible, demoted(markedName));
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`two writers finalize the same whole line at the same moment: the heading of the higher writer takes the name, the other has no place: ${order}`, () => {
  const { set, handles } = setup(3, whole);
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, ...finalize("Alice", "R1", 2, null, "R2")); send(set.b, ...finalize("Bob", "R1", 2, null, "R2")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("same line", order, handles, visible, { rows: [["R0", "x", false], ["R2", "ef", false]], sections: [["Hb", "Ab", "R2"]], recovery: [] });
  } finally { set.close(); }
});

test("finalization refuses a joined row, a refused name, a broken line, a heading left after an earlier placed beat and an unknown beat; refusals leave bytes, vector and revision", () => {
  const { set } = setup(2, { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# Ab<br>cd", paragraphStart: true }, { id: "R2", audioText: "# Cd" },
    { id: "R3", audioText: "ij", paragraphStart: true },{ id: "R4", audioText: "# \u0007 ", paragraphStart: true }, { id: "R5", audioText: "gh", paragraphStart: true }] });
  try {
    const refuse = (ops: readonly unknown[], reason: string, index = 0) => {
      const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a);
      const result = executeSharedOperations(set.a, ops.map(operation), { base: revision }); assert.ok(!result.ok); assert.equal(result.reason, reason);
      assert.ok("index" in result); assert.equal(result.index, index);
      assert.deepEqual([encodeSharedState(set.a), encodeSharedStateVector(set.a), readSharedRevision(set.a)], [bytes, vector, revision]);
    };
    refuse(finalize("Alice", "R4", 2, null, "R5", 4), "invalid-heading-name");
    refuse(finalize("Alice", "R9", 2, "cd", ""), "missing-target");
    const [head, ...rest] = finalize("Alice", "R1", 2, "cd", "") as [Record<string, unknown>, ...unknown[]];
    refuse([{ ...head, name: [base("R1", 3, 4)] }, ...rest], "invalid-heading-range");
    refuse([{ ...head, tail: { left: null, right: base("R1", 6), affinity: "before" } }, ...rest], "invalid-heading-range");
    refuse([{ kind: "segment-create", id: "blank", by: "Alice", segment: "Rb", beat: "Rb", at: { left: "R0", right: "R2", affinity: "after" }, fields: {} },
      { ...head, id: "fin_o_1", retainedBeat: "Rb", emptyBeat: null, separator: [], tail: { left: base("R1", 3), right: null, affinity: "after" }, name: [base("R1", 2, 4)] }], "misplaced-heading-beat", 1);
    send(set.a, { kind: "join", id: "glue", by: "Alice", from: "R2", into: "R1", glue: " " });
    refuse(finalize("Alice", "R2", 2, null, "R3"), "joined-heading");
    refuse(finalize("Alice", "R1", 2, "cd", ""), "joined-heading");
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`declared limit: a line whose name is half a surrogate pair is stored as U+FFFD and accepted; every copy loads that scene, which the app drops: ${order}`, () => {
  const { set, handles } = setup(3, { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "# \uD800", paragraphStart: true }, { id: "R2", audioText: "ef", paragraphStart: true }] });
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, ...finalize("Alice", "R1", 1, null, "R2")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("lone half", order, handles, visible, { rows: [["R0", "x", false], ["R2", "ef", false]], sections: [["Ha", "�", "R2"]], recovery: [] });
    assert.equal(runtime.load({ rows: [{ id: "R0", audioText: "x" }, { id: "R2", audioText: "ef" }], sections: [{ id: "Hn", name: "\uD800", firstSceneId: "R2" }] }).sections, undefined);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`two writers finalize a line with a tail while a third, whose id lies between theirs, types at the tail start: the tail after that typing goes to recovery: ${order}`, () => {
  const { set, handles } = setup(3);
  try {
    const { projector } = captureIncrementalReplica(set.b);
    send(set.a, ...finalize("Alice", "R1", 2, "cd", "")); send(set.c, ...finalize("Carol", "R1", 2, "cd", "")); send(set.b, type("Bob", "R1", 5, "Z"));
    set.queue.flush(order); assertIncremental(set.b, projector);
    agree("between", order, handles, visible, { rows: [["R0", "x", false], ["R1", "Z", false], ["R2", "ef", false]], sections: [["Hc", "Ab", "R1"]], recovery: [["unprojectable-fragment"]] });
  } finally { set.close(); }
});

const pasted = [{ kind: "heading-create", id: "head", by: "Bob", segment: "Hp", heading: "Hp", firstBeat: "R1", at: { left: null, right: "R1", affinity: "before" } },
  { kind: "text-insert", id: "name", by: "Bob", target: { owner: "Hp", segment: "Hp", field: "heading" }, at: { left: null, right: flowBaseReference("Hp", "heading", 0), affinity: "before" }, content: [{ value: "New", marks: [] }] }];
const outcomes: Record<string, { readonly bob: readonly (readonly unknown[])[]; readonly expected: ReturnType<typeof visible> }> = {
  "types a line break and text at the end of a whole line: the name holds the line break": { bob: [[type("Bob", "R1", 4, "\ncd")]], expected: moved("Ab\ncd") },
  "pastes a heading whose first beat is the line: that heading is left with no beats": { bob: [pasted], expected: moved("Ab", [["scene-with-no-beats", "Hp", "New"]]) },
  "types a tail and finalizes the line with it: the tail goes to recovery as a removed beat": { bob: [[type("Bob", "R1", 4, "\ncd")], finalize("Bob", "R1", 2, "cd", "")],
    expected: { rows: [["R0", "x", false], ["R2", "ef", false]], sections: [["Hb", "Ab", "R2"]], recovery: [["removed-beat", "cd"]] } }
};
for (const [name, scenario] of Object.entries(outcomes)) for (const order of ["D1", "rev", "dup"] as const) test(`a whole line finalized while another writer ${name}: ${order}`, () => {
  const { set, handles } = setup(3, whole);
  try {
    const { projector } = captureIncrementalReplica(set.c);
    for (const ops of scenario.bob) send(set.b, ...ops);
    send(set.a, ...finalize("Alice", "R1", 2, null, "R2")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree(name, order, handles, visible, scenario.expected);
  } finally { set.close(); }
});
