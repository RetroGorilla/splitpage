import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSharedProjections } from "../../../src/core/collab/projection/changes.ts";
import { expectedProjectionChanges, longestKeptRun } from "../../collab/projection-changes-oracle.ts";

type Bag = Record<string, unknown>;

function script(parts: Bag = {}): Bag & { rows: Bag[] } {
  return {
    schema: 2, title: "Title", docId: "d1",
    rows: [
      { id: "R1", status: "todo", visualText: "", audioText: "one", imageRef: null },
      { id: "R2", status: "todo", visualText: "", audioText: "two", imageRef: null },
      { id: "R3", status: "todo", visualText: "", audioText: "three", imageRef: null },
      { id: "R4", status: "todo", visualText: "", audioText: "four", imageRef: null }
    ],
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0,
    sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }],
    ...parts
  };
}

function reordered(ids: readonly string[]): Bag {
  const source = script();
  return script({ rows: ids.map(id => source.rows.find(row => row.id === id) ?? { id, status: "todo", visualText: "", audioText: "new", imageRef: null }) });
}

const NOTHING = { whole: false, added: [], removed: [], moved: [], changed: [], fields: [] };
const WHOLE = { ...NOTHING, whole: true };

test("no previous projection reports the whole document, and equal projections report nothing", () => {
  assert.deepEqual(compareSharedProjections(null, script()), WHOLE);
  assert.deepEqual(compareSharedProjections(script(), script()), NOTHING);
});

test("a changed row names its fields in the next row's key order; an added field follows and a dropped field comes last", () => {
  const after = script();
  after.rows[0] = { id: "R1", status: "ready", visualText: "", audioText: "one", imageRef: null, lengthSeconds: 7 };
  after.rows[2] = { id: "R3", status: "todo", visualText: "wide", audioText: "three" };
  assert.deepEqual(compareSharedProjections(script(), after), { ...NOTHING, changed: [
    { id: "R1", fields: ["status", "lengthSeconds"] }, { id: "R3", fields: ["visualText", "imageRef"] }
  ] });
});

test("added rows are named in the next order and removed rows in the previous order; kept rows that held their order did not move", () => {
  assert.deepEqual(compareSharedProjections(script(), reordered(["N2", "R1", "R3", "N1"])), { ...NOTHING, added: ["N2", "N1"], removed: ["R2", "R4"] });
});

test("moved rows are the kept rows off the longest run that held its order; of equal runs the earliest in the next order stays", () => {
  const moved = (ids: readonly string[]) => compareSharedProjections(script(), reordered(ids)).moved;
  assert.deepEqual(moved(["R1", "R4", "R2", "R3"]), ["R4"]);
  assert.deepEqual(moved(["R2", "R3", "R1", "R4"]), ["R1"]);
  assert.deepEqual(moved(["R2", "R1", "R3", "R4"]), ["R1"]);
  assert.deepEqual(moved(["R3", "R4", "R1", "R2"]), ["R1", "R2"]);
  assert.deepEqual(moved(["R4", "R3", "R2", "R1"]), ["R3", "R2", "R1"]);
  assert.deepEqual(compareSharedProjections(script(), reordered(["R4", "N1", "R1", "R3"])), { ...NOTHING, added: ["N1"], removed: ["R2"], moved: ["R4"] });
});

test("document fields other than rows are named in the next key order; a dropped field comes last", () => {
  const after = script({ title: "Renamed", people: [{ id: "P1", name: "Ann" }], sections: [{ id: "H1", name: "Scene!", firstSceneId: "R1" }], targetSeconds: 90 });
  Reflect.deleteProperty(after, "wordsPerMinute");
  assert.deepEqual(compareSharedProjections(script(), after), { ...NOTHING, fields: ["title", "people", "sections", "targetSeconds", "wordsPerMinute"] });
});

test("a repeated id, a row with no string id, a hole or rows that are no list report the whole document on either side", () => {
  const twice = script(); twice.rows.push({ id: "R1", status: "todo", audioText: "again" });
  const unnamed = script(); unnamed.rows[1] = { id: 7, status: "todo" };
  const holed = script(); Reflect.deleteProperty(holed.rows, "2");
  for (const wrong of [twice, unnamed, holed, script({ rows: null }), script({ rows: { 0: { id: "R1" } } })]) {
    assert.deepEqual(compareSharedProjections(script(), wrong), WHOLE);
    assert.deepEqual(compareSharedProjections(wrong, script()), WHOLE);
  }
});

test("values compare by kind, key presence and order, list length and holes, and sign of zero", () => {
  const field = (before: unknown, after: unknown) => {
    const previous = script({ extra: before }), next = script({ extra: after });
    previous.rows[0] = { id: "R1", value: before }; next.rows[0] = { id: "R1", value: after };
    const changes = compareSharedProjections(previous, next);
    assert.deepEqual(changes, changes.fields.length ? { ...NOTHING, changed: [{ id: "R1", fields: ["value"] }], fields: ["extra"] } : NOTHING);
    return changes.fields.length > 0;
  };
  const holed: unknown[] = []; holed.length = 2; holed[1] = 1;
  assert.deepEqual([
    field({ a: 1, b: 2 }, { a: 1, b: 2 }), field({ a: 1, b: 2 }, { b: 2, a: 1 }), field({ a: undefined }, {}), field([1, 2], [1, 2]), field([1, 2], [1, 2, undefined]),
    field(holed, [undefined, 1]), field(0, -0), field(NaN, NaN), field(null, {}), field([], {}), field("1", 1), field([{ a: [null] }], [{ a: [null] }])
  ], [false, true, true, false, true, true, true, false, true, true, true, false]);
  const present = script(), absent = script();
  present.rows[0] = { id: "R1", note: undefined }; absent.rows[0] = { id: "R1" };
  assert.deepEqual(compareSharedProjections(present, absent), { ...NOTHING, changed: [{ id: "R1", fields: ["note"] }] });
});

test("a retained row or field object is not compared by value, and sharing objects does not change the report", () => {
  const previous = script({ people: [{ id: "P1", name: "Ann" }] });
  const shared = { ...previous, rows: [previous.rows[0], { ...previous.rows[1], audioText: "two!" }, { ...previous.rows[2] }, previous.rows[3]], comments: [] };
  const fresh = structuredClone(shared), compared: string[] = [];
  const expected = { ...NOTHING, changed: [{ id: "R2", fields: ["audioText"] }] };
  assert.deepEqual(compareSharedProjections(previous, shared, (kind, key) => compared.push(kind + ":" + key)), expected);
  assert.deepEqual(compared, ["row:R2", "row:R3", "field:comments"]);
  compared.length = 0;
  assert.deepEqual(compareSharedProjections(previous, fresh, (kind, key) => compared.push(kind + ":" + key)), expected);
  assert.deepEqual(compared, ["row:R1", "row:R2", "row:R3", "row:R4", "field:comments", "field:people", "field:productionTags", "field:brollShots", "field:sections"]);
});

test("every order of up to six kept rows names the earliest longest run found by trying every subset", () => {
  const names = ["A", "B", "C", "D", "E", "F"];
  let orders = 0;
  const permute = (rest: readonly string[], taken: readonly string[], visit: (order: readonly string[]) => void): void => {
    if (!rest.length) { visit(taken); return; }
    for (const name of rest) permute(rest.filter(other => other !== name), [...taken, name], visit);
  };
  for (let size = 0; size <= names.length; size++) {
    const before = names.slice(0, size);
    permute(before, [], order => {
      let best: number[] = [];
      for (let subset = 0; subset < 1 << size; subset++) {
        const positions = order.map((_name, at) => at).filter(at => subset & 1 << at);
        const places = positions.map(at => before.indexOf(order[at] ?? ""));
        if (places.some((place, at) => at > 0 && place < (places[at - 1] ?? 0))) continue;
        const differs = positions.findIndex((at, index) => at !== best[index]);
        const earlier = positions.length === best.length && differs >= 0 && (positions[differs] ?? 0) < (best[differs] ?? 0);
        if (positions.length > best.length || earlier) best = positions;
      }
      const stays = new Set(best.map(at => order[at]));
      const changes = compareSharedProjections({ rows: before.map(id => ({ id })) }, { rows: order.map(id => ({ id })) });
      assert.deepEqual(changes, { ...NOTHING, moved: order.filter(id => !stays.has(id)) }, order.join(""));
      orders++;
    });
  }
  assert.equal(orders, 1 + 1 + 2 + 6 + 24 + 120 + 720);
});

test("seeded: random insertions, removals, moves and edits over 400 rows match the slow comparison and move the fewest rows", () => {
  let state = 0x6c0001, compared = 0, movedRows = 0;
  const pick = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 4294967296 * limit); };
  let serial = 0;
  const fresh = (): Bag => ({ id: "N" + String(++serial), status: "todo", audioText: "" });
  let previous: Bag & { rows: Bag[] } = { title: "T", rows: Array.from({ length: 400 }, fresh) };
  for (let round = 0; round < 60; round++) {
    const rows = previous.rows.slice();
    for (let edits = 1 + pick(6); edits > 0; edits--) {
      const kind = pick(5), at = pick(rows.length);
      if (kind === 0) rows.splice(at, 0, fresh());
      else if (kind === 1) rows.splice(at, 1);
      else if (kind === 2) rows.splice(pick(rows.length), 0, ...rows.splice(at, 1 + pick(3)));
      else if (kind === 3) rows[at] = { ...rows[at], audioText: "v" + String(pick(3)) };
      else rows[at] = { ...rows[at] };
    }
    const next = { title: pick(4) ? "T" : "T" + String(round), rows };
    const changes = compareSharedProjections(previous, next);
    assert.deepEqual(changes, expectedProjectionChanges(previous, next), `round ${round}`);
    assert.deepEqual(compareSharedProjections(structuredClone(previous), structuredClone(next)), changes, `round ${round}`);
    const before = previous.rows.map(row => row.id), kept = rows.map(row => row.id).filter(id => before.includes(id));
    assert.equal(changes.moved.length, kept.length - longestKeptRun(kept.map(id => before.indexOf(id))), `round ${round}`);
    const held = kept.filter(id => !changes.moved.includes(String(id)));
    assert.deepEqual(held, before.filter(id => held.includes(id)), `round ${round}`);
    movedRows += changes.moved.length; compared++; previous = next;
  }
  assert.equal(compared, 60);
  assert.equal(movedRows, 81);
});
