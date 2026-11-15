import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { closeBrollPage } from "../features/broll/panel.ts";
import { TYPED_PATHS as allCases, noticeCalls, ORDERS, enter, exchange, shape, agree, REFUSED, ADMISSION_HELD, tidy, $, boxValue } from "./_shared-split-records.mjs";

const TYPED_PATHS = allCases.filter((_, index) => [0,1,2,3,4,5,6,7,8,9,10,11,12].includes(index));

for (const path of TYPED_PATHS) for (const order of ORDERS) test(`C7 record held, typed text: ${path.name} keeps the typed text after the refusal and after a redraw, then saves it once after release and blur or Enter, ${order}`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    path.setup();
    const typed = boxValue(path.box), before = path.saved(), warned = () => noticeCalls.filter(call => call[1] === "warn");
    stop = f.parts.session.hold(ADMISSION_HELD);
    noticeCalls.length = 0;
    path.refuse($(path.target));
    assert.deepEqual([warned(), boxValue(path.box), path.saved()], [[[REFUSED, "warn"]], typed, before], "after the refusal");
    noticeCalls.length = 0;
    path.redraw();
    assert.deepEqual([warned(), boxValue(path.box), path.saved()], [[], typed, before], "after a redraw");
    stop();
    path.redraw();
    assert.deepEqual([warned(), boxValue(path.box), path.saved()], [[], typed, before], "release and redraw still wait for a submit");
    path.save($(path.target));
    assert.deepEqual([warned(), path.saved()], [[], path.want], "saved once after release");
    exchange(f, order);
    agree(f, shape(currentDocument()));
  } finally { stop(); closeBrollPage(() => {}); tidy(f); }
});
