import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { statusValue, changeStatus, undoStatus } from "../../src/marks/commands.ts";
import { fromDocument, createProjectionReplica } from "../../src/proj/document.ts";
import { structureManager } from "../../src/structure.ts";
import { observeStatusOrder, statusOrderEvidence } from "../../src/perf/lifetime/status-order.ts";
import type { SchemaReplica } from "../../src/schema.ts";
import { statusReaders, legacyStatusValue } from "./status-readers.ts";
import { resolveBeatStatus } from "../../src/marks/status-resolution.ts";
import type { BeatStatusEvent } from "../../src/marks/status-resolution.ts";

const cases = [
  { name: "different roots", values: ["ready", "shot"], expected: ["todo", "todo", "todo"] },
  { name: "identical roots", values: ["shot", "shot"], expected: ["shot", "todo", "todo"] }
] as const;

function check(replica: SchemaReplica, expected: string): void {
  for (const [reader, value] of Object.entries(statusReaders(replica))) assert.equal(value, expected, reader);
}

test("four-event common-root history passes all 96 delivery/client/recreation cases with literal todo", () => {
  const evidence = statusOrderEvidence(replica => { check(replica, "todo"); return statusValue(replica, "R1"); });
  assert.equal(evidence.total, 96);
  assert.equal(evidence.disagreements, 0);
  for (const row of evidence.rows) for (const observation of row.observations) assert.equal(observation.status, "todo");
});

for (const candidate of ["A", "B"] as const) for (const fixture of cases) {
  for (const clients of [[1, 2], [2, 1]] as const) for (const order of [[0, 1], [1, 0]] as const) for (const duplicate of [false, true]) {
    test(`${candidate}: ${fixture.name}, ${clients}, ${order}, duplicate ${duplicate}: either undo and late join through every reader`, () => {
      const seed = fromDocument({ title: "", rows: [{ id: "R1", audioText: "", visualText: "", status: "todo" }] }, candidate, 100);
      const writers = clients.map(client => createProjectionReplica(candidate, client));
      const readers = [createProjectionReplica(candidate, 10), createProjectionReplica(candidate, 11)];
      const managers = writers.map(writer => structureManager(writer));
      const first = readers[0]; assert.ok(first);
      try {
        const initial = Y.encodeStateAsUpdate(seed.doc);
        for (const replica of [...writers, ...readers]) Y.applyUpdate(replica.doc, initial);
        const updates = writers.map((writer, index) => {
          const manager = managers[index]; assert.ok(manager);
          changeStatus(writer, manager, "R1", `s${index}`, fixture.values[index] ?? "", `writer${index}`);
          return Y.encodeStateAsUpdate(writer.doc, Y.encodeStateVector(seed.doc));
        });
        if (order[0] === 1) updates.reverse();
        for (const [phase, expected] of fixture.expected.entries()) {
          if (phase) {
            const writer = writers[order[phase - 1] ?? 0], manager = managers[order[phase - 1] ?? 0]; assert.ok(writer && manager);
            undoStatus(writer, manager);
            updates.push(Y.encodeStateAsUpdate(writer.doc));
          }
          for (const [index, reader] of readers.entries()) {
            for (const update of index ? [...updates].reverse() : updates) {
              Y.applyUpdate(reader.doc, update); if (duplicate) Y.applyUpdate(reader.doc, update);
            }
            check(reader, expected);
          }
          for (const writer of writers) Y.applyUpdate(writer.doc, Y.encodeStateAsUpdate(first.doc));
          const late = createProjectionReplica(candidate, 12);
          try { Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(first.doc)); check(late, expected); }
          finally { late.destroy(); }
        }
      } finally { for (const manager of managers) manager.destroy(); for (const replica of [...writers, ...readers, seed]) replica.destroy(); }
    });
  }
}

test("legacy map-iteration resolution is rejected by the literal matrix checker", () => {
  const value = observeStatusOrder(["a", "c", "b", "d"], false, [1, 2], legacyStatusValue);
  assert.throws(() => { for (const observation of value.observations) assert.equal(observation.status, "todo"); });
  assert.deepEqual(value.observations.map(row => row.status), ["ready", "shot", "shot"]);
});

for (const fixture of [
  { retired: ["c"], expected: "ready" },
  { retired: ["d"], expected: "shot" },
  { retired: ["c", "d"], expected: "todo" },
  { retired: ["a", "c", "b", "d"], expected: "todo" }
]) test(`four-event retirement ${fixture.retired}: all 96 orders and all readers`, () => {
  const matrix = statusOrderEvidence();
  for (const row of matrix.rows) observeStatusOrder(row.delivery, row.recreate, row.clients as [number, number],
    replica => { check(replica, fixture.expected); return statusValue(replica, "R1"); }, fixture.retired);
});

const deeper = [
  { name: "shared ready ancestor", events: [["p", "ready", []], ["a", "shot", ["p"]], ["b", "todo", ["p"]]], retired: [], expected: "ready" },
  { name: "common conflicting ancestors resolve recursively", events: [["p", "ready", []], ["q", "shot", []], ["a", "shot", ["p", "q"]], ["b", "ready", ["q", "p"]]], retired: [], expected: "todo" },
  { name: "common identical ancestors resolve recursively", events: [["p", "ready", []], ["q", "ready", []], ["a", "shot", ["p", "q"]], ["b", "todo", ["q", "p"]]], retired: [], expected: "ready" },
  { name: "retired shared ancestor", events: [["p", "ready", []], ["a", "shot", ["p"]], ["b", "todo", ["p"]]], retired: ["p"], expected: "todo" },
  { name: "later change applies", events: [["p", "ready", []], ["q", "shot", []], ["a", "ready", ["p", "q"]]], retired: [], expected: "ready" },
  { name: "undo later change restores common conflict", events: [["p", "ready", []], ["q", "shot", []], ["a", "ready", ["p", "q"]]], retired: ["a"], expected: "todo" }
] as const;

for (const fixture of deeper) test(`${fixture.name}: event spelling, priors, parent order and insertion order cannot choose the value`, () => {
  for (const reverse of [false, true]) for (const rename of [false, true]) {
    const key = (id: string): string => rename ? String.fromCharCode(300 - id.charCodeAt(0)) : id;
    const entries = fixture.events.map(([id, value, parents]) => [key(id), { by: "writer", target: "R1", value, prior: "deliberately wrong", parents: [...parents].reverse().map(key) }] as const);
    const events = new Map(reverse ? entries.reverse() : entries);
    assert.equal(resolveBeatStatus(events, new Set(fixture.retired.map(key)), "todo"), fixture.expected);
  }
});

const branchMatrices: { name: string; shared: Record<string, BeatStatusEvent>; events: Record<string, BeatStatusEvent>; retired: string[]; expected: string }[] = [
  { name: "identical frontier", shared: {}, retired: [], expected: "shot", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] }, c: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["a"] },
    b: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] }, d: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["b"] }
  } },
  { name: "identical frontier undone by either writer", shared: {}, retired: ["c", "d"], expected: "ready", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] }, c: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["a"] },
    b: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] }, d: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["b"] }
  } },
  { name: "shared ancestor", shared: { p: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] } }, retired: [], expected: "ready", events: {
    a: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["p"] }, c: { by: "writer", target: "R1", value: "todo", prior: "shot", parents: ["a"] },
    b: { by: "writer", target: "R1", value: "todo", prior: "ready", parents: ["p"] }, d: { by: "writer", target: "R1", value: "shot", prior: "todo", parents: ["b"] }
  } },
  { name: "recursive conflicting common ancestors", shared: {
    p: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] }, q: { by: "writer", target: "R1", value: "shot", prior: "todo", parents: [] }
  }, retired: [], expected: "todo", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["p", "q"] }, c: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["a"] },
    b: { by: "writer", target: "R1", value: "shot", prior: "todo", parents: ["q", "p"] }, d: { by: "writer", target: "R1", value: "ready", prior: "shot", parents: ["b"] }
  } }
];

for (const fixture of branchMatrices) test(`${fixture.name}: literal status across the full 96-case matrix and all readers`, () => {
  for (const row of statusOrderEvidence().rows) observeStatusOrder(row.delivery, row.recreate, row.clients as [number, number],
    replica => { check(replica, fixture.expected); return statusValue(replica, "R1"); }, fixture.retired, fixture.events, fixture.shared);
});

const identicalBranchEvents = branchMatrices[0]?.events; assert.ok(identicalBranchEvents);
for (const fixture of [
  { name: "different branches", events: undefined, expected: "todo" },
  { name: "identical branches", events: identicalBranchEvents, expected: "ready" }
]) for (const undo of [[0], [1], [0, 1], [1, 0]]) test(`semantic undo ${undo} of ${fixture.name}: 96 permutations, reverse/duplicate retirements and late join`, () => {
  for (const row of statusOrderEvidence().rows) observeStatusOrder(row.delivery, row.recreate, row.clients as [number, number],
    replica => { check(replica, fixture.expected); return statusValue(replica, "R1"); }, [], fixture.events, {}, undo);
});
