import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const { intern } = await import("../adapters/storage/02c-blobs.js");

const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, 0, 200, 1, 44, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 7, 0xFF, 0xD9]);

function scriptJson(imageRef) {
  return JSON.stringify({
    schema: 5, title: "Pictures", docId: "d" + "7".repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageRef }],
    comments: []
  });
}

after(closeApp);

test("a Markdown export with pictures that the caller allows to bundle is named '(with images).zip'", async () => {
  await bootApp(scriptJson(intern(jpegBytes)));
  const { buildFileData } = await import("../js/18-local-files.js");
  const made = await buildFileData("md", "Pictures", { allowImageBundle: true });
  assert.equal(made.filename, "Pictures (with images).zip");
  assert.equal((await buildFileData("md", "Pictures", {})).filename, "Pictures.md", "bundling is off unless the caller allows it");
});
