import test from "node:test";
import assert from "node:assert/strict";
import { mountScriptPlace } from "../../../src/features/panels/script-place.js";
import { viewHarness } from "../view-harness.ts";

function setup() {
  const h = viewHarness();
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  h.window.requestAnimationFrame = (run) => { frames.set(++serial, run); return serial; };
  h.window.cancelAnimationFrame = (id) => { frames.delete(id); };
  Object.defineProperty(h.window, "scrollY", { value: 200 });
  h.window.scrollBy = h.log("scroll");
  for (const el of h.document.querySelectorAll("#root, .topbar-row")) el.getAnimations = () => [];
  const row = h.document.createElement("div");
  row.className = "row";
  h.el("rows").replaceChildren(row);
  let top = 0;
  row.getBoundingClientRect = () => ({ top, bottom: top + 100, height: 100 } as DOMRect);
  return { ...h, frames, shift: () => { top += 20; }, mount: () => mountScriptPlace(h.window),
    advance: () => { const jobs = [...frames.values()]; frames.clear(); jobs.forEach((run) => run(0)); }
  };
}

test("script place: registers the same three routes once per mount and removes them on dispose", () => {
  const h = setup();
  h.assertRemount(() => [h.mount()], [
    ["window", "wheel", "B", true],
    ["window", "touchmove", "B", true],
    ["window", "keydown", "C"]
  ]);
  h.window.close();
});

for (const event of ["wheel", "touchmove", "keydown"]) {
  test("script place: " + event + " releases an active hold", () => {
    const h = setup();
    const owner = h.mount();
    owner.holdScriptPlace();
    assert.equal(h.frames.size, 1);
    h.shift();
    h.advance();
    assert.deepEqual(h.calls, [{ name: "scroll", args: [0, 20] }]);
    assert.equal(h.frames.size, 1);
    h.fire(h.window, event);
    h.shift();
    h.advance();
    assert.deepEqual(h.calls, [{ name: "scroll", args: [0, 20] }]);
    assert.equal(h.frames.size, 0);
    owner.dispose();
    assert.equal(h.entries.length, 0);
    h.window.close();
  });
}

test("script place: opening records the gutter and dispose cancels an active animation", () => {
  const h = setup();
  const owner = h.mount();
  owner.sidePanelOpening(true);
  assert.equal(h.document.documentElement.style.getPropertyValue("--page-gutter"), h.window.innerWidth + "px");
  assert.equal(h.frames.size, 1);
  owner.dispose();
  owner.dispose();
  assert.equal(h.frames.size, 0);
  assert.equal(h.entries.length, 0);
  h.shift();
  h.advance();
  assert.deepEqual(h.calls, []);
  h.window.close();
});
