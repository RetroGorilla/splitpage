import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERSON_COLORS,
  PERSON_MAP_MAX,
  PERSON_NAME_MAX,
  lookupByName,
  mergePersonColors,
  normalizePersonColors,
  paletteColor,
  personKey
} from "../../../src/core/document/person-colors.ts";

const [BLUE, AMBER, VIOLET, GREEN] = PERSON_COLORS as [string, string, string, string];

test("the palette has eight colours and reads them in any case", () => {
  assert.equal(PERSON_COLORS.length, 8);
  assert.equal(paletteColor(" #80bdfb "), BLUE);
  assert.equal(paletteColor(AMBER), AMBER);
  assert.equal(paletteColor("#123456"), "");
  assert.equal(paletteColor(null), "");
  assert.equal(paletteColor(42), "");
});

test("a person's key ignores case and surrounding space", () => {
  assert.equal(personKey("  Sam Smith "), "sam smith");
  assert.equal(personKey(null), "");
  assert.equal(personKey(undefined), "");
  assert.equal(personKey(7), "7");
});

test("a colour map keeps palette colours for clean names, once per person", () => {
  assert.equal(normalizePersonColors(null), null);
  assert.equal(normalizePersonColors("Sam"), null);
  assert.equal(normalizePersonColors([BLUE]), null);
  assert.equal(normalizePersonColors({}), null);
  assert.equal(normalizePersonColors({ Sam: "#000000" }), null);
  assert.deepEqual(normalizePersonColors({
    " Sam ": "#80bdfb",
    "sam": AMBER,
    "A\u0000d\u001fa\u007f": VIOLET,
    "\u0001\u0002": GREEN,
    "Lee": "red"
  }), { Sam: BLUE, Ada: VIOLET });
});

test("a colour map refuses the names that would reach Object.prototype", () => {
  const raw = JSON.parse('{"__proto__": "#80BDFB", "constructor": "#80BDFB", " prototype ": "#80BDFB", "Sam": "#80BDFB"}') as unknown;
  const out = normalizePersonColors(raw);
  assert.deepEqual(out, { Sam: BLUE });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test("a colour map cuts names to their limit and stops at its size", () => {
  const long = "x".repeat(PERSON_NAME_MAX + 5);
  assert.deepEqual(normalizePersonColors({ [long]: BLUE }), { ["x".repeat(PERSON_NAME_MAX)]: BLUE });
  const spaced = "x".repeat(PERSON_NAME_MAX - 1) + " y";
  const cut = normalizePersonColors({ [spaced]: BLUE });
  assert.deepEqual(cut, { ["x".repeat(PERSON_NAME_MAX - 1)]: BLUE }, "the space the cut leaves is trimmed (#406)");
  assert.deepEqual(normalizePersonColors(cut), cut);
  const many: Record<string, string> = {};
  for (let i = 0; i < PERSON_MAP_MAX + 5; i++) many["P" + i] = BLUE;
  const out = normalizePersonColors(many) as Record<string, string>;
  assert.equal(Object.keys(out).length, PERSON_MAP_MAX);
  assert.equal(out["P" + (PERSON_MAP_MAX - 1)], BLUE);
  assert.equal(out["P" + PERSON_MAP_MAX], undefined);
});

test("a colour is found by exact name first, then by key", () => {
  const map = { Sam: BLUE, "SAM ": AMBER, Ada: "nope" };
  assert.equal(lookupByName(map, "SAM "), AMBER);
  assert.equal(lookupByName(map, "sam"), BLUE);
  assert.equal(lookupByName(map, "Ada"), "");
  assert.equal(lookupByName(map, "Lee"), "");
  assert.equal(lookupByName(null, "Sam"), "");
});

test("a three-way merge takes their change where mine kept the base, and keeps every name", () => {
  assert.deepEqual(mergePersonColors({ Sam: BLUE }, { Sam: BLUE }, { sam: AMBER }), { Sam: AMBER });
  assert.deepEqual(mergePersonColors({ Sam: BLUE }, { Sam: VIOLET }, { Sam: AMBER }), { Sam: VIOLET });
  assert.deepEqual(mergePersonColors(null, { Sam: BLUE }, { Ada: GREEN }), { Sam: BLUE, Ada: GREEN });
  assert.deepEqual(mergePersonColors({ Lee: GREEN }, {}, {}), { Lee: GREEN });
  assert.deepEqual(mergePersonColors({ Sam: BLUE }, { Sam: BLUE }, { SAM: AMBER, Ada: VIOLET }), { Sam: AMBER, Ada: VIOLET });
  assert.equal(mergePersonColors(null, null, null), null);
  assert.equal(mergePersonColors({ Sam: "bad" }, [], "x"), null);
});
