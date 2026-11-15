import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";
import { served as allCases, warnings, ORDERS, enter, remoteInsert, exchange, shape, agree, undoOnce, withZ, tidy } from "./_shared-split-records.mjs";

const served = allCases.filter((_, index) => [2,3,4,5,6,8,9,10,11].includes(index));

for (const literal of served) for (const order of ORDERS) test(`C7 record caller literal: ${literal.name}, ${order}`, async () => {
  const f = await enter();
  try {
    const start = shape(currentDocument()), sizes = f.parts.undo.sizes(), standalone = undoOwner().sizes();
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    literal.act(f);
    exchange(f, order);
    agree(f, withZ(literal.after(start)));
    assert.deepEqual(warnings(), []);
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + (literal.undoable === false ? 0 : 1) });
    assert.deepEqual(undoOwner().sizes(), standalone);
    if (literal.undoable === false) return;
    undoOnce(f, order);
    assert.deepEqual(warnings(), []);
    agree(f, withZ(start));
  } finally { tidy(f); }
});
