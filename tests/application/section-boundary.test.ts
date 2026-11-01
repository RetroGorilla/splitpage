import { test } from "node:test";
import assert from "node:assert/strict";
import { createSectionBoundaryRemoval } from "../../src/application/editing/section-boundary.ts";
import { fakeClock } from "./session-fakes.ts";

function setup() {
  const timers = fakeClock();
  const removed: string[] = [];
  let hint = "";
  const owner = createSectionBoundaryRemoval({ timers, remove: id => { removed.push(id); },
    hint: (_id, text) => { hint = text; } });
  return { timers, removed, owner, hint: () => hint };
}

for (const key of ["Backspace", "Delete", "Alt+ArrowUp", "Alt+ArrowDown"] as const) {
  test("section boundary: " + key + " first press only hints, second removes exactly one header", () => {
    const h = setup();
    assert.equal(h.owner.press("s1", key), false);
    assert.deepEqual(h.removed, []);
    assert.equal(h.hint(), key.startsWith("Alt+") ? "Press again to remove the section header" : "Press " + key + " again to remove the section header");
    h.timers.advance(1999);
    assert.equal(h.owner.press("s1", key), true);
    assert.deepEqual(h.removed, ["s1"]);
    assert.equal(h.hint(), "");
    assert.equal(h.timers.armed(), 0);
  });

  test("section boundary: interrupted or timed-out " + key + " cannot remove a header", () => {
    for (const cancel of ["input", "key", "click", "caret", "timeout"] as const) {
      const h = setup();
      h.owner.press("s1", key);
      if (cancel === "timeout") h.timers.advance(2000);
      else h.owner.cancel();
      assert.equal(h.hint(), "", cancel);
      h.owner.press("s1", key);
      assert.deepEqual(h.removed, [], cancel);
      h.owner.dispose();
      assert.equal(h.timers.armed(), 0);
    }
  });
}

test("section boundary: changing key, header or disposing never confirms the pending removal", () => {
  const h = setup();
  h.owner.press("s1", "Backspace");
  h.owner.press("s1", "Delete");
  h.owner.press("s2", "Delete");
  h.owner.dispose();
  h.owner.press("s2", "Delete");
  assert.deepEqual(h.removed, []);
  assert.equal(h.hint(), "");
});
