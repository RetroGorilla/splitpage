import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesktopVideoResult } from "../../../src/application/media/desktop-video.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { GalleryVideoPorts, UndoStepView } from "../../../src/features/gallery/ports.ts";
import { __init as mountVideo } from "../../../src/features/gallery/video.js";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeOwnership, fakePictures } from "../fakes.ts";

const VIMEO = "https://vimeo.com/123456789";

function setup(opts: { allowed?: boolean; thumbnail?: (host: string, ref: string) => Promise<DesktopVideoResult | null> | null } = {}) {
  const doc = migrateRows({ title: "Video", rows: [{ id: "r1", visualText: "", audioText: "", imageLinks: [{ href: VIMEO, poster: true }] }] }, fakeMigration().ports);
  const pictures = fakePictures();
  const ownership = fakeOwnership();
  const asked: string[] = [];
  const folds: { entry: unknown; touches: (step: UndoStepView) => boolean; changed: boolean }[] = [];
  const ports: GalleryVideoPorts = {
    document: fakeDocument(doc).document,
    pictures: pictures.pictures,
    ownership: ownership.ownership,
    undo: {
      fold: (entry, touches, change) => {
        const changed = change(doc);
        folds.push({ entry, touches, changed });
        return changed;
      }
    },
    thumbnailsAllowed: () => opts.allowed !== false,
    desktop: {
      present: () => true,
      thumbnail: opts.thumbnail ?? ((host, ref) => {
        asked.push(host + ":" + ref);
        return Promise.resolve({ ok: true, bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" });
      })
    }
  };
  return { doc, pictures, ownership, asked, folds, owner: mountVideo(ports) };
}

function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

test("gallery video: on the desktop a thumbnail comes from the desktop and is stored and persisted", async () => {
  const { pictures, asked, owner } = setup();
  const rec = await owner.fetchThumbnail(VIMEO);
  assert.ok(rec);
  assert.deepEqual(asked, ["vimeo:123456789"]);
  assert.deepEqual(pictures.persisted, [rec.sha256]);
  owner.dispose();
});

test("gallery video: a desktop that cannot fetch thumbnails, or throws, gives none", async () => {
  const none = setup({ thumbnail: () => null });
  assert.equal(await none.owner.fetchThumbnail(VIMEO), null);
  none.owner.dispose();
  const throwing = setup({ thumbnail: () => { throw new Error("gone"); } });
  assert.equal(await throwing.owner.fetchThumbnail(VIMEO), null);
  throwing.owner.dispose();
});

test("gallery video: a pasted link's thumbnail folds into the paste's undo entry while the document is still owned", async () => {
  const { doc, folds, owner } = setup();
  owner.thumbnailsAfterPaste("r1", [VIMEO], "entry");
  await settle();
  assert.equal(folds.length, 1);
  assert.equal(folds[0]?.entry, "entry");
  assert.equal(folds[0]?.changed, true);
  assert.equal(folds[0]?.touches({ op: "rowField", rowId: "r1", key: "imageLinks" }), true);
  assert.equal(folds[0]?.touches({ op: "rowField", rowId: "r1", key: "audioText" }), false);
  assert.equal(folds[0]?.touches({ op: "deleteRow", row: { id: "r1" } }), true);
  assert.match(JSON.stringify(doc.rows[0]), /"sha256"/);
  owner.dispose();
});

test("gallery video: no thumbnail when thumbnails are off, the link is not a video, or the document was replaced", async () => {
  const off = setup({ allowed: false });
  off.owner.thumbnailsAfterPaste("r1", [VIMEO], null);
  await settle();
  assert.deepEqual(off.asked, []);
  off.owner.dispose();
  const plain = setup();
  plain.owner.thumbnailsAfterPaste("r1", ["https://example.com/page"], null);
  await settle();
  assert.deepEqual(plain.asked, []);
  plain.owner.dispose();
  const replaced = setup();
  replaced.owner.thumbnailsAfterPaste("r1", [VIMEO], null);
  replaced.ownership.replace();
  await settle();
  assert.equal(replaced.asked.length, 1);
  assert.deepEqual(replaced.folds, []);
  replaced.owner.dispose();
});

test("gallery video: the test hook sets the page protocol, and dispose takes the hook away", () => {
  const { owner } = setup();
  const hook = (window as unknown as { __videoTest?: { setProtocol: (p: string) => void } }).__videoTest;
  assert.ok(hook);
  hook.setProtocol("file:");
  assert.match(owner.embedRefusal({ host: "youtube", id: "abc" }), /opened from a file/);
  assert.equal(owner.embedRefusal({ host: "vimeo", id: "1" }), "");
  owner.dispose();
  assert.equal((window as unknown as { __videoTest?: unknown }).__videoTest, undefined);
});
