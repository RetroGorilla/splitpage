import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareIdentityReplacement } from "../../../src/application/recovery/identity-replacement.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { sha256Hex } from "../../../src/core/document/ids.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

test("ordinary complete-ID recovery inputs remain untouched and need no rich-text reads", () => {
  const base = migrateRows({ rows: [{ id: "a" }, { id: "b" }],
    comments: [{ id: "c", rowId: "a", body: "Note" }] }, fakeMigration().ports);
  const mine = structuredClone(base), disk = structuredClone(base);
  mine.comments[0]!.resolved = true;
  disk.rows.shift(); disk.comments = [];
  const before = JSON.stringify([base, mine, disk]);
  const got = prepareIdentityReplacement(base, mine, disk, () => { throw new Error("No replacement to inspect"); });
  assert.equal(got.base, base);
  assert.equal(got.mine, mine);
  assert.equal(got.disk, disk);
  assert.equal(JSON.stringify([base, mine, disk]), before);
});

test("identity-replacement recovery reserves other records and leaves all original inputs untouched", () => {
  const rowId = "r-load-" + "a".repeat(24) + "-1";
  const candidate = "a-recovery-" + sha256Hex(rowId + "\u0000quote").slice(0, 24);
  const base = migrateRows({ rows: [{ id: rowId, audioText: "Original." }], people: [{ id: candidate, name: "Reserved" }],
    comments: [{ id: "c", rowId, anchorId: "quote", field: "audioText", body: "Original note" }] }, fakeMigration().ports);
  const mine = structuredClone(base), disk = structuredClone(base);
  mine.comments[0]!.body = "DRAFT NOTE";
  disk.rows[0]!.id = "r-load-" + "b".repeat(24) + "-1";
  disk.rows[0]!.audioText = "Disk.";
  disk.comments[0]!.rowId = disk.rows[0]!.id;
  disk.comments[0]!.body = "DISK NOTE";
  const before = JSON.stringify([base, mine, disk]);
  const got = prepareIdentityReplacement(base, mine, disk, html => html ? [{ text: html, marks: { cmt: ["quote"] } }] : []);
  assert.equal(JSON.stringify([base, mine, disk]), before);
  assert.equal(got.disk, disk);
  assert.equal(got.mine.comments[0]!.anchorId, candidate + "-1");
  assert.notEqual(got.mine.comments[0]!.id, "c");
  assert.equal(got.mine.rows[0]!.audioText, '<span class="cmt-anchor" data-cmt="' + candidate + '-1">Original.</span>');
  assert.deepEqual(got.base?.rows, []);
  assert.deepEqual(got.base?.comments, []);
});

test("a surviving explicit scene prevents legacy fallback for production-shaped IDs", () => {
  const base = migrateRows({ rows: [{ id: "rabcdefghi123456", audioText: "Deleted." },
    { id: "rsurvivor123456", audioText: "Survivor." }],
  comments: [{ id: "c", rowId: "rabcdefghi123456", body: "Note" }] }, fakeMigration().ports);
  const mine = structuredClone(base), disk = structuredClone(base);
  mine.comments[0]!.assignee = "Sam";
  disk.rows.shift(); disk.comments = [];
  disk.rows.push({ id: "r-load-" + "b".repeat(24) + "-1", audioText: "New disk scene." });
  const got = prepareIdentityReplacement(base, mine, disk, () => { throw new Error("The surviving ID rules out replacement"); });
  assert.equal(got.base, base);
  assert.equal(got.mine, mine);
  assert.equal(got.disk, disk);
});
