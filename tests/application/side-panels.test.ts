import "../../src/test/_dom.mjs";
import { panelControl as portSidePanels } from "../../src/bootstrap/wiring/ports/panels.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { SidePanels } from "../../src/application/side-panels.ts";

import { startSidePanels } from "../../src/legacy/panels-bridge.ts";

test("shared side panels close the current owner across restarts", () => {
  const panels = portSidePanels;
  const calls: string[] = [];
  const owner = (name: string): SidePanels => ({
    registerPanel: () => () => {}, registerPage: () => () => {}, open: () => {}, close: () => {},
    closeAll: () => { calls.push(name); }, sync: () => {}, applyWidth: () => {}
  });
  assert.throws(() => panels.closeAll(), /The side panels are not started yet/);
  let stop = startSidePanels(owner("first"));
  try {
    panels.closeAll();
    stop();
    stop = startSidePanels(owner("second"));
    panels.closeAll();
    assert.deepEqual(calls, ["first", "second"]);
  } finally {
    stop();
  }
});
