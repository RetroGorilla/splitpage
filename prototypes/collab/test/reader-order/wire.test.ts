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
import { projectionDifference } from "../strict-comparison.ts";
import { readerJoinGroups } from "../../src/readers/joins.ts";
import { IncrementalProjection } from "../../src/perf/incremental.ts";
import { legacyStructureReader } from "./legacy-structure.ts";
import { serializeProjection } from "../../src/proj/reference.ts";

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
    , { kind: "repeated-head", make: () => ({ b: "R1" }) }, { kind: "missing-metadata-head", make: () => ({ b: "missing" }) }
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
  , ["segments", "head"], ["segments", "text"], ["order", "items"]
] as const;

function readAll(replica: SchemaReplica, observing: IndexedStructureProjection): unknown {
  const model: CollabModel = { rows: [{ id: "R1", characters: [], status: "todo" }], recovery: [], carets: {} };
  projectComments(model, replica.doc); projectStatus(model, replica.doc);
  const document = toDocument(replica.doc, replica.candidate);
  const incremental = new IncrementalProjection(replica);
  const blocks = incremental.index.spans.map(span => span.block);
  try { assert.equal(projectionDifference(incremental.document, document, "fresh incremental document"), null); } finally { incremental.destroy(); }
  const perf = perfStructureView(replica, document), fresh = new IndexedStructureProjection(replica);
  try {
    assert.equal(projectionDifference(observing.view(document), fresh.view(document), "observing status index"), null);
    assert.equal(projectionDifference(fresh.view(document), perf, "fresh status index"), null);
    return { structure: readStructure(replica.doc, replica.candidate, replica.identities),
      earlier: readReplica(replica.doc, replica.candidate, replica.identities), document, perf, indexed: fresh.view(document),
      marks: model, command: statusValue(replica, "R1"), blocks };
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
    const resetSegment = (): void => {
      const record = new Y.Map<unknown>(); source.doc.getMap("segments").set("seg-b-R2", record);
      record.set("head", { b: "R2" }); const text = new Y.Text(); record.set("text", text); text.insert(0, "b");
    };
    const check = (label: string): void => {
      const before = readAll(source, observer), encoded = Y.encodeStateAsUpdate(source.doc), late = createProjectionReplica(candidate, 201);
      assert.equal(projectionDifference(cached.document, toDocument(source.doc, candidate), `${label}: persistent incremental projection`), null);
      assert.equal(projectionDifference(cached.index.spans.map(span => span.block), (before as { blocks: unknown }).blocks, `${label}: persistent block index`), null);
      assert.equal(serializeProjection(cached.document), serializeProjection(toDocument(source.doc, candidate)), `${label}: serialized cache`);
      try {
        Y.applyUpdate(late.doc, encoded);
        const index = new IndexedStructureProjection(late);
        try { assert.equal(projectionDifference(readAll(late, index), before, label), null); } finally { index.destroy(); }
        checkpoints++;
      } finally { late.destroy(); }
    };
    try {
      const targets = candidate === "A" ? fields.filter(([root]) => root !== "segments" && root !== "order") : fields;
      const exhaustive = targets.length * pool.length;
      for (let step = 0; step < exhaustive + 96; step++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const entry = targets[step < exhaustive ? Math.floor(step / pool.length) : (random >>> 8) % targets.length];
        const factory = pool[step < exhaustive ? step % pool.length : (random >>> 16) % pool.length]; assert.ok(entry && factory);
        const [root, field] = entry;
        if (root === "order") {
          const order = source.doc.getArray<unknown>("order"), original = order.toArray(); order.delete(0, order.length);
          const raw = factory.make();
          try { order.push(Array.isArray(raw) ? raw : [raw]); } catch (error) {
            if (!["undefined", "null", "array", "sparse", "bigint", "null-prototype", "uint16", "array-buffer", "symbol", "function"].includes(factory.kind)) throw error;
            refused[factory.kind] = (refused[factory.kind] ?? 0) + 1;
          }
          check(`seed ${seed}, order, ${factory.kind}, written`); order.delete(0, order.length); check(`seed ${seed}, order, ${factory.kind}, deleted`); order.push(original); continue;
        }
        const id = root === "beats" ? "R1" : root === "segments" ? "seg-b-R2" : root === "meta" ? undefined : "probe";
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
          if (root === "segments") { record.set("head", { b: "R2" }); const text = new Y.Text(); record.set("text", text); text.insert(0, "b"); }
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
        if (root === "segments") resetSegment();
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

const identityMaps = ["comments", "replies", "tags", "people", "shots", "beats", "segments", "visuals", "gallery", "gallery-links", "shot-props", "removalRecords", "joins", "retiredJoins", "statusEvents", "retiredStatus", "headings"] as const;

function identityCollection(replica: SchemaReplica, root: typeof identityMaps[number]): Y.Map<unknown> {
  if (root === "joins") return (replica.doc.getMap<Y.Map<unknown>>("beats").get("R1") as Y.Map<unknown>).get("joins") as Y.Map<unknown>;
  if (root === "gallery-links") return (replica.doc.getMap<Y.Map<unknown>>("gallery").get("R1:slot:0") as Y.Map<unknown>).get("links") as Y.Map<unknown>;
  if (root === "shot-props") {
    let shot = replica.doc.getMap<Y.Map<unknown>>("shots").get("S1");
    if (!shot) {
      shot = new Y.Map(); replica.doc.getMap("shots").set("S1", shot);
      for (const [key, value] of Object.entries({ id: "S1", rank: "0", name: "Shot", keys: ["id", "name", "props"] })) shot.set(key, value);
      shot.set("props", new Y.Map());
    }
    return shot.get("props") as Y.Map<unknown>;
  }
  return replica.doc.getMap(root);
}

function putIdentity(replica: SchemaReplica, root: typeof identityMaps[number], id: string): void {
  const beat = replica.doc.getMap<Y.Map<unknown>>("beats").get("R1"); assert.ok(beat);
  if (root === "statusEvents" || root === "retiredStatus") {
    replica.doc.getMap("statusEvents").set(root === "statusEvents" ? id : "\ufffd", { target: "R1", value: "ready", parents: [], by: "Alice" });
    if (root === "retiredStatus") replica.doc.getMap(root).set(id, true);
    return;
  }
  if (root === "joins" || root === "retiredJoins") {
    (beat.get("joins") as Y.Map<unknown>).set(root === "joins" ? id : "\ufffd", { into: "R2", glue: " " });
    if (root === "retiredJoins") replica.doc.getMap(root).set(id, true);
    return;
  }
  const record = new Y.Map<unknown>(); identityCollection(replica, root).set(id, record);
  for (const [key, value] of Object.entries({ id, rank: "0", keys: ["id", "name"], name: `Identity ${id.charCodeAt(0)}`, extra: "{}" })) record.set(key, value);
  if (root === "beats") {
    record.set("status", "shot"); record.set("joins", new Y.Map()); record.set("removals", new Y.Map());
    if (replica.candidate === "A") { const flow = replica.doc.getText("flow"); flow.delete(0, 1); flow.insertEmbed(0, { b: id }); }
    else (replica.doc.getMap("segments").get("seg-b-R1") as Y.Map<unknown>).set("head", { b: id });
  }
  if (root === "segments") {
    record.set("head", { b: "R1" }); const text = new Y.Text(); record.set("text", text); text.insert(0, "a");
    replica.doc.getMap("segments").delete("seg-b-R1");
    const order = replica.doc.getArray<string>("order"); order.delete(0, order.length); order.push([id, "seg-b-R2"]);
  }
  if (root === "visuals") { record.set("beat", "R1"); const text = new Y.Text(); record.set("text", text); text.insert(0, "V"); }
  if (root === "gallery") for (const [key, value] of Object.entries({ beat: "R1", ref: "P", name: "Photo", annotation: "", links: [] })) record.set(key, value);
  if (root === "gallery-links") { record.set("href", id); record.set("keys", ["href", "name"]); }
  if (root === "shot-props") record.set("value", { id, name: `Prop ${id.charCodeAt(0)}` });
  if (root === "headings") {
    record.set("keys", ["name", "firstSceneId", "id"]);
    if (replica.candidate === "A") {
      const flow = replica.doc.getText("flow"), first: unknown = flow.toDelta()[0]?.insert;
      const exists = Boolean(first && typeof first === "object" && "h" in first);
      if (exists) flow.delete(0, 1);
      flow.insertEmbed(0, { h: id }); if (!exists) flow.insert(1, "Scene");
    } else {
      const segment = new Y.Map<unknown>(); replica.doc.getMap("segments").set("head-probe", segment);
      segment.set("head", { h: id }); const text = new Y.Text(); segment.set("text", text); text.insert(0, "Scene");
      const order = replica.doc.getArray<string>("order"); if (!order.toArray().includes("head-probe")) order.insert(0, ["head-probe"]);
    }
  }
  if (root === "comments") {
    record.set("author", "Alice"); record.set("rowId", "R1"); record.set("field", "audioText"); replica.format("R1", 0, 1, { [`c:${id}`]: true });
  }
  if (root === "replies") for (const [key, value] of Object.entries({ commentId: "C1", author: "Alice", createdAt: 0, text: "Reply" })) record.set(key, value);
  if (root === "tags") replica.format("R1", 0, 1, { "t:probe": id });
  if (root === "removalRecords") {
    for (const [key, value] of Object.entries({ kind: "beat", beat: "R1", by: "Alice", observed: [] })) record.set(key, value);
    (beat.get("removals") as Y.Map<unknown>).set(id, true);
  }
}

for (const candidate of ["A", "B"] as const) test(`${candidate}: every identity map uses wire-normalized keys, including key collisions`, t => {
  let checkpoints = 0;
  for (const root of identityMaps) for (const keys of [["\ud800"], ["\udfff"], ["pre\ud800x"], ["\ufffd"], ["\ud834\udf06"], ["é"], ["é"], ["\ud800", "\ud801", "\ufffd"], ["\ufffd", "\ud801", "\ud800"]]) {
    if (candidate === "A" && root === "segments") continue;
    const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "a", visualText: "", status: "todo" }, { id: "R2", audioText: "b", visualText: "", status: "todo" }] }, candidate, 200);
    const observer = new IndexedStructureProjection(source), cached = new IncrementalProjection(source);
    try {
      for (const id of keys) putIdentity(source, root, id);
      const check = (phase: string): void => {
        const label = `${candidate}/${root}/${JSON.stringify(keys)}/${phase}`, expected = readAll(source, observer), late = createProjectionReplica(candidate, 201);
        assert.equal(projectionDifference(cached.document, toDocument(source.doc, candidate), `${label}/observing`), null);
        try {
          Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(source.doc)); const other = new IndexedStructureProjection(late);
          try { assert.equal(projectionDifference(readAll(late, other), expected, label), null); } finally { other.destroy(); }
        } finally { late.destroy(); }
        checkpoints++;
      };
      check("written");
      const map = identityCollection(source, root);
      const id = keys[0]; assert.ok(id); map.delete(id); check("deleted"); putIdentity(source, root, id); check("recreated");
    } finally { cached.destroy(); observer.destroy(); source.destroy(); }
  }
  t.diagnostic(JSON.stringify({ candidate, identityMapCheckpoints: checkpoints }));
});

for (const candidate of ["A", "B"] as const) test(`${candidate}: later fields from a second writer have stable projected order for the covered record kinds`, t => {
  let checkpoints = 0;
  for (const root of identityMaps) {
    if (candidate === "A" && root === "segments") continue;
    const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "a", visualText: "", status: "todo" }, { id: "R2", audioText: "b", visualText: "", status: "todo" }] }, candidate, 200);
    const remote = createProjectionReplica(candidate, 201), cached = new IncrementalProjection(source), observer = new IndexedStructureProjection(source);
    try {
      putIdentity(source, root, "probe"); Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(source.doc));
      const collection = identityCollection(remote, root), key = "probe";
      const raw = collection.get(key);
      if (raw instanceof Y.Map) { raw.set("updatedAt", 1); raw.set("zFuture", { z: 1, a: 2 }); raw.set("aFuture", 1); }
      else {
        const record = raw && typeof raw === "object" ? Object.fromEntries(Object.entries(raw)) : { flag: raw };
        record.updatedAt = 1; record.zFuture = { z: 1, a: 2 }; record.aFuture = 1; collection.set(key, record);
      }
      Y.applyUpdate(source.doc, Y.encodeStateAsUpdate(remote.doc), "delivery");
      const before = readAll(source, observer), late = createProjectionReplica(candidate, 202);
      try {
        Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(source.doc)); const other = new IndexedStructureProjection(late);
        try { assert.equal(projectionDifference(readAll(late, other), before, `${candidate}/${root}/later fields`), null); } finally { other.destroy(); }
        assert.equal(projectionDifference(cached.document, toDocument(source.doc, candidate), `${candidate}/${root}/later cache`), null);
        checkpoints++;
      } finally { late.destroy(); }
    } finally { observer.destroy(); cached.destroy(); source.destroy(); remote.destroy(); }
  }
  t.diagnostic(JSON.stringify({ candidate, laterFieldCheckpoints: checkpoints }));
});
