import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROLL_CLOSERS,
  BROLL_MARKER_RE,
  BROLL_NAME_MAX,
  BROLL_PROP_NAME_MAX,
  BROLL_PROPS_MAX,
  BROLL_STATUS_IDS,
  BROLL_TEXT_MAX,
  brollPropKey,
  brollStatusId,
  normalizeBrollProps
} from "../../../src/core/document/broll.ts";
import { mintTagId } from "../../../src/core/document/tags.ts";

const MUG = mintTagId("prop", "Mug");
const REGISTRY = [
  { id: MUG, cat: "prop", name: "Mug" },
  { id: mintTagId("location", "Mug"), cat: "location", name: "Mug" },
  { id: mintTagId("prop", "Lamp"), cat: "prop", name: "Lamp" }
];

test("the shot statuses and limits", () => {
  assert.deepEqual([...BROLL_STATUS_IDS], ["unshot", "shot"]);
  assert.equal(brollStatusId("unshot"), "unshot");
  assert.equal(brollStatusId("shot"), "shot");
  for (const id of ["Shot", "", null, undefined, "bogus", "constructor"]) assert.equal(brollStatusId(id), null, String(id));
  assert.equal(BROLL_NAME_MAX, 200);
  assert.equal(BROLL_TEXT_MAX, 2000);
  assert.equal(BROLL_PROP_NAME_MAX, 80);
  assert.equal(BROLL_PROPS_MAX, 40);
});

test("the marker is B-roll, spelt loosely, closed by a colon or a dash", () => {
  for (const line of ["B-roll: city", "b roll - city", "Broll— city", "  B - Roll – city", "\tBROLL:city", "b-roll-city"]) {
    assert.ok(BROLL_MARKER_RE.test(line), line);
  }
  for (const line of ["B-roll city", "Bro ll: city", "x B-roll: city", "B--roll: city", "B-rolls: city"]) {
    assert.ok(!BROLL_MARKER_RE.test(line), line);
  }
  const m = BROLL_MARKER_RE.exec("  b Roll –  The street");
  assert.deepEqual(m && [m[0], m[1], m[2]], ["  b Roll –  ", "b Roll", "–"]);
  for (const closer of [":", "—", "–", "-"]) assert.ok(BROLL_CLOSERS.indexOf(closer) !== -1, closer);
  assert.equal(BROLL_CLOSERS.length, 4);
});

test("a prop's key is its registry id, else its normalised name", () => {
  assert.equal(brollPropKey(MUG, "Anything"), MUG);
  assert.equal(brollPropKey("", "  Red  MUG "), "n:red mug");
  assert.equal(brollPropKey("", null), "n:");
});

test("props normalise to tracked ids and registry names, dropping repeats and junk", () => {
  assert.deepEqual(normalizeBrollProps([
    "mug",
    { name: "Lamp" },
    { id: MUG, name: "old name" },
    { name: "  Loose   thing " },
    { name: "loose THING" },
    { id: "t_gone", name: "Gone" },
    { id: "not an id", name: 42 },
    { name: "<b></b>" },
    { name: { toString: () => "object" } },
    null,
    7,
    ["mug"]
  ], REGISTRY), [
    { id: MUG, name: "Mug" },
    { id: mintTagId("prop", "Lamp"), name: "Lamp" },
    { id: "", name: "Loose   thing" },
    { id: "t_gone", name: "Gone" },
    { id: "", name: "42" }
  ]);
});

test("a prop name is cut to its limit and trimmed before it is matched, so a second pass matches nothing new (#406)", () => {
  const cut = "n".repeat(BROLL_PROP_NAME_MAX - 1);
  const registry = [{ id: mintTagId("prop", cut), cat: "prop", name: cut }];
  const once = normalizeBrollProps([cut + " tail"], registry);
  assert.deepEqual(once, [{ id: registry[0]?.id, name: cut }]);
  assert.deepEqual(normalizeBrollProps(once, registry), once);
  assert.deepEqual(normalizeBrollProps([cut + " tail"], []), [{ id: "", name: cut }]);
});

test("a prop name is cut to its limit, and the list to forty", () => {
  const long = "x".repeat(BROLL_PROP_NAME_MAX + 5);
  assert.deepEqual(normalizeBrollProps([long], []), [{ id: "", name: "x".repeat(BROLL_PROP_NAME_MAX) }]);
  const many = Array.from({ length: BROLL_PROPS_MAX + 5 }, (_, i) => "Prop " + i);
  const out = normalizeBrollProps(many, null);
  assert.equal(out.length, BROLL_PROPS_MAX);
  assert.deepEqual(out[BROLL_PROPS_MAX - 1], { id: "", name: "Prop " + (BROLL_PROPS_MAX - 1) });
  const withRepeat = normalizeBrollProps(["a", "A ", ...many], undefined);
  assert.equal(withRepeat.length, BROLL_PROPS_MAX, "a repeat takes no place");
  assert.deepEqual(withRepeat[BROLL_PROPS_MAX - 1], { id: "", name: "Prop " + (BROLL_PROPS_MAX - 2) });
});

test("a list that is not an array has no props", () => {
  for (const list of [null, undefined, "mug", { 0: "mug", length: 1 }]) assert.deepEqual(normalizeBrollProps(list, REGISTRY), []);
});
