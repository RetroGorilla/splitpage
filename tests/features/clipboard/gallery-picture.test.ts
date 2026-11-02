import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blobImgHtml } from "../../../src/adapters/storage/02c-blobs.ts";
import { noFreeze } from "../../../src/core/document/freeze.ts";
import { cellFromClipboard, hasMediaFiles, readClipboardFiles, startCellClipboard } from "../../../src/features/clipboard/cell-clipboard.ts";
import type { CellClipboardPorts } from "../../../src/features/clipboard/ports.ts";
import { adapterWith, fakePorts } from "../../adapters/richtext/fakes.ts";
import { fakeDocument, fakeEdits, fakePictures } from "../fakes.ts";

const ref = { sha256: "d".repeat(64), width: 17, height: 13, mime: "image/png" };

function clipboard(recover: boolean = false) {
  const state = { loaded: false };
  const reads: (readonly string[])[] = [];
  const base = fakePorts();
  const text = adapterWith({ ...base, images: { ...base.images, known: () => state.loaded ? ref : null } });
  const edits = fakeEdits();
  const ports: CellClipboardPorts = {
    document: fakeDocument().document,
    edits: { ...edits.edits, text: { ...edits.edits.stamps, cells: () => [] } },
    undo: { breakCoalescing: () => {}, flush: () => {} },
    pictures: {
      ...fakePictures().pictures,
      bytesFor: () => state.loaded ? new Uint8Array([1]) : null,
      ensureBytes: async (shas) => { reads.push(shas); state.loaded = recover; return recover ? [] : [...shas]; }
    },
    text: { cellOf: text.createCellReader(noFreeze), fromHtml: text.decode, inertBody: text.inertBody, storedHtmlFromDom: text.storedHtmlFromDom },
    imageRefOf: text.imageRefOf,
    ids: { id: (prefix) => prefix + "1" },
    nonce: () => "n1",
    selection: () => null,
    cells: { open: () => null, close: (cell) => cell },
    paintGuard: { whileShown: (edit) => edit() },
    brollSeed: () => ({ audioRef: "", location: "" })
  };
  return { owner: startCellClipboard(ports), state, reads };
}

test("gallery picture HTML without bytes is counted as lost, keeping its surrounding words (#1098)", () => {
  const { owner } = clipboard();
  try {
    const got = cellFromClipboard("before " + blobImgHtml(ref) + " after", "before after");
    assert.equal(got.lost, 1);
    assert.equal(got.media, 1);
    assert.deepEqual(got.attach, []);
    assert.equal(got.cell.map((run) => run.text).join(""), "before  after");
  } finally {
    owner.dispose();
  }
});

test("even complete picture metadata cannot be accepted without the bytes (#1098)", async () => {
  const { owner, reads } = clipboard();
  try {
    const html = '<img data-blob="' + ref.sha256 + '" data-w="17" data-h="13" data-mime="image/png">';
    assert.equal(hasMediaFiles([], html), true);
    await readClipboardFiles([], async () => "", undefined, html);
    assert.deepEqual(reads, [[ref.sha256]]);
    const got = cellFromClipboard(html, "");
    assert.equal(got.lost, 1);
    assert.deepEqual(got.attach, []);
  } finally {
    owner.dispose();
  }
});

test("an HTML-only gallery picture loads its bytes before the paste and obtains its full reference (#1098)", async () => {
  const { owner, reads } = clipboard(true);
  try {
    const html = blobImgHtml(ref);
    assert.equal(hasMediaFiles([], html), true);
    assert.equal(cellFromClipboard(html, "").lost, 1);
    await readClipboardFiles([], async () => "", undefined, html);
    assert.deepEqual(reads, [[ref.sha256]]);
    const got = cellFromClipboard(html, "");
    assert.equal(got.lost, 0);
    assert.deepEqual(got.attach, [{ kind: "image", ref }]);
    assert.equal(hasMediaFiles([], '<span data-blob="' + ref.sha256 + '">words</span>'), false);
    assert.equal(hasMediaFiles([], '<!--' + html + '-->words'), false);
  } finally {
    owner.dispose();
  }
});
