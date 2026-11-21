import { test } from "node:test";
import { longRows, checkCaret } from "./_undo-caret-parity.mjs";

for (const row of longRows) for (const view of row.views) {
  test(`standalone undo caret, ${row.name}, ${view}`, () => checkCaret(row, view));
}
