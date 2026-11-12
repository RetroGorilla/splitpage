import { test } from "node:test";
import assert from "node:assert/strict";
import * as readers from "../../../src/core/collab/read-operation.ts";
import { replaceObservedText } from "../../../src/core/collab/operations.ts";
import { operationExamples } from "./operation-examples.ts";

const validators = [readers.readTextInsert, readers.readTextDelete, readers.readMarkChange, readers.readSegmentCreate,
  readers.readBeatSplit, readers.readBeatJoin, readers.readJoinGlue, readers.readSoftRemove, readers.readRestore,
  readers.readSegmentMove, readers.readHeadingCreate, readers.readHeadingFinalize, readers.readHeadingRemove,
  readers.readRecordCreate, readers.readRecordSet, readers.readRecordDelete, readers.readScalarSet, readers.readSharedStatusEvent, readers.readBeatSplitBefore,
  readers.readTextRestore, readers.readMarkRetract, readers.readStatusRetire];

for (const { fixture, operation } of operationExamples) {
  test(`${fixture}: accepts literal ${operation.kind} intent without positional indices`, () => {
    assert.deepEqual(readers.readOperation(operation), operation);
    assert.equal(validators.filter(read => read(operation) !== null).length, 1);
    for (const key of Object.keys(operation)) {
      const missing = Object.fromEntries(Object.entries(operation).filter(([field]) => field !== key));
      assert.equal(readers.readOperation(missing), null, key);
    }
  });
}

test("T01 composition: replacement inserts at the painted gap before deleting observed bc", () => {
  const inserted = readers.readTextInsert(operationExamples[0].operation);
  const deleted = readers.readTextDelete(operationExamples[1].operation);
  assert.ok(inserted && deleted);
  assert.deepEqual(replaceObservedText(deleted, inserted), [
    { kind: "text-insert", id: "insert-A", by: "Alice", target: { segment: "seg-R1", owner: "R1", field: "audioText" },
      at: { left: "s1", right: "s2", affinity: "after" }, content: [{ value: "β", marks: [] }] },
    { kind: "text-delete", id: "delete-A", by: "Alice", target: { segment: "seg-R1", owner: "R1", field: "audioText" }, observed: ["s2", "s3"] }
  ]);
});

test("T11, T20 and T21: one mark kind and one identity key, including explicit clearing", () => {
  const base = operationExamples[2].operation;
  const marks = [{ kind: "i", value: null }, { kind: "u", value: true }, { kind: "s", value: true }, { kind: "hl", value: true },
    { kind: "dir", value: true }, { kind: "cue", value: true }, { kind: "comment", id: "C1", value: true },
    { kind: "tag", id: "occ-P", value: "P" }, { kind: "link", id: "L1", value: "https://v/1" },
    { kind: "comment", id: "C1", value: null }, { kind: "tag", id: "occ-P", value: null }, { kind: "link", id: "L1", value: null }];
  for (const mark of marks) assert.deepEqual(readers.readOperation({ ...base, mark }), { ...base, mark });
  for (const mark of [{ kind: "tag", value: "P" }, { kind: "comment", id: "C1", value: false }, { kind: "unknown", value: true }]) {
    assert.equal(readers.readOperation({ ...base, mark }), null);
  }
});

test("nested addresses, gaps, chunks and identity ranges reject missing or malformed evidence", () => {
  const insert = operationExamples[0].operation;
  for (const key of ["segment", "owner", "field"]) {
    const target = Object.fromEntries(Object.entries(insert.target).filter(([field]) => field !== key));
    assert.equal(readers.readOperation({ ...insert, target }), null);
  }
  for (const key of ["left", "right", "affinity"]) {
    const at = Object.fromEntries(Object.entries(insert.at).filter(([field]) => field !== key));
    assert.equal(readers.readOperation({ ...insert, at }), null);
  }
  for (const at of [{ left: 0, right: "s2", affinity: "after" }, { left: "s1", right: "s2", affinity: "left" }]) {
    assert.equal(readers.readOperation({ ...insert, at }), null);
  }
  for (const observed of [new Array(1), [null], [""], [1]]) assert.equal(readers.readTextDelete({ ...operationExamples[1].operation, observed }), null);
  assert.equal(readers.readOperation({ ...insert, content: [{ marks: [] }] }), null);
  assert.equal(readers.readRecordSet({ ...operationExamples[14].operation, target: { collection: "unknown", record: "C1" } }), null);
});

test("T06 / PROJ content atoms, title and visuals preserve explicit attributes", () => {
  const base = operationExamples[0].operation;
  const sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const content = [{ value: { atom: "broll", id: "bs1" }, marks: [] }, { value: { atom: "who", name: "Alice" }, marks: [] },
    { value: { atom: "image", ref: { sha256, width: 1, height: 2, mime: "image/png" } }, marks: [] },
    { value: { atom: "video", href: "https://v/1", host: "v" }, marks: [] }];
  assert.deepEqual(readers.readTextInsert({ ...base, content })?.content, content);
  assert.deepEqual(readers.readTextInsert({ ...base, content: [{ value: { atom: "image", ref: { sha256 } }, marks: [] }] })?.content,
    [{ value: { atom: "image", ref: { sha256 } }, marks: [] }]);
  for (const field of ["title", "heading", "visualText"]) assert.equal(readers.readTextInsert({ ...base, target: { ...base.target, field } })?.target.field, field);
  assert.equal(readers.readTextInsert({ ...base, content: [{ value: "X" }] }), null);
  assert.equal(readers.readTextInsert({ ...base, content: [{ value: "X", marks: [{ kind: "b", value: true }, { kind: "b", value: null }] }] }), null);
  assert.equal(readers.readTextInsert({ ...base, content: [{ value: { atom: "image", ref: {} }, marks: [] }] }), null);
});

test("T11 / PROJ registries: all seven collections retain record data and unknown fields", () => {
  const base = operationExamples[13].operation;
  for (const collection of ["comments", "replies", "people", "tags", "shots", "gallery", "visuals"]) {
    const input = { ...base, target: { collection, record: "r1" }, fields: { extra: { kept: [1, null, true] }, name: "Mug", rank: "0" } };
    assert.deepEqual(readers.readRecordCreate(input), input);
  }
});

test("undeclared ids cannot disguise duplicate attributes for any unkeyed mark kind", () => {
  for (const kind of ["b", "i", "u", "s", "hl", "dir", "cue"]) {
    assert.equal(readers.readTextInsert({ ...operationExamples[0].operation, content: [{ value: "X", marks: [{ kind, value: true, id: "a" }] }] }), null);
    const content = [{ value: "X", marks: [{ kind, value: true, id: "a" }, { kind, value: null, id: "b" }] }];
    assert.equal(readers.readTextInsert({ ...operationExamples[0].operation, content }), null);
  }
  for (const kind of ["comment", "tag", "link"]) {
    const value = kind === "comment" ? true : "P";
    const content = [{ value: "X", marks: [{ kind, value, id: "\uD800" }, { kind, value: null, id: "�" }] }];
    assert.equal(readers.readTextInsert({ ...operationExamples[0].operation, content }), null);
  }
});

test("seeded undeclared JSON fields always invalidate typed operation objects", context => {
  const variants: unknown[] = operationExamples.map(example => example.operation);
  for (const mark of [{ kind: "b", value: true }, { kind: "comment", id: "C1", value: true }, { kind: "tag", id: "T1", value: "P" },
    { kind: "link", id: "L1", value: "https://v/1" }]) variants.push({ ...operationExamples[0].operation, content: [{ value: "X", marks: [mark] }] });
  for (const value of [{ atom: "broll", id: "bs1" }, { atom: "who", name: "Alice" }, { atom: "video", href: "https://v/1", host: "v" },
    { atom: "image", ref: { sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" } }]) {
    variants.push({ ...operationExamples[0].operation, content: [{ value, marks: [] }] });
  }
  variants.push({ kind: "scalar", id: "a", by: "A", target: { scope: "beat", record: "R1" }, field: "notes", clear: true });
  const locations = (value: unknown, path: (string | number)[] = []): (string | number)[][] => {
    if (Array.isArray(value)) return value.flatMap((item: unknown, index: number) => locations(item, [...path, index]));
    if (!value || typeof value !== "object") return [];
    return [path, ...Object.entries(value).flatMap(([key, item]) => key === "fields" || key === "prior" ||
      key === "value" && !(item && typeof item === "object" && "atom" in item) ? [] : locations(item, [...path, key]))];
  };
  let attempts = 0;
  for (const seed of [1376, 1413, 1592590337, 1592590338]) {
    let state = seed;
    for (const variant of variants) {
      assert.ok(readers.readOperation(variant));
      for (const path of locations(variant)) {
        for (let count = 0; count < 16; count++) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          const input = structuredClone(variant) as Record<string, unknown>;
          let target: unknown = input;
          for (const key of path) target = (target as Record<string | number, unknown>)[key];
          const extras = [null, state, "\uD800", { id: "b", kind: "b", clear: true }, [false, "x"], { "\uD800": 1, "�": 2 }];
          Object.defineProperty(target, `undeclared-${state}`, { value: extras[state % extras.length], enumerable: true });
          for (const read of [...validators, readers.readOperation]) {
            assert.equal(read(input), null, `${seed}: ${read.name} at ${path.join(".")}`);
            attempts++;
          }
        }
      }
    }
  }
  context.diagnostic(`${attempts} seeded undeclared-field rejections across 23 readers`);
});

test("field clearing remains distinct from null; heading removal can retain or discard the name", () => {
  for (const kind of ["record-set", "scalar"] as const) {
    const target = kind === "scalar" ? { scope: "beat", record: "R1" } : { collection: "people", record: "p1" };
    const clear = { kind, id: "a", by: "Alice", target, field: "notes", clear: true };
    const set = { kind, id: "a", by: "Alice", target, field: "notes", value: null };
    assert.deepEqual(readers.readOperation(clear), clear);
    assert.deepEqual(readers.readOperation(set), set);
    assert.equal(readers.readOperation({ ...clear, value: null }), null);
  }
  assert.deepEqual(readers.readHeadingRemove({ ...operationExamples[12].operation, newBeat: null })?.newBeat, null);
});

test("T21 status wire validation: sparse parents, unknown statuses and invalid authors are absent", () => {
  const base = operationExamples[17].operation;
  for (const parents of [new Array(1), [undefined], [null], [1], {}]) assert.equal(readers.readSharedStatusEvent({ ...base, parents }), null);
  for (const value of ["bogus", "", "READY", "done", "needed"]) assert.equal(readers.readSharedStatusEvent({ ...base, value }), null);
  assert.equal(readers.readSharedStatusEvent({ ...base, by: { toString: null, valueOf: null } }), null);
  assert.deepEqual(readers.readSharedStatusEvent({ ...base, prior: "todo" })?.prior, "todo");
  for (const [scope, values] of [["beat", ["todo", "ready", "shot"]], ["tag", ["needed", "sourcing", "have", "returned"]], ["shot", ["unshot", "shot"]]] as const) {
    for (const value of values) assert.equal(readers.readSharedStatusEvent({ ...base, target: { scope, record: "r1" }, value })?.value, value);
  }
});

test("T21 wire strings: ids, author names, parent keys and field keys use stored Unicode", () => {
  assert.equal(readers.readSharedContentRef("\uD800"), "�");
  assert.equal(readers.readSharedContentRef("😀"), "😀");
  assert.deepEqual(readers.readOperation({ kind: "status", id: "\uD800", by: "A\uDC00", target: { scope: "beat", record: "R\uD800" },
    value: "ready", parents: ["p\uD800"] }), { kind: "status", id: "�", by: "A�", target: { scope: "beat", record: "R�" }, value: "ready", parents: ["p�"] });
  assert.deepEqual(readers.readOperation({ kind: "record-create", id: "a", by: "A", target: { collection: "people", record: "p" }, fields: { "\uD800": "N\uD800" } }),
    { kind: "record-create", id: "a", by: "A", target: { collection: "people", record: "p" }, fields: { "�": "N�" } });
  assert.equal(readers.readOperation({ ...operationExamples[13].operation, fields: { "\uD800": 1, "�": 2 } }), null);
  const keyed = readers.readRecordCreate({ ...operationExamples[13].operation, fields: { "\uD800": 1, "\uE000": 2 } });
  assert.ok(keyed);
  assert.deepEqual(Object.keys(keyed.fields), ["\uE000", "�"]);
});

function arbitraryPool(): unknown[] {
  const inherited = Object.create(operationExamples[17].operation) as unknown;
  const hidden = Object.defineProperty({}, "kind", { value: "status" });
  const throwing = Object.defineProperty({}, "kind", { enumerable: true, get() { throw new Error("getter"); } });
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  return [null, undefined, false, true, 0, -1, NaN, Infinity, -Infinity, 1n, Symbol("s"), () => 1, "", "\uD800", "😀", "é", "é",
    "x".repeat(65536), [], new Array(2), [undefined], {}, { kind: "unknown" }, inherited, hidden, throwing, cyclic, revoked.proxy,
    new Date(0), new Uint8Array([1]), Object.create(null), { toJSON: () => operationExamples[17].operation },
    ...operationExamples.map(example => example.operation)];
}

test("seeded arbitrary values: every validator is total and agrees after a JSON round trip", context => {
  const pool = arbitraryPool();
  const checks = [...validators, readers.readOperation];
  let attempts = 0;
  for (const seed of [1376, 1413, 1592590337, 1592590338]) {
    let state = seed;
    const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    const samples: unknown[] = [...pool];
    for (let count = 0; count < 400; count++) {
      const example = operationExamples[next() % operationExamples.length]?.operation;
      assert.ok(example);
      const keys = Object.keys(example);
      const key = keys[next() % keys.length];
      assert.ok(key);
      samples.push({ ...example, [key]: pool[next() % pool.length] });
    }
    for (const raw of samples) {
      for (const read of checks) {
        const result = read(raw);
        assert.ok(result === null || typeof result.kind === "string");
        if (result) assert.deepEqual(read(result), result);
        let encoded: string | undefined;
        try { encoded = JSON.stringify(raw); } catch { continue; }
        if (encoded !== undefined) assert.deepEqual(read(JSON.parse(encoded)), result, `${seed}: ${read.name}`);
        attempts++;
      }
    }
  }
  assert.ok(attempts > 30000);
  context.diagnostic(`${attempts} JSON round-trip comparisons across 23 readers and four seeds`);
});
