import test from "node:test";
import assert from "node:assert/strict";
import { mountHistory } from "../../../src/features/history/mount.ts";
import type { HistoryPorts } from "../../../src/features/history/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const expected: readonly Registration[] = [
  [
    "runtime-chip",
    "click"
  ],
  [
    "length-status",
    "click"
  ],
  [
    "history-close",
    "click"
  ],
  [
    "history-panel",
    "click"
  ]
];

export function setup() {
  const h = viewHarness();
  const p0: HistoryPorts = {
    promptForWpm: h.log("promptForWpm"),
    closeHistoryPanel: h.log("closeHistoryPanel"),
    onRootClick: h.log("onRootClick")
  };
  const mount = () => [mountHistory({ window: h.window, ports: p0 })];
  return { ...h, mount, p0 };
}

test("history: every target, event, phase and multiplicity across dispose and remount", () => {
  const h = setup();
  h.assertRemount(h.mount, expected);
  h.window.close();
});

test("history: timing chips and close act once and panel delegation remains after its own controls", () => {
  const h = setup();
  const owners = h.mount();
  h.fire(h.el("runtime-chip"), "click");
  h.fire(h.el("length-status"), "click");
  h.fire(h.el("history-close"), "click");
  assert.deepEqual(h.calls.map((call) => call.name), ["promptForWpm", "promptForWpm", "closeHistoryPanel", "onRootClick"]);
  owners.forEach((owner) => owner.dispose());
  h.window.close();
});
