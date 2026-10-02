import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BROLL_PROPS_MAX } from "../../../src/core/document/broll.ts";
import { STATE_FIELDS } from "../../../src/core/document/fields.ts";
import {
  LIST_MERGERS, mergeBrollProps, mergeBrollShots, mergePeople, mergeProductionTags, personIdRemap, repointOwners
} from "../../../src/core/merge/lists.ts";
import type { BrollShot, ListMerger, TagInput } from "../../../src/core/merge/lists.ts";
import { jsonCopy } from "./fakes.ts";

type ListCase = { fn: string; case: string; base: unknown; mine: unknown; theirs: unknown; out: unknown };

const GOLDEN = new URL("../../../src/test/fixtures/golden/merge-list-mergers.json", import.meta.url);

const shot = (id: string, extra?: Partial<BrollShot>): BrollShot => Object.assign({
  id: id, name: "Shot " + id, desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "",
  props: [], origin: "script"
}, extra || {});
const tag = (id: string, name: string, extra?: TagInput): TagInput =>
  Object.assign({ id: id, cat: "prop", name: name, owner: "", notes: "", status: "needed" }, extra || {});
const prop = (id: string, name: string) => ({ id: id, name: name });

test("LIST_MERGERS holds a merger for exactly the fields merged as lists", () => {
  assert.ok(Object.isFrozen(LIST_MERGERS));
  assert.deepEqual(Object.keys(LIST_MERGERS),
    STATE_FIELDS.filter((f) => f.merge === "list-union-with-base").map((f) => f.key));
});

test("LIST_MERGERS reproduces every stored list-merger case, key order included, without touching its inputs", () => {
  const cases = JSON.parse(readFileSync(GOLDEN, "utf8")) as ListCase[];
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const args = jsonCopy({ base: c.base, mine: c.mine, theirs: c.theirs });
    const before = JSON.stringify(args);
    const merger = LIST_MERGERS[c.fn];
    assert.ok(merger, c.fn);
    assert.equal(JSON.stringify(merger(args.base, args.mine, args.theirs)), JSON.stringify(c.out), c.fn + ": " + c.case);
    assert.equal(JSON.stringify(args), before, c.fn + ": " + c.case);
  }
});

test("each list merger is the named function", () => {
  const merger = (key: string): ListMerger => LIST_MERGERS[key] as ListMerger;
  const people = [{ id: "p1", name: "Sam" }, { id: "p2", name: "sam" }];
  assert.deepEqual(merger("people")(null, people, []), mergePeople(null, people, []));
  const tags = [tag("t_a", "A"), tag("t_b", "a")];
  assert.deepEqual(merger("productionTags")(null, tags, []), mergeProductionTags(null, tags, []));
  const shots = [shot("b1"), shot("b1", { notes: "again" })];
  assert.deepEqual(merger("brollShots")(null, shots, []), mergeBrollShots(null, shots, []));
});

test("people: theirs first, one entry per id and per name, and a delete one side made the other left alone", () => {
  const base = [{ id: "p1", name: "Sam" }, { id: "p2", name: "Ada" }];
  const mine = [{ id: "p1", name: "Sam" }, { id: "p3", name: "bo" }];
  const theirs = [{ id: "p1", name: "Sam" }, { id: "p2", name: "Ada" }, { id: "p4", name: "Bo " }];
  assert.deepEqual(mergePeople(base, mine, theirs), [{ id: "p1", name: "Sam" }, { id: "p4", name: "Bo " }]);
  assert.deepEqual(mergePeople(null, mine, theirs),
    [{ id: "p1", name: "Sam" }, { id: "p2", name: "Ada" }, { id: "p4", name: "Bo " }]);
});

test("personIdRemap maps each id that did not survive to the survivor with its name, and nothing else (#283)", () => {
  const theirs = [{ id: "p1", name: "Sam" }, { id: "p4", name: "Bo " }];
  const mine = [{ id: "p1", name: "Sam" }, { id: "p3", name: "bo" }, { id: "p5", name: "Gone" }];
  const merged = mergePeople(null, mine, theirs);
  assert.deepEqual({ ...personIdRemap(theirs.concat(mine), merged) }, { p3: "p4" });
  const remap = personIdRemap([{ id: "constructor", name: "Ada" }, { id: "p9", name: "toString" }],
    [{ id: "pA", name: "ada" }]);
  assert.deepEqual(Object.keys(remap), ["constructor"]);
  assert.equal(remap.toString, undefined, "a map with no prototype");
  assert.deepEqual({ ...personIdRemap(undefined, undefined) }, {});
  assert.deepEqual({ ...personIdRemap([null, { id: "x", name: "" }], [null, { id: "p1", name: "Sam" }]) }, {});
});

test("repointOwners rewrites only owners the map names, in place, and skips what is not an item (#283)", () => {
  const tags = [tag("t_a", "A", { owner: "p3" }), tag("t_b", "B", { owner: "p1" }), tag("t_c", "C")];
  const shots: unknown[] = [shot("b1", { owner: "p3" }), null, "x", { owner: 7 }];
  repointOwners([tags, shots, undefined, "not a list"], personIdRemap([{ id: "p3", name: "Bo" }], [{ id: "p4", name: "bo" }]));
  assert.deepEqual(tags.map((t) => t.owner), ["p4", "p1", ""]);
  assert.deepEqual(shots.map((s) => s && typeof s === "object" ? (s as BrollShot).owner : s), ["p4", null, "x", 7]);
});

test("production tags: a status only ever rises, and two entries for one name become the first", () => {
  const out = mergeProductionTags([], [tag("t_a", "Ladder", { status: "have", owner: "p1" })],
    [tag("t_b", "ladder", { notes: "6 ft" }), tag("t_a", "Ladder", { status: "sourcing" })]);
  assert.deepEqual(out, [{ cat: "prop", name: "ladder", owner: "p1", notes: "6 ft", status: "have", id: "t_b" }]);
  assert.deepEqual(mergeProductionTags(null, [tag("t_a", "A", { status: "bogus" })], [])[0]?.status, "needed");
});

test("production tags: of two entries for one name, the first keeps its own owner, notes and status", () => {
  const out = mergeProductionTags([], [], [
    tag("t_a", "Ladder", { owner: "p1", notes: "first", status: "have" }),
    tag("t_b", "ladder", { owner: "p2", notes: "second", status: "sourcing" })
  ]);
  assert.deepEqual(out, [{ cat: "prop", name: "Ladder", owner: "p1", notes: "first", status: "have", id: "t_a" }]);
});

test("b-roll props: additions on both sides, removals, an ancestor with no list, and the cap", () => {
  const K = prop("t_kettle", "Kettle"), L = prop("t_ladder", "Ladder"), T = prop("t_tripod", "Tripod");
  assert.deepEqual(mergeBrollProps([K], [K, L], [K, T]), [K, T, L]);
  assert.deepEqual(mergeBrollProps([K, L, T], [L, T], [K, L]), [L]);
  assert.deepEqual(mergeBrollProps(undefined, [], [K]), [K]);
  assert.deepEqual(mergeBrollProps([], [prop("", "kettle")], [prop("", "Kettle")]), [prop("", "Kettle")]);
  const many = (label: string) => Array.from({ length: 30 }, (_, i) => prop("", label + " " + i));
  assert.equal(mergeBrollProps([], many("Mine"), many("Theirs")).length, BROLL_PROPS_MAX);
  assert.deepEqual(mergeBrollProps(null, [null, 7, { id: "t_x" }, "Kettle"], [{ name: "Lamp" }]), [prop("", "Lamp")]);
});

test("b-roll shots: my side fills their empty fields, shot and reshoot stick, props merge against the ancestor", () => {
  const out = mergeBrollShots([shot("b1", { props: [prop("t_k", "K")] })],
    [shot("b1", { owner: "p1", status: "shot", reshoot: true, props: [prop("t_k", "K"), prop("t_l", "L")] })],
    [shot("b1", { notes: "theirs", props: [] })]);
  assert.deepEqual(out, [shot("b1", { notes: "theirs", owner: "p1", status: "shot", reshoot: true, props: [prop("t_l", "L")] })]);
});

test("ids named like Object.prototype members collide in the id maps, as today (#278)", () => {
  assert.deepEqual(mergePeople(
    [{ id: "p1", name: "Sam" }, { id: "constructor", name: "Con" }],
    [{ id: "p1", name: "Sam" }, { id: "constructor", name: "Con" }, { id: "__proto__", name: "Proto" }, { id: "p2", name: "constructor" }],
    [{ id: "p1", name: "Sam" }, { id: "constructor", name: "Con" }, { id: "toString", name: "Tess" }, { id: "p3", name: "__proto__" }]
  ), [{ id: "p1", name: "Sam" }]);
  const tags = [tag("constructor", "Kettle"), tag("toString", "Lamp")];
  assert.deepEqual(mergeProductionTags(tags, tags.concat([tag("hasOwnProperty", "Ladder")]), tags.concat([tag("__proto__", "Tripod")])), []);
  const shots = [shot("constructor"), shot("toString")];
  assert.deepEqual(mergeBrollShots(shots, [shot("constructor", { notes: "mine" }), shot("hasOwnProperty")],
    shots.concat([shot("__proto__")])), []);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "notes"), false);
});
