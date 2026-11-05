import { test } from "node:test";
import assert from "node:assert/strict";
import { mountFlowClipboardRoutes } from "../../../src/features/clipboard/routes.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

test("the flow host owns paste before invoking the range handler and disposes its routes", () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  const root = win.document.createElement("div");
  root.innerHTML = '<span class="wr-beat">Words</span>';
  win.document.body.append(root);
  const calls: string[] = [];
  const dispose = mountFlowClipboardRoutes(root, {
    copy: () => { calls.push("copy"); },
    cut: () => { calls.push("cut"); },
    paste: event => { assert.equal(event.defaultPrevented, true); calls.push("paste"); }
  });
  for (const type of ["copy", "cut", "paste"]) {
    const child = root.firstElementChild;
    assert.ok(child);
    child.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
  }
  assert.deepEqual(calls, ["copy", "cut", "paste"]);
  dispose();
  const event = new win.Event("paste", { bubbles: true, cancelable: true });
  root.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(calls.length, 3);
});
