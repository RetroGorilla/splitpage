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
    "writer",
    "wheel",
    "B",
    false
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

function wheelHarness(size: number) {
  const h = setup();
  const owners = h.mount();
  h.el("wr-size").value = String(size);
  const wheel = (deltaY: number, props: Record<string, unknown> = {}) => {
    h.calls.length = 0;
    const event = h.fire(h.el("writer-doc"), "wheel", { ctrlKey: true, deltaY, deltaMode: 0, clientY: 0, ...props });
    const sizes = h.calls.filter((call) => call.name === "applyWriterSize").map((call) => call.args);
    const last = sizes.at(-1);
    if (last) h.el("wr-size").value = String(last[0]);
    return { event, sizes };
  };
  return { h, owners, wheel };
}

test("writer: Ctrl+wheel sets the same size the slider does, and keeps the browser from zooming the page", () => {
  const { h, owners, wheel } = wheelHarness(20);
  const up = wheel(-300);
  assert.equal(up.event.defaultPrevented, true);
  assert.deepEqual(up.sizes, [[27, true]]);
  const down = wheel(300);
  assert.equal(down.event.defaultPrevented, true);
  assert.deepEqual(down.sizes, [[20, true]]);
  owners.forEach((owner) => owner.dispose());
  h.window.close();
});

test("writer: a wheel without Ctrl scrolls as before and changes no size", () => {
  const { h, owners, wheel } = wheelHarness(20);
  const plain = wheel(-300, { ctrlKey: false });
  assert.equal(plain.event.defaultPrevented, false);
  assert.deepEqual(plain.sizes, []);
  owners.forEach((owner) => owner.dispose());
  h.window.close();
});

test("writer: small pinch steps add up to a size step, and a slider move starts the count again", () => {
  const { h, owners, wheel } = wheelHarness(20);
  const seen: unknown[][] = [];
  for (let i = 0; i < 6; i++) seen.push(...wheel(-10).sizes);
  assert.deepEqual(seen, [[21, true]], "six small steps make one size step, none sooner");
  h.el("wr-size").value = "30";
  assert.deepEqual(wheel(-10).sizes, [], "the leftover from before the slider moved is dropped");
  owners.forEach((owner) => owner.dispose());
  h.window.close();
});

test("writer: Ctrl+wheel scrolls the writer to keep the point under the pointer where it was", () => {
  const h = setup();
  const owners = h.mount();
  let height = 100;
  const block = h.document.createElement("div");
  block.className = "wr-block";
  block.getBoundingClientRect = () => ({ top: 50, height } as DOMRect);
  h.el("writer-doc").append(block);
  (h.p1 as { applyWriterSize: (size: number, persist: boolean) => void }).applyWriterSize = () => { height = 200; };
  h.el("wr-size").value = "20";
  const scroller = h.el("writer-scroll");
  scroller.scrollTop = 40;
  h.fire(block, "wheel", { ctrlKey: true, deltaY: -300, deltaMode: 0, clientY: 100 });
  assert.equal(scroller.scrollTop, 90, "the block doubled, so the point halfway down it moved 50px and the scroll follows");
  scroller.scrollTop = 40;
  height = 100;
  h.el("wr-size").value = "20";
  h.fire(h.el("writer-doc"), "wheel", { ctrlKey: true, deltaY: -300, deltaMode: 0, clientY: 100 });
  assert.equal(scroller.scrollTop, 40, "with no block under the pointer there is nothing to hold");
  owners.forEach((owner) => owner.dispose());
  h.window.close();
});

test("writer: Ctrl+wheel stays inside the slider's range and counts lines and pages like pixels", () => {
  const { h, owners, wheel } = wheelHarness(33);
  assert.deepEqual(wheel(-5000).sizes, [[34, true]]);
  assert.deepEqual(wheel(-5000).sizes, [], "at the top there is nothing to apply, and the count does not run past it");
  assert.deepEqual(wheel(300).sizes, [[25, true]]);
  assert.deepEqual(wheel(-1, { deltaMode: 1 }).sizes, [[26, true]], "a line is 33 pixels");
  assert.deepEqual(wheel(-1, { deltaMode: 2 }).sizes, [[34, true]], "a page is 600 pixels, capped like a hard flick");
  assert.deepEqual(wheel(5000).sizes, [[25, true]]);
  assert.deepEqual(wheel(5000).sizes, [[19, true]]);
  assert.deepEqual(wheel(5000).sizes, [[16, true]]);
  assert.deepEqual(wheel(5000).sizes, []);
  owners.forEach((owner) => owner.dispose());
  h.window.close();
});
