import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountFileCopyBanner } from "../../../src/features/collaboration/file-copy-banner.ts";
import { fakeFileCopy } from "../fakes.ts";

test("the file copy banner offers the choices for the current failure", async t => {
  const anchor = document.createElement("div");
  anchor.id = "merge-banner";
  document.body.append(anchor);
  const copy = fakeFileCopy();
  const retry = t.mock.fn(async () => {});
  const overwrite = t.mock.fn(async () => {});
  const saveAs = t.mock.fn(async () => {});
  const stop = t.mock.fn(async () => {});
  const dispose = mountFileCopyBanner({ ...copy.reads, retry, overwrite, saveAs, stop });
  t.after(() => { dispose(); anchor.remove(); });
  const banner = document.getElementById("file-copy-banner");
  assert.ok(banner?.hidden);
  const file = { name: "Pilot.splitpage", docId: "d" + "a".repeat(32), missing: 0 };
  copy.set({ file, problem: "changed" });
  const buttons = () => Array.from(banner.querySelectorAll<HTMLButtonElement>("button:not([hidden])"));
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent ?? "", /Pilot\.splitpage.*changed outside/);
  assert.deepEqual(buttons().map(button => button.textContent), ["Overwrite the file", "Save as a new copy…", "Stop keeping a copy"]);
  for (const button of buttons()) {
    button.click();
    assert.ok(buttons().every(action => action.disabled));
    await Promise.resolve();
  }
  assert.deepEqual([overwrite, saveAs, stop].map(mock => mock.mock.callCount()), [1, 1, 1]);
  copy.set({ file, problem: "unavailable" });
  assert.equal(buttons()[0]?.textContent, "Try again");
  buttons()[0]?.click();
  await Promise.resolve();
  assert.equal(retry.mock.callCount(), 1);
  copy.set({ file, problem: null });
  assert.equal(banner.hidden, true);
});
