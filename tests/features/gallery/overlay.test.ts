import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import { setVideoThumbnail, videoLinkKey } from "../../../src/core/document/gallery.ts";
import type { ImageRef } from "../../../src/core/document/ports.ts";
import type { GalleryOverlayPorts } from "../../../src/features/gallery/ports.ts";
import { startGalleryOverlay as mountOverlay, closeGalleryOverlay, openGalleryOverlay } from "../../../src/features/gallery/overlay.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeActions, fakeDocument, fakeNotices, fakeOwnership, fakePreferenceChanges } from "../fakes.ts";

const MODAL = '<div id="gallery-modal" hidden><h2 id="gallery-title"></h2><p id="gallery-summary"></p>' +
  '<button id="gallery-close"></button><div id="gallery-body"></div>' +
  '<div id="gallery-zoom" hidden><div id="gallery-zoom-stage"></div><p id="gallery-zoom-info"></p><button id="gallery-zoom-close"></button></div></div>' +
  '<div id="rows"></div>';

function setup(desktop = false) {
  document.body.innerHTML = MODAL;
  const doc = migrateRows({ title: "Gallery", rows: [{ id: "r1", visualText: "", audioText: "", imageLinks: [{ href: "https://example.com/clip", poster: true }] }] }, fakeMigration().ports);
  const changes = fakePreferenceChanges();
  const edits: string[] = [];
  const picked: string[] = [];
  const ports: GalleryOverlayPorts = {
    document: fakeDocument(doc).document,
    notices: fakeNotices().notices,
    ownership: fakeOwnership().ownership,
    cells: { editGallery: (rowId, label) => { edits.push(rowId + ": " + label); return true; } },
    undo: { breakCoalescing: () => {}, last: () => null, undo: () => {} },
    actions: fakeActions().actions,
    changes: changes.changes,
    pickPicture: (rowId) => { picked.push(rowId); },
    render: { slotPictureHtml: () => "", badgeHtml: () => "" },
    video: { embedRefusal: () => "", playerSrc: () => null, thumbnailsAllowed: () => false, fetchThumbnail: () => Promise.resolve(null), hostLabel: () => "Link" },
    sessionVideos: { has: () => false, url: () => null },
    desktop: () => desktop
  };
  return { owner: mountOverlay(ports), changes, edits, picked };
}

function press(act: string): void {
  const button = document.querySelector<HTMLElement>('#gallery-modal [data-gact="' + act + '"]');
  assert.ok(button, act + " is shown");
  button.click();
}

test("gallery overlay: opens over a scene's gallery read through the document port, and its add tile asks for a picture for that scene", () => {
  const { owner, picked } = setup();
  openGalleryOverlay("r1", 0, false);
  assert.equal(document.getElementById("gallery-modal")?.hidden, false);
  press("add");
  assert.deepEqual(picked, ["r1"]);
  closeGalleryOverlay();
  assert.equal(document.getElementById("gallery-modal")?.hidden, true);
  owner.dispose();
});

test("gallery overlay: a link's open button says where it opens, from the desktop port", () => {
  const title = (desktop: boolean): string | null | undefined => {
    const { owner } = setup(desktop);
    openGalleryOverlay("r1", 0, false);
    const text = document.querySelector('#gallery-modal [data-gact="open"]')?.getAttribute("title");
    closeGalleryOverlay();
    owner.dispose();
    return text;
  };
  assert.match(title(false) ?? "", / in a new tab$/);
  assert.match(title(true) ?? "", / in your web browser$/);
});

test("gallery overlay: remove edits the gallery through the cells port", () => {
  const { owner, edits } = setup();
  openGalleryOverlay("r1", 0, false);
  press("remove");
  assert.deepEqual(edits, ["r1: Video removed"]);
  closeGalleryOverlay();
  owner.dispose();
});

test("gallery overlay: dispose removes its listeners and its preference subscription", () => {
  const { owner, changes, picked } = setup();
  assert.equal(changes.listenerCount(), 1);
  openGalleryOverlay("r1", 0, false);
  owner.dispose();
  assert.equal(changes.listenerCount(), 0);
  document.querySelector<HTMLElement>('#gallery-modal [data-gact="add"]')?.click();
  assert.deepEqual(picked, []);
});

const YOUTUBE = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const PICTURE: ImageRef = { sha256: "a".repeat(64), mime: "image/jpeg", width: 480, height: 270 };

function retrySetup(fetchThumbnail: (href: string) => Promise<ImageRef | null>) {
  document.body.innerHTML = MODAL;
  const doc = migrateRows({ title: "Gallery", rows: [{ id: "r1", visualText: "", audioText: "", imageLinks: [{ href: YOUTUBE, poster: true }] }] }, fakeMigration().ports);
  const notes = fakeNotices();
  const ports: GalleryOverlayPorts = {
    document: fakeDocument(doc).document,
    notices: notes.notices,
    ownership: fakeOwnership().ownership,
    cells: { editGallery: (rowId, _label, edit) => { const row = doc.rows.find((r) => r.id === rowId); return !!row && !!edit(row); } },
    undo: { breakCoalescing: () => {}, last: () => null, undo: () => {} },
    actions: fakeActions().actions,
    changes: fakePreferenceChanges().changes,
    pickPicture: () => {},
    render: { slotPictureHtml: () => "", badgeHtml: () => "" },
    video: { embedRefusal: () => "", playerSrc: () => null, thumbnailsAllowed: () => true, fetchThumbnail, hostLabel: () => "YouTube" },
    sessionVideos: { has: () => false, url: () => null },
    desktop: () => false
  };
  return { owner: mountOverlay(ports), doc, shown: notes.shown };
}

function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

test("gallery overlay: Retry thumbnail says nothing wrong when an automatic fetch added the thumbnail while it ran", async () => {
  let release: ((rec: ImageRef | null) => void) | null = null;
  const { owner, doc, shown } = retrySetup(() => new Promise((resolve) => { release = resolve; }));
  openGalleryOverlay("r1", 0, false);
  press("retry-thumb");
  const key = videoLinkKey({ href: YOUTUBE, poster: true });
  assert.equal(doc.rows[0] && setVideoThumbnail(doc.rows[0], key, PICTURE), true);
  (release as ((rec: ImageRef | null) => void) | null)?.(PICTURE);
  await settle();
  assert.deepEqual(shown, []);
  closeGalleryOverlay();
  owner.dispose();
});

test("gallery overlay: Retry thumbnail still says it could not get one when none arrived", async () => {
  const { owner, shown } = retrySetup(() => Promise.resolve(null));
  openGalleryOverlay("r1", 0, false);
  press("retry-thumb");
  await settle();
  assert.equal(shown.length, 1);
  assert.match(shown[0]?.message ?? "", /Could not get this video/);
  closeGalleryOverlay();
  owner.dispose();
});