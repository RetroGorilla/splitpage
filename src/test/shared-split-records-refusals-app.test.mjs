import { test } from "node:test";
import assert from "node:assert/strict";
import { warnings, clearWarnings, ORDERS, enter, exchange, agree, withZ, refusals, refusedOnce, tidy } from "./_shared-split-records.mjs";

for (const literal of refusals) for (const order of ORDERS) test(`C7 record refusal: ${literal.name} is refused once and writes nothing, ${order}`, async () => {
  const f = await enter();
  try {
    const start = refusedOnce(f, order, literal.act, literal.kept);
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
    assert.deepEqual(warnings(), []);
  } finally { tidy(f); }
});
