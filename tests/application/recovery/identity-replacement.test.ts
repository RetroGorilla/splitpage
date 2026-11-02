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
  const comment = mine.comments[0];
  assert.ok(comment);
  comment.resolved = true;
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
  const mineComment = mine.comments[0], diskComment = disk.comments[0], diskRow = disk.rows[0];
  assert.ok(mineComment && diskComment && diskRow);
  mineComment.body = "DRAFT NOTE";
  diskRow.id = "r-load-" + "b".repeat(24) + "-1";
  diskRow.audioText = "Disk.";
  diskComment.rowId = diskRow.id;
  diskComment.body = "DISK NOTE";
  const before = JSON.stringify([base, mine, disk]);
  const got = prepareIdentityReplacement(base, mine, disk, html => html ? [{ text: html, marks: { cmt: ["quote"] } }] : []);
  assert.equal(JSON.stringify([base, mine, disk]), before);
  assert.equal(got.disk, disk);
  const comment = got.mine.comments[0], row = got.mine.rows[0];
  assert.ok(comment && row);
  assert.equal(comment.anchorId, candidate + "-1");
  assert.notEqual(comment.id, "c");
  assert.equal(row.audioText, '<span class="cmt-anchor" data-cmt="' + candidate + '-1">Original.</span>');
  assert.deepEqual(got.base?.rows, []);
  assert.deepEqual(got.base?.comments, []);
});

test("a surviving explicit scene prevents legacy fallback for production-shaped IDs", () => {
  const base = migrateRows({ rows: [{ id: "rabcdefghi123456", audioText: "Deleted." },
    { id: "rsurvivor123456", audioText: "Survivor." }],
  comments: [{ id: "c", rowId: "rabcdefghi123456", body: "Note" }] }, fakeMigration().ports);
  const mine = structuredClone(base), disk = structuredClone(base);
  const comment = mine.comments[0];
  assert.ok(comment);
  comment.assignee = "Sam";
  disk.rows.shift(); disk.comments = [];
  disk.rows.push({ id: "r-load-" + "b".repeat(24) + "-1", audioText: "New disk scene." });
  const got = prepareIdentityReplacement(base, mine, disk, () => { throw new Error("The surviving ID rules out replacement"); });
  assert.equal(got.base, base);
  assert.equal(got.mine, mine);
  assert.equal(got.disk, disk);
});
