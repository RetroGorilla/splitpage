import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BROLL_PROPS_MAX } from "../../../src/core/document/broll.ts";
import { STATE_FIELDS } from "../../../src/core/document/fields.ts";
import {
  LIST_MERGERS, mergeBrollProps, mergeBrollShots, mergePeople, mergeProductionTags, personIdRemap, personSurvives, repointOwners
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

test("personSurvives holds for a merged person's id and for an id that moves to one, and nothing else (#353)", () => {
  const theirs = [{ id: "p1", name: "Sam" }, { id: "p4", name: "Bo " }];
  const mine = [{ id: "p3", name: "bo" }, { id: "constructor", name: "Gone" }];
  const survives = personSurvives(theirs.concat(mine), mergePeople([{ id: "p1", name: "Sam" }], mine, theirs));
  assert.deepEqual(["p1", "p3", "p4", "constructor", "toString", "__proto__", ""].map(survives), [false, true, true, true, false, false, false]);
  assert.equal(personSurvives(undefined, undefined)("p1"), false);
  assert.equal(personSurvives([null], [null, { id: "p1", name: "" }])("p1"), false);
});

test("an owner who did not survive gives way to the other side's live owner, in tags and shots (#353)", () => {
  const survives = (id: string) => id === "pAda" || id === "pBo";
  const tagsOf = (owner: string) => [tag("t_k", "Kettle", { owner: owner })];
  const shotsOf = (owner: unknown) => [shot("b1", { owner: owner })];
  const tagOwner = (mine: string, theirs: string, check?: (id: string) => boolean) =>
    mergeProductionTags(tagsOf("pSam"), tagsOf(mine), tagsOf(theirs), check)[0]?.owner;
  const shotOwner = (mine: unknown, theirs: unknown, check?: (id: string) => boolean) =>
    mergeBrollShots(shotsOf("pSam"), shotsOf(mine), shotsOf(theirs), check)[0]?.owner;
  for (const owner of [tagOwner, shotOwner]) {
    assert.equal(owner("pAda", "pSam", survives), "pAda", owner.name + ": my live owner replaces their deleted one");
    assert.equal(owner("pSam", "pAda", survives), "pAda", owner.name + ": their live owner stays");
    assert.equal(owner("pAda", "pBo", survives), "pBo", owner.name + ": a live owner on their side is never replaced");
    assert.equal(owner("pCy", "pSam", survives), "pSam", owner.name + ": a deleted owner gives way only to a live one");
    assert.equal(owner("", "pSam", survives), "pSam", owner.name + ": nor to no owner");
    assert.equal(owner("pCy", "pSam"), "pCy", owner.name + ": with no check every owner counts as live");
  }
  assert.equal(shotOwner("pAda", 7, survives), 7, "an owner that is not an id is left as it was");
  assert.equal(shotOwner(7, "pSam", survives), "pSam");
  const tags = [tag("t_k", "Kettle", { owner: "pSam" })];
  const before = JSON.stringify(tags);
  mergeProductionTags(tags, [tag("t_k", "Kettle", { owner: "pAda" })], tags, survives);
  assert.equal(JSON.stringify(tags), before);
});

test("my reassignment wins over an owner their side left as it was in the base, in tags and shots (#353)", () => {
  const survives = (id: string) => id !== "pGone";
  const tagOwner = (base: string | null, mine: string, theirs: string) =>
    mergeProductionTags(base === null ? [] : [tag("t_k", "Kettle", { owner: base })], [tag("t_k", "Kettle", { owner: mine })],
      [tag("t_k", "Kettle", { owner: theirs })], survives)[0]?.owner;
  const shotOwner = (base: string | null, mine: unknown, theirs: string) =>
    mergeBrollShots(base === null ? [] : [shot("b1", { owner: base })], [shot("b1", { owner: mine })],
      [shot("b1", { owner: theirs })], survives)[0]?.owner;
  for (const owner of [tagOwner, shotOwner]) {
    assert.equal(owner("pSam", "pAda", "pSam"), "pAda", owner.name + ": their side kept the base owner");
    assert.equal(owner("", "pAda", ""), "pAda", owner.name + ": no owner in the base or theirs");
    assert.equal(owner("pSam", "pAda", "pBo"), "pBo", owner.name + ": both sides reassigned: theirs stays");
    assert.equal(owner("pSam", "pSam", "pBo"), "pBo", owner.name + ": only their side reassigned");
    assert.equal(owner("pSam", "", "pSam"), "pSam", owner.name + ": an unassignment never removes an owner");
    assert.equal(owner("pSam", "pGone", "pSam"), "pSam", owner.name + ": a reassignment to a person who is gone loses");
    assert.equal(owner(null, "pAda", "pSam"), "pSam", owner.name + ": with no base entry theirs stays");
  }
  assert.equal(shotOwner("pSam", 7, "pSam"), "pSam", "an owner that is not an id never wins");
  const base = [shot("b1", { owner: "pSam" })];
  const mine = [shot("b1", { owner: "pAda" }), shot("b1", { owner: "pBo" })];
  assert.equal(mergeBrollShots(base, mine, [], survives)[0]?.owner, "pAda", "my own duplicate is not their side");
  assert.equal(mergeProductionTags([tag("t_k", "Kettle", { owner: "pSam" })],
    [tag("t_k", "Kettle", { owner: "pAda" }), tag("t_k", "Kettle", { owner: "pBo" })], [], survives)[0]?.owner, "pAda");
});

test("two or more entries for one tag name: a deleted owner gives way to the next live one, in list order (#353)", () => {
  const survives = (id: string) => id === "pAda" || id === "pBo";
  const names = ["Ladder", "ladder", "LADDER ", " Ladder"];
  const theirOwner = (owners: string[], check?: (id: string) => boolean) =>
    mergeProductionTags([], [], owners.map((o, i) => tag("t" + i, names[i] as string, { owner: o })), check)[0]?.owner;
  assert.equal(theirOwner(["pSam", "pCy"], survives), "pSam", "both deleted: the first stays, and migrateRows clears it");
  assert.equal(theirOwner(["pAda", "pBo"], survives), "pAda", "both alive: the first keeps its owner");
  assert.equal(theirOwner(["pSam", "pCy", "pBo"], survives), "pBo");
  assert.equal(theirOwner(["pSam", "pAda", "pBo"], survives), "pAda");
  assert.equal(theirOwner(["", "pSam", "pBo"], survives), "pBo");
  assert.equal(theirOwner(["pSam", "pBo"]), "pSam", "with no check, the first owner stays");
  assert.equal(theirOwner(["", "pSam", "pBo"]), "pSam");
  const mineOwner = (mine: string[], theirs: string[], check?: (id: string) => boolean) =>
    mergeProductionTags([], mine.map((o, i) => tag("tm" + i, "ladder", { owner: o })),
      theirs.map((o, i) => tag("tt" + i, "Ladder", { owner: o })), check)[0];
  assert.deepEqual(mineOwner(["pAda"], ["pSam"], survives), { cat: "prop", name: "Ladder", owner: "pAda", notes: "", status: "needed", id: "tt0" });
  assert.equal(mineOwner(["pAda", "pBo"], ["pSam"], survives)?.owner, "pAda");
  assert.equal(mineOwner(["pSam", "pBo"], [], survives)?.owner, "pBo", "duplicates on my side alone");
  assert.equal(mineOwner(["pAda"], ["pSam"])?.owner, "pSam");
  const theirs = [{ id: "pT", name: "ada" }], mine = [{ id: "pM", name: "Ada" }];
  const known = personSurvives(theirs.concat(mine), mergePeople([], mine, theirs));
  assert.equal(mineOwner(["pM"], ["pSam"], known)?.owner, "pM", "a live owner known under another id (#283)");
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

test("ids and names like Object.prototype members merge like any other (#278)", () => {
  assert.deepEqual(mergePeople(
    [{ id: "p1", name: "Sam" }, { id: "constructor", name: "Con" }],
    [{ id: "p1", name: "Sam" }, { id: "constructor", name: "Con" }, { id: "__proto__", name: "Proto" }, { id: "p2", name: "constructor" }],
    [{ id: "p1", name: "Sam" }, { id: "constructor", name: "Con" }, { id: "toString", name: "Tess" }, { id: "p3", name: "__proto__" }]
  ), [
    { id: "p1", name: "Sam" }, { id: "constructor", name: "Con" }, { id: "toString", name: "Tess" },
    { id: "p3", name: "__proto__" }, { id: "__proto__", name: "Proto" }, { id: "p2", name: "constructor" }
  ]);
  assert.deepEqual(mergePeople([{ id: "p9", name: "constructor" }], [], [{ id: "p9", name: "constructor" }]), []);
  const entry = (id: string, name: string) => ({ cat: "prop", name: name, owner: "", notes: "", status: "needed", id: id });
  const tags = [tag("constructor", "Kettle"), tag("toString", "Lamp")];
  assert.deepEqual(mergeProductionTags(tags, tags.concat([tag("hasOwnProperty", "Ladder")]), tags.concat([tag("__proto__", "Tripod")])),
    [entry("constructor", "Kettle"), entry("toString", "Lamp"), entry("__proto__", "Tripod"), entry("hasOwnProperty", "Ladder")]);
  assert.deepEqual(mergeProductionTags(tags, [tags[1] as TagInput], tags), [entry("toString", "Lamp")]);
  const shots = [shot("constructor"), shot("toString")];
  assert.deepEqual(mergeBrollShots(shots, [shot("constructor", { notes: "mine" }), shot("hasOwnProperty")],
    shots.concat([shot("__proto__")])), [shot("constructor", { notes: "mine" }), shot("__proto__"), shot("hasOwnProperty")]);
  assert.deepEqual(mergeBrollProps([], [prop("constructor", "Kettle"), prop("", "toString")], [prop("__proto__", "Lamp")]),
    [prop("__proto__", "Lamp"), prop("constructor", "Kettle"), prop("", "toString")]);
  assert.deepEqual(mergeBrollProps([prop("constructor", "Kettle")], [], [prop("constructor", "Kettle")]), []);
  const cup = prop("t_cup", "Cup"), hat = prop("t_hat", "Hat");
  for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const base = [shot(id, { props: [cup, hat] })];
    assert.deepEqual(mergeBrollShots(base, [shot(id, { props: [cup] })], [shot(id, { notes: "theirs", props: [cup, hat] })]),
      [shot(id, { notes: "theirs", props: [cup] })], id + ": a prop mine removed stays removed");
    assert.deepEqual(mergeBrollShots(base, [shot(id, { notes: "mine", props: [cup, hat] })], [shot(id, { props: [hat] })]),
      [shot(id, { notes: "mine", props: [hat] })], id + ": a prop theirs removed stays removed");
  }
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "notes"), false);
});
