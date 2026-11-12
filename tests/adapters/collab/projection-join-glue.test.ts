import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, execute } from "./executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument, encodeSharedState, encodeSharedStateVector, readSharedRevision, observeSharedTransactions } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument, projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readProjectionBeatStructure } from "../../../src/adapters/collab/projection-reader.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

function beat(handle: SharedDocumentHandle, id = "R2"): Y.Map<unknown> {
  const value = collabState(handle).roots.beats.get(id); assert.ok(value instanceof Y.Map); return value;
}
function seed(copies: number, removed: boolean) {
  const run = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  transactSharedDocument(run.a, "local-command", () => {
    const joins = beat(run.a).get("joins"); assert.ok(joins instanceof Y.Map); joins.set("jA", { into: "R1", glue: " " });
    if (removed) { const removals = beat(run.a, "R1").get("removals"); assert.ok(removals instanceof Y.Map); removals.set("removal", true); }
  }); run.queue.flush("D1"); return run;
}
function set(handle: SharedDocumentHandle, value: unknown, join = "jA"): void {
  const field = join === "jA" ? 'joinGlue:["join-retirement","R2","R1"," ",0]'
    : join === "jB" ? 'joinGlue:["join-retirement","R2","R3"," ",0]' : 'joinGlue:["join-retirement","missing","R1"," ",0]';
  transactSharedDocument(handle, "local-command", () => collabState(handle).roots.meta.set(field, value));
}
function read(handle: SharedDocumentHandle) {
  const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
  let transactions = 0, updates = 0;
  const detach = observeSharedTransactions(handle, () => { transactions++; }), update = () => { updates++; };
  collabState(handle).doc.on("update", update);
  try {
    const full = projectSharedDocument(handle), result = projectSharedDocumentWithRecovery(handle);
    assert.deepEqual(full, result.document);
    assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector);
    assert.equal(readSharedRevision(handle), revision); assert.deepEqual([transactions, updates], [0, 0]);
    return result;
  } finally { detach(); collabState(handle).doc.off("update", update); }
}
function expected(text: string, removed: boolean, lengthSeconds?: number) {
  const row = { id: "R1", status: "todo", visualText: "", audioText: text, imageRef: null, updatedAt: "", updatedBy: null,
    ...(lengthSeconds === undefined ? {} : { lengthSeconds }) };
  return { document: { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows: removed ? [] : [row],
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 },
  recovery: removed ? [{ kind: "removed-beat" as const, row, members: ["R1", "R2"] }] : [] };
}
function scalar(handle: SharedDocumentHandle, value: number): void {
  const removals = beat(handle, "R1").get("removals");
  if (removals instanceof Y.Map && removals.get("removal") === true) {
    transactSharedDocument(handle, "hydration", () => beat(handle, "R1").set("lengthSeconds", value)); return;
  }
  execute(handle, { kind: "scalar", id: "scalar" + value, by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value });
}

for (const removed of [false, true]) {
  test(`join glue with no register falls back; valid sets leave the issued entry immutable: recovery=${removed}`, () => {
    const run = seed(2, removed);
    try {
      agree("issued glue", "D1", [run.a, run.b], read, expected("ab cd", removed));
      set(run.a, ""); run.queue.flush("D1"); agree("empty register", "D1", [run.a, run.b], read, expected("abcd", removed));
      set(run.b, " "); run.queue.flush("rev"); agree("space register", "rev", [run.a, run.b], read, expected("ab cd", removed));
      agree("unchanged issued entry", "D1", [run.a, run.b], handle => (beat(handle).get("joins") as Y.Map<unknown>).get("jA"), { into: "R1", glue: " " });
    } finally { run.close(); }
  });
  test(`a later causal glue set from the lower writer replaces the higher writer's set: recovery=${removed}`, () => {
    const run = seed(2, removed);
    try {
      set(run.b, ""); run.queue.flush("D1"); agree("first set", "D1", [run.a, run.b], read, expected("abcd", removed));
      set(run.a, " "); run.queue.flush("dup"); agree("causal replacement", "dup", [run.a, run.b], read, expected("ab cd", removed));
    } finally { run.close(); }
  });
  for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const variant of [
    { values: ["", " ", ""], two: "ab cd", three: "abcd" },
    { values: [" ", "", " "], two: "abcd", three: "ab cd" }
  ]) test(`concurrent join glue has the literal scalar register winner: ${copies}/${order}/${variant.two}/recovery=${removed}`, () => {
    const run = seed(copies, removed), handles = [run.a, run.b, run.c].slice(0, copies);
    try {
      handles.forEach((handle, index) => { set(handle, variant.values[index]); scalar(handle, [10, 20, 30][index] as number); });
      run.queue.flush(order);
      agree("scalar register winner", order, handles, handle => beat(handle, "R1").get("lengthSeconds"), copies === 2 ? 20 : 30);
      agree("glue register winner", order, handles, read, expected(copies === 2 ? variant.two : variant.three, removed, copies === 2 ? 20 : 30));
    } finally { run.close(); }
  });
  test(`wrong-shaped, dangling and retired join registers are ignored: recovery=${removed}`, () => {
    const run = seed(2, removed);
    try {
      for (const value of [undefined, null, true, false, 0, "x", "  ", "\n", [], [""], {}, { value: "" }, new Y.Text(" ")]) {
        set(run.a, value); set(run.a, "", "dangling"); run.queue.flush("dup");
        agree("invalid/dangling register", "dup", [run.a, run.b], read, expected("ab cd", removed));
      }
      transactSharedDocument(run.a, "local-command", () => collabState(run.a).roots.retiredJoins.set("jA", true));
      set(run.a, ""); run.queue.flush("rev");
      agree("retired join ignored", "rev", [run.a, run.b], handle => readProjectionBeatStructure(beat(handle), "R2", collabState(handle).roots.retiredJoins, collabState(handle).roots.meta), { id: "R2", joins: [], removed: false });
      agree("retired projection", "rev", [run.a, run.b], read);
      const result = read(run.a);
      assert.deepEqual(result.document.rows.map(row => ({ id: row.id, text: row.audioText })), removed ? [{ id: "R2", text: "cd" }] : [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]);
      assert.deepEqual(result.recovery.map(entry => entry.kind === "removed-beat" ? { kind: entry.kind, text: entry.row.audioText, members: entry.members } : entry),
        removed ? [{ kind: "removed-beat", text: "ab", members: ["R1"] }] : []);
    } finally { run.close(); }
  });
}

for (const removed of [false, true]) test(`R1/R2/R3 glue register counterexample: changing selected or unselected glue never changes join selection: recovery=${removed}`, () => {
  const run = replicas(3, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "b" }, { id: "R3", audioText: "c" }] });
  try {
    transactSharedDocument(run.a, "local-command", () => {
      const joins = beat(run.a).get("joins"); assert.ok(joins instanceof Y.Map);
      joins.set("jA", { into: "R1", glue: " " }); joins.set("jB", { into: "R3", glue: " " });
      if (removed) { const removals = beat(run.a, "R1").get("removals"); assert.ok(removals instanceof Y.Map); removals.set("removal", true); }
    }); run.queue.flush("D1");
    const rows = (handle: SharedDocumentHandle) => {
      const result = read(handle);
      return { rows: result.document.rows.map(row => ({ id: row.id, text: row.audioText })),
        recovery: result.recovery.map(entry => entry.kind === "removed-beat" ? { id: entry.row.id, text: entry.row.audioText, members: entry.members } : entry) };
    };
    set(run.b, "", "jB"); run.queue.flush("rev");
    agree("unselected join glue", "rev", [run.a, run.b, run.c], rows, removed
      ? { rows: [{ id: "R3", text: "c" }], recovery: [{ id: "R1", text: "a b", members: ["R1", "R2"] }] }
      : { rows: [{ id: "R1", text: "a b" }, { id: "R3", text: "c" }], recovery: [] });
    set(run.c, "", "jA"); run.queue.flush("dup");
    agree("selected join glue", "dup", [run.a, run.b, run.c], rows, removed
      ? { rows: [{ id: "R3", text: "c" }], recovery: [{ id: "R1", text: "ab", members: ["R1", "R2"] }] }
      : { rows: [{ id: "R1", text: "ab" }, { id: "R3", text: "c" }], recovery: [] });
    agree("issued joins retained", "dup", [run.a, run.b, run.c], handle => [...beat(handle).get("joins") as Y.Map<unknown>].sort(),
      [["jA", { into: "R1", glue: " " }], ["jB", { into: "R3", glue: " " }]]);
    for (const handle of [run.a, run.b, run.c]) assert.deepEqual([...collabState(handle).roots.retiredJoins], []);
  } finally { run.close(); }
});

test("seeded join glue register checkpoints agree with literal values, the scalar winner and encoded reloads", t => {
  const declaredLimits: readonly string[] = [], violations = new Set<string>(), covered = new Set<number>();
  const variants = [{ value: "", text: "abcd" }, { value: " ", text: "ab cd" }, { value: "x", text: "ab cd" },
    { value: null, text: "ab cd" }, { value: { value: "" }, text: "ab cd" }, { value: [""], text: "ab cd" }];
  let random = 0x28c5, histories = 0, commands = 0, checkpoints = 0;
  const pick = (limit: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 16) % limit; };
  for (let sample = 0; sample < 12; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const removed of [false, true]) {
    const run = seed(copies, removed), handles = [run.a, run.b, run.c].slice(0, copies);
    try {
      let text = "ab cd";
      for (let round = 0; round < 3; round++) {
        const writers = round ? [handles[pick(copies)] as SharedDocumentHandle] : handles;
        writers.forEach((handle, index) => {
          const choice = pick(variants.length), variant = variants[choice]; assert.ok(variant); covered.add(choice);
          set(handle, variant.value); scalar(handle, round ? 99 : [10, 20, 30][index] as number); text = variant.text; commands++;
        }); run.queue.flush(order);
        try { agree("glue checkpoint " + sample + "/" + round, order, handles, read, expected(text, removed, round ? 99 : copies === 2 ? 20 : 30)); }
        catch { violations.add("join glue differs from the literal register model or an encoded replica"); }
        checkpoints++;
      } histories++;
    } finally { run.close(); }
  }
  assert.deepEqual([...violations], declaredLimits); assert.equal(covered.size, 6);
  assert.deepEqual({ histories, commands, checkpoints }, { histories: 144, commands: 648, checkpoints: 432 });
  t.diagnostic(JSON.stringify({ seed: 0x28c5, histories, commands, checkpoints, covered: [...covered].sort(), declaredLimits, violations: [...violations] }));
});

for (const removed of [false, true]) test(`different source groups have separate glue registers even when damaged maps reuse a join id: recovery=${removed}`, () => {
  const run = replicas(3, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "b" }, { id: "R3", audioText: "c" }] });
  try {
    transactSharedDocument(run.a, "local-command", () => {
      for (const id of ["R2", "R3"]) { const joins = beat(run.a, id).get("joins"); assert.ok(joins instanceof Y.Map); joins.set("jA", { into: "R1", glue: " " }); }
      if (removed) { const removals = beat(run.a, "R1").get("removals"); assert.ok(removals instanceof Y.Map); removals.set("removal", true); }
    }); run.queue.flush("D1");
    set(run.b, ""); run.queue.flush("dup");
    agree("global glue cell", "dup", [run.a, run.b, run.c], handle => {
      const result = read(handle);
      return { rows: result.document.rows.map(row => ({ id: row.id, text: row.audioText })),
        recovery: result.recovery.map(entry => entry.kind === "removed-beat" ? { id: entry.row.id, text: entry.row.audioText, members: entry.members } : entry) };
    }, removed ? { rows: [], recovery: [{ id: "R1", text: "ab c", members: ["R1", "R2", "R3"] }] } : { rows: [{ id: "R1", text: "ab c" }], recovery: [] });
  } finally { run.close(); }
});

for (const removed of [false, true]) test(`a valid glue register cannot make an invalid issued join projectable: recovery=${removed}`, () => {
  const run = seed(2, removed);
  try {
    set(run.a, "");
    for (const value of [null, [], { into: "R1", glue: "x" }, { into: "", glue: " " }, { glue: " " }, { into: "R1" }]) {
      transactSharedDocument(run.a, "local-command", () => { const joins = beat(run.a).get("joins"); assert.ok(joins instanceof Y.Map); joins.set("jA", value); });
      run.queue.flush("dup");
      agree("invalid issued join", "dup", [run.a, run.b], handle => readProjectionBeatStructure(beat(handle), "R2", collabState(handle).roots.retiredJoins, collabState(handle).roots.meta), { id: "R2", joins: [], removed: false });
      agree("invalid join cannot join rows", "dup", [run.a, run.b], handle => read(handle).document.rows.map(row => ({ id: row.id, text: row.audioText })),
        removed ? [{ id: "R2", text: "cd" }] : [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]);
    }
  } finally { run.close(); }
});
