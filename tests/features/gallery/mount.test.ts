import test from "node:test";
import assert from "node:assert/strict";
import { mountHistoryGallery } from "../../../src/features/gallery/mount.ts";
import { viewHarness } from "../view-harness.ts";

test("gallery and history: B43 and B55 register no listeners and disable both routes across remount", () => {
  const h = viewHarness();
  const mount = () => mountHistoryGallery({ restore: h.log("restore"), open: h.log("open") });
  let owner = mount();
  assert.equal(h.entries.length, 0);
  const button = h.document.createElement("button");
  h.document.body.append(button);
  function click(action: string, row: string, slot: string): MouseEvent {
    button.dataset.action = action;
    button.dataset.id = row;
    button.dataset.slot = slot;
    const event = new h.window.MouseEvent("click");
    Object.defineProperty(event, "target", { value: button });
    return event;
  }
  const disposed = owner;
  owner.dispose();
  owner.dispose();
  owner = mount();
  assert.equal(disposed.restoreClick(click("restore-snapshot", "r1", "0")), false);
  assert.equal(disposed.galleryClick(click("gallery-open", "r1", "0")), false);
  assert.equal(owner.restoreClick(click("restore-snapshot", "r1", "0")), true);
  assert.equal(owner.galleryClick(click("gallery-open", "r2", "2")), true);
  assert.equal(owner.galleryClick(click("gallery-open-videos", "r3", "invalid")), true);
  assert.deepEqual(h.calls, [
    { name: "restore", args: [button] }, { name: "open", args: ["r2", 2, false] }, { name: "open", args: ["r3", 0, true] }
  ]);
  owner.dispose();
  assert.equal(h.entries.length, 0);
  h.window.close();
});
