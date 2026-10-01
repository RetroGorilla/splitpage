import { test } from "node:test";
import assert from "node:assert/strict";
import { createProductionReaders } from "../../../src/core/production/readers.ts";
import { B, T, cue, mapDecoder, tag } from "./cells.ts";

const cells = mapDecoder();
cells.html([]);
const readers = createProductionReaders(cells.decode);

const TAGGED = cells.html([
  T("Put the "), tag("prop", "  Kettle ", "kettle", { b: true }), tag("prop", "  Kettle ", " on"), T(" and the "),
  tag("location", "Kitchen", "kitchen "), T(" "), tag("prop", "   ", "blank"), T(" "), tag("prop", "Kettle", "again")
]);
const CUED = cells.html([
  T("Intro.\n"), cue("SFX: door slam"), T("\n"), cue("Music: " + "x".repeat(79) + " yy"), T("\n"), cue("SFX:   ")
]);
const SPOKEN = cells.html([T("one two  "), T("(aside here)", { dir: true }), T(" three\nfour")]);
const BROLL = cells.html([
  B("bs1"), T(" the gulls "), tag("prop", "Kite", "kite"), T("\nover the pier\nB-roll: drone sweep "), tag("prop", "Drone"),
  T(" and "), tag("prop", "drone ", "the drone"), T("\nno marker here")
]);

test("tagsInField reads each tag span once, by trimmed name, with the text it covers", () => {
  assert.deepEqual(readers.tagsInField(TAGGED), [
    { catId: "prop", name: "Kettle", text: "kettle on" },
    { catId: "location", name: "Kitchen", text: "kitchen" },
    { catId: "prop", name: "Kettle", text: "again" }
  ]);
  assert.deepEqual(readers.tagsInField(""), []);
  assert.deepEqual(readers.tagsInField(null), []);
});

test("tagsInField adds each cue line as a sound, its name cut at 80 characters", () => {
  assert.deepEqual(readers.tagsInField(CUED), [
    { catId: "sound", name: "door slam", text: "SFX: door slam" },
    { catId: "sound", name: "x".repeat(79), text: "Music: " + "x".repeat(79) + " yy" }
  ]);
  assert.deepEqual(readers.cueNamesInField(CUED), ["door slam", "x".repeat(79)]);
  assert.deepEqual(readers.cueNamesInField(TAGGED), [], "no cue markup, no cue names");
});

test("wordCount counts the spoken words: directions are left out", () => {
  assert.equal(readers.wordCount(SPOKEN), 4);
  assert.equal(readers.wordCount(""), 0);
  assert.equal(readers.wordCount(undefined), 0);
});

test("brollInField and brollPropsInField read the b-roll lines and the props tagged on each", () => {
  assert.deepEqual(readers.brollInField(BROLL), [
    { id: "bs1", name: "the gulls kite", desc: "over the pier" },
    { id: "", name: "drone sweep Drone and the drone", desc: "no marker here" }
  ]);
  assert.deepEqual(readers.brollPropsInField(BROLL), [["Kite"], ["Drone"]]);
});

test("each reader decodes a cell once and answers again from its memo", () => {
  cells.decoded.length = 0;
  const fresh = createProductionReaders(cells.decode);
  const first = fresh.tagsInField(TAGGED);
  assert.equal(fresh.tagsInField(TAGGED), first);
  assert.equal(fresh.brollInField(BROLL), fresh.brollInField(BROLL));
  fresh.wordCount(SPOKEN);
  fresh.wordCount(SPOKEN);
  assert.deepEqual(cells.decoded, [TAGGED, BROLL, SPOKEN]);
  fresh.cueNamesInField(TAGGED);
  assert.deepEqual(cells.decoded, [TAGGED, BROLL, SPOKEN], "a cell without cue markup is not decoded for cue names");
});

test("the readers share no memo with another set of readers", () => {
  const a = createProductionReaders(cells.decode), b = createProductionReaders(cells.decode);
  assert.notEqual(a.tagsInField(TAGGED), b.tagsInField(TAGGED));
  assert.deepEqual(a.tagsInField(TAGGED), b.tagsInField(TAGGED));
});
