import assert from "node:assert/strict";
import { test } from "node:test";
import { observeStatusOrder, statusOrderEvidence } from "../../src/perf/lifetime/status-order.ts";
import { statusReaders } from "./status-readers.ts";
import { resolveBeatStatus } from "../../src/marks/status-resolution.ts";
import type { BeatStatusEvent } from "../../src/marks/status-resolution.ts";
import { fromDocument } from "../../src/proj/document.ts";
import { IndexedStructureProjection } from "../../src/perf/lifetime/projector.ts";

const filler = { by: "writer", target: "R2", value: "shot", prior: "todo", parents: [] };
const fixtures = [
  { name: "self-parent with retired frontier", retired: ["a", "b"], expected: "todo", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["a"] },
    b: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["a"] }, c: filler, d: filler } },
  { name: "two-node cycle", retired: ["a", "b"], expected: "todo", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["b"] },
    b: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["a"] }, c: filler, d: filler } },
  { name: "cycle reachable from active frontier", retired: [], expected: "todo", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["b"] },
    b: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["a"] },
    c: { by: "writer", target: "R1", value: "shot", prior: "ready", parents: ["a"] }, d: filler } },
  { name: "lone self-parent", retired: [], expected: "todo", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["a"] }, b: filler, c: filler, d: filler } },
  { name: "cycle disconnected from valid frontier", retired: [], expected: "todo", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["a"] }, b: filler,
    c: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] }, d: filler } },
  { name: "foreign-target parent is absent", retired: ["a"], expected: "todo", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["b"] }, b: filler, c: filler, d: filler } },
  { name: "cross-target cycle does not reject a valid local event", retired: [], expected: "ready", events: {
    a: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["b"] },
    b: { by: "writer", target: "R2", value: "shot", prior: "todo", parents: ["a"] }, c: filler, d: filler } }
] as const;

for (const fixture of fixtures) test(`${fixture.name}: literal stored status through every reader across 96 deliveries`, () => {
  for (const row of statusOrderEvidence().rows) observeStatusOrder(row.delivery, row.recreate, row.clients as [number, number], replica => {
    for (const [reader, actual] of Object.entries(statusReaders(replica))) assert.equal(actual, fixture.expected, reader);
    return statusReaders(replica).command ?? "";
  }, fixture.retired, fixture.events);
});

test("retired chains are evaluated without using the JavaScript call stack", () => {
  const events = new Map<string, BeatStatusEvent>();
  const retired = new Set<string>();
  for (let index = 0; index < 20000; index++) {
    const id = `e${index}`; events.set(id, { by: "writer", target: "R1", value: "shot", prior: "wrong", parents: index ? [`e${index - 1}`] : [] }); retired.add(id);
  }
  assert.equal(resolveBeatStatus(events, retired, "todo"), "todo");
});

test("malformed non-records and parent fields are ignored across all 96 deliveries and every reader", () => {
  const malformed = { a: null, b: true, c: { by: "writer", target: "R1", value: "ready", prior: "todo", parents: null },
    d: { by: "writer", target: "R1", value: "shot", prior: "todo", parents: [42] } };
  for (const row of statusOrderEvidence().rows) observeStatusOrder(row.delivery, row.recreate, row.clients as [number, number], replica => {
    for (const actual of Object.values(statusReaders(replica))) assert.equal(actual, "todo"); return statusReaders(replica).command ?? "";
  }, [], malformed);
});

test("an already-observing index ignores malformed replacements and recovers when a cycle is repaired", () => {
  const replica = fromDocument({ title: "", rows: [{ id: "R1", audioText: "", visualText: "", status: "todo" }] }, "B");
  const indexed = new IndexedStructureProjection(replica), document = { rows: [{ id: "R1" }] }, events = replica.doc.getMap("statusEvents");
  const check = (expected: string): void => {
    assert.equal(indexed.view(document).groups[0]?.status, expected);
    for (const actual of Object.values(statusReaders(replica))) assert.equal(actual, expected);
  };
  try {
    events.set("a", { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] }); check("ready");
    events.set("a", null); check("todo"); events.set("a", { parents: true }); check("todo");
    events.set("a", { by: "writer", target: "R1", value: "ready", prior: "todo", parents: ["a"] }); check("todo");
    events.set("a", { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] }); check("ready");
  } finally { indexed.destroy(); replica.destroy(); }
});

test("prior metadata never controls event validity or resolution across the 96-case matrix", () => {
  const events = {
    a: { by: "writer", target: "R1", value: "ready", parents: [], prior: undefined },
    b: { by: "writer", target: "R1", value: "ready", parents: [], prior: null },
    c: { by: "writer", target: "R1", value: "ready", parents: [], prior: 42 },
    d: { by: "writer", target: "R1", value: "ready", parents: [], prior: { ignored: true } }
  };
  for (const row of statusOrderEvidence().rows) observeStatusOrder(row.delivery, row.recreate, row.clients as [number, number], replica => {
    for (const actual of Object.values(statusReaders(replica))) assert.equal(actual, "ready"); return statusReaders(replica).command ?? "";
  }, [], events);
});
