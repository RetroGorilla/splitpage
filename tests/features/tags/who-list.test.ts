import { test } from "node:test";
import assert from "node:assert/strict";
import { whoChoices, whoOpensAt } from "../../../src/features/tags/who-list.ts";

const PEOPLE = [{ id: "p1", name: "Sam" }, { id: "p2", name: "Sandy Lee" }, { id: "p3", name: "Ann" }];

test("the @ list opens only for an @ at the start of a line or after whitespace or punctuation", () => {
  assert.equal(whoOpensAt("@", 1), 0);
  assert.equal(whoOpensAt("Ask @", 5), 4);
  assert.equal(whoOpensAt("one\n@", 5), 4);
  assert.equal(whoOpensAt("(@", 2), 1);
  assert.equal(whoOpensAt("adam@", 5), null);
  assert.equal(whoOpensAt("adam@x.com", 5), null);
  assert.equal(whoOpensAt("Ask @", 4), null, "the caret is not after an @");
});

test("the list offers People whose name starts with what was typed, then the typed name if it is new", () => {
  assert.deepEqual(whoChoices(PEOPLE, ""), ["Sam", "Sandy Lee", "Ann"]);
  assert.deepEqual(whoChoices(PEOPLE, "sa"), ["Sam", "Sandy Lee", "sa"]);
  assert.deepEqual(whoChoices(PEOPLE, "SAM"), ["Sam"]);
  assert.deepEqual(whoChoices(PEOPLE, "Robin"), ["Robin"]);
  assert.deepEqual(whoChoices(PEOPLE, "Sandy L"), ["Sandy Lee", "Sandy L"]);
});

test("the list closes on a new line, a leading space, or a space no person's name continues", () => {
  assert.equal(whoChoices(PEOPLE, "Sam\nx"), null);
  assert.equal(whoChoices(PEOPLE, " Sam"), null);
  assert.equal(whoChoices(PEOPLE, "Bo went"), null);
  assert.equal(whoChoices(PEOPLE, "x".repeat(61)), null);
  assert.equal(whoChoices([], "Bo "), null);
});

test("the list shows at most eight people", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: "p" + i, name: "Pat " + i }));
  assert.equal(whoChoices(many, "")?.length, 8);
  assert.deepEqual(whoChoices(many, "pat 1"), ["Pat 1", "Pat 10", "Pat 11"]);
});
