import { test } from "node:test";
import assert from "node:assert/strict";
import { peer, runShared, cellCaretAfterStep } from "./_undo-caret-parity.mjs";

const KEPT = [
  ["before the range", peer.insert("R1", 0, "X"), [2, 4]],
  ["inside the range", peer.insert("R1", 2, "X"), [1, 4]],
  ["after the range", peer.insert("R1", 4, "X"), [1, 3]],
  ["deleting the character before it", peer.erase("R1", 0, 1), [0, 2]],
  ["deleting part of it", peer.erase("R1", 1, 2), [1, 2]]
];
for (const [where, change, [from, to]] of KEPT) for (const order of ["mine first", "peer first"]) {
  test(`undo selection, bold over bc, the other person changes the text ${where}: the recorded range follows its characters, ${order}`, async () => {
    const row = { seed: [["R1", "abcd"]], edits: [], caretRow: "R1", again: true,
      shared: { during: [change], edits: { "mine first": [["press", "R1", 1, 3, "b", { ctrlKey: true }]], "peer first": [] } } };
    if (order === "peer first") {
      const after = { "before the range": [2, 4], "inside the range": [1, 4], "after the range": [1, 3], "deleting the character before it": [0, 2], "deleting part of it": [1, 2] }[where];
      row.shared.edits["peer first"] = [["press", "R1", after[0], after[1], "b", { ctrlKey: true }]];
    }
    const carets = await runShared(row, "writer", order);
    assert.deepEqual(carets, [["R1", from, to, "R1"], ["R1", from, to, "R1"], ["R1", from, to, "R1"]]);
  });
}

test("undo caret: a cell is measured with the Split decoder, not the Writer media decoder (comment removed in a tag with a picture)", () => {
  const picture = '<img class="comment-img" data-blob="' + "c".repeat(64) + '" data-w="3" data-h="3" data-mime="image/png">';
  const tagged = inner => '<span class="tag-anchor" data-tag-cat="cast" data-tag-name="Ada">' + inner + picture + "b</span>";
  assert.equal(cellCaretAfterStep({ before: tagged('<span class="cmt-anchor" data-cmt="c1">a</span>'), after: tagged("a") }), 2);
});
