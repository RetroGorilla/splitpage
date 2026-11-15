import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { openProductionPanel } from "../features/tags/panels.ts";
import { noticeCalls, toastHost, clearWarnings, ORDERS, enter, remoteInsert, exchange, shape, agree, withZ, edit, ADMISSION_HELD, refusedOnce, tidy, PREP_CHOICES } from "./_shared-split-records.mjs";

for (const choice of PREP_CHOICES) for (const order of ORDERS) test(`C7 record held: ${choice.name} refused at admission by a session hold shows the refusal once and no success notice, ${order}`, async () => {
  const f = await enter();
  const stop = f.parts.session.hold(ADMISSION_HELD);
  try {
    openProductionPanel();
    const start = refusedOnce(f, order, choice.act);
    stop();
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
  } finally { stop(); tidy(f); }
});

for (const choice of PREP_CHOICES) for (const order of ORDERS) test(`C7 record caller literal: ${choice.name} saves in a shared session with its notice and no Undo button (rule 157), ${order}`, async () => {
  const f = await enter();
  try {
    openProductionPanel();
    remoteInsert(f.peer, "r2", "audioText", 0, "Z");
    const start = shape(currentDocument());
    noticeCalls.length = 0; clearWarnings();
    assert.doesNotThrow(choice.act);
    assert.deepEqual(noticeCalls, [[choice.notice, "ok"]]);
    const toast = [...toastHost().querySelectorAll(".toast")].find(el => el.firstChild.textContent === choice.notice);
    assert.ok(toast, "the notice shows");
    assert.equal(toast.querySelector(".toast-action"), null, "the notice has no Undo button");
    exchange(f, order);
    agree(f, edit(withZ(start), n => { n.tags.find(t => t[1] === "Mug")[3] = "have"; }));
  } finally { tidy(f); }
});
