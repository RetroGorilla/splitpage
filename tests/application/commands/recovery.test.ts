import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryCommand } from "../../../src/application/commands/recovery.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { readSharedContentRef } from "../../../src/core/collab/read-operation.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { SharedRecoveryEntry } from "../../../src/core/collab/recovery.ts";
import { sharedRecoveryEntryName } from "../../../src/core/collab/recovery.ts";

const doc = enterSharedDocument({ schema: 2, title: "", docId: "d1", rows: [], comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 });
const capability = createSessionCapabilities("shared", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
const id = readSharedContentRef("action"); assert.ok(id);
const beat: SharedRecoveryEntry = { kind: "removed-beat", row: { id: "R1", audioText: "Kept" }, members: ["R1"], removal: { ids: ["gone"], by: "Alice", edited: [] } };
const person: SharedRecoveryEntry = { kind: "deleted-person", person: "P1", name: "Pat", by: "Alice", owners: [], mentions: ["R1"] };

for (const action of ["restore", "discard"] as const) test("C9 command refuses an entry no longer in the published recovery list: " + action, () => {
  let authors = 0;
  const plan = recoveryCommand(action, { kind: "removed-beat", key: "R1" }, { recovery: { recovery: () => [] }, author: () => { authors++; return { id, by: "Bob" }; } }).plan(doc, capability);
  assert.deepEqual(plan, { refused: "recovery-entry-unavailable" }); assert.equal(authors, 0);
});

for (const action of ["restore", "discard"] as const) test("C9 command refuses a missing author: " + action, () => {
  assert.deepEqual(recoveryCommand(action, { kind: "removed-beat", key: "R1" }, { recovery: { recovery: () => [beat] }, author: () => null }).plan(doc, capability), { refused: "recovery-no-author" });
});

for (const action of ["restore", "discard"] as const) for (const ids of [undefined, [], [" "]]) test("C9 " + action + " refuses missing, empty or unreadable removal provenance: " + JSON.stringify(ids), () => {
  const entry: SharedRecoveryEntry = { kind: "removed-beat", row: { id: "R1", audioText: "Kept" }, members: ["R1"],
    ...(ids ? { removal: { ids, by: "Alice", edited: [] } } : {}) };
  assert.deepEqual(recoveryCommand(action, { kind: "removed-beat", key: "R1" }, { recovery: { recovery: () => [entry] }, author: () => ({ id, by: "Bob" }) }).plan(doc, capability), { refused: "recovery-removal-unavailable" });
});

for (const action of ["restore", "discard"] as const) test("C9 scene with no beats has no recovery " + action + " operation", () => {
  const entry: SharedRecoveryEntry = { kind: "scene-with-no-beats", heading: { id: "H1", name: "Empty" }, beforeRowId: null };
  assert.deepEqual(recoveryCommand(action, sharedRecoveryEntryName(entry), { recovery: { recovery: () => [entry] }, author: () => ({ id, by: "Bob" }) }).plan(doc, capability), { refused: "recovery-" + action + "-unavailable" });
});

test("C9 person restore keeps the model's caseless namesake refusal", () => {
  const namesake = enterSharedDocument({ ...doc, people: [{ id: "P2", name: "pAt" }] });
  assert.deepEqual(recoveryCommand("restore", { kind: "deleted-person", key: "P1" }, { recovery: { recovery: () => [person] }, author: () => ({ id, by: "Bob" }) }).plan(namesake, capability), { refused: "recovery-restore-unavailable" });
});

for (const name of [{ kind: "removed-beat", key: "R2" }, { kind: "removed-heading", key: "R1" }] as const) test("C9 entry identity compares both kind and key: " + name.kind + "/" + name.key, () => {
  assert.deepEqual(recoveryCommand("restore", name, { recovery: { recovery: () => [beat] }, author: () => ({ id, by: "Bob" }) }).plan(doc, capability), { refused: "recovery-entry-unavailable" });
});

for (const [entry, action, operations] of [
  [beat, "restore", [{ kind: "restore", id: "action", by: "Bob", removals: ["gone"] }]],
  [beat, "discard", [{ kind: "discard", id: "action", by: "Bob", entry: { kind: "removed-beat", key: "R1" }, removals: ["gone"] }]],
  [person, "restore", [{ kind: "record-create", id: "action", by: "Bob", target: { collection: "people", record: "P1" }, fields: { name: "Pat" } }]]
] as const) test("C9 command sends one literal existing operation and one undo description: " + entry.kind + "/" + action, () => {
  const plan = recoveryCommand(action, sharedRecoveryEntryName(entry), { recovery: { recovery: () => [entry] }, author: () => ({ id, by: "Bob" }) }).plan(doc, capability);
  assert.ok(plan && !("refused" in plan));
  assert.deepEqual(plan.shared, { operations, description: { label: "recovery-" + action, selection: null, typing: null } });
  assert.throws(() => plan.apply(doc), /^Error: recovery-shared-only$/);
});
