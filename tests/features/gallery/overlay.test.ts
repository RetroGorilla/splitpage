import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { GalleryOverlayPorts } from "../../../src/features/gallery/ports.ts";
import { __init as mountOverlay, closeGalleryOverlay, openGalleryOverlay } from "../../../src/features/gallery/overlay.js";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeActions, fakeDocument, fakeNotices, fakeOwnership, fakePreferenceChanges, fakeReview } from "../fakes.ts";

const MODAL = '<div id="gallery-modal" hidden><h2 id="gallery-title"></h2><p id="gallery-summary"></p>' +
  '<button id="gallery-close"></button><div id="gallery-body"></div>' +
  '<div id="gallery-zoom" hidden><div id="gallery-zoom-stage"></div><p id="gallery-zoom-info"></p><button id="gallery-zoom-close"></button></div></div>' +
  '<div id="rows"></div>';

function setup() {
  document.body.innerHTML = MODAL;
  const doc = migrateRows({ title: "Gallery", rows: [{ id: "r1", visualText: "", audioText: "", imageLinks: [{ href: "https://example.com/clip", poster: true }] }] }, fakeMigration().ports);
  const review = fakeReview();
  const changes = fakePreferenceChanges();
  const edits: string[] = [];
  const picked: string[] = [];
  const ports: GalleryOverlayPorts = {
    document: fakeDocument(doc).document,
    review: review.review,
    notices: fakeNotices().notices,
    ownership: fakeOwnership().ownership,
    cells: { editGallery: (rowId, label) => { edits.push(rowId + ": " + label); return true; } },
    undo: { breakCoalescing: () => {}, last: () => null, undo: () => {} },
    actions: fakeActions().actions,
    changes: changes.changes,
    pickPicture: (rowId) => { picked.push(rowId); },
    render: { slotPictureHtml: () => "", badgeHtml: () => "" },
    video: { embedRefusal: () => "", playerSrc: () => null, thumbnailsAllowed: () => false, fetchThumbnail: () => Promise.resolve(null), hostLabel: () => "Link" },
    sessionVideos: { has: () => false, url: () => null }
  };
  return { owner: mountOverlay(ports), review, changes, edits, picked };
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

test("gallery overlay: remove edits the gallery through the cells port, and not while reviewing", () => {
  const { owner, review, edits } = setup();
  review.setReviewing(true);
  openGalleryOverlay("r1", 0, false);
  assert.equal(document.querySelector('#gallery-modal [data-gact="remove"]'), null);
  closeGalleryOverlay();
  review.setReviewing(false);
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
