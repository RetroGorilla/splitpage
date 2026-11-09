import { test } from "node:test";
import assert from "node:assert/strict";
import { bundlePromptText } from "../../../src/features/gallery/video-bundles.ts";

test("the attach prompt says file for an attached document, and video only when every file is a video (#256, #260)", () => {
  assert.deepEqual(bundlePromptText(["brief.pdf"], "Episode 12 files"), {
    title: "Add this file to the script's folder?",
    detail: "Splitpage can copy or move “brief.pdf” into “Episode 12 files”, a folder next to this script. " +
      "Keep that folder with the script, and the file opens wherever the script goes. " +
      "Move takes it out of where it is now, so other scripts that link it there lose it.",
    leave: "Leave it where it is", move: "Move it", copy: "Copy it"
  });
  assert.equal(bundlePromptText(["take.mp4", "brief.pdf"], "Episode 12 files").title, "Add these files to the script's folder?");
  assert.match(bundlePromptText(["take.mp4", "brief.pdf"], "Episode 12 files").detail, /^Splitpage can copy or move these 2 files into/);
  assert.equal(bundlePromptText(["take.mp4"], "Episode 12 files").title, "Add this video to the script's folder?");
});
