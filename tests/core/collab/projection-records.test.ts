import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSharedBrollKeys } from "../../../src/core/collab/projection/broll.ts";
import { projectSharedGroupGallery } from "../../../src/core/collab/projection/gallery.ts";
import type { SharedProjectionUnit } from "../../../src/core/collab/projection/units.ts";
import { readSharedContentRef } from "../../../src/core/collab/read-operation.ts";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
test("duplicate b-roll native identities avoid real keys, shot ids and earlier derived ids without changing marks", () => {
  const marker = (id: string, clock: number): SharedProjectionUnit => {
    const reference = readSharedContentRef(id); assert.ok(reference);
    return { value: { atom: "broll", id: reference, text: "B-roll:" },
      marks: [{ kind: "b", value: true }, { kind: "comment", id: "C1", value: "C1" }], identity: { client: 7, clock } };
  };
  const cells = freeze([{ key: "visual", units: [marker("S1", 1), marker("S1", 9), marker("broll_00530031_7_9", 2), marker("S1", 9)] }]);
  const before = JSON.stringify(cells), result = projectSharedBrollKeys(cells, ["broll_00530031_7_9_"]);
  assert.deepEqual(result[0]?.units.map(unit => typeof unit.value === "string" ? unit.value : unit.value.atom === "broll" ? unit.value.id : ""),
    ["S1", "broll_00530031_7_9__", "broll_00530031_7_9", "broll_00530031_7_9___"]);
  assert.deepEqual(result[0]?.units.map(unit => unit.marks), cells[0]?.units.map(unit => unit.marks));
  assert.equal(JSON.stringify(cells), before);
});
test("gallery fold follows first nonempty metadata and link fill without mutating frozen records", () => {
  const imageRef = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
  const annotation = { imageRef: { ...imageRef, sha256: "b".repeat(64) }, marks: [{ kind: "text", color: "#ffffff", size: 0.1, x: 0, y: 0, text: "Note" }] };
  const root = freeze({ id: "R1", status: "todo", imageRef: null }), members = freeze([root, { id: "R2" }]);
  const records = freeze([
    { key: "z", fields: { beat: "R1", picture: { imageRef, name: "", annotation: { imageRef: annotation.imageRef, marks: [] } }, links: [{ fields: { href: "https://example.test/v", duration: 3 } }] } },
    { key: "a", fields: { beat: "R2", picture: { imageRef, name: "First name", annotation }, links: [{ fields: { href: "https://example.test/v", duration: 9, poster: true } }] } },
    { key: "b", fields: { beat: "R2", picture: { imageRef, name: "Later name" }, links: [{ fields: { href: "https://example.test/other" } }] } }
  ]);
  const before = JSON.stringify({ root, members, records });
  const expected = { row: { id: "R1", status: "todo", imageRef, imageName: "First name", imageAnnotation: annotation,
    imageLinks: [{ href: "https://example.test/v", duration: 3, poster: true }, { href: "https://example.test/other" }] }, overflow: [] };
  assert.deepEqual(projectSharedGroupGallery(root, members, records), expected);
  assert.deepEqual(projectSharedGroupGallery(root, members, records.toReversed()), expected);
  assert.equal(JSON.stringify({ root, members, records }), before);
});

test("b-roll collisions compare cleaned identities while derivation retains the raw identity", () => {
  const marker = (raw: string, clock: number): SharedProjectionUnit => {
    const id = readSharedContentRef(raw); assert.ok(id);
    return { value: { atom: "broll", id, text: "B-roll:" }, marks: [], identity: { client: 2, clock } };
  };
  const cells = freeze([{ key: "b", units: [marker("S1!", 9), marker("S1", 0), marker("S1!", 1)] }]);
  const result = projectSharedBrollKeys(cells, ["broll_00530031_2_0!"]);
  assert.deepEqual(result[0]?.units.map(unit => typeof unit.value !== "string" && unit.value.atom === "broll" ? unit.value.id : ""),
    ["S1", "broll_00530031_2_0_", "broll_005300310021_2_1"]);
  assert.deepEqual(projectSharedBrollKeys([{ key: "bad", units: [marker("!", 0), marker("!", 1)] }], [])[0]?.units.map(unit =>
    typeof unit.value !== "string" && unit.value.atom === "broll" ? unit.value.id : ""), ["broll_0021_2_0", "broll_0021_2_1"]);
  const markerOnly = projectSharedBrollKeys([{ key: "b", units: [marker("S1", 9), marker("S1", 0), marker("broll_00530031_2_0!", 1)] }], []);
  assert.deepEqual(markerOnly[0]?.units.map(unit => typeof unit.value !== "string" && unit.value.atom === "broll" ? unit.value.id : ""),
    ["S1", "broll_00530031_2_0_", "broll_00530031_2_0"]);
});
test("folded file links keep the first details and fill a missing location", () => {
  const imageRef = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" }, root = { id: "R1", imageRef: null };
  const location = { kind: "bundled", name: "clip.mp4" } as const;
  const records = [
    { key: "a", fields: { beat: "R1", picture: { imageRef }, links: [{ fields: { name: "clip.mp4", size: 7, duration: 3 } }] } },
    { key: "b", fields: { beat: "R2", picture: { imageRef }, links: [{ fields: { name: "clip.mp4", size: 7, duration: 9, location, poster: true } }] } }
  ];
  assert.deepEqual(projectSharedGroupGallery(root, [root, { id: "R2" }], records), { row: { id: "R1", imageRef,
    imageLinks: [{ name: "clip.mp4", size: 7, duration: 3, location, poster: true }] }, overflow: [] });
});
test("pure b-roll callers without stable atom identities are rejected before and after unrelated typing", () => {
  const id = readSharedContentRef("S1"); assert.ok(id);
  const unit: SharedProjectionUnit = freeze({ value: { atom: "broll", id, text: "B-roll:" }, marks: [] });
  assert.throws(() => projectSharedBrollKeys([{ key: "b", units: [unit] }], []), { message: "B-roll atom requires a stable identity" });
  for (const prefix of [[], [{ value: "unrelated typing", marks: [] }]]) {
    const cells = freeze([{ key: "a", units: [unit] }, { key: "b", units: [...prefix, unit] }]);
    const before = JSON.stringify(cells);
    assert.throws(() => projectSharedBrollKeys(cells, []), { message: "B-roll atom requires a stable identity" });
    assert.equal(JSON.stringify(cells), before);
  }
});

test("gallery folding visits each of 10000 incoming links once", () => {
  const root = { id: "R1", imageRef: null }, imageRef = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
  const records = Array.from({ length: 10000 }, (_, index) => ({ key: String(index).padStart(5, "0"), fields: { beat: "R1", picture: { imageRef },
    links: [{ fields: { href: "https://example.test/" + index } }] } }));
  const original = Map.prototype.get; let visits = 0;
  Map.prototype.get = function (key: unknown) { if (typeof key === "string" && key.startsWith("u:")) visits++; return original.call(this, key) as unknown; };
  try {
    const result = projectSharedGroupGallery(root, [root], records);
    assert.deepEqual(result, { row: { id: "R1", imageRef, imageLinks: Array.from({ length: 10000 }, (_, index) => ({ href: "https://example.test/" + index })) }, overflow: [] });
    assert.equal(visits, 10000);
  } finally { Map.prototype.get = original; }
});
for (const scenario of [
  { first: { client: 9, clock: 500 }, later: { client: 1, clock: 1 }, id: "broll_00530031_1_1" },
  { first: { client: 1, clock: 1 }, later: { client: 9, clock: 500 }, id: "broll_00530031_9_500" }
]) test(`b-roll document order wins over native identity order: first client ${scenario.first.client}`, () => {
  const id = readSharedContentRef("S1"); assert.ok(id);
  const value = { atom: "broll" as const, id, text: "B-roll:" }, cells = freeze([
    { key: "first", units: [{ value, marks: [], identity: scenario.first }] },
    { key: "later", units: [{ value, marks: [], identity: scenario.later }] }
  ]);
  assert.deepEqual(projectSharedBrollKeys(cells, []).map(cell => cell.units.map(unit => typeof unit.value !== "string" && unit.value.atom === "broll" ? unit.value.id : "")), [["S1"], [scenario.id]]);
});
