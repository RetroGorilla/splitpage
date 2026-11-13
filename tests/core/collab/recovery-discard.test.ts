import { test } from "node:test";
import assert from "node:assert/strict";
import { hideSharedDiscardedEntries, projectSharedDeletedPeople, readSharedWhoNames, sharedRecoveryDiscardOperation, sharedRecoveryEntryName,
  sharedRecoveryPersonRestore } from "../../../src/core/collab/recovery.ts";
import type { SharedRecoveryEntry } from "../../../src/core/collab/recovery.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";

const removal = (...ids: string[]) => ({ ids, by: "Alice", edited: [] });
const ENTRIES: readonly SharedRecoveryEntry[] = [
  { kind: "removed-beat", row: { id: "R1" }, members: ["R1", "R2"], removal: removal("gone") },
  { kind: "removed-heading", heading: { id: "H1" }, removal: removal("unhead") },
  { kind: "crossing-tag", occurrence: "t1", tag: "prop", from: 0, to: 2, words: "ab", rowId: "R3", field: "audioText", start: "3:1" },
  { kind: "deleted-tag", occurrence: "t2", tag: "prop", from: 0, to: 2, words: "ab", rowId: "R3", field: "visualText", start: "3:5" },
  { kind: "gallery-overflow", itemId: "g1", beat: "R3", slot: {}, rowId: "R3" },
  { kind: "unprojectable-fragment", reason: "missing-beat", owner: "N", segment: "b:R3", field: "audioText", from: 2, to: 6, html: "lost", start: "2:1" },
  { kind: "comment-without-words", comment: "C9", rowId: "R2", field: "visualText" },
  { kind: "reply-without-comment", reply: '["C1","r1"]', commentId: "C1" },
  { kind: "deleted-person", person: "P1", name: "Ada", by: "Bob", owners: [], mentions: ["R1"] },
  { kind: "scene-with-no-beats", heading: { id: "H2" }, beforeRowId: null }
];
const named = (entries: readonly SharedRecoveryEntry[]) => entries.map(entry => { const name = sharedRecoveryEntryName(entry); return name.kind + " " + name.key; });

test("assumed rule 54: a deleted person is listed only while an owner or an @Name refers to it, once per row, and restore is refused while a live person has its name", () => {
  const deleted = [{ person: "P1", name: "Ada", by: "Bob" }, { person: "P2", name: "Bo", by: "Bob" }, { person: "P3", name: "Cy", by: "Bob" }];
  const records = { people: [{ id: "P3", name: "Cy" }], tags: [{ id: "t2", owner: "P2" }, { id: "t1", owner: "P2" }], shots: [{ id: "S1", owner: "P2" }] };
  const listed = projectSharedDeletedPeople(deleted, records, [{ rowId: "R2", names: readSharedWhoNames([{ value: { atom: "who", name: "ADA" }, marks: [] }]) }, { rowId: "R1", names: ["ada"] },
    { rowId: "R1", names: ["ada", "bo"] }]);
  assert.deepEqual(listed, [{ kind: "deleted-person", person: "P1", name: "Ada", by: "Bob", owners: [], mentions: ["R2", "R1"] },
    { kind: "deleted-person", person: "P2", name: "Bo", by: "Bob", owners: [{ collection: "shots", record: "S1" }, { collection: "tags", record: "t1" }, { collection: "tags", record: "t2" }], mentions: ["R1"] }]);
  assert.deepEqual(projectSharedDeletedPeople(deleted, records, []).map(entry => entry.kind === "deleted-person" ? entry.person : ""), ["P2"]);
  const [ada] = listed; assert.ok(ada);
  assert.deepEqual(sharedRecoveryPersonRestore(ada, [], { id: "back", by: "Carol" }),
    { kind: "record-create", id: "back", by: "Carol", target: { collection: "people", record: "P1" }, fields: { name: "Ada" } });
  assert.equal(sharedRecoveryPersonRestore(ada, [{ id: "P9", name: " ADA " }], { id: "back", by: "Carol" }), null);
});

test("assumed rule 51: every entry kind is named by its kind and one stored key", () => {
  assert.deepEqual(named(ENTRIES), ["removed-beat R1", "removed-heading H1", 'crossing-tag ["t1","3:1"]', 'deleted-tag ["t2","3:5"]', "gallery-overflow g1",
    'unprojectable-fragment ["b:R3","2:1"]', "comment-without-words C9", 'reply-without-comment ["C1","r1"]', "deleted-person P1", "scene-with-no-beats H2"]);
});

test("assumed rule 52: a discard names its entry and the removals it saw; a scene with no beats has none, and every discard reads back unchanged", () => {
  const made = ENTRIES.map((entry, index) => sharedRecoveryDiscardOperation(entry, { id: "d" + index, by: "Bob" }));
  assert.equal(made.at(-1), null);
  assert.deepEqual(made[0], { kind: "discard", id: "d0", by: "Bob", entry: { kind: "removed-beat", key: "R1" }, removals: ["gone"] });
  assert.deepEqual(made[6], { kind: "discard", id: "d6", by: "Bob", entry: { kind: "comment-without-words", key: "C9" }, removals: [] });
  for (const operation of made) if (operation) assert.deepEqual(readOperation(operation), operation);
  assert.equal(readOperation({ kind: "discard", id: "x", by: "Bob", entry: { kind: "unknown", key: "R1" }, removals: [] }), null);
});

test("assumed rule 52: each discardable kind is hidden by its own discard only, and nothing is filtered or copied when there are no discards", () => {
  assert.equal(hideSharedDiscardedEntries(ENTRIES, []), ENTRIES);
  for (const [index, entry] of ENTRIES.entries()) {
    const discard = sharedRecoveryDiscardOperation(entry, { id: "d", by: "Bob" });
    if (!discard) continue;
    assert.deepEqual(named(hideSharedDiscardedEntries(ENTRIES, [discard])), named(ENTRIES.filter((_entry, at) => at !== index)));
  }
  assert.deepEqual(named(hideSharedDiscardedEntries(ENTRIES, [{ entry: { kind: "scene-with-no-beats", key: "H2" }, removals: [] }])), named(ENTRIES));
});

test("assumed rule 52: a removal the discard did not see shows the entry again; the three names that can change fail open", () => {
  const beat = (id: string, ...ids: string[]): SharedRecoveryEntry => ({ kind: "removed-beat", row: { id }, members: [id], removal: removal(...ids) });
  const R1 = { kind: "removed-beat" as const, key: "R1" }, seen = [{ entry: R1, removals: ["gone"] }];
  assert.deepEqual(named(hideSharedDiscardedEntries([beat("R1", "gone")], seen)), []);
  assert.deepEqual(named(hideSharedDiscardedEntries([beat("R1", "gone", "fresh")], seen)), ["removed-beat R1"]);
  assert.deepEqual(named(hideSharedDiscardedEntries([beat("R1", "gone", "fresh")], [...seen, { entry: R1, removals: ["fresh"] }])), []);
  assert.deepEqual(named(hideSharedDiscardedEntries([beat("R0", "gone")], seen)), ["removed-beat R0"]);
  const tag = (occurrence: string, start: string, to: number): SharedRecoveryEntry => ({ kind: "deleted-tag", occurrence, tag: "prop", from: 0, to, words: "", rowId: "R3", field: "audioText", start });
  const tags = [{ entry: { kind: "deleted-tag" as const, key: '["t5","3:1"]' }, removals: [] }];
  assert.deepEqual(named(hideSharedDiscardedEntries([tag("t5", "3:1", 9), tag("t5", "3:0", 9), tag("t3", "3:1", 4)], tags)), ['deleted-tag ["t5","3:0"]', 'deleted-tag ["t3","3:1"]']);
  const fragment = (start: string): SharedRecoveryEntry => ({ kind: "unprojectable-fragment", reason: "missing-beat", owner: null, segment: "S", field: "audioText", from: 0, to: 3, html: "", start });
  assert.deepEqual(named(hideSharedDiscardedEntries([fragment("2:4")], [{ entry: { kind: "unprojectable-fragment", key: '["S","2:3"]' }, removals: [] }])), ['unprojectable-fragment ["S","2:4"]']);
});

test("assumed rule 52 as amended: an entry with no first character has no name to discard, and two such entries are never hidden", () => {
  const empty = (from: number): SharedRecoveryEntry => ({ kind: "unprojectable-fragment", reason: "missing-beat", owner: null, segment: "S", field: "audioText", from, to: from, html: "", start: null });
  const tag: SharedRecoveryEntry = { kind: "crossing-tag", occurrence: "t1", tag: "prop", from: 0, to: 0, words: "", rowId: "R3", field: "audioText", start: null };
  assert.deepEqual([empty(0), empty(3), tag].map(entry => sharedRecoveryDiscardOperation(entry, { id: "d", by: "Bob" })), [null, null, null]);
  const crafted = [{ entry: { kind: "unprojectable-fragment" as const, key: '["S",null]' }, removals: [] }, { entry: { kind: "crossing-tag" as const, key: '["t1",null]' }, removals: [] }];
  assert.deepEqual(named(hideSharedDiscardedEntries([empty(0), empty(3), tag], crafted)), ['unprojectable-fragment ["S",null]', 'unprojectable-fragment ["S",null]', 'crossing-tag ["t1",null]']);
});
