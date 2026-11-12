import assert from "node:assert/strict";
import { test } from "node:test";
import { replicas, operation, ref } from "./executor-support.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { readPureMergedProjection, literalMergedDocument } from "./projection-merged-support.ts";
import { splitReplicas, splitRow, splitOriginal, splitCommand, splitInputFields, splitIdentities, submitProjectionOperations } from "./projection-split-support.ts";
import { agree } from "./executor-support.ts";
import { mergedProjectionSave } from "./projection-merged-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const structurePorts = { cells: createFlowLoadRuntime().cells };

for (const before of [false, true]) test(`executed ${before ? "prefix" : "ordinary"} split has literal rows`, () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    registerSharedSplitHandlers(run.a, structurePorts);
    assert.deepEqual(executeSharedOperations(run.a, [operation({ kind: before ? "split-before" : "split", id: "cut", by: "Writer", target: { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, observed: [], boundary: "B", beat: "new", fields: { status: "todo" } })], { base: readSharedRevision(run.a) }), { ok: true });
    const id = '["structure","1","cut","beat"]';
    const original = literalMergedDocument(before ? "cd" : "ab").rows[0]; assert.ok(original);
    const added = { id, status: "todo", visualText: "", audioText: before ? "ab" : "cd", imageRef: null };
    assert.deepEqual(readPureMergedProjection(run.a).view, { document: { ...literalMergedDocument(""), rows: before ? [added, original] : [original, added] }, recovery: [] });
  } finally { run.close(); }
});

test("seeded split, prefix and blank entry lists preserve literal marked text, fields and status on every copy", t => {
  let seed = 0x14556, checkpoints = 0, commands = 0;
  const kinds = new Set<string>(), authoringOrders = new Set<string>(), declaredLimits: readonly string[] = [];
  const bold = (text: string) => text ? "<strong>" + text + "</strong>" : "";
  for (let sample = 0; sample < 24; sample++) for (const kind of ["split", "prefix", "blank"] as const) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const candidates = concurrentSplits.filter(item => item.before === (kind === "prefix") && item.offsets.length === copies);
    const scenario = candidates[(seed >>> 16) % candidates.length]; assert.ok(scenario);
    const run = splitReplicas(copies, { rows: [{ id: "R1", audioText: "abcd" }] });
    try {
      const writers = seed & 1 ? [...run.handles.keys()].reverse() : [...run.handles.keys()];
      for (const writer of writers) {
        const handle = run.handles[writer], fields = splitInputFields[writer], offset = scenario.offsets[writer]; assert.ok(handle && fields && offset !== undefined);
        const create = kind === "blank" ? { kind: "segment-create", id: "cut", by: "Writer", beat: "new", segment: "segment",
          at: { left: null, right: "R1", affinity: "before" }, fields: { ...fields, audioText: "", visualText: "", imageRef: null } } : splitCommand(offset, kind === "prefix", fields);
        const list = [{ kind: "mark", id: "marked" + writer, by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" },
          observed: [flowBaseReference("R1", "audioText", 0, 4)], mark: { kind: "b", value: true } }, create,
        { kind: "text-insert", id: "typed", by: "Writer", target: { owner: "new", segment: "new", field: "audioText" },
          at: { left: null, right: flowBaseReference("new", "audioText", 0), affinity: "before" }, content: [{ value: "xyz".charAt(writer), marks: kind === "blank" ? [] : [{ kind: "b", value: true }] }] },
        { kind: "scalar", id: "flag" + writer, by: "Writer", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true },
        { kind: "status", id: "status" + writer, by: "Writer", target: { scope: "beat", record: "R1" }, value: "ready", parents: [] }];
        submitProjectionOperations(handle, list); list.forEach(command => kinds.add(command.kind)); commands += list.length;
      }
      run.queue.flush(order);
      const baseRows = kind === "blank" ? [...Array.from({ length: copies }, (_, index) => splitRow(index, "")), splitOriginal("abcd")] : scenario.rows;
      const rows = baseRows.map(row => {
        if (row.id === "R1") return { ...row, status: "ready", audioText: bold(String(row.audioText)), paragraphStart: true as const };
        const writer = splitIdentities.findIndex(id => id === row.id); assert.ok(writer >= 0);
        const typed = kind === "prefix" && scenario.offsets[0] !== 0 ? writer === 0 ? "xyz".slice(0, copies) : "" : "xyz".charAt(writer);
        return { ...row, audioText: kind === "blank" ? typed : bold(typed + String(row.audioText)) };
      });
      const document = { ...literalMergedDocument(""), rows };
      for (const handle of run.handles) {
        const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
      }
      agree("seeded entry split " + sample + kind, order, run.handles, readPureMergedProjection); checkpoints++;
    } finally { run.close(); }
  }
  for (let sample = 0; sample < 24; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const scenario of mixedSplits) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const reverse = !!((seed >>> 16) & 1); authoringOrders.add(scenario.name + ":" + reverse);
    const history = runMixedSplit(scenario, copies, order, reverse); history.forEach(command => kinds.add(command.kind)); commands += history.length; checkpoints++;
  }
  assert.deepEqual([...kinds].sort(), ["mark", "scalar", "segment-create", "split", "split-before", "status", "text-delete", "text-insert"]);
  assert.equal(authoringOrders.size, 20); assert.equal(checkpoints, 1872); assert.equal(commands, 9000); assert.deepEqual(declaredLimits, []);
  t.diagnostic(JSON.stringify({ seeds: 24, commands, checkpoints, declaredLimits }));
});

const concurrentSplits = [
  { before: false, offsets: [2, 2], rows: [splitOriginal("ab"), splitRow(0, ""), splitRow(1, "cd")] },
  { before: false, offsets: [1, 3], rows: [splitOriginal("a"), splitRow(0, "bc"), splitRow(1, "d")] },
  { before: false, offsets: [2, 2, 2], rows: [splitOriginal("ab"), splitRow(0, ""), splitRow(1, ""), splitRow(2, "cd")] },
  { before: false, offsets: [1, 2, 3], rows: [splitOriginal("a"), splitRow(0, "b"), splitRow(1, "c"), splitRow(2, "d")] },
  { before: true, offsets: [2, 2], rows: [splitRow(0, "ab"), splitRow(1, ""), splitOriginal("cd")] },
  { before: true, offsets: [1, 3], rows: [splitRow(0, "a"), splitRow(1, "bc"), splitOriginal("d")] },
  { before: true, offsets: [2, 2, 2], rows: [splitRow(0, "ab"), splitRow(1, ""), splitRow(2, ""), splitOriginal("cd")] },
  { before: true, offsets: [1, 2, 3], rows: [splitRow(0, "a"), splitRow(1, "b"), splitRow(2, "c"), splitOriginal("d")] },
  { before: false, offsets: [4, 4], rows: [splitOriginal("abcd"), splitRow(0, ""), splitRow(1, "")] },
  { before: true, offsets: [0, 0], rows: [splitRow(0, ""), splitRow(1, ""), splitOriginal("abcd")] }
];
function mixedRow(writer: number, audioText: string) { const id = splitIdentities[writer]; assert.ok(id); return { id, status: "todo", visualText: "", audioText, imageRef: null }; }
const typed = (offset: number) => ({ kind: "text-insert", id: "peer", by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" },
  at: { left: null, right: flowBaseReference("R1", "audioText", offset), affinity: "before" }, content: [{ value: "X", marks: [] }] });
const deleted = { kind: "text-delete", id: "peer", by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" }, observed: [flowBaseReference("R1", "audioText", 1, 3)] };
const blank = { kind: "segment-create", id: "cut", by: "Writer", beat: "new", segment: "segment", at: { left: null, right: "R1", affinity: "before" }, fields: { status: "todo" } };
const mixedSplits = [
  { name: "prefix then ordinary at different positions", commands: [splitCommand(1, true), splitCommand(3)], rows: [mixedRow(0, "a"), splitOriginal("bc"), mixedRow(1, "d")] },
  { name: "prefix then ordinary at one position", commands: [splitCommand(2, true), splitCommand(2)], rows: [mixedRow(0, "ab"), splitOriginal(""), mixedRow(1, "cd")] },
  { name: "ordinary then prefix at different positions", commands: [splitCommand(1), splitCommand(3, true)], rows: [mixedRow(1, "a"), mixedRow(0, "bc"), splitOriginal("d")] },
  { name: "ordinary with typing at the position", commands: [splitCommand(2), typed(2)], rows: [splitOriginal("ab"), mixedRow(0, "Xcd")] },
  { name: "prefix with typing at the position", commands: [splitCommand(2, true), typed(2)], rows: [mixedRow(0, "ab"), splitOriginal("Xcd")] },
  { name: "ordinary with typing in the source", commands: [splitCommand(2), typed(1)], rows: [splitOriginal("aXb"), mixedRow(0, "cd")] },
  { name: "ordinary with deletion across the position", commands: [splitCommand(2), deleted], rows: [splitOriginal("a"), mixedRow(0, "d")] },
  { name: "prefix with deletion across the position", commands: [splitCommand(2, true), deleted], rows: [mixedRow(0, "a"), splitOriginal("d")] },
  { name: "blank creation with ordinary split", commands: [blank, splitCommand(2)], rows: [mixedRow(0, ""), splitOriginal("ab"), mixedRow(1, "cd")] },
  { name: "blank creation with prefix split", commands: [blank, splitCommand(2, true)], rows: [mixedRow(0, ""), mixedRow(1, "ab"), splitOriginal("cd")] }
];
function runMixedSplit(scenario: typeof mixedSplits[number], copies: number, order: "D1" | "rev" | "dup", reverse = false) {
  const run = splitReplicas(copies, { rows: [{ id: "R1", audioText: "abcd" }] });
  const history = [...scenario.commands, ...(copies === 3 ? [{ kind: "scalar", id: "peer-field", by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 }] : [])];
  try {
    for (const writer of reverse ? [...run.handles.keys()].reverse() : [...run.handles.keys()]) {
      const handle = run.handles[writer], command = history[writer]; assert.ok(handle && command); submitProjectionOperations(handle, [command]);
    }
    run.queue.flush(order);
    const document = { ...literalMergedDocument(""), rows: scenario.rows.map(row => copies === 3 && row.id === "R1" ? { ...row, lengthSeconds: 7 } : row) };
    for (const handle of run.handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree(scenario.name, order, run.handles, readPureMergedProjection); return history;
  } finally { run.close(); }
}
for (const scenario of mixedSplits) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
  test(`mixed concurrent split shapes: ${scenario.name}, ${copies} ${order}`, () => { runMixedSplit(scenario, copies, order); });
for (const scenario of concurrentSplits) for (const order of ["D1", "rev", "dup"] as const)
  test(`executed concurrent splits: ${scenario.before ? "prefix" : "ordinary"}, ${scenario.offsets.join(",")}, ${order}`, () => {
    const run = splitReplicas(scenario.offsets.length, { rows: [{ id: "R1", audioText: "abcd" }] });
    try {
      scenario.offsets.forEach((offset, writer) => {
        const handle = run.handles[writer], fields = splitInputFields[writer]; assert.ok(handle && fields);
        submitProjectionOperations(handle, [splitCommand(offset, scenario.before, fields)]);
      });
      run.queue.flush(order);
      const document = { ...literalMergedDocument(""), rows: scenario.rows };
      for (const handle of run.handles) {
        const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
      }
      agree("executed concurrent split", order, run.handles, readPureMergedProjection);
    } finally { run.close(); }
  });

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`blank segment creation through the entry: ${copies} copies ${order}`, () => {
  const run = splitReplicas(copies, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    run.handles.forEach((handle, index) => submitProjectionOperations(handle, [{ kind: "segment-create", id: "cut", by: "Writer", beat: "new", segment: "segment",
      at: { left: null, right: "R1", affinity: "before" }, fields: { ...splitInputFields[index], audioText: "", visualText: "", imageRef: null } }]));
    run.queue.flush(order);
    const document = { ...literalMergedDocument(""), rows: copies === 2 ? [splitRow(0, ""), splitRow(1, ""), splitOriginal("abcd")]
      : [splitRow(0, ""), splitRow(1, ""), splitRow(2, ""), splitOriginal("abcd")] };
    for (const handle of run.handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree("executed blank creation", order, run.handles, readPureMergedProjection);
  } finally { run.close(); }
});
