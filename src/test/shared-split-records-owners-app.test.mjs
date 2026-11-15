import { test } from "node:test";
import assert from "node:assert/strict";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { warnings, clearWarnings, ORDERS, enter, exchange, agree, withZ, REFUSED, ADMISSION_HELD, refusedOnce, tidy, HELD_OWNER_CALLS } from "./_shared-split-records.mjs";

for (const call of HELD_OWNER_CALLS) for (const order of ORDERS) test(`C7 record held: the owner call for ${call.name} reports held, writes nothing and warns once, ${order}`, async () => {
  const f = await enter();
  const stop = f.parts.session.hold(ADMISSION_HELD);
  try {
    const start = refusedOnce(f, order, call.act);
    stop();
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
    assert.deepEqual(warnings(), []);
  } finally { stop(); tidy(f); }
});

for (const call of HELD_OWNER_CALLS) test(`C7 record held: the owner call for ${call.name} refused by a listener that announces it is not announced again`, async () => {
  const f = await enter();
  const stop = f.parts.session.beforeCommand(() => { notices.show(REFUSED, "warn"); return "announced"; });
  try { refusedOnce(f, "local-first", call.act); } finally { stop(); tidy(f); }
});
