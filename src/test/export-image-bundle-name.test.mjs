import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();
after(closeApp);

const { migrateRows } = await import("../js/02-state.js");
const { intern } = await import("../adapters/storage/02c-blobs.js");
const { clearDirty } = await import("../js/12-dirty-toast.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { buildFileData } = await import("../js/18-local-files.js");

const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, 0, 200, 1, 44, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 7, 0xFF, 0xD9]);

function useScript(imageRef) {
  S.state = migrateRows({
    schema: 5, title: "Pictures", docId: "d" + "7".repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo", ...(imageRef ? { imageRef } : {}) }],
    comments: []
  });
  flushEdits();
  clearDirty();
}

test("a Markdown export with pictures that the caller allows to bundle is named '(with images).zip'", async () => {
  useScript(intern(jpegBytes));
  const made = await buildFileData("md", "Pictures", { allowImageBundle: true });
  assert.equal(made.filename, "Pictures (with images).zip");
});

test("a Markdown export is a plain .md when bundling is not allowed or the script has no pictures", async () => {
  useScript(intern(jpegBytes));
  assert.equal((await buildFileData("md", "Pictures", {})).filename, "Pictures.md");
  useScript(null);
  assert.equal((await buildFileData("md", "Pictures", { allowImageBundle: true })).filename, "Pictures.md");
});
