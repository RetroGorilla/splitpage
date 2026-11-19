import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { observeRemoteBeatIds, observeRemoteRemoval, putNoticeBack, readNotice } from "../../src/native-notice/yjs.ts";
import { ROW_MAKERS, ROW_OPTIONS } from "../../src/native-row-record/variants.ts";
import { MODES } from "../native-chosen/engine.ts";
import { GENERATED_SPEC, generateHistory } from "../native-chosen/generate.ts";
import { b, h } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import type { Step } from "../native-chosen/play.ts";
import { act, intoScene, justTwo, redo, remove, rowAfter, rowBefore, rowTop, split, sync, undo } from "../native-rank-undo/histories.ts";
import { countBoundaries, drive } from "./drive.ts";
import { ROW_HISTORIES } from "./histories.ts";
import { inWorld, stored } from "./world.ts";
import type { World } from "./world.ts";

const ALICE = 0, BOB = 1;
const race: Step[] = [split(ALICE, "B", 0, "N"), ...sync(2), remove(BOB, "N"), ...sync(2), undo(ALICE), ...sync(2), undo(BOB), ...sync(2)];
const type = (by: number, id: string, field: "audio" | "visual", at: number, text: string): Step => act(by, { op: "type", id, field, at, text });
const rankOf = (world: World, id = "N"): boolean => typeof world.peer(ALICE).storedRank("b", id) === "string";

test("E17 review 1: restoring from the notice and the remote-removal observers", () => {
  const restored: Record<string, unknown> = {};
  for (const option of ROW_OPTIONS) inWorld(option, justTwo(), 2, world => {
    const alice = world.peer(ALICE), old = readNotice(alice);
    world.run([...race, remove(ALICE, "A")]);
    const before = Y.snapshot(alice.doc);
    let message = "";
    try { putNoticeBack(alice, old, "A", "A2", 1); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    restored[option] = { message, wrote: !Y.equalSnapshots(before, Y.snapshot(alice.doc)), rows: world.rows() };
  });
  assert.deepEqual(restored, {
    K: { message: "Expected a flat rank", wrote: false, rows: ["B:  / ", "N: b / "] },
    R: { message: "", wrote: true, rows: ["A2: a / ", "B: b / "] },
    U: { message: "Expected a flat rank", wrote: false, rows: ["B:  / ", "N: b / "] }
  });
  const observed: Record<string, unknown> = {};
  for (const option of ROW_OPTIONS) inWorld(option, justTwo(), 2, world => {
    world.run([split(ALICE, "B", 0, "N"), ...sync(2), undo(ALICE)]);
    const map: string[] = [], rows: string[] = [];
    observeRemoteBeatIds(world.peer(BOB), ids => map.push(...ids));
    observeRemoteRemoval(world.peer(BOB), (was, now) => rows.push(...was.flatMap(beat => now.some(other => other.id === beat.id) ? [] : [String(beat.id)])));
    world.run([{ from: ALICE, to: BOB }]);
    observed[option] = { map, rows };
  });
  assert.deepEqual(observed, { K: { map: ["N"], rows: ["N"] }, R: { map: ["N"], rows: ["N"] }, U: { map: [], rows: ["N"] } });
});

const bcd = (): Spec => ({ order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "bcd"] } }, beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: {} });

// why: expected rows and storage are written from the commands; all copies and a fresh reader must agree
test("E17 review 2: where later edits go under R after the race", () => {
  const edits: Step[] = [split(ALICE, "B", 0, "N"), ...sync(2), act(BOB, { op: "field", id: "N", key: "status", value: "done" }), type(BOB, "N", "visual", 0, "v"),
    remove(BOB, "N"), ...sync(2), undo(ALICE), ...sync(2), undo(BOB), ...sync(2)];
  const cases: [string, Step[], string[], string, boolean][] = [
    ["the race", race, ["A: a / ", "B: bcd / "], "[A]a[B][N]bcd", false],
    ["Alice redoes her split", [...edits, redo(ALICE), ...sync(2)], ["A: a / ", "B:  / ", "N: bcd / v"], "[A]a[B][N]bcd", true],
    ["Bob redoes his cut", [...race, redo(BOB), ...sync(2)], ["A: a / ", "B:  / "], "[A]a[B]", false],
    ["Bob redoes his cut and undoes it", [...race, redo(BOB), ...sync(2), undo(BOB), ...sync(2)], ["A: a / ", "B: bcd / "], "[A]a[B][N]bcd", false],
    ["Bob types x in B", [...race, type(BOB, "B", "audio", 1, "x"), ...sync(2)], ["A: a / ", "B: bxcd / "], "[A]a[B][N]bxcd", false],
    ["Bob types x in B, Alice redoes", [...race, type(BOB, "B", "audio", 1, "x"), ...sync(2), redo(ALICE), ...sync(2)], ["A: a / ", "B:  / ", "N: bxcd / "], "[A]a[B][N]bxcd", true],
    ["Alice types x in B, Bob redoes", [...race, type(ALICE, "B", "audio", 1, "x"), ...sync(2), redo(BOB), ...sync(2)], ["A: a / ", "B: x / "], "[A]a[B]x", false],
    ["Bob splits B at 1", [...race, split(BOB, "B", 1, "M"), ...sync(2)], ["A: a / ", "B: b / ", "M: cd / "], "[A]a[B][N]b[M]cd", false],
    ["Bob splits B at 1, Alice redoes", [...race, split(BOB, "B", 1, "M"), ...sync(2), redo(ALICE), ...sync(2)], ["A: a / ", "B:  / ", "N: b / ", "M: cd / "], "[A]a[B][N]b[M]cd", true],
    ["cut B", [...race, remove(ALICE, "B"), ...sync(2)], ["A: a / "], "[A]a", false],
    ["cut B, undo", [...race, remove(ALICE, "B"), ...sync(2), undo(ALICE), ...sync(2)], ["A: a / ", "B: bcd / "], "[A]a[B][N]bcd", false],
    ["move B above A", [...race, rowBefore(ALICE, "B", "A"), ...sync(2)], ["B: bcd / ", "A: a / "], "[A]a[B][N]bcd", false],
    ["join B to A", [...race, act(ALICE, { op: "join", id: "B" }), ...sync(2)], ["A(A+B): a bcd / "], "[A]a[B][N]bcd", false],
    ["join B to A, unjoin", [...race, act(ALICE, { op: "join", id: "B" }), ...sync(2), act(ALICE, { op: "unjoin", id: "B" }), ...sync(2)], ["A: a / ", "B: bcd / "], "[A]a[B][N]bcd", false]
  ];
  const settledBeats = inWorld("R", bcd(), 2, world => JSON.stringify(world.run(race).peer(ALICE).beats.toJSON()));
  for (const [label, steps, rows, storage, whole] of cases) inWorld("R", bcd(), 2, world => {
    world.run(steps);
    const alice = world.peer(ALICE);
    assert.deepEqual([world.rows(), stored(alice), world.agree(), world.threw], [rows, storage, true, []], label);
    assert.deepEqual([alice.beats.has("N"), alice.visuals.has("N"), rankOf(world)], [whole, whole, whole], label);
    if (label === "Alice redoes her split") assert.deepEqual([alice.beats.get("N")?.get("status"), alice.visuals.get("N")?.toString()], ["done", "v"]);
    const beats = alice.beats.toJSON() as Record<string, Record<string, unknown>>, before = JSON.parse(settledBeats) as typeof beats;
    if (label === "move B above A") assert.deepEqual([beats.A, Object.keys(beats.B ?? {}), beats.B?.e10Rank !== before.B?.e10Rank], [before.A, ["e10Rank"], true]);
    if (label === "join B to A") assert.deepEqual(beats, { ...before, B: { ...before.B, joined: { into: "A", glue: " " } } });
    if (label === "join B to A, unjoin") assert.deepEqual(beats, before);
  });
});

test("E17 follow-up: what every copy shows before and after Bob's restoring undo", () => {
  const empty = ["A: a / ", "B:  / "];
  const expected: Record<string, Record<"K" | "R" | "U", string[]>> = {
    b: { K: ["A: a / ", "B:  / ", "N: b / "], R: ["A: a / ", "B: b / "], U: ["A: a / ", "B:  / ", "N: b / "] },
    bcd: { K: ["A: a / ", "B:  / ", "N: bcd / "], R: ["A: a / ", "B: bcd / "], U: ["A: a / ", "B:  / ", "N: bcd / "] }
  };
  const bobUndo = race.length - 3;
  for (const option of ROW_OPTIONS) for (const [name, spec] of [["b", justTwo()], ["bcd", bcd()]] as const) inWorld(option, spec, 2, world => {
    world.run(race.slice(0, bobUndo));
    assert.deepEqual([world.rows(ALICE), world.rows(BOB)], [empty, empty], `${option} ${name} before`);
    world.run(race.slice(bobUndo));
    assert.deepEqual([world.rows(ALICE), world.rows(BOB), world.agree()], [expected[name]?.[option], expected[name]?.[option], true], `${option} ${name} after`);
  });
});

// why: the hidden marker sits where B's own text ended, so typing at that offset or before stays in B on Alice's redo
test("E17 follow-up: where the seam sits when R shows the hidden row's text in B", () => {
  const own = (): Spec => ({ order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "xbcd"] } }, beats: { A: {}, B: {} }, visuals: { A: "", B: "" }, headings: {} });
  const ownRace: Step[] = [split(ALICE, "B", 1, "N"), ...sync(2), remove(BOB, "N"), ...sync(2), undo(ALICE), ...sync(2), undo(BOB), ...sync(2)];
  const cases: [string, () => Spec, Step[], number, string, string[], string, string[]][] = [
    ["y at 0", bcd, race, 0, "y", ["A: a / ", "B: ybcd / "], "[A]a[B]y[N]bcd", ["A: a / ", "B: y / ", "N: bcd / "]],
    ["z at the end", bcd, race, 3, "z", ["A: a / ", "B: bcdz / "], "[A]a[B][N]bcdz", ["A: a / ", "B:  / ", "N: bcdz / "]],
    ["B's own x: y at 0", own, ownRace, 0, "y", ["A: a / ", "B: yxbcd / "], "[A]a[B]yx[N]bcd", ["A: a / ", "B: yx / ", "N: bcd / "]],
    ["B's own x: y at 1", own, ownRace, 1, "y", ["A: a / ", "B: xybcd / "], "[A]a[B]xy[N]bcd", ["A: a / ", "B: xy / ", "N: bcd / "]],
    ["B's own x: y at 2", own, ownRace, 2, "y", ["A: a / ", "B: xbycd / "], "[A]a[B]x[N]bycd", ["A: a / ", "B: x / ", "N: bycd / "]],
    ["B's own x: z at the end", own, ownRace, 4, "z", ["A: a / ", "B: xbcdz / "], "[A]a[B]x[N]bcdz", ["A: a / ", "B: x / ", "N: bcdz / "]]
  ];
  for (const [label, spec, base, at, letter, typed, storage, redone] of cases) inWorld("R", spec(), 2, world => {
    world.run([...base, type(BOB, "B", "audio", at, letter), ...sync(2)]);
    assert.deepEqual([world.rows(), stored(world.peer(ALICE))], [typed, storage], label);
    world.run([redo(ALICE), ...sync(2)]);
    assert.deepEqual([world.rows(), stored(world.peer(ALICE)), world.agree(), world.threw], [redone, storage, true, []], label);
  });
});

test("E17 review 2: R reads a bare boundary at a segment's start, after a heading and in a leading span", () => {
  const one = (units: Spec["segments"][string], extra: Partial<Spec> = {}): Spec => ({ order: ["S"], segments: { S: units }, beats: { A: {}, N: {} }, visuals: { A: "", N: "" }, headings: {}, ...extra });
  const cases: [string, Spec, string[], string[] | null][] = [
    ["head", one({ head: b("N"), units: ["n", b("A"), "a"] }), ["A: na / "], null],
    ["bare segment after a beat", { ...one({ head: b("A"), units: ["a"] }), order: ["S", "T"], segments: { S: { head: b("A"), units: ["a"] }, T: { head: b("N"), units: ["n"] } } }, ["A: an / "], null],
    ["bare segment first", { ...one({ head: b("A"), units: ["a"] }), order: ["T", "S"], segments: { S: { head: b("A"), units: ["a"] }, T: { head: b("N"), units: ["n"] } } }, ["A: na / "], null],
    ["after a heading", { order: ["S"], segments: { S: { head: h("H"), units: [b("N"), "n", b("B"), "b"] } }, beats: { B: {}, N: {} }, visuals: { B: "", N: "" }, headings: { H: {} } }, ["#H ", "B: nb / "], null],
    ["after a heading, no beat", { order: ["S"], segments: { S: { head: h("H"), units: [b("N"), "n"] } }, beats: { N: {} }, visuals: { N: "" }, headings: { H: {} } }, ["~stray: n / ", "#H "], null],
    ["split A at 1, one leading letter", one({ head: b("N"), units: ["n", b("A"), "cda"] }), ["A: ncda / "], ["A: n / ", "M: cda / "]],
    ["split A at 1, three leading letters", one({ head: b("N"), units: ["ncd", b("A"), "a"] }), ["A: ncda / "], ["A: ncd / ", "M: a / "]]
  ];
  for (const [label, spec, shown, afterSplit] of cases) inWorld("R", spec, 2, world => {
    const first = world.peer(0);
    // why: a seeded beat needs its record, so N's record and cell are removed afterwards by a write no undo tracks
    first.doc.transact(() => { first.beats.delete("N"); first.visuals.delete("N"); });
    first.changes();
    world.settle();
    assert.deepEqual(world.rows(), shown, label);
    if (afterSplit) {
      world.run([split(ALICE, "A", 1, "M"), ...sync(2)]);
      assert.deepEqual(world.rows(), afterSplit, label);
    }
    assert.deepEqual([world.agree(), world.threw], [true, []], label);
  });
});

test("E17 review 3: under U the restored row's place follows rule (e)", () => {
  const scene = (): Spec => ({
    order: ["S"], segments: { S: { head: b("A"), units: ["a", b("B"), "b", h("H"), b("C"), "c"] } },
    beats: { A: {}, B: {}, C: {} }, visuals: { A: "", B: "", C: "" }, headings: { H: {} }
  });
  const intoH: Step[] = [intoScene(ALICE, "B", "H"), ...sync(2), ...race];
  const cases: [string, Spec, Step[], Record<"K" | "R" | "U", [string[], boolean]>][] = [
    ["move B to the top", justTwo(), [...race, rowTop(ALICE, "B"), ...sync(2)],
      { K: [["B:  / ", "N: b / ", "A: a / "], false], R: [["B: b / ", "A: a / "], false], U: [["B:  / ", "A: a / ", "N: b / "], true] }],
    ["move B across the heading", scene(), [...race, rowAfter(ALICE, "B", "C"), ...sync(2)],
      { K: [["A: a / ", "B:  / ", "N: b / ", "#H ", "C: c / "], false], R: [["A: a / ", "#H ", "C: c / ", "B: b / "], false], U: [["A: a / ", "N: b / ", "#H ", "C: c / ", "B:  / "], true] }],
    ["B in scene H, race", scene(), intoH,
      { K: [["A: a / ", "#H ", "B:  / ", "N: b / ", "C: c / "], false], R: [["A: a / ", "#H ", "B: b / ", "C: c / "], false], U: [["A: a / ", "#H ", "B:  / ", "N: b / ", "C: c / "], false] }],
    ["B in scene H, race, cut B", scene(), [...intoH, remove(ALICE, "B"), ...sync(2)],
      { K: [["A: a / ", "N: b / ", "#H ", "C: c / "], false], R: [["A: a / ", "#H ", "C: c / "], false], U: [["A: a / ", "N: b / ", "#H ", "C: c / "], false] }],
    ["B in scene H, race, cut B, undo", scene(), [...intoH, remove(ALICE, "B"), ...sync(2), undo(ALICE), ...sync(2)],
      { K: [["A: a / ", "#H ", "B:  / ", "N: b / ", "C: c / "], false], R: [["A: a / ", "#H ", "B: b / ", "C: c / "], false], U: [["A: a / ", "#H ", "B:  / ", "N: b / ", "C: c / "], false] }]
  ];
  for (const [label, spec, steps, expected] of cases) for (const option of ROW_OPTIONS) inWorld(option, spec, 2, world => {
    world.run(steps);
    assert.deepEqual([world.rows(), rankOf(world)], expected[option], `${option} ${label}`);
    assert.deepEqual([world.rows(BOB), world.agree()], [world.rows(), true], `${option} ${label}`);
    assert.deepEqual(world.threw, option === "K" && label.startsWith("move") ? ["step 12 move: Missing record b:N"] : [], `${option} ${label}`);
  });
});

test("E17 review 4: U's three hidden letters are unplaced visuals; only seed 252's creator can redo", () => {
  const found: Record<number, unknown> = {};
  for (const [seedNumber, beat, letter] of [[252, "N25", "К"], [287, "N22", "З"], [367, "N12", "Г"]] as const) {
    const { steps } = generateHistory(seedNumber, 40, false, "cells");
    inWorld("U", GENERATED_SPEC(), 3, world => {
      world.run(steps).settle();
      const hub = world.peer(0), creator = steps.find(step => "cmd" in step && step.cmd.op === "split" && step.cmd.created === beat);
      assert.ok(creator && "by" in creator);
      assert.ok(!world.rows().some(row => row.includes(letter)));
      const unplaced = hub.recovery().some(entry => entry.beat === beat && entry.reason === "unplaced" && entry.visual === letter);
      const before = world.rows();
      world.run([redo(creator.by)]).settle();
      found[seedNumber] = { unplaced, redoChanged: JSON.stringify(before) !== JSON.stringify(world.rows()), shown: world.rows().some(row => row.startsWith(`${beat}:`) && row.endsWith(letter)), agree: world.agree() };
    });
  }
  assert.deepEqual(found, {
    252: { unplaced: true, redoChanged: true, shown: true, agree: true },
    287: { unplaced: true, redoChanged: false, shown: false, agree: true },
    367: { unplaced: true, redoChanged: false, shown: false, agree: true }
  });
});

test("E17 review 4: what U's filter keeps, on undo and on redo", () => {
  for (const option of ROW_OPTIONS) {
    inWorld(option, justTwo(), 2, world => {
      world.run([split(ALICE, "B", 0, "N"), ...sync(2), undo(ALICE), redo(ALICE), ...sync(2)]);
      assert.deepEqual([world.rows(), rankOf(world), countBoundaries(world.peer(ALICE), "N")], [["A: a / ", "B:  / ", "N: b / "], true, 1], option);
    });
    inWorld(option, justTwo(), 2, world => {
      world.run([...race, redo(ALICE), ...sync(2)]);
      assert.deepEqual([world.rows(), rankOf(world), countBoundaries(world.peer(ALICE), "N"), world.agree()], [["A: a / ", "B:  / ", "N: b / "], true, 1, true], option);
    });
    inWorld(option, justTwo(), 2, world => {
      world.run([split(ALICE, "B", 0, "N"), ...sync(2), type(BOB, "N", "visual", 0, "v"), ...sync(2), undo(ALICE), ...sync(2)]);
      const cell = () => world.peer(BOB).visuals.get("N")?.toString() ?? null, states = [cell()];
      world.run([undo(BOB), ...sync(2)]); states.push(cell());
      world.run([redo(BOB), ...sync(2)]); states.push(cell());
      assert.deepEqual([states, world.threw], [option === "U" ? ["v", "", "v"] : [null, null, null], []], option);
    });
    inWorld(option, justTwo(), 2, world => {
      const alice = world.peer(ALICE), has = () => [alice.beats.has("B"), alice.visuals.has("B")];
      alice.transact(() => { alice.beats.delete("B"); alice.visuals.delete("B"); });
      alice.changes();
      const states = [has()];
      world.run([undo(ALICE)]); states.push(has());
      world.run([redo(ALICE)]); states.push(has());
      assert.deepEqual(states, [[false, false], [true, true], option === "U" ? [true, true] : [false, false]], option);
    });
  }
});

test("E17 review 5: two stored N markers, then both cut N unseen and both undo", () => {
  const labels = ["Alice undoes before Bob cuts; Bob redoes, Alice redoes, Bob undoes", "Bob cuts and undoes while Alice undoes, offline; Bob redoes, Alice redoes, Bob undoes"];
  const both: Step[] = [remove(ALICE, "N"), remove(BOB, "N"), ...sync(2), undo(ALICE), undo(BOB), ...sync(2)];
  const single: Step[] = [remove(ALICE, "N"), ...sync(2), undo(ALICE), ...sync(2)];
  for (const label of labels) {
    const history = ROW_HISTORIES.find(entry => entry.label === label);
    assert.ok(history, label);
    for (const option of ROW_OPTIONS) for (const [at, mode] of MODES.entries()) {
      for (const [more, rows, markers] of [[[], ["A: a / ", "B:  / ", "N: b / "], 2], [both, ["A: a / ", "B:  / ", "N: bb / "], 4], [single, ["A: a / ", "B:  / ", "N: b / "], 2]] as const) {
        const result = drive(ROW_MAKERS[option], justTwo(), [...history.steps, ...more], 2, mode, at);
        assert.deepEqual([result.threw, result.disagree], [[], false], `${option} ${mode}`);
        for (const view of result.settled) assert.deepEqual([view.rows, view.boundaries], [rows, markers], `${option} ${mode} ${more.length}`);
      }
    }
  }
});

test("E17 review 6: a container made in an outer untracked transaction survives undo, and redo restores the rest", () => {
  for (const option of ROW_OPTIONS) inWorld(option, justTwo(), 1, world => {
    const replica = world.peer(ALICE), text = replica.segments.get("S")?.get("text"), record = new Y.Map<unknown>();
    assert.ok(text instanceof Y.Text);
    replica.doc.transact(() => { replica.beats.set("N", record); replica.visuals.set("N", new Y.Text()); });
    replica.transact(() => { text.insertEmbed(1, { b: "N" }); record.set("e10Rank", "000010V"); });
    replica.changes();
    const read = (): unknown[] => [replica.beats.has("N"), replica.visuals.has("N"), rankOf(world), countBoundaries(replica, "N")];
    const states = [read()];
    world.run([undo(ALICE)]); states.push(read());
    world.run([redo(ALICE)]); states.push(read());
    assert.deepEqual([states, world.threw], [[[true, true, true, 1], [true, true, false, 0], [true, true, true, 1]], []], option);
  });
});
