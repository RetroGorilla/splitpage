import test from "node:test";
import assert from "node:assert/strict";
import { mountPanels } from "../../../src/features/panels/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const ids = ["comments-panel", "production-panel", "gear-panel", "broll-panel", "history-panel"];

function setup() {
  const h = viewHarness();
  const mount = () => mountPanels({ window: h.window, ports: {
    ids, readWidth: () => 488, defaultWidth: () => 488,
    clampWidth: (width) => Math.max(280, Math.min(720, Math.round(width))),
    applyWidth: (id, width) => { h.log("apply")(id, width); h.el(id).style.setProperty("--panel-width", String(width)); },
    saveWidth: h.log("save")
  } });
  return { ...h, mount };
}

test("panels: every S29 handle registration and phase across dispose and remount", () => {
  const h = setup();
  const expected: Registration[] = ids.flatMap((id) => [
    [id + "-resize-handle", "mousedown"],
    [id + "-resize-handle", "touchstart", "B", false],
    [id + "-resize-handle", "dblclick"]
  ] as Registration[]);
  h.assertRemount(() => [h.mount()], expected);
  h.window.close();
});

test("panels: dispose during mouse and touch resizing removes supporting routes and drag classes", () => {
  const h = setup();
  for (const touch of [false, true]) {
    const owner = h.mount();
    const handle = h.el("history-panel-resize-handle");
    h.fire(handle, touch ? "touchstart" : "mousedown", touch ? { touches: [{ clientX: 100 }] } : { clientX: 100 });
    assert.deepEqual(h.order.slice(-4), ["document:mousemove/B", "document:mouseup/B", "document:touchmove/B/passive:false", "document:touchend/B"]);
    assert.equal(h.entries.length, 19);
    h.calls.length = 0;
    h.fire(h.document, touch ? "touchmove" : "mousemove", touch ? { touches: [{ clientX: 80 }] } : { clientX: 80 });
    assert.deepEqual(h.calls, [{ name: "apply", args: ["history-panel", 508] }]);
    owner.dispose();
    owner.dispose();
    assert.equal(h.entries.length, 0);
    assert.equal(handle.classList.contains("is-dragging"), false);
    assert.equal(h.document.body.classList.contains("is-panel-resizing"), false);
    h.calls.length = 0;
    h.fire(h.document, "mousemove", { clientX: 10 });
    h.fire(h.document, "mouseup");
    assert.deepEqual(h.calls, []);
  }
  h.window.close();
});

test("panels: release persists clamped width once and double click resets", () => {
  const h = setup();
  const owner = h.mount();
  const handle = h.el("comments-panel-resize-handle");
  h.calls.length = 0;
  h.fire(handle, "mousedown", { clientX: 100 });
  h.fire(h.document, "mousemove", { clientX: -1000 });
  h.fire(h.document, "mouseup");
  h.fire(h.document, "mouseup");
  h.fire(handle, "dblclick");
  assert.deepEqual(h.calls, [
    { name: "apply", args: ["comments-panel", 720] }, { name: "save", args: ["comments-panel", 720] },
    { name: "apply", args: ["comments-panel", 488] }, { name: "save", args: ["comments-panel", 488] }
  ]);
  assert.equal(h.entries.length, 15);
  owner.dispose();
  h.window.close();
});
