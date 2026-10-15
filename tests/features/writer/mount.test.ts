import test from "node:test";
import assert from "node:assert/strict";
import { mountWriterOpen, mountWriterNavigation, mountWriterClose } from "../../../src/features/writer/mount.ts";
import type { WriterOpenPorts, WriterNavigationPorts, WriterClosePorts } from "../../../src/features/writer/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const expected: readonly Registration[] = [
  [
    "btn-write",
    "click"
  ],
  [
    "writer-doc",
    "click"
  ],
  [
    "wr-save",
    "click"
  ],
  [
    "wr-size",
    "input"
  ],
  [
    "wr-close",
    "click"
  ]
];

export function setup() {
  const h = viewHarness();
  const p0: WriterOpenPorts = {
    runFromButton: h.log("runFromButton")
  };
  const p1: WriterNavigationPorts = {
    jumpFromWriterToRow: h.log("jumpFromWriterToRow"),
    expandHiddenShotStrip: h.log("expandHiddenShotStrip"),
    saveFromButton: h.log("saveFromButton"),
    applyWriterSize: h.log("applyWriterSize")
  };
  const p2: WriterClosePorts = {
    closeWriter: h.log("closeWriter")
  };
  const mount = () => [mountWriterOpen({ window: h.window, ports: p0 }), mountWriterNavigation({ window: h.window, ports: p1 }), mountWriterClose({ window: h.window, ports: p2 })];
  return { ...h, mount, p0, p1, p2 };
}

test("writer: every target, event, phase and multiplicity across dispose and remount", () => {
  const h = setup();
  h.assertRemount(h.mount, expected);
  h.window.close();
});

test("writer: jump precedes expansion and size, open, save and close reach their existing actions once", () => {
  const h = setup();
  const owners = h.mount();
  const outer = h.document.createElement("div");
  outer.dataset.action = "expand-hidden-shot";
  outer.dataset.ids = "r1,r2";
  const jump = h.document.createElement("button");
  jump.dataset.action = "writer-jump";
  jump.dataset.row = "r2";
  outer.append(jump);
  h.el("writer-doc").append(outer);
  h.fire(jump, "click");
  h.fire(outer, "click");
  h.el("wr-size").value = "24";
  h.fire(h.el("wr-size"), "input");
  h.fire(h.el("btn-write"), "click");
  const saveEvent = h.fire(h.el("wr-save"), "click");
  h.fire(h.el("wr-close"), "click");
  assert.deepEqual(h.calls, [
    { name: "jumpFromWriterToRow", args: ["r2"] }, { name: "expandHiddenShotStrip", args: ["r1,r2"] },
    { name: "applyWriterSize", args: [24, true] }, { name: "runFromButton", args: ["write"] },
    { name: "saveFromButton", args: [saveEvent] }, { name: "closeWriter", args: [] }
  ]);
  owners.forEach((owner) => owner.dispose());
  h.window.close();
});
