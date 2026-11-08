import { test } from "node:test";
import assert from "node:assert/strict";
import { BROLL_PROPS_MAX } from "../../../src/core/document/broll.ts";
import type { DocumentShot, DocumentTag } from "../../../src/core/document/validated.ts";
import {
  PERSON_NAME_MAX,
  addBrollProp,
  addPerson,
  addRegistryTag,
  peopleOf,
  personById,
  personNamed,
  registryCompletion,
  registryEntryById,
  removeBrollProp,
  removePerson,
  removeRegistryTag,
  renameBrollProps,
  renameRegistryTag
} from "../../../src/core/production/records.ts";
import type { LiveRecords } from "../../../src/core/production/records.ts";
import { countingIds } from "./cells.ts";

function tagged(cat: string, name: string, extra?: Partial<DocumentTag>): DocumentTag {
  return Object.assign({ id: "t_" + name.toLowerCase().replace(/\W+/g, ""), cat: cat, name: name, owner: "", notes: "", status: "needed" }, extra || {});
}

function shotOf(id: string, extra?: Partial<DocumentShot>): DocumentShot {
  return Object.assign({ id: id, name: id, owner: "", props: [] }, extra || {});
}

function records(extra?: Partial<LiveRecords>): LiveRecords {
  return Object.assign({ productionTags: [], brollShots: [], people: [] }, extra || {});
}

test("registry completion offers the shortest longer name in the asked category, from what was typed", () => {
  const doc = records({ productionTags: [
    tagged("prop", "cable tray"), tagged("prop", "cable tie"), tagged("gear", "cable"),
    tagged("prop", "Camera bag"), tagged("location", "cafe")
  ] });
  assert.deepEqual(registryCompletion(doc, "prop", " ca"), { name: "cable tie", rest: "ble tie" });
  assert.deepEqual(registryCompletion(doc, "prop", "CAM"), { name: "Camera bag", rest: "era bag" });
  assert.deepEqual(registryCompletion(doc, "prop", "cable t"), { name: "cable tie", rest: "ie" });
  assert.deepEqual(registryCompletion(doc, "prop", "cable tr"), { name: "cable tray", rest: "ay" });
  assert.deepEqual(registryCompletion(doc, "location", "c"), { name: "cafe", rest: "afe" });
  assert.equal(registryCompletion(doc, "prop", "cable tray"), null, "a full name needs no completion");
  assert.equal(registryCompletion(doc, "gear", "cable"), null);
  assert.equal(registryCompletion(doc, "prop", "  "), null);
  assert.equal(registryCompletion(doc, "prop", "x"), null);
  assert.equal(registryCompletion(doc, "vfx", "c"), null, "other categories are not offered");
  assert.equal(registryCompletion(null, "prop", "c"), null);
});

test("a registry tag is added once per category and normalised name, and removed with every entry under that key", () => {
  const doc = records();
  const first = addRegistryTag(doc, "prop", "  Mug ");
  assert.equal(first?.name, "Mug");
  assert.equal(addRegistryTag(doc, "prop", "MUG"), null, "the same name again adds nothing");
  assert.notEqual(addRegistryTag(doc, "gear", "Mug"), null, "another category is another entry");
  assert.equal(doc.productionTags.length, 2);

  const other = tagged("prop", "Kettle");
  const mixed = records({ productionTags: [tagged("prop", "Mug"), tagged("gear", "Mug"), null, tagged("prop", "mug "), other] });
  assert.equal(removeRegistryTag(mixed, "prop", "MUG"), true);
  assert.deepEqual(mixed.productionTags.map((t) => t && t.cat + ":" + t.name), ["gear:Mug", null, "prop:Kettle"]);
  assert.equal(removeRegistryTag(mixed, "prop", "Nothing"), false);
  assert.equal(mixed.productionTags.length, 3);
});

test("registry entries and people are found by id or by cleaned name, and nothing else answers", () => {
  const kettle = tagged("prop", "Kettle");
  assert.equal(registryEntryById(records({ productionTags: [null, kettle] }), kettle.id), kettle);
  assert.equal(registryEntryById(records({ productionTags: [kettle] }), "t_other"), null);
  assert.equal(registryEntryById(records({ productionTags: [kettle] }), ""), null);
  assert.equal(registryEntryById(null, kettle.id), null);

  const sam = { id: "p1", name: "Sam Reed" };
  const doc = { people: [sam, { id: "p2", name: "Alex" }] };
  assert.deepEqual(peopleOf(doc), doc.people);
  assert.deepEqual(peopleOf({ people: "none" }), []);
  assert.deepEqual(peopleOf(null), []);
  assert.equal(personById(doc, "p1"), sam);
  assert.equal(personById(doc, "p9"), null);
  assert.equal(personById(doc, ""), null);
  assert.equal(personNamed(doc, "  sam   REED "), sam, "names match folded and trimmed");
  assert.equal(personNamed(doc, "Reed"), null);
  assert.equal(personNamed(doc, "   "), null);
});

test("a person is added once by name, cut to the name limit, and a blank name adds none", () => {
  const doc = records();
  const ids = countingIds();
  const id = addPerson(doc, "Sam", ids);
  assert.equal(id, "pmint0001");
  assert.equal(addPerson(doc, " sam ", ids), id, "the same name in another case is the same person");
  assert.equal(doc["people"] instanceof Array && doc["people"].length, 1);
  assert.deepEqual(ids.minted, [id], "a known name mints no id");
  assert.equal(addPerson(doc, "   ", ids), "");
  assert.equal(ids.minted.length, 1);

  const long = addPerson(doc, "a".repeat(PERSON_NAME_MAX + 10), ids);
  const person = peopleOf(doc).find((p) => p.id === long);
  assert.equal(person?.name.length, PERSON_NAME_MAX);
  assert.equal(PERSON_NAME_MAX, 60);
  assert.throws(() => addPerson({ productionTags: [], brollShots: [] }, "Sam", ids), /no people list/);
});

test("removing a person blanks them as owner of every tag and shot, and leaves other owners alone", () => {
  const doc = records({
    people: [{ id: "p1", name: "Sam" }, { id: "p2", name: "Alex" }],
    productionTags: [tagged("prop", "Mug", { owner: "p1" }), tagged("prop", "Kettle", { owner: "p2" }), null],
    brollShots: [shotOf("s1", { owner: "p1" }), shotOf("s2", { owner: "p2" })]
  });
  removePerson(doc, "p1");
  assert.deepEqual(peopleOf(doc), [{ id: "p2", name: "Alex" }]);
  assert.deepEqual(doc.productionTags.map((t) => t && t.owner), ["", "p2", null]);
  assert.deepEqual(doc.brollShots.map((s) => s.owner), ["", "p2"]);
});

test("renaming a prop in the registry re-points every shot at it, and says whether anything changed", () => {
  const doc = records({
    productionTags: [tagged("prop", "Kettle")],
    brollShots: [shotOf("s1", { props: [{ id: "t_kettle", name: "Old name" }] })]
  });
  assert.equal(renameBrollProps(doc, "t_kettle", "", "t_kettle", "Kettle"), true);
  assert.deepEqual(doc.brollShots[0]?.props, [{ id: "t_kettle", name: "Kettle" }]);
  assert.equal(renameBrollProps(doc, "t_kettle", "", "t_kettle", "Kettle"), false, "a shot already showing the name is left as it is");

  const renamed = records({
    productionTags: [tagged("prop", "Kettle")],
    brollShots: [shotOf("s1", { props: [{ id: "t_kettle", name: "Kettle" }] })]
  });
  assert.equal(renameRegistryTag(renamed, "prop", "Kettle", "Copper kettle"), true);
  assert.equal(renamed.productionTags[0]?.name, "Copper kettle");
  assert.deepEqual(renamed.brollShots[0]?.props, [{ id: "t_kettle", name: "Copper kettle" }]);
  assert.equal(renameRegistryTag(renamed, "prop", "Missing", "Whatever"), false);
});

test("renaming onto a name already in the registry keeps one entry, with the owner, notes and furthest status of the two", () => {
  const doc = records({
    productionTags: [tagged("prop", "Mug"), tagged("prop", "Cup", { owner: "p1", notes: "chipped", status: "have" })],
    brollShots: [
      shotOf("s1", { props: [{ id: "t_cup", name: "Cup" }] }),
      shotOf("s2", { props: [{ id: "", name: "cup" }] })
    ]
  });
  assert.equal(renameRegistryTag(doc, "prop", "Cup", "mug"), true);
  assert.deepEqual(doc.productionTags, [tagged("prop", "Mug", { owner: "p1", notes: "chipped", status: "have" })]);
  assert.deepEqual(doc.brollShots.map((s) => s.props), [[{ id: "t_mug", name: "Mug" }], [{ id: "t_mug", name: "Mug" }]], "shots by id and by bare name both follow the merge");
});

test("a merge never overwrites what the surviving entry already has, nor lowers its status", () => {
  const doc = records({
    productionTags: [
      tagged("prop", "Mug", { owner: "p2", notes: "keep me", status: "returned" }),
      tagged("prop", "Cup", { owner: "p1", notes: "drop me", status: "sourcing" })
    ]
  });
  assert.equal(renameRegistryTag(doc, "prop", "Cup", "Mug"), true);
  assert.deepEqual(doc.productionTags, [tagged("prop", "Mug", { owner: "p2", notes: "keep me", status: "returned" })]);
});

test("a merge in another category leaves a shot's untracked prop of the same name alone", () => {
  const doc = records({
    productionTags: [tagged("gear", "Mug"), tagged("gear", "Cup")],
    brollShots: [shotOf("s1", { props: [{ id: "", name: "Cup" }] })]
  });
  assert.equal(renameRegistryTag(doc, "gear", "Cup", "Mug"), true);
  assert.deepEqual(doc.productionTags.map((t) => t && t.name), ["Mug"]);
  assert.deepEqual(doc.brollShots[0]?.props, [{ id: "", name: "Cup" }]);
});

test("renaming to the entry's own name still reports shots it had to re-point", () => {
  const doc = records({
    productionTags: [tagged("prop", "Kettle")],
    brollShots: [shotOf("s1", { props: [{ id: "t_kettle", name: "Stale" }] })]
  });
  assert.equal(renameRegistryTag(doc, "prop", "Kettle", "Kettle"), true);
  assert.deepEqual(doc.brollShots[0]?.props, [{ id: "t_kettle", name: "Kettle" }]);
  assert.equal(renameRegistryTag(doc, "prop", "Kettle", "Kettle"), false);
});

test("a prop is added to a shot once, registering it, and never past the props limit", () => {
  const doc = records({ brollShots: [shotOf("s1")] });
  assert.equal(addBrollProp(doc, "s1", "Kettle"), true);
  assert.equal(addBrollProp(doc, "s1", " kettle "), false, "the same prop again adds nothing");
  assert.deepEqual(doc.brollShots[0]?.props, [{ id: doc.productionTags[0]?.id, name: "Kettle" }]);
  assert.equal(doc.productionTags.length, 1);
  assert.equal(addBrollProp(doc, "s9", "Mug"), false, "no such shot");
  assert.equal(addBrollProp(doc, "s1", "   "), false, "no name");

  const full = records({ brollShots: [shotOf("s1", { props: Array.from({ length: BROLL_PROPS_MAX - 1 }, (_, i) => ({ id: "", name: "p" + i })) })] });
  assert.equal(addBrollProp(full, "s1", "last one"), true);
  assert.equal(full.brollShots[0]?.props?.length, BROLL_PROPS_MAX);
  assert.equal(addBrollProp(full, "s1", "one too many"), false);
  assert.equal(full.brollShots[0]?.props?.length, BROLL_PROPS_MAX);
});

test("a prop is removed from a shot by its key, and the answer says whether one went", () => {
  const doc = records({
    brollShots: [shotOf("s1", { props: [{ id: "t_kettle", name: "Kettle" }, { id: "", name: "Boat hook" }, null] })]
  });
  assert.equal(removeBrollProp(doc, "s1", "t_zzz"), false);
  assert.equal(doc.brollShots[0]?.props?.length, 3);
  assert.equal(removeBrollProp(doc, "s1", "t_kettle"), true);
  assert.equal(removeBrollProp(doc, "s1", "n:boat hook"), true);
  assert.deepEqual(doc.brollShots[0]?.props, [null]);
  assert.equal(removeBrollProp(doc, "s1", ""), false);
  assert.equal(removeBrollProp(doc, "s9", "t_kettle"), false);
});
