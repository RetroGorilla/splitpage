import test from "node:test";
import assert from "node:assert/strict";
import { mountNotices } from "../../../src/features/notices/mount.ts";
import type { NoticesPorts } from "../../../src/features/notices/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const expected: readonly Registration[] = [
  [
    "update-bar-dismiss",
    "click"
  ],
  [
    "desktop-app-bar-dismiss",
    "click"
  ]
];

export function setup() {
  const h = viewHarness();
  const p0: NoticesPorts = {
    loadUpdateStatus: () => { h.calls.push({ name: "loadUpdateStatus", args: [] }); return h.log("dispose:loadUpdateStatus"); },
    dismissUpdateNotice: h.log("dismissUpdateNotice"),
    renderDesktopAppNotice: () => { h.calls.push({ name: "renderDesktopAppNotice", args: [] }); return h.log("dispose:renderDesktopAppNotice"); },
    dismissDesktopAppNotice: h.log("dismissDesktopAppNotice")
  };
  const mount = () => [mountNotices({ window: h.window, ports: p0 })];
  return { ...h, mount, p0 };
}

test("notices: every target, event, phase and multiplicity across dispose and remount", () => {
  const h = setup();
  h.assertRemount(h.mount, expected);
  h.window.close();
});

test("notices: S11 and S12 start in order, dismiss once, and release startup resources once", () => {
  const h = setup();
  const owners = h.mount();
  h.fire(h.el("update-bar-dismiss"), "click");
  h.fire(h.el("desktop-app-bar-dismiss"), "click");
  owners.forEach((owner) => { owner.dispose(); owner.dispose(); });
  assert.deepEqual(h.calls.map((call) => call.name), ["loadUpdateStatus", "renderDesktopAppNotice", "dismissUpdateNotice", "dismissDesktopAppNotice", "dispose:renderDesktopAppNotice", "dispose:loadUpdateStatus"]);
  h.window.close();
});
