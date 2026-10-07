import { SEED_TEXT, bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

const { migrateRows } = await import("../js/02-state.js");
const { liveSession } = await import("../legacy/session-bridge.ts");

const seed = migrateRows(JSON.parse(SEED_TEXT));
const mine = JSON.parse(JSON.stringify(seed));
mine.rows[0].audioText = "Recovered from the last session.";
sessionStorage.setItem("splitpage-conflict-stash", JSON.stringify({ at: "2026-10-07T09:00:00.000Z", by: "Sam", base: seed, mine: mine }));

const session = liveSession();
const heard = [];
session.subscribe((c) => heard.push(c.kind + ":" + c.epoch + ":" + c.generation));

await bootApp();

after(closeApp);

test("E4: boot recovery of unsaved work enters the session as a recovery with an epoch of its own, no generation and no undo entry", async () => {
  const { flushEdits, undoSizes } = await import("../js/12a-undo.js");
  assert.equal(S.state.rows[0].audioText, "Recovered from the last session.");
  assert.deepEqual(heard, ["recovery:1:0"]);
  assert.equal(session.read((doc) => doc), S.state);
  assert.equal(session.generation(), 0);
  flushEdits();
  assert.equal(undoSizes().undo, 0);
  assert.equal(sessionStorage.getItem("splitpage-conflict-stash"), null, "the stash was taken");
});
