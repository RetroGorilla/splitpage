import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { renderProduction } from "../features/tags/panels.ts";
import { closeBrollPage } from "../features/broll/panel.ts";
import { TYPED_PATHS as allCases, noticeCalls, ORDERS, enter, exchange, shape, agree, press, REFUSED, ADMISSION_HELD, tidy, $, typeIn, focused, MUG, productionCards, RENAME, boxValue } from "./_shared-split-records.mjs";

const TYPED_PATHS = allCases.filter((_, index) => [13,14,15,16,17,18,19].includes(index));

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

test("C7 record held, typed text: renaming a tag keeps its box, text, focus and selection after the rule 73 refusal and after a redraw", async () => {
  const f = await enter();
  try {
    productionCards();
    $(`#production-panel [data-action="tag-rename"]${MUG}`).click();
    typeIn(RENAME, "Cup", [1, 2]);
    const view = focused(), before = shape(currentDocument());
    noticeCalls.length = 0;
    press($(RENAME), "Enter");
    assert.deepEqual(noticeCalls.filter(call => call[1] === "warn"), [[REFUSED, "warn"]]);
    const kept = () => { const now = focused(); assert.equal(now.active, $(RENAME)); assert.deepEqual([now.value, now.range], [view.value, view.range]); };
    assert.equal(document.activeElement, view.active, "the box itself stays");
    kept();
    noticeCalls.length = 0;
    renderProduction();
    kept();
    assert.deepEqual(noticeCalls, []);
    assert.deepEqual(shape(currentDocument()), before);
    press($(RENAME), "Escape");
    exchange(f, "local-first");
    agree(f, before);
  } finally { tidy(f); }
});
