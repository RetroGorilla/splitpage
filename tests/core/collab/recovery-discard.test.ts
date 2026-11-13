import { test } from "node:test";
import assert from "node:assert/strict";
import { hideSharedDiscardedEntries, sharedRecoveryDiscardOperation, sharedRecoveryEntryName } from "../../../src/core/collab/recovery.ts";
import type { SharedRecoveryEntry } from "../../../src/core/collab/recovery.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";

const removal = (...ids: string[]) => ({ ids, by: "Alice", edited: [] });
const ENTRIES: readonly SharedRecoveryEntry[] = [
  { kind: "removed-beat", row: { id: "R1" }, members: ["R1", "R2"], removal: removal("gone") },
  { kind: "removed-heading", heading: { id: "H1" }, removal: removal("unhead") },
  { kind: "crossing-tag", occurrence: "t1", tag: "prop", from: 0, to: 2, words: "ab", rowId: "R3", field: "audioText" },
  { kind: "deleted-tag", occurrence: "t2", tag: "prop", from: 0, to: 2, words: "ab", rowId: "R3", field: "visualText" },
  { kind: "gallery-overflow", itemId: "g1", beat: "R3", slot: {}, rowId: "R3" },
  { kind: "unprojectable-fragment", reason: "missing-beat", owner: "N", segment: "b:R3", field: "audioText", from: 2, to: 6, html: "lost", start: "2:1" },
  { kind: "comment-without-words", comment: "C9", rowId: "R2", field: "visualText" },
  { kind: "reply-without-comment", reply: '["C1","r1"]', commentId: "C1" },
  { kind: "scene-with-no-beats", heading: { id: "H2" }, beforeRowId: null }
];
const named = (entries: readonly SharedRecoveryEntry[]) => entries.map(entry => { const name = sharedRecoveryEntryName(entry); return name.kind + " " + name.key; });

test("assumed rule 51: every entry kind is named by its kind and one stored key", () => {
  assert.deepEqual(named(ENTRIES), ["removed-beat R1", "removed-heading H1", "crossing-tag t1", "deleted-tag t2", "gallery-overflow g1",
    'unprojectable-fragment ["b:R3","2:1"]', "comment-without-words C9", 'reply-without-comment ["C1","r1"]', "scene-with-no-beats H2"]);
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
  const tag = (occurrence: string, to: number): SharedRecoveryEntry => ({ kind: "deleted-tag", occurrence, tag: "prop", from: 0, to, words: "", rowId: "R3", field: "audioText" });
  const tags = [{ entry: { kind: "deleted-tag" as const, key: "t5" }, removals: [] }];
  assert.deepEqual(named(hideSharedDiscardedEntries([tag("t5", 9), tag("t3", 4)], tags)), ["deleted-tag t3"]);
  const fragment = (start: string): SharedRecoveryEntry => ({ kind: "unprojectable-fragment", reason: "missing-beat", owner: null, segment: "S", field: "audioText", from: 0, to: 3, html: "", start });
  assert.deepEqual(named(hideSharedDiscardedEntries([fragment("2:4")], [{ entry: { kind: "unprojectable-fragment", key: '["S","2:3"]' }, removals: [] }])), ['unprojectable-fragment ["S","2:4"]']);
});
