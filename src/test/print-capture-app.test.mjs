import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { createGates } from "./_m4-matrix.mjs";

await bootApp();
after(closeApp);

const { printDialog } = await import("../bootstrap/wiring/ports/printing.ts");
const { localFileMenuControls } = await import("../bootstrap/wiring/local-files.ts");
const { exportFormats } = await import("../bootstrap/wiring/export-registry.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { blobStore, createMemoryBackend, intern, setBackend } = await import("../adapters/storage/02c-blobs.ts");
const { confirmSavedNow } = await import("../bootstrap/wiring/save-owners.ts");
const { loadTestDocument } = await import("./_document.mjs");

const PDF_KINDS = ["pdf", "packing-gear", "packing-prop", "b-roll pdf"];

const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt || 0, 0xFF, 0xD9]);

function picture(w, h, salt) {
  const bytes = jpegBytes(w, h, salt);
  return { bytes: bytes, ref: intern(bytes) };
}

function picturedScript(refs) {
  return migrateRows({
    schema: 5, title: "Pictures", docId: "d" + "8".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageRef: refs.row, moreImages: [{ imageRef: refs.more }] },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ],
    comments: [{
      id: "c1", rowId: "r1", field: "audioText", author: "Ann", createdAt: "2026-10-01T10:00:00.000Z", replies: [],
      body: 'See <img class="comment-img" data-blob="' + refs.comment.sha256 + '" data-w="40" data-h="30" data-mime="' + refs.comment.mime + '">'
    }]
  });
}

function useDocument(doc) {
  loadTestDocument(doc);
  confirmSavedNow();
}

function capturePrints() {
  const reserve = printDialog.reserve;
  const pages = [];
  printDialog.reserve = () => ({ ended: new Promise(() => {}), print: async (html) => { pages.push(html); return "opened"; }, close() {} });
  return { pages: pages, restore: () => { printDialog.reserve = reserve; } };
}

test("the four PDF products have only a print page, so asking for their file bytes is refused", async () => {
  for (const kind of PDF_KINDS) {
    const exporter = exportFormats.byId(kind);
    assert.equal(typeof exporter?.printPage, "function", kind + ": prints a page");
    assert.equal(exporter.build, undefined, kind + ": builds no file of its own");
    await assert.rejects(localFileMenuControls().buildFileData(kind, "export"), new RegExp("The " + kind + " export prints a page and builds no file"));
  }
});

test("a PDF export whose picture reads are held prints the captured pictures in their places when the document and pictures change", async () => {
  const gates = createGates();
  const inner = createMemoryBackend();
  const reads = [];
  const held = {
    name: "held", persistent: false,
    get: async (sha) => { reads.push(sha); await gates.pass("blob.get", sha); return inner.get(sha); },
    put: (sha, bytes, mime) => inner.put(sha, bytes, mime),
    missing: (shas) => inner.missing(shas)
  };
  const prints = capturePrints();
  try {
    const row = picture(300, 200, 51);
    const more = picture(200, 300, 52);
    const comment = picture(40, 30, 53);
    const replacement = picture(120, 90, 54);
    useDocument(picturedScript({ row: row.ref, more: more.ref, comment: comment.ref }));
    await localFileMenuControls().runExport("export-pdf");
    assert.equal(prints.pages.length, 1, "setup: the reference export printed");
    const reference = prints.pages[0];
    assert.ok((reference.match(/<img /g) || []).length >= 3, "setup: the reference page holds the three pictures");
    for (const p of [row, more, comment]) await inner.put(p.ref.sha256, p.bytes, p.ref.mime);
    setBackend(held);
    blobStore.forgetMemory();
    intern(replacement.bytes);
    useDocument(picturedScript({ row: row.ref, more: more.ref, comment: comment.ref }));
    gates.hold("blob.get", { times: 99 });
    const printing = localFileMenuControls().runExport("export-pdf");
    await gates.arrived("blob.get");
    currentDocument().title = "Changed after capture";
    currentDocument().rows[0].imageRef = replacement.ref;
    currentDocument().rows[0].moreImages = [];
    currentDocument().comments[0].body = "No picture now";
    const replaced = JSON.stringify(currentDocument());
    gates.releaseAll("blob.get");
    await printing;
    assert.deepEqual(reads.slice().sort(), [row.ref.sha256, more.ref.sha256, comment.ref.sha256].sort(), "the held reads were for the captured pictures");
    assert.equal(prints.pages.length, 2, "the held export printed once");
    assert.equal(prints.pages[1], reference, "the print page holds the captured pictures where they were");
    assert.equal(JSON.stringify(currentDocument()), replaced, "the live document is as it was left");
  } finally {
    gates.releaseAll("blob.get");
    setBackend(createMemoryBackend());
    prints.restore();
  }
});
