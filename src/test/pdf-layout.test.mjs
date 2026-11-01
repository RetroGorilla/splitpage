import "./_dom.mjs";
import "./_export-services-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { intern } from "../adapters/storage/02c-blobs.js";
import { mountProductionTagsFeature as initTags } from "../bootstrap/wiring/production-tags.ts";
import { commentEntries } from "../adapters/formats/export-projections.ts";
import { exportDocumentOf } from "../bootstrap/wiring/export-capture.ts";
import { loadTestDocument } from "./_document.mjs";

initTags();

const jpeg = (w, h) => {
  const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
  return { bytes, size: { w, h } };
};
const cimg = (w, h) => {
  const rec = intern(jpeg(w, h).bytes);
  assert.ok(rec, "fake JPEG " + w + "x" + h + " interned");
  return { rec, html: '<img class="comment-img" data-blob="' + rec.sha256 + '" data-w="' + w + '" data-h="' + h + '" data-mime="image/jpeg">' };
};

test("commentEntries(exportDocumentOf(currentDocument())) keeps its plain-text shape; pieces only when asked", () => {
  const pic = cimg(120, 90);
  loadTestDocument(migrateRows({
    schema: 2, title: "t", rows: [{ id: "r0", visualText: "v", audioText: "a", status: "todo" }],
    comments: [{ id: "c0", rowId: "r0", field: "audioText", author: "Ann", body: "One&nbsp;" + pic.html + "<br>two <b>three</b>",
      replies: [{ id: "rp0", author: "Bob", body: "plain <i>reply</i>" }] }]
  }));
  const [plain] = commentEntries(exportDocumentOf(currentDocument()));
  assert.equal(plain.body, "One \ntwo three");
  assert.ok(!("pieces" in plain) && !("pieces" in plain.replies[0]));
  const [withPieces] = commentEntries(exportDocumentOf(currentDocument()), { pieces: true });
  assert.equal(withPieces.body, plain.body);
  assert.deepEqual(withPieces.pieces, [{ text: "One" }, { image: pic.rec.sha256 }, { text: "two three" }]);
  assert.deepEqual(withPieces.replies[0].pieces, [{ text: "plain reply" }]);
});
