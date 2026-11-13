import { test } from "node:test";
import assert from "node:assert/strict";
import { enterSharedDocument, migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeReplica, sharedHarness } from "./shared-session-support.ts";

const LONG = "Scene " + "x".repeat(244);

function projection(): Record<string, unknown> {
  return {
    schema: 2, title: "Title", docId: "d1", rev: 0,
    rows: [{ id: "R:1", status: "todo", audioText: "ab", visualText: "B-roll: drone" }, { id: "R2", status: "todo", audioText: "cd" }],
    sections: [{ id: "H1", name: "  Opening ", firstSceneId: "R:1" }, { id: "H2", name: LONG, firstSceneId: "R2" }],
    comments: [], people: [], productionTags: [], brollShots: []
  };
}

test("D1, rule 59, D31: the shared entry holds the projection itself, ids, scene names with their edge spaces and a name over 200 characters as projected, and mints nothing", () => {
  const projected = projection();
  const held = enterSharedDocument(projected) as unknown as Record<string, unknown>;
  assert.equal(held, projected);
  assert.deepEqual(held, projection());
  assert.equal(LONG.length, 250);
});

test("for contrast, the standalone loader on the same projection rewrites the id, which drops the scene that started there, cuts the long name and mints a shot, which is why it is not the shared entry", () => {
  const loaded = migrateRows(projection(), fakeMigration().ports) as unknown as {
    rows: { id: string }[]; sections: { name: string }[]; brollShots: unknown[];
  };
  assert.deepEqual([loaded.rows.map(row => row.id), loaded.sections.map(scene => scene.name), loaded.brollShots.length],
    [["R1", "R2"], [LONG.slice(0, 200)], 1]);
});

test("the shared entry refuses what is not a projected document", () => {
  for (const raw of [null, 7, "doc", [], { title: "no rows" }, { rows: "R1" }]) {
    assert.throws(() => enterSharedDocument(raw), /^TypeError: A shared session enters only a projected document$/);
  }
});

test("D2: the change set and the row report name a row the same way, also an id the standalone loader would clean", () => {
  const replica = fakeReplica(), h = sharedHarness(replica.port), told: unknown[] = [];
  h.session.subscribeRows(rows => { told.push(rows); });
  replica.write("hydration", projection());
  replica.write("remote", { ...projection(), rows: [{ id: "R:1", status: "ready", audioText: "ab", visualText: "B-roll: drone" }, { id: "R2", status: "todo", audioText: "cd" }] });
  const change = h.published.at(-1);
  assert.deepEqual(change?.changes.cells, [{ rowId: "R:1", field: "status" }]);
  assert.deepEqual(told.at(-1), { whole: false, added: [], removed: [], moved: [], changed: [{ id: "R:1", fields: ["status"] }], fields: [] });
  assert.deepEqual(h.session.read(doc => doc?.rows.map(row => row.id)), ["R:1", "R2"]);
});
