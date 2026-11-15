import { test } from "node:test";
import assert from "node:assert/strict";
import { HELD_PATHS as allCases, warnings, clearWarnings, ORDERS, enter, exchange, agree, withZ, ADMISSION_HELD, refusedOnce, tidy, $, FIRE, focused } from "./_shared-split-records.mjs";

const HELD_PATHS = allCases.filter((_, index) => [18,19,20,21,22,23,24,25,26,27,28,29,30,31].includes(index));

for (const path of HELD_PATHS) for (const order of ORDERS) test(`C7 record held: ${path.name} refused at admission by a session hold writes nothing, keeps text, focus, selection and open state, and warns once, ${order}`, async () => {
  const f = await enter();
  let stop = () => {};
  try {
    path.setup();
    const target = $(path.target);
    if (path.how === "click") target.focus();
    const view = focused(), state = path.state();
    stop = f.parts.session.hold(ADMISSION_HELD);
    const start = refusedOnce(f, order, () => { FIRE[path.how](target); }, () => {
      const now = focused();
      assert.equal(now.active, view.active, "focus stays where it was");
      assert.deepEqual([now.value, now.range], [view.value, view.range], "the text and its selection stay");
      assert.deepEqual(path.state(), state, "the open state and its text stay");
      path.render();
      const shown = s => path.kept || !s.boxes ? s : { ...s, boxes: s.boxes.map(box => box.slice(0, 2)) };
      assert.deepEqual(shown(path.state()), shown(state), path.kept ? "the open state and its text survive a render" : "the open state survives a render");
    });
    stop();
    clearWarnings();
    exchange(f, order);
    agree(f, withZ(start));
    assert.deepEqual(warnings(), []);
  } finally { stop(); tidy(f); }
});
