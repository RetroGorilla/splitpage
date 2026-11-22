import { test } from "node:test";
import { rows, checkCaret } from "./_undo-caret-parity.mjs";

for (const row of rows) for (const view of row.views) {
  test("standalone undo caret, " + row.name + ", " + view, () => checkCaret(row, view));
}
