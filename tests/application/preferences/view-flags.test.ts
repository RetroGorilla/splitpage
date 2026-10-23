import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewFlags } from "../../../src/application/preferences/view-flags.ts";
import type { ViewFlagChange } from "../../../src/application/preferences/view-flags.ts";

test("the find bar and the writer start closed, and hide-shot starts from the stored preference", () => {
  const off = createViewFlags({ hideShot: () => false });
  assert.equal(off.findOpen(), false);
  assert.equal(off.writerOpen(), false);
  assert.equal(off.tourOpen(), false);
  assert.equal(off.brollPageOpen(), false);
  assert.equal(off.hideShot(), false);
  assert.equal(createViewFlags({ hideShot: () => true }).hideShot(), true);
});

test("each setter changes only its own flag and announces the change", () => {
  const flags = createViewFlags({ hideShot: () => false });
  const seen: ViewFlagChange[] = [];
  flags.onChange((change) => seen.push(change));
  flags.setFindOpen(true);
  flags.setWriterOpen(true);
  flags.setHideShot(true);
  assert.deepEqual([flags.findOpen(), flags.writerOpen(), flags.hideShot()], [true, true, true]);
  flags.setWriterOpen(false);
  assert.deepEqual([flags.findOpen(), flags.writerOpen(), flags.hideShot()], [true, false, true]);
  assert.deepEqual(seen, [
    { flag: "findOpen", value: true },
    { flag: "writerOpen", value: true },
    { flag: "hideShot", value: true },
    { flag: "writerOpen", value: false }
  ]);
});

test("the tour setter changes only its own flag and announces only changes", () => {
  const flags = createViewFlags({ hideShot: () => false });
  const seen: ViewFlagChange[] = [];
  flags.onChange((change) => seen.push(change));
  flags.setTourOpen(false);
  assert.deepEqual(seen, []);
  flags.setTourOpen(true);
  assert.deepEqual([flags.findOpen(), flags.writerOpen(), flags.tourOpen(), flags.hideShot()], [false, false, true, false]);
  assert.deepEqual(seen, [{ flag: "tourOpen", value: true }]);
  flags.setTourOpen(true);
  assert.deepEqual(seen, [{ flag: "tourOpen", value: true }]);
  flags.setWriterOpen(true);
  assert.equal(flags.tourOpen(), true);
  flags.setTourOpen(false);
  assert.deepEqual([flags.findOpen(), flags.writerOpen(), flags.tourOpen(), flags.hideShot()], [false, true, false, false]);
  assert.deepEqual(seen, [
    { flag: "tourOpen", value: true },
    { flag: "writerOpen", value: true },
    { flag: "tourOpen", value: false }
  ]);
});

test("setting a flag to the value it already has announces nothing", () => {
  const flags = createViewFlags({ hideShot: () => false });
  const seen: ViewFlagChange[] = [];
  flags.onChange((change) => seen.push(change));
  flags.setFindOpen(false);
  flags.setBrollPageOpen(false);
  flags.setHideShot(false);
  assert.deepEqual(seen, []);
});

test("the B-roll page setter changes only its own flag and announces only changes", () => {
  const flags = createViewFlags({ hideShot: () => true });
  const seen: ViewFlagChange[] = [];
  flags.onChange((change) => seen.push(change));
  flags.setBrollPageOpen(true);
  assert.deepEqual([flags.findOpen(), flags.writerOpen(), flags.brollPageOpen(), flags.hideShot()], [false, false, true, true]);
  flags.setBrollPageOpen(true);
  assert.deepEqual(seen, [{ flag: "brollPageOpen", value: true }]);
  flags.setBrollPageOpen(false);
  assert.deepEqual([flags.findOpen(), flags.writerOpen(), flags.brollPageOpen(), flags.hideShot()], [false, false, false, true]);
  flags.setBrollPageOpen(false);
  assert.deepEqual(seen, [
    { flag: "brollPageOpen", value: true },
    { flag: "brollPageOpen", value: false }
  ]);
});

test("a listener that is removed hears no more, and removing it during an announcement does not skip the others", () => {
  const flags = createViewFlags({ hideShot: () => false });
  const calls: string[] = [];
  const off = flags.onChange(() => { calls.push("a"); off(); });
  flags.onChange(() => calls.push("b"));
  flags.setFindOpen(true);
  flags.setFindOpen(false);
  assert.deepEqual(calls, ["a", "b", "b"]);
});
