import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesktopVideoThumbnail } from "../../../src/application/media/desktop-video.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { GalleryVideoPorts } from "../../../src/features/gallery/ports.ts";
import type { Step } from "../../../src/core/text/steps.ts";
import { startGalleryVideo as mountVideo } from "../../../src/features/gallery/video.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices, fakeOwnership, fakePictures } from "../fakes.ts";

const VIMEO = "https://vimeo.com/123456789";

function setup(opts: { allowed?: boolean; thumbnail?: (host: string, ref: string) => Promise<DesktopVideoThumbnail | null> | null; rows?: object[] } = {}) {
  const doc = migrateRows({ title: "Video", rows: opts.rows ?? [{ id: "r1", visualText: "", audioText: "", imageLinks: [{ href: VIMEO, poster: true }] }] }, fakeMigration().ports);
  const pictures = fakePictures();
  const ownership = fakeOwnership();
  const asked: string[] = [];
  const edits: { rowId: string; message: string; changed: boolean }[] = [];
  const refreshed: number[] = [];
  const folds: { entry: unknown; touches: (step: Step) => boolean; changed: boolean }[] = [];
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
    cells: {
      editGallery: (rowId, message, edit) => {
        const row = doc.rows.find((r) => r.id === rowId);
        const changed = !!row && !!edit(row);
        edits.push({ rowId, message, changed });
        return changed;
      }
    },
    viewer: { refresh: () => { refreshed.push(1); } },
    desktop: {
      present: () => true,
      thumbnail: opts.thumbnail ?? ((host, ref) => {
        asked.push(host + ":" + ref);
        return Promise.resolve({ ok: true, bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" });
      })
    },
    bundles: {
      window: window,
      script: () => null,
      files: { bundle: async () => ({ ok: false, code: "UNAVAILABLE" }), move: async () => ({ ok: false, code: "UNAVAILABLE" }), cancelBundle: () => {} },
      carries: () => {},
      saves: { plan: async () => null, choose: async () => [] },
      exports: { plan: async () => null, pick: async () => null, run: async () => null },
      notices: fakeNotices().notices,
      ownership: ownership.ownership,
      undo: { fold: () => false },
      document: fakeDocument(doc).document,
      cells: { editGallery: () => false },
      viewer: { refresh: () => {} }
    }
  };
  return { doc, pictures, ownership, asked, folds, edits, refreshed, owner: mountVideo(ports) };
}

const LONELY = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

function offline<T>(run: () => Promise<T>): Promise<T> {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  return run().finally(() => { Reflect.deleteProperty(navigator, "onLine"); });
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
  assert.equal(folds[0]?.touches({ op: "deleteRow", index: 0, row: { id: "r1" } }), true);
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

test("gallery video: clicking a beat fetches one thumbnail for its link through the gallery edit, and the viewer is refreshed", async () => {
  const { doc, asked, edits, refreshed, owner } = setup();
  owner.thumbnailsOnBeatClick("r1");
  await settle();
  assert.deepEqual(asked, ["vimeo:123456789"]);
  assert.deepEqual(edits, [{ rowId: "r1", message: "Thumbnail added", changed: true }]);
  assert.equal(refreshed.length, 1);
  assert.match(JSON.stringify(doc.rows[0]), /"sha256"/);
  owner.thumbnailsOnBeatClick("r1");
  await settle();
  assert.equal(asked.length, 1);
  owner.dispose();
});

test("gallery video: a click fetches only the clicked beat, and nothing for a beat with a picture or a link that is not a video", async () => {
  const rows = [
    { id: "r1", visualText: "", audioText: "", imageLinks: [{ href: VIMEO, poster: true }] },
    { id: "r2", visualText: "", audioText: "", imageLinks: [{ href: LONELY, poster: true }] },
    { id: "r3", visualText: "", audioText: "", imageLinks: [{ href: "https://example.com/clip", poster: true }] }
  ];
  const { asked, edits, owner } = setup({ rows });
  owner.thumbnailsOnBeatClick("r3");
  owner.thumbnailsOnBeatClick("missing");
  owner.thumbnailsOnBeatClick(null);
  await settle();
  assert.deepEqual(asked, []);
  owner.thumbnailsOnBeatClick("r2");
  await settle();
  assert.deepEqual(asked, ["youtube:aaaaaaaaaaa"]);
  assert.deepEqual(edits.map((e) => e.rowId), ["r2"]);
  owner.thumbnailsOnBeatClick("r2");
  await settle();
  assert.equal(asked.length, 1);
  owner.dispose();
});

test("gallery video: a link that failed is not asked for again this session, and a failure says nothing and changes nothing", async () => {
  let calls = 0;
  const { doc, edits, refreshed, owner } = setup({ thumbnail: () => { calls++; return Promise.resolve({ ok: false, code: "NOT_FOUND" }); } });
  const before = JSON.stringify(doc.rows);
  owner.thumbnailsOnBeatClick("r1");
  await settle();
  owner.thumbnailsOnBeatClick("r1");
  owner.thumbnailsOnBeatClick("r1");
  await settle();
  assert.equal(calls, 1);
  assert.deepEqual(edits, []);
  assert.equal(refreshed.length, 0);
  assert.equal(JSON.stringify(doc.rows), before);
  owner.dispose();
});

test("gallery video: clicks while a fetch is running make no second request", async () => {
  let release: (() => void) | null = null;
  let calls = 0;
  const { edits, owner } = setup({
    thumbnail: () => new Promise((resolve) => {
      calls++;
      release = () => resolve({ ok: true, bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" });
    })
  });
  owner.thumbnailsOnBeatClick("r1");
  owner.thumbnailsOnBeatClick("r1");
  assert.equal(calls, 1);
  (release as (() => void) | null)?.();
  await settle();
  assert.equal(edits.length, 1);
  owner.dispose();
});

test("gallery video: a click asks for nothing when thumbnails are off or the browser is offline, and a failure then is not remembered", async () => {
  const off = setup({ allowed: false });
  off.owner.thumbnailsOnBeatClick("r1");
  await settle();
  assert.deepEqual(off.asked, []);
  off.owner.dispose();
  const gone = setup();
  await offline(async () => {
    gone.owner.thumbnailsOnBeatClick("r1");
    await settle();
  });
  assert.deepEqual(gone.asked, []);
  gone.owner.thumbnailsOnBeatClick("r1");
  await settle();
  assert.equal(gone.asked.length, 1);
  gone.owner.dispose();
});

test("gallery video: a thumbnail that arrives after the document was replaced is dropped", async () => {
  const { asked, edits, owner, ownership } = setup();
  owner.thumbnailsOnBeatClick("r1");
  ownership.replace();
  await settle();
  assert.equal(asked.length, 1);
  assert.deepEqual(edits, []);
  owner.dispose();
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
