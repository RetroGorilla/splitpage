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
test("pure duplicate-key callers without native items use their stable cell identity", () => {
  const id = readSharedContentRef("S1"); assert.ok(id);
  const unit: SharedProjectionUnit = freeze({ value: { atom: "broll", id, text: "B-roll:" }, marks: [] });
  const cells = freeze([{ key: "R", units: [unit] }, { key: "S", units: [unit] }]);
  assert.deepEqual(projectSharedBrollKeys(cells, []).map(cell => cell.units.map(item => typeof item.value === "string" ? item.value : item.value.atom === "broll" ? item.value.id : "")),
    [["S1"], ["broll_00530031_0053_0"]]);
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
