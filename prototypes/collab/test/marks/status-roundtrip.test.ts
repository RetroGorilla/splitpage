import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { fromDocument, createProjectionReplica } from "../../src/proj/document.ts";
import { readStatusEvent } from "../../src/marks/status-resolution.ts";
import { changeStatus, undoStatus } from "../../src/marks/commands.ts";
import { writePerfStatus } from "../../src/perf/operations.ts";
import { structureManager } from "../../src/structure.ts";
import { IndexedStructureProjection } from "../../src/perf/lifetime/projector.ts";
import { projectedStatusData, statusReaderResults, statusReaders } from "./status-readers.ts";

const baseEvent = () => ({ target: "R1", value: "ready", parents: [], by: "Alice" });
const statuses = ["todo", "ready", "shot"];

function writer() {
  return fromDocument({ title: "", rows: [{ id: "R1", audioText: "", visualText: "", status: "todo" }] }, "B", 100);
}

for (const fixture of [
  { name: "sparse parents", make: () => ({ ...baseEvent(), parents: new Array<unknown>(1) }), expected: "todo" },
  ...["bogus", "", "READY", "done"].map(value => ({ name: `invalid value ${JSON.stringify(value)}`, make: () => ({ ...baseEvent(), value }), expected: "todo" })),
  { name: "non-coercible author", make: () => ({ ...baseEvent(), by: { toString: null, valueOf: null } }), expected: "shot" }
]) test(`literal raw-status regression: ${fixture.name}`, () => {
  const source = writer(), indexed = new IndexedStructureProjection(source), late = createProjectionReplica("B", 101);
  try {
    if (fixture.name === "non-coercible author") source.doc.getMap("statusEvents").set("b", { target: "R1", value: "shot", parents: [], by: "Bob" });
    source.doc.getMap("statusEvents").set("a", fixture.make());
    const encoded = Y.encodeStateAsUpdate(source.doc); Y.applyUpdate(late.doc, encoded);
    assert.deepEqual(Y.encodeStateAsUpdate(late.doc), encoded);
    assert.equal(readStatusEvent(source.doc.getMap("statusEvents").get("a")), null);
    assert.deepEqual(projectedStatusData(statusReaderResults(source)), projectedStatusData(statusReaderResults(late)));
    for (const replica of [source, late]) for (const actual of Object.values(statusReaders(replica))) assert.equal(actual, fixture.expected);
    assert.equal(indexed.view({ rows: [{ id: "R1" }] }).groups[0]?.status, fixture.expected);
  } finally { indexed.destroy(); late.destroy(); source.destroy(); }
});

type RawFactory = { kind: string; make: () => unknown };

function factories(): RawFactory[] {
  const values: RawFactory[] = [
    { kind: "undefined", make: () => undefined }, { kind: "null", make: () => null },
    { kind: "number", make: () => 42 }, { kind: "NaN", make: () => Number.NaN }, { kind: "Infinity", make: () => Infinity },
    { kind: "boolean", make: () => false }, { kind: "bigint", make: () => 42n }, { kind: "string", make: () => "ready" },
    { kind: "symbol", make: () => Symbol("fixture") }, { kind: "function", make: () => () => "fixture" },
    { kind: "long-string", make: () => "x".repeat(65536) }, { kind: "lone-surrogate", make: () => "\ud800" },
    { kind: "object", make: () => ({ nested: { array: [null, undefined, { value: 3 }] } }) },
    { kind: "array", make: () => [null, undefined, { nested: [1, 2] }] }, { kind: "sparse-array", make: () => new Array<unknown>(3) },
    { kind: "uint8", make: () => new Uint8Array([1, 2]) }, { kind: "uint16", make: () => new Uint16Array([1, 2]) },
    { kind: "float64", make: () => new Float64Array([1.5]) }, { kind: "array-buffer", make: () => new ArrayBuffer(2) },
    { kind: "null-prototype", make: () => Object.create(null) as object },
    { kind: "odd-prototype", make: () => Object.assign(Object.create({ inherited: true }) as object, baseEvent()) },
    { kind: "inherited-event", make: () => Object.create(baseEvent()) as object },
    { kind: "null-prototype-event", make: () => Object.assign(Object.create(null) as object, baseEvent()) },
    { kind: "constructor-object-event", make: () => Object.assign(Object.create(null) as object, { constructor: Object }, baseEvent()) },
    { kind: "null-constructor", make: () => ({ ...baseEvent(), constructor: null }) },
    { kind: "null-coercion", make: () => ({ toString: null, valueOf: null }) },
    { kind: "array-event", make: () => Object.assign([] as unknown[], baseEvent()) },
    { kind: "binary-event", make: () => Object.assign(new Uint8Array(1), baseEvent()) },
    { kind: "boxed-event", make: () => Object.assign(Object(7) as object, baseEvent()) },
    { kind: "date-event", make: () => Object.assign(new Date(0), baseEvent()) },
    { kind: "shared-map", make: () => new Y.Map() }, { kind: "shared-doc", make: () => new Y.Doc() },
    { kind: "valid", make: baseEvent }, { kind: "valid-shot", make: () => ({ ...baseEvent(), value: "shot", parents: ["b"] }) },
    { kind: "valid-lone-author", make: () => ({ ...baseEvent(), by: "\ud800" }) },
    { kind: "sparse-parents", make: () => ({ ...baseEvent(), parents: new Array<unknown>(2) }) },
    { kind: "non-coercible-author", make: () => ({ ...baseEvent(), by: { toString: null, valueOf: null } }) },
    { kind: "getter-author", make: () => Object.defineProperty(baseEvent(), "by", { get: () => "Getter", enumerable: true }) },
    { kind: "hidden-author", make: () => Object.defineProperty(baseEvent(), "by", { value: "Hidden", enumerable: false }) },
    ...["bogus", "", "READY", "done"].map(value => ({ kind: `invalid-status/${value}`, make: () => ({ ...baseEvent(), value }) }))
  ];
  const fields = ["target", "value", "parents", "by"];
  const fieldValues = values.filter(value => ["undefined", "null", "number", "NaN", "Infinity", "boolean", "bigint", "string", "long-string", "lone-surrogate", "object", "array", "sparse-array", "uint8", "uint16", "null-prototype", "null-coercion", "symbol", "function"].includes(value.kind));
  for (const field of fields) for (const value of fieldValues) values.push({ kind: `${field}/${value.kind}`, make: () => ({ ...baseEvent(), [field]: value.make() }) });
  return values;
}

for (const seed of [1376, 1413, 0x5eed0001, 0x5eed0002]) test(`seed ${seed}: arbitrary shared status values survive encoded reload through every reader`, t => {
  const source = writer(), indexed = new IndexedStructureProjection(source), pool = factories(), refused: Record<string, number> = {};
  let random = seed, accepted = 0;
  const check = (phase: string): void => {
    const original = statusReaderResults(source);
    for (const value of Object.values(statusReaders(source))) assert.ok(value !== undefined && statuses.includes(value), `${phase}: invalid projected status`);
    assert.equal(indexed.view({ rows: [{ id: "R1" }] }).groups[0]?.status, original.command, `${phase}: observing index`);
    const late = createProjectionReplica("B", 101);
    try {
      const state = Y.encodeStateAsUpdate(source.doc); Y.applyUpdate(late.doc, state);
      assert.deepEqual(Y.encodeStateAsUpdate(late.doc), state);
      assert.deepEqual(projectedStatusData(statusReaderResults(late)), projectedStatusData(original), `${phase}: writer/reload full reader results`);
    } finally { late.destroy(); }
  };
  try {
    source.doc.getMap("statusEvents").set("b", { target: "R1", value: "shot", parents: [], by: "Bob" });
    for (let step = 0; step < pool.length + 96; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const entry = pool[step < pool.length ? step : random % pool.length]; assert.ok(entry);
      const retired = pool[(random >>> 8) % pool.length]; assert.ok(retired);
      for (const phase of ["write", "recreate"]) {
        source.doc.getMap("statusEvents").delete("a"); source.doc.getMap("retiredStatus").clear();
        if (entry.kind === "non-coercible-author" || random & 4) source.doc.getMap("statusEvents").set("b", { target: "R1", value: "shot", parents: [], by: "Bob" });
        else source.doc.getMap("statusEvents").delete("b");
        if (entry.kind.startsWith("invalid-status/") || entry.kind === "sparse-parents") source.doc.getMap("statusEvents").delete("b");
        let raw: unknown, storing = `statusEvents/${entry.kind}`;
        try {
          raw = entry.make(); source.doc.getMap("statusEvents").set("a", raw);
          if (random & 1 && !entry.kind.startsWith("invalid-status/") && entry.kind !== "sparse-parents") {
            storing = `retiredStatus/${retired.kind}`; source.doc.getMap("retiredStatus").set("a", retired.make());
          }
        }
        catch {
          refused[storing] = (refused[storing] ?? 0) + 1;
          check(`seed ${seed}, step ${step}, refused ${storing}`); continue;
        }
        const normalized = readStatusEvent(raw);
        if (normalized) {
          assert.ok(statuses.includes(normalized.value)); assert.equal(typeof normalized.by, "string"); assert.equal(typeof normalized.target, "string");
          assert.deepEqual(Object.keys(normalized).sort(), ["by", "parents", "target", "value"]);
          for (let index = 0; index < normalized.parents.length; index++) assert.equal(typeof normalized.parents[index], "string");
        }
        check(`seed ${seed}, step ${step}, ${phase}, ${entry.kind}, retired ${retired.kind}`); accepted++;
        source.doc.getMap("statusEvents").delete("a"); check(`seed ${seed}, step ${step}, deleted`);
      }
    }
    assert.ok(accepted > 100);
    t.diagnostic(JSON.stringify({ seed, accepted, refused }));
  } finally { indexed.destroy(); source.destroy(); }
});

test("status commands and undo only emit accepted events and true retirement flags", () => {
  const source = writer(), manager = structureManager(source);
  try {
    changeStatus(source, manager, "R1", "a", "ready", "Alice");
    for (const value of source.doc.getMap("statusEvents").values()) assert.ok(readStatusEvent(value));
    undoStatus(source, manager);
    for (const value of source.doc.getMap("statusEvents").values()) assert.ok(readStatusEvent(value));
    assert.deepEqual([...source.doc.getMap("retiredStatus").values()], [true]);
    for (const value of ["bogus", "", "READY", "done"]) {
      const before = Y.encodeStateAsUpdate(source.doc);
      assert.throws(() => changeStatus(source, manager, "R1", "bad", value, "Alice"), /Invalid status command/);
      assert.throws(() => writePerfStatus(source, "R1", "bad", value), /Invalid performance status command/);
      assert.deepEqual(Y.encodeStateAsUpdate(source.doc), before);
    }
    writePerfStatus(source, "R1", "b", "shot"); assert.ok(readStatusEvent(source.doc.getMap("statusEvents").get("b")));
  } finally { manager.destroy(); source.destroy(); }
});
