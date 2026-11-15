import { test } from "node:test";
import assert from "node:assert/strict";
import { rows, checkParity, peer, runShared } from "./_undo-caret-parity.mjs";

for (const row of rows) for (const view of row.views) for (const order of row.orders ?? ["mine first"]) {
  test(`undo caret parity, ${row.name}, ${view}${row.orders ? ", " + order : ""}: shared equals standalone`, () => checkParity(row, view, order));
}

test("undo caret, the other person adds a picture before the change, split: the cell decoder measures it", async () => {
  const row = { name: "picture", seed: [["R1", "abcdef"]], edits: [["delete", "R1", 4, 5]], shared: { before: [peer.picture("R1", 2)] } };
  const carets = await runShared(row, "split", "mine first");
  assert.deepEqual(carets, [["R1", 5, 5, "audioText"], ["R1", 4, 4, "audioText"]]);
});
