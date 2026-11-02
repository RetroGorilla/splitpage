import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blobImgHtml } from "../../../src/adapters/storage/02c-blobs.ts";
import { noFreeze } from "../../../src/core/document/freeze.ts";
import { cellFromClipboard, hasMediaFiles, readClipboardFiles, startCellClipboard } from "../../../src/features/clipboard/cell-clipboard.ts";
import type { CellClipboardPorts } from "../../../src/features/clipboard/ports.ts";
import type { PictureStore } from "../../../src/application/media/picture-store.ts";
import { adapterWith, fakePorts } from "../../adapters/richtext/fakes.ts";
import { cleanPastedLinks } from "../../../src/adapters/richtext/paste-links.ts";
import { fakeDocument, fakeEdits, fakePictures } from "../fakes.ts";

const ref = { sha256: "d".repeat(64), width: 17, height: 13, mime: "image/png" };

function clipboard(recover: boolean = false, inline: boolean = false) {
  const state = { loaded: false };
  const reads: (readonly string[])[] = [];
  const stats = { copiedBytes: 0, presenceChecks: [] as string[] };
  const bytes = new Uint8Array(1024 * 1024);
  const base = fakePorts();
  const text = adapterWith({ ...base, images: {
    ...base.images,
    known: (sha) => state.loaded && sha === ref.sha256 ? ref : null,
    fromDataUrl: (src) => {
      if (!inline || src !== 'data:image/png;base64,AQ==') return null;
      state.loaded = true;
      return ref;
    }
  } });
  const edits = fakeEdits();
  const pictures: PictureStore = {
    ...fakePictures().pictures,
    has: (sha) => { stats.presenceChecks.push(String(sha)); return state.loaded && sha === ref.sha256; },
    bytesFor: (sha) => {
      if (!state.loaded || sha !== ref.sha256) return null;
      stats.copiedBytes += bytes.byteLength;
      return bytes.slice();
    },
    ensureBytes: async (shas) => { reads.push(shas); state.loaded = recover; return recover ? [] : [...shas]; }
  };
  const ports: CellClipboardPorts = {
    document: fakeDocument().document,
    edits: { ...edits.edits, text: { ...edits.edits.stamps, cells: () => [] } },
    undo: { breakCoalescing: () => {}, flush: () => {} },
    pictures,
    text: { cellOf: text.createCellReader(noFreeze), fromHtml: text.decode, inertBody: text.inertBody, cleanPastedCell: cleanPastedLinks, storedHtmlFromDom: text.storedHtmlFromDom },
    imageRefOf: text.imageRefOf,
    ids: { id: (prefix) => prefix + "1" },
    nonce: () => "n1",
    selection: () => null,
    cells: { open: () => null, close: (cell) => cell },
    paintGuard: { whileShown: (edit) => edit() },
    brollSeed: () => ({ audioRef: "", location: "" })
  };
  return { owner: startCellClipboard(ports), state, reads, stats };
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

test("repeated picture references check each unique hash once without copying bytes (#1098)", () => {
  const { owner, state, stats } = clipboard();
  state.loaded = true;
  try {
    const missing = { ...ref, sha256: 'e'.repeat(64) };
    const html = blobImgHtml(ref).repeat(64) + blobImgHtml(missing).repeat(64);
    const got = cellFromClipboard(html, '');
    assert.deepEqual(got.attach, [{ kind: 'image', ref }]);
    assert.equal(got.media, 128);
    assert.equal(got.lost, 64);
    assert.equal(stats.copiedBytes, 0);
    assert.deepEqual(stats.presenceChecks, [ref.sha256, missing.sha256]);
  } finally {
    owner.dispose();
  }
});

test("inline bytes elsewhere in the same paste are resolved before checking a shared hash (#1098)", () => {
  const { owner, stats } = clipboard(false, true);
  try {
    const got = cellFromClipboard(blobImgHtml(ref) + '<img src="data:image/png;base64,AQ==">', '');
    assert.deepEqual(got.attach, [{ kind: 'image', ref }]);
    assert.equal(got.media, 2);
    assert.equal(got.lost, 0);
    assert.equal(stats.copiedBytes, 0);
    assert.deepEqual(stats.presenceChecks, [ref.sha256]);
  } finally {
    owner.dispose();
  }
});
