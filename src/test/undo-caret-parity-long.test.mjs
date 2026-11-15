import { test } from "node:test";
import { longRows, checkParity } from "./_undo-caret-parity.mjs";

for (const row of longRows) for (const view of row.views) for (const order of row.orders ?? ["mine first"]) {
  test(`undo caret parity, ${row.name}, ${view}${row.orders ? ", " + order : ""}: shared equals standalone`, () => checkParity(row, view, order));
}
