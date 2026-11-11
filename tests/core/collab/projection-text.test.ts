import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseSharedProjectionPayload, projectSharedText } from "../../../src/core/collab/projection/text.ts";
import { readSharedContentRef } from "../../../src/core/collab/read-operation.ts";

test("projection payload choice compares serialized values by UTF-16 in both arrangements", () => {
  for (const [values, expected] of [[["z", "a"], "a"], [["a", "z"], "a"], [[true, "a"], "a"], [["a", true], "a"], [["\ue000", "😀"], "😀"], [["😀", "\ue000"], "😀"]] as const) {
    assert.equal(chooseSharedProjectionPayload(values), expected);
  }
  assert.equal(chooseSharedProjectionPayload([]), undefined);
});
test("projection reuses the plain text serializer for every inline atom from the operation contract", () => {
  const id = readSharedContentRef("S1"); assert.ok(id);
  assert.equal(projectSharedText([
    { value: { atom: "broll", id }, marks: [] }, { value: { atom: "who", name: "Ada" }, marks: [] },
    { value: { atom: "image", ref: { sha256: "a".repeat(64) } }, marks: [] },
    { value: { atom: "video", href: "https://example.test/clip", host: "Host" }, marks: [] }
  ], []), '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span><span class="who-anchor" data-who="Ada" contenteditable="false">@Ada</span><img class="comment-img" data-blob="' + "a".repeat(64) + '"><a class="video-embed-card" href="https://example.test/clip" target="_blank" rel="noopener"><span class="vec-play">▶</span><span>Watch video</span><span class="vec-host">· Host</span></a>');
});
