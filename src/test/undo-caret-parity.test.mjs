import { test } from "node:test";
import assert from "node:assert/strict";
import { rows, checkCaret, peer, runShared } from "./_undo-caret-parity.mjs";

const mapped = new Set([
  "delete across a join",
  "typing then two forward Deletes",
  "delete a join's glue",
  "change in the middle",
  "Enter in the middle of a row",
  "bold across two rows",
  "undo from the Split cell itself, with the Split binding mounted"
]);

for (const row of rows) for (const view of row.views) for (const order of row.orders ?? ["mine first"]) {
  const shared = !mapped.has(row.name);
  test(`undo caret parity, ${row.name}, ${view}${row.orders ? ", " + order : ""}: ${shared ? "shared equals standalone" : "standalone"}`,
    () => checkCaret(row, view, shared ? order : undefined));
}

test("undo caret, the other person adds a picture before the change, split: the cell decoder measures it", async () => {
  const row = { name: "picture", seed: [["R1", "abcdef"]], edits: [["delete", "R1", 4, 5]], shared: { before: [peer.picture("R1", 2)] } };
  const carets = await runShared(row, "split", "mine first");
  assert.deepEqual(carets, [["R1", 5, 5, "audioText"], ["R1", 4, 4, "audioText"]]);
});
