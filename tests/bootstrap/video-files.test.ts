import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { videoFiles, mountVideoFilesFeature, stopVideoFilesFeature } from "../../src/bootstrap/wiring/video-files.ts";

test("video-file wiring creates its owner explicitly, replaces it, and refuses calls after it stops", () => {
  const link = { name: "wiring.mp4", size: 3 };
  assert.throws(() => videoFiles.has(link), /not mounted/);
  try {
    const first = mountVideoFilesFeature();
    videoFiles.grant({ size: 3 }, link);
    assert.equal(videoFiles.has(link), true);
    const replacement = mountVideoFilesFeature();
    assert.notEqual(first, replacement);
    assert.equal(first.has(link), false);
    assert.equal(videoFiles.has(link), false);
    first.dispose();
    videoFiles.grant({ size: 3 }, link);
    assert.equal(videoFiles.has(link), true);
    stopVideoFilesFeature();
    stopVideoFilesFeature();
    assert.throws(() => videoFiles.has(link), /not mounted/);
  } finally {
    stopVideoFilesFeature();
  }
});
