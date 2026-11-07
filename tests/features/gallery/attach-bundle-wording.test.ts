import { test } from "node:test";
import assert from "node:assert/strict";
import { bundlePromptText } from "../../../src/features/gallery/video-bundles.ts";

test("the copy prompt says file for an attached document, and video only when every file is a video (#256)", () => {
  assert.deepEqual(bundlePromptText(["brief.pdf"], "Episode 12 files"), {
    title: "Copy this file into the script's folder?",
    detail: "Splitpage can copy “brief.pdf” into “Episode 12 files”, a folder next to this script, and link to the copy. " +
      "Keep that folder with the script, and the file opens wherever the script goes. Otherwise the script links to the file where it is now."
  });
  assert.equal(bundlePromptText(["take.mp4", "brief.pdf"], "Episode 12 files").title, "Copy these files into the script's folder?");
  assert.match(bundlePromptText(["take.mp4", "brief.pdf"], "Episode 12 files").detail, /^Splitpage can copy these 2 files into/);
  assert.equal(bundlePromptText(["take.mp4"], "Episode 12 files").title, "Copy this video into the script's folder?");
});
