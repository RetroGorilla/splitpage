import { test } from "node:test";
import assert from "node:assert/strict";
import { imageDims, sniffImageMime } from "../../shared/blob-policy.ts";
import { thumbnailRefusal } from "../../shared/video-embed.ts";

function inspectUntrustedMedia(value: unknown) {
  return [sniffImageMime(value), imageDims(value), thumbnailRefusal(value)];
}

test("shared media validators accept untrusted strings and unknown values", () => {
  assert.equal(sniffImageMime("GIF89a"), null);
  assert.equal(imageDims("GIF89a"), null);
  assert.equal(thumbnailRefusal("GIF89a"), "NOT_AN_IMAGE");
  assert.deepEqual(inspectUntrustedMedia("GIF89a"), [null, null, "NOT_AN_IMAGE"]);
  assert.deepEqual(inspectUntrustedMedia(null), [null, null, "NOT_AN_IMAGE"]);
});
