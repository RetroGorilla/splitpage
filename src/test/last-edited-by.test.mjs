import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import { loadInitialState, migrateDocument } from "../js/02b-doc-id.js";
import { mergeStates } from "../js/03-sync.js";

const GRIN = String.fromCodePoint(0x1F600);
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function load(lastEditedBy) {
  return migrateRows({ schema: 2, title: "T", rows: [], rev: 3, lastEditedBy });
}

for (const [label, value] of [["a number", 42], ["an object", { name: "Sam" }], ["null", null], ["an array", ["Sam"]], ["a boolean", true]]) {
  test(`lastEditedBy: ${label} is treated as absent`, () => {
    const s = load(value);
    assert.ok(!("lastEditedBy" in s) || s.lastEditedBy === undefined);
  });
}

test("lastEditedBy: a very long name is cut to 30 characters", () => {
  assert.equal(load("x".repeat(5000)).lastEditedBy, "x".repeat(30));
});

test("lastEditedBy: a cut never lands inside an emoji", () => {
  const name = load("x".repeat(29) + GRIN + " tail").lastEditedBy;
  assert.equal(name, "x".repeat(29) + GRIN);
  assert.doesNotMatch(name, LONE);
});

test("lastEditedBy: a lone half emoji is removed", () => {
  const half = GRIN.slice(0, 1);
  assert.equal(load("Sam " + half).lastEditedBy, "Sam");
  assert.equal(load(half + "Sam").lastEditedBy, "Sam");
  assert.equal(load("Sam" + GRIN.slice(1) + "!").lastEditedBy, "Sam!");
});

test("lastEditedBy: a name made only of lone halves is treated as absent", () => {
  const s = load(GRIN.slice(0, 1));
  assert.ok(!("lastEditedBy" in s) || s.lastEditedBy === undefined);
});

test("lastEditedBy: a whole emoji name and a plain name load unchanged", () => {
  assert.equal(load("Ada " + GRIN).lastEditedBy, "Ada " + GRIN);
  assert.equal(load("Sam").lastEditedBy, "Sam");
});

test("lastEditedBy: loading never throws", () => {
  for (const v of [undefined, NaN, 0, "", " ", "\u0000", {}, [], () => 1, 10n]) {
    assert.doesNotThrow(() => load(v));
  }
});

test("lastEditedBy: a second load changes nothing", () => {
  for (const v of ["x".repeat(500), "Sam " + GRIN.slice(0, 1), "x".repeat(29) + GRIN + "y", 7, null, "Ann"]) {
    const once = load(v);
    const twice = migrateRows(JSON.parse(JSON.stringify(once)));
    assert.equal(JSON.stringify(twice), JSON.stringify(once));
  }
});

test("lastEditedBy: a file opened from disk is cleaned", () => {
  const s = migrateDocument({ schema: 2, title: "T", rows: [], rev: 3, lastEditedBy: "Sam " + GRIN.slice(0, 1) }, { kind: "file" });
  assert.equal(s.lastEditedBy, "Sam");
});

test("lastEditedBy: a merge carries a cleaned name from the other side", () => {
  const base = { schema: 2, title: "T", rows: [], rev: 1, lastEditedBy: "Base" };
  const mine = { ...base, rev: 2, lastEditedBy: "Mine" };
  const theirs = { ...base, rev: 3, lastEditedBy: "x".repeat(300) + GRIN.slice(0, 1) };
  const merged = mergeStates(base, mine, theirs);
  assert.equal(merged.merged.lastEditedBy, "x".repeat(30));
});

test("lastEditedBy: the name the opening toast shows is a sane name", async () => {
  const el = document.createElement("script");
  el.id = "state-data";
  el.type = "application/json";
  el.textContent = JSON.stringify({ schema: 2, title: "T", rows: [], rev: 4, lastEditedBy: "x".repeat(300) + GRIN.slice(0, 1) });
  document.body.appendChild(el);
  try {
    const loaded = await loadInitialState(false);
    assert.equal(loaded.lastEditedBy, "x".repeat(30));
  } finally {
    el.remove();
  }
});
