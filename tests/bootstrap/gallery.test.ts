import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import { galleryActions, mountGalleryFeature, stopGalleryFeature } from "../../src/bootstrap/wiring/gallery.ts";

test("gallery wiring replaces its owned mount and disables its action when stopped", () => {
  const registry = createActionRegistry();
  const unregister = registerAll(registry, galleryActions());
  try {
    assert.equal(registry.view("annotate-picture")?.enabled, false);
    assert.equal(registry.view("annotate-picture")?.visible, false);
    const first = mountGalleryFeature();
    assert.equal(registry.view("annotate-picture")?.enabled, true);
    const next = mountGalleryFeature();
    assert.notEqual(first, next);
    first.dispose();
    assert.equal(registry.view("annotate-picture")?.enabled, true);
    stopGalleryFeature();
    stopGalleryFeature();
    assert.equal(registry.view("annotate-picture")?.enabled, false);
    assert.equal(registry.invoke("annotate-picture", "button").kind, "unavailable");
  } finally {
    stopGalleryFeature();
    unregister();
  }
});
