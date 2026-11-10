import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { fromDocument, createProjectionReplica, toDocument } from "../../src/proj/document.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { readReplica } from "../../src/reader.ts";
import { perfStructureView } from "../../src/perf/operations.ts";
import { IndexedStructureProjection } from "../../src/perf/lifetime/projector.ts";
import { projectComments, projectStatus } from "../../src/marks/projection.ts";
import { statusValue } from "../../src/marks/commands.ts";
import type { CollabModel } from "../../src/model.ts";
import type { SchemaReplica } from "../../src/schema.ts";
import { projectedStatusData } from "../marks/status-readers.ts";
import { readerJoinGroups } from "../../src/readers/joins.ts";
import { IncrementalProjection } from "../../src/perf/incremental.ts";
import { legacyStructureReader } from "./legacy-structure.ts";

type WireFactory = { kind: string; make: () => unknown };

function values(): WireFactory[] {
  return [
    { kind: "undefined", make: () => undefined }, { kind: "null", make: () => null },
    { kind: "number", make: () => 3 }, { kind: "NaN", make: () => NaN }, { kind: "Infinity", make: () => Infinity },
    { kind: "boolean", make: () => true }, { kind: "bigint", make: () => 42n },
    { kind: "string", make: () => "R1" }, { kind: "surrogate", make: () => "\ud800" }, { kind: "long", make: () => "x".repeat(65536) },
    { kind: "nested", make: () => ({ nested: [null, undefined, { a: [1, 2] }] }) },
    { kind: "array", make: () => [null, undefined, { x: 2 }] }, { kind: "sparse", make: () => new Array<unknown>(2) },
    { kind: "null-coercion", make: () => ({ toString: null, valueOf: null }) },
    { kind: "odd-prototype", make: () => Object.assign(Object.create({ inherited: 1 }) as object, { own: 2 }) },
    { kind: "null-prototype", make: () => Object.create(null) as object },
    { kind: "uint8", make: () => new Uint8Array([0, 1]) }, { kind: "uint16", make: () => new Uint16Array([0, 1]) },
    { kind: "array-buffer", make: () => new ArrayBuffer(2) }, { kind: "symbol", make: () => Symbol("fixture") },
    { kind: "function", make: () => () => 1 }, { kind: "shared-map", make: () => new Y.Map() },
    { kind: "shared-doc", make: () => new Y.Doc() },
    { kind: "shared-text", make: () => { const text = new Y.Text(); text.insert(0, "V"); return text; } },
    { kind: "surrogate-text", make: () => { const text = new Y.Text(); text.insert(0, "\ud800"); return text; } },
    { kind: "valid-join", make: () => ({ into: "R2", glue: " " }) },
    { kind: "valid-observed", make: () => [{ client: 200, clock: 0, len: 1 }] },
    { kind: "sparse-observed", make: () => { const result = new Array<unknown>(2); result[1] = { client: 200, clock: 0, len: 1 }; return result; } },
    { kind: "valid-reply", make: () => ({ commentId: "C1", author: "Alice", createdAt: 0, text: "reply" }) }
  ];
}

const fields = [
  ["removalRecords", "by"], ["removalRecords", "beat"], ["removalRecords", "observed"],
  ["visuals", "beat"], ["visuals", "rank"], ["visuals", "text"],
  ["replies", "commentId"], ["replies", "createdAt"], ["replies", "author"], ["replies", "text"],
  ["comments", "rowId"], ["comments", "author"], ["comments", "resolution"],
  ["gallery", "rank"], ["gallery", "links"], ["gallery", "picture"], ["gallery", "extra"],
  ["beats", "status"], ["beats", "splitBy"], ["beats", "joins"], ["beats", "removals"], ["beats", "stamp"],
  ["meta", "capture"], ["meta", "keys"], ["meta", "title"], ["join-record", "into"], ["join-record", "glue"]
] as const;

function readAll(replica: SchemaReplica, observing: IndexedStructureProjection): unknown {
  const model: CollabModel = { rows: [{ id: "R1", characters: [], status: "todo" }], recovery: [], carets: {} };
  projectComments(model, replica.doc); projectStatus(model, replica.doc);
  const document = toDocument(replica.doc, replica.candidate);
  const incremental = new IncrementalProjection(replica);
  try { assert.deepEqual(incremental.document, document); } finally { incremental.destroy(); }
  const perf = perfStructureView(replica, document), fresh = new IndexedStructureProjection(replica);
  try {
    assert.deepEqual(observing.view(document), fresh.view(document)); assert.deepEqual(fresh.view(document), perf);
    return projectedStatusData({ structure: readStructure(replica.doc, replica.candidate, replica.identities),
      earlier: readReplica(replica.doc, replica.candidate, replica.identities), document, perf, indexed: fresh.view(document),
      marks: model, command: statusValue(replica, "R1") });
  } finally { fresh.destroy(); }
}

for (const candidate of ["A", "B"] as const) for (const seed of [1376, 1413, 0x5eed0001, 0x5eed0002]) {
  test(`${candidate}: raw reader records seed ${seed} are total and equal after encoded reload`, t => {
    const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "a", visualText: "", status: "todo" }, { id: "R2", audioText: "b", visualText: "", status: "todo" }] }, candidate, 200);
    const observer = new IndexedStructureProjection(source), pool = values(), refused: Record<string, number> = {};
    const cached = new IncrementalProjection(source), reported: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { reported.push(args); });
    let random = seed, checkpoints = 0;
    const resetBeat = (): void => {
      const beat = new Y.Map<unknown>(); source.doc.getMap("beats").set("R1", beat);
      for (const [key, value] of Object.entries({ id: "R1", status: "todo", keys: ["id", "audioText", "visualText", "status"], extra: "{}", stamp: {} })) beat.set(key, value);
      beat.set("joins", new Y.Map()); beat.set("removals", new Y.Map());
    };
    const check = (label: string): void => {
      const before = readAll(source, observer), encoded = Y.encodeStateAsUpdate(source.doc), late = createProjectionReplica(candidate, 201);
      assert.deepEqual(cached.document, toDocument(source.doc, candidate), `${label}: persistent incremental projection`);
      try {
        Y.applyUpdate(late.doc, encoded);
        const index = new IndexedStructureProjection(late);
        try { assert.deepEqual(readAll(late, index), before, label); } finally { index.destroy(); }
        checkpoints++;
      } finally { late.destroy(); }
    };
    try {
      const exhaustive = fields.length * pool.length;
      for (let step = 0; step < exhaustive + 96; step++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const entry = fields[step < exhaustive ? Math.floor(step / pool.length) : (random >>> 8) % fields.length];
        const factory = pool[step < exhaustive ? step % pool.length : (random >>> 16) % pool.length]; assert.ok(entry && factory);
        const [root, field] = entry;
        const id = root === "beats" ? "R1" : root === "meta" ? undefined : "probe";
        const map = root === "join-record" ? source.doc.getMap<Y.Map<unknown>>("beats").get("R1")?.get("joins") as Y.Map<unknown> : source.doc.getMap(root);
        const old = id === undefined ? map.get(field) : map.get(id);
        const record = id === undefined ? map : new Y.Map<unknown>();
        if (id !== undefined) {
          map.set(id, record);
          if (root === "beats") { record.set("status", "todo"); record.set("joins", new Y.Map()); record.set("removals", new Y.Map()); }
          if (root === "removalRecords") {
            for (const [key, value] of Object.entries({ kind: "beat", beat: "R1", by: "Alice", observed: [] })) record.set(key, value);
            const beat = source.doc.getMap<Y.Map<unknown>>("beats").get("R1"); assert.ok(beat);
            (beat.get("removals") as Y.Map<unknown>).set("probe", true);
          }
          if (root === "visuals") { record.set("beat", "R1"); record.set("rank", "0"); const text = new Y.Text(); record.set("text", text); text.insert(0, "V"); }
          if (root === "replies") for (const [key, value] of Object.entries({ commentId: "C1", author: "Alice", createdAt: 0, text: "reply" })) record.set(key, value);
          if (root === "comments") for (const [key, value] of Object.entries({ author: "Alice", createdAt: 0, rowId: "R1", field: "audioText" })) record.set(key, value);
          if (root === "gallery") { record.set("beat", "R1"); record.set("rank", "0"); record.set("picture", {}); record.set("links", new Y.Map()); }
          if (root === "join-record") { record.set("into", "R2"); record.set("glue", " "); }
        }
        const label = `seed ${seed}, ${root}.${field}, ${factory.kind}, step ${step}`;
        try { record.set(field, factory.make()); } catch (error) {
          if (!["null-prototype", "uint16", "array-buffer", "symbol", "function"].includes(factory.kind)) throw error;
          refused[factory.kind] = (refused[factory.kind] ?? 0) + 1;
        }
        check(label);
        record.delete(field); check(`${label}, deleted`);
        if (id !== undefined) map.delete(id);
        else if (root === "meta" && field === "title") map.set(field, new Y.Text());
        else if (old !== undefined) map.set(field, old);
        if (root === "beats") resetBeat();
        if (root === "removalRecords") (source.doc.getMap<Y.Map<unknown>>("beats").get("R1")?.get("removals") as Y.Map<unknown>).delete("probe");
      }
      assert.ok(checkpoints >= 1000); assert.deepEqual(reported, []); t.diagnostic(JSON.stringify({ seed, candidate, checkpoints, refused }));
    } finally { cached.destroy(); observer.destroy(); source.destroy(); }
  });
}

test("malformed join graph literals: self-cycle, reachable cycle and absent target never select an id winner", () => {
  assert.deepEqual(readerJoinGroups(["R1", "R2"], new Map([["R1", { into: "R1", glue: " " }]]), new Set()), [{ root: "R1", members: ["R1"] }, { root: "R2", members: ["R2"] }]);
  assert.deepEqual(readerJoinGroups(["R3", "R2", "R1"], new Map([["R1", { into: "R2", glue: " " }], ["R2", { into: "R1", glue: " " }], ["R3", { into: "R2", glue: " " }]]), new Set()),
    [{ root: "R2", members: ["R2", "R3"] }, { root: "R1", members: ["R1"] }]);
  assert.deepEqual(readerJoinGroups(["R1"], new Map([["R1", { into: "missing", glue: " " }]]), new Set()), [{ root: "R1", members: ["R1"] }]);
});

for (const candidate of ["A", "B"] as const) test(`${candidate}: lone-surrogate visual text has the literal wire value on the writer and late joiner`, () => {
  const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "a", visualText: "", status: "todo" }] }, candidate, 200), late = createProjectionReplica(candidate, 201);
  try {
    const text = (source.doc.getMap("visuals").get("visual-R1") as Y.Map<unknown>).get("text") as Y.Text;
    text.insert(0, "\ud800");
    assert.equal(legacyStructureReader(source.doc, candidate, source.identities).rows[0]?.visualText, "\ud800");
    assert.equal(readStructure(source.doc, candidate, source.identities).rows[0]?.visualText, "\ufffd");
    assert.equal((toDocument(source.doc, candidate).rows as { visualText: string }[])[0]?.visualText, "\ufffd");
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(source.doc));
    assert.equal(readStructure(late.doc, candidate, late.identities).rows[0]?.visualText, "\ufffd");
    assert.equal((toDocument(late.doc, candidate).rows as { visualText: string }[])[0]?.visualText, "\ufffd");
    assert.equal(legacyStructureReader(late.doc, candidate, late.identities).rows[0]?.visualText, "\ufffd");
    assert.equal(text.toString(), "\ud800");
  } finally { source.destroy(); late.destroy(); }
});

for (const candidate of ["A", "B"] as const) test(`${candidate}: malformed content atoms preserve cache offsets and never throw on the next edit`, () => {
  for (const atom of [null, 42, { toString: null, valueOf: null }, [], { b: null }]) {
    const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "a", visualText: "", status: "todo" }] }, candidate, 200);
    const text = source.locate("R1").text, cached = new IncrementalProjection(source), index = new IndexedStructureProjection(source), late = createProjectionReplica(candidate, 201);
    try {
      const embed = atom as unknown as Parameters<Y.Text["insertEmbed"]>[1];
      if (atom === null) { assert.throws(() => text.insertEmbed(0, embed), TypeError); continue; }
      text.insertEmbed(0, embed); text.insert(text.length, "x");
      assert.deepEqual(cached.document, toDocument(source.doc, candidate));
      const expected = readAll(source, index); Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(source.doc));
      const other = new IndexedStructureProjection(late);
      try { assert.deepEqual(readAll(late, other), expected); } finally { other.destroy(); }
    } finally { cached.destroy(); index.destroy(); source.destroy(); late.destroy(); }
  }
});

test("invalid order entries, segment records and head boundaries are absent in both fresh and observing readers", () => {
  for (const change of ["order", "segment", "head"] as const) {
    const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "a", visualText: "", status: "todo" }] }, "B", 200), late = createProjectionReplica("B", 201);
    const cached = new IncrementalProjection(source), index = new IndexedStructureProjection(source);
    try {
      if (change === "order") source.doc.getArray<unknown>("order").push([null, 42, { toString: null }]);
      else if (change === "segment") source.doc.getMap("segments").set("seg-b-R1", 42);
      else (source.doc.getMap("segments").get("seg-b-R1") as Y.Map<unknown>).set("head", { b: { toString: null, valueOf: null } });
      assert.deepEqual(cached.document, toDocument(source.doc, "B"));
      const before = readAll(source, index); Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(source.doc));
      const other = new IndexedStructureProjection(late);
      try { assert.deepEqual(readAll(late, other), before); } finally { other.destroy(); }
    } finally { cached.destroy(); index.destroy(); source.destroy(); late.destroy(); }
  }
});

test("an empty-string status target is invalidated on retirement, replacement and deletion like every other string", () => {
  const source = fromDocument({ title: "", rows: [{ id: "", audioText: "", visualText: "", status: "todo" }] }, "B", 200), index = new IndexedStructureProjection(source);
  const document = { rows: [{ id: "" }] };
  const check = (expected: string): void => { assert.equal(index.view(document).groups[0]?.status, expected); assert.equal(statusValue(source, ""), expected); };
  try {
    source.doc.getMap("statusEvents").set("a", { target: "", value: "ready", parents: [], by: "Alice" }); check("ready");
    source.doc.getMap("retiredStatus").set("a", true); check("todo");
    source.doc.getMap("retiredStatus").delete("a"); check("ready");
    source.doc.getMap("statusEvents").set("a", { target: "R2", value: "shot", parents: [], by: "Alice" }); check("todo");
    source.doc.getMap("statusEvents").delete("a"); check("todo");
  } finally { index.destroy(); source.destroy(); }
});
