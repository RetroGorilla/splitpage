import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerEvent } from "./ledger.ts";
import { lostTags, play } from "./play.ts";
import type { Step, TagAsk } from "./play.ts";
import { base } from "./kit.ts";

const event = (index: number, by: number, seen: number[], op = "format", reverts: number | null = null, redoes: number | null = null): LedgerEvent => ({
  index, by, op, seen: new Set(seen), typed: [], erased: [], deletedBeats: [], seenVisual: [], createdBeats: [], createdSegment: false,
  createdHeading: null, fieldSet: null, reverts, redoes, skipped: []
});
const ask = (index: number, by: number, on: boolean, ids: string[], seen: number[]): TagAsk => ({ index, by, name: "t:prop", on, ids, seen: new Set(seen) });
const keys = (held: Record<string, string[]>) => (id: string): ReadonlySet<string> | undefined => held[id] ? new Set(held[id]) : undefined;
const KEY = "t:prop\u001f2.1";

test("E11 tag count control: the check flags a requested tag missing from a shown letter, and nothing else", () => {
  const asks = [ask(0, 0, true, ["1:5", "1:6"], [])], events = [event(0, 0, []), event(1, 1, [], "type")];
  assert.deepEqual(lostTags(asks, events, keys({ "1:5": [KEY], "1:6": [KEY] })), { requested: 1, kept: 1, lost: [] });
  assert.deepEqual(lostTags(asks, events, keys({ "1:5": [KEY], "1:6": ["b"] })).lost, [{ index: 0, name: "t:prop", letters: 2, missing: 1, concurrent: ["type by 1"] }], "a missing tag is caught");
  assert.deepEqual(lostTags(asks, events, keys({ "1:5": [KEY] })).lost, [], "a deleted letter is not a lost tag");
  assert.deepEqual(lostTags([...asks, ask(2, 1, false, ["1:6"], [0])], [...events, event(2, 1, [0])], keys({ "1:5": [KEY], "1:6": [] })).lost, [], "an untag made after seeing the tag");
  assert.equal(lostTags([...asks, ask(2, 1, false, ["1:6"], [])], [...events, event(2, 1, [])], keys({ "1:5": [KEY], "1:6": [] })).lost.length, 1, "an untag that had not seen the tag does not excuse it");
  assert.deepEqual(lostTags(asks, [...events, event(2, 0, [0], "undo", 0)], keys({})), { requested: 1, kept: 0, lost: [] }, "an undone tag is not asked for any more");
  assert.equal(lostTags(asks, [...events, event(2, 0, [0], "undo", 0), event(3, 0, [0, 2], "redo", null, 2)], keys({ "1:5": [], "1:6": [] })).lost.length, 1, "a redone tag is asked for again");
});

test("E11 tag loss, smallest history: a tag put on letters someone else deleted and brought back by undo, unseen, is lost", () => {
  const steps: Step[] = [
    { by: 0, cmd: { op: "delete", rows: ["B", "D"] } },
    { by: 0, cmd: { op: "undo" } },
    { by: 1, cmd: { op: "format", id: "B", field: "audio", from: 0, to: 1, key: "t:prop", on: true } }
  ];
  for (const mode of ["forward", "reverse", "state"] as const) {
    const result = play({ spec: base(), steps, writers: 2, mode, seed: 1 });
    assert.deepEqual([result.never, result.local], [[], []]);
    // why: the undo restores new copies of the letters; the tag stays on the deleted originals, so no one sees it
    assert.equal(result.lines[1], "B: def / 2", mode);
    assert.deepEqual(result.tags.lost.map(loss => [loss.missing, loss.concurrent]), [[1, ["delete by 0", "undo by 0"]]], mode);
  }
});

test("E11 move counters: a split at the same moment as a move, and two drops onto each other's rows, are each counted once", () => {
  const split: Step[] = [
    { by: 0, cmd: { op: "split", id: "B", at: 1, created: "N" } },
    { by: 1, cmd: { op: "move", drop: { unit: "row", first: "B", target: "D", after: true } } }
  ];
  const swap: Step[] = [
    { by: 0, cmd: { op: "move", drop: { unit: "row", first: "A", target: "C", after: true } } },
    { by: 1, cmd: { op: "move", drop: { unit: "row", first: "C", target: "A", after: false } } }
  ];
  const kinds = (steps: Step[]): Record<string, number> => play({ spec: base(), steps, writers: 2, mode: "forward", seed: 1 }).kinds;
  assert.deepEqual(kinds(split), { "a split at the same moment as a move left the second half at the old place": 1 });
  assert.deepEqual(kinds(swap), { "two drops onto each other's rows at the same moment; neither request met": 1 });
  assert.deepEqual(kinds([split[0] as Step, { from: 0, to: 1 }, split[1] as Step]), {}, "a move made after seeing the split takes both halves along or leaves them by choice");
});

test("E11 tag count: a tag kept through someone else's split, join and deletion of a neighbour is counted as kept", () => {
  const steps: Step[] = [
    { by: 0, cmd: { op: "format", id: "B", field: "audio", from: 0, to: 3, key: "t:prop", on: true } },
    { by: 1, cmd: { op: "split", id: "B", at: 1, created: "N" } },
    { by: 1, cmd: { op: "join", id: "C" } },
    { by: 1, cmd: { op: "delete", rows: ["A"] } }
  ];
  const result = play({ spec: base(), steps, writers: 2, mode: "forward", seed: 1 });
  assert.deepEqual([result.never, result.local, result.tags], [[], [], { requested: 1, kept: 1, lost: [] }]);
});
