import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCell, settleCues } from "../../../src/core/text/runs.ts";
import { joinCells, splitCell } from "../../../src/core/text/edits.ts";
import {
  cueLines,
  cueShortcut,
  cuesInCell,
  editCues,
  flattenCues,
  importCues,
  withoutCues
} from "../../../src/core/text/cues.ts";
import { spokenText, toPlainText } from "../../../src/core/text/projections.ts";
import { B, NBSP, T } from "./cells.ts";

const CUE = { cue: true } as const;

test("a cue mark stays only on a line that reads as a cue, and then covers all of the line", () => {
  assert.deepEqual(normalizeCell([T("SFX: rain", CUE)]), [T("SFX: rain", CUE)]);
  assert.deepEqual(normalizeCell([T("rain", CUE)]), [T("rain")]);
  assert.deepEqual(normalizeCell([T("SFX:"), T(" rain", { cue: true, b: true })]), [T("SFX:", CUE), T(" rain", { b: true, cue: true })]);
  assert.deepEqual(normalizeCell([T("sfx" + NBSP + ":x", CUE)]), [T("sfx" + NBSP + ":x", CUE)]);
  assert.deepEqual(normalizeCell([T("SFX: a\nb", CUE)]), [T("SFX: a", CUE), T("\nb")], "a line break is never a cue");
  assert.deepEqual(normalizeCell([T("x\nSFX: a", CUE)]), [T("x\n"), T("SFX: a", CUE)]);
  assert.deepEqual(normalizeCell([T("Music: ", CUE), B("bs1"), T(" theme")]), [T("Music: ", CUE), B("bs1"), T(" theme", CUE)]);
  assert.deepEqual(normalizeCell([B("bs1"), T("sfx: x", CUE)]), [B("bs1"), T("sfx: x")], "a key at the start means the line does not open with SFX");
});

test("settleCues leaves cells without cues as they are", () => {
  const runs = [T("a"), T("b")];
  assert.equal(settleCues(runs), runs);
});

test("a split before a cue's colon loses the cue on both sides, and joining does not bring it back", () => {
  const cell = normalizeCell([T("SFX: rain", CUE)]);
  for (const at of [1, 2, 3]) {
    const [a, b] = splitCell(cell, at);
    assert.deepEqual([a, b], [[T("SFX: rain".slice(0, at))], [T("SFX: rain".slice(at))]], "at " + at);
    assert.deepEqual(joinCells(a, b), [T("SFX: rain")], "at " + at);
  }
  assert.deepEqual(splitCell(cell, 0), [[], cell], "at the line's start the whole cue moves");
});

test("a split after a cue's colon keeps the cue on the left, and joining restores it on the whole line", () => {
  const cell = normalizeCell([T("SFX: rain", CUE)]);
  assert.deepEqual(splitCell(cell, 4), [[T("SFX:", CUE)], [T(" rain")]]);
  assert.deepEqual(splitCell(cell, 6), [[T("SFX: r", CUE)], [T("ain")]]);
  for (const at of [4, 6, 9]) {
    const [a, b] = splitCell(cell, at);
    assert.deepEqual(joinCells(a, b), cell, "at " + at);
  }
});

test("cue lines are counted in positions, a b-roll key and the line feed one each", () => {
  assert.deepEqual(cueLines([T("ab\n"), T("SFX: x", CUE), B("bs1"), T("\n\nz")]), [
    { from: 0, to: 2, cue: false },
    { from: 3, to: 10, cue: true },
    { from: 11, to: 11, cue: false },
    { from: 12, to: 13, cue: false }
  ]);
  assert.deepEqual(cueLines([T("ab\n"), B("bs1"), T("SFX: x", CUE)]), [{ from: 0, to: 2, cue: false }, { from: 3, to: 10, cue: false }],
    "a key that opens the line means it does not read as a cue");
  assert.deepEqual(cueLines([]), [{ from: 0, to: 0, cue: false }]);
});

test("a cue's name leaves out tags, directions and spare spaces; its text leaves out b-roll keys", () => {
  assert.deepEqual(cuesInCell([
    T("Music: ", CUE), T("Theme", { cue: true, tag: "t:sound:Theme" }), T(" swell ", CUE), T("(soft)", { cue: true, dir: true }),
    T(" now", CUE), B("bs1"), T("\nsfx" + NBSP + ":  door  slam", CUE)
  ]), [
    { kind: "music", name: "swell now", text: "Music: Theme swell (soft) now" },
    { kind: "sfx", name: "door slam", text: "sfx :  door  slam" }
  ]);
  assert.deepEqual(cuesInCell([T("SFX:", CUE)]), [{ kind: "sfx", name: "", text: "SFX:" }]);
  assert.deepEqual(cuesInCell([T("SFX: rain")]), [], "no cue mark, no cue");
});

test("without cues: each cue line goes with one line feed, whichever end it is at", () => {
  const three = normalizeCell([T("SFX: one", CUE), T("\nmiddle\n"), T("MUSIC: two", CUE)]);
  assert.deepEqual(withoutCues(three), [T("middle")]);
  assert.deepEqual(withoutCues([T("SFX: only", CUE)]), []);
  assert.deepEqual(withoutCues(normalizeCell([T("a\n"), T("SFX: x", CUE), T("\nb")])), [T("a\nb")]);
  const plain = [T("no cues")];
  assert.deepEqual(withoutCues(plain), plain);
  assert.equal(toPlainText(three), "SFX: one\nmiddle\nMUSIC: two");
  assert.equal(toPlainText(three, { cues: "omit" }), "middle");
  assert.equal(spokenText(normalizeCell([T("SFX: rain", CUE), T("\nHello "), T("aside", { dir: true }), T(", you.")])), "Hello, you.");
});

test("typing the colon of SFX: or MUSIC: at a line's start makes the line a cue, once", () => {
  assert.deepEqual(cueShortcut([T("intro\nsfx:")], 10), [T("intro\n"), T("sfx:", CUE)]);
  assert.deepEqual(cueShortcut([T("intro\n  Music :")], 15), [T("intro\n"), T("  Music :", CUE)]);
  assert.deepEqual(cueShortcut([T("sfx: rain\nnext")], 4), [T("sfx: rain", CUE), T("\nnext")], "the rest of the line comes too");
  assert.equal(cueShortcut([T("a sfx:")], 6), null);
  assert.equal(cueShortcut([T("sfx")], 3), null);
  assert.equal(cueShortcut([T("sfx: x")], 6), null, "only just after the colon");
  assert.equal(cueShortcut(normalizeCell([T("sfx:", CUE)]), 4), null);
});

test("importing marks every line that reads as a cue", () => {
  assert.deepEqual(importCues([T("SFX: rain\nnot a cue\n  music : theme")]),
    [T("SFX: rain", CUE), T("\nnot a cue\n"), T("  music : theme", CUE)]);
  const none = normalizeCell([T("nothing here")]);
  assert.deepEqual(importCues(none), none);
});

test("editing a cue renames its name where it stands, or takes the cue mark off", () => {
  assert.deepEqual(editCues(normalizeCell([T("SFX:door slam", CUE)]), (n) => n === "door slam", "Door"), [T("SFX: Door", CUE)]);
  assert.deepEqual(editCues(normalizeCell([T("SFX: door ", CUE), T("(soft)", { cue: true, dir: true }), T(" slam", CUE)]), (n) => n === "door slam", "Bang"),
    [T("SFX: Bang ", CUE), T("(soft)", { dir: true, cue: true })]);
  assert.deepEqual(editCues(normalizeCell([T("SFX: rain", CUE)]), () => true, null), [T("SFX: rain")]);
  assert.deepEqual(editCues(normalizeCell([T("SFX:", CUE)]), () => true, "x"), [T("SFX:", CUE)], "a cue with no name has none to rename");
  assert.deepEqual(editCues(normalizeCell([T("SFX: rain", CUE)]), () => false, "x"), [T("SFX: rain", CUE)]);
  const both = normalizeCell([T("SFX: rain", CUE), T("\n"), T("SFX: rain", CUE)]);
  assert.deepEqual(editCues(both, (n) => n === "rain", "Storm"), [T("SFX: Storm", CUE), T("\n"), T("SFX: Storm", CUE)]);
});

test("flattening takes every cue mark off and keeps the rest", () => {
  assert.deepEqual(flattenCues(normalizeCell([T("SFX: rain", { cue: true, b: true })])), [T("SFX: rain", { b: true })]);
  const plain = [T("plain")];
  assert.deepEqual(flattenCues(plain), plain);
});
