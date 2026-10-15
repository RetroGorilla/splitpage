import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

await bootApp();
const views = await import("../js/22d-views-wiring.js");
const { appActions } = await import("../legacy/app-actions.ts");
after(closeApp);

test("views app: main and Writer saves submit one existing action each after disposal and remount", () => {
  views.mountSaveFeature().dispose();
  views.mountWriterNavigationFeature().dispose();
  const main = views.mountSaveFeature();
  const writer = views.mountWriterNavigationFeature();
  const invoke = appActions.invoke;
  const calls = [];
  appActions.invoke = (id, source) => { calls.push([id, source]); return { kind: "ran", id }; };
  try {
    document.getElementById("btn-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    document.getElementById("wr-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.deepEqual(calls, [["save", "button"], ["save", "button"]]);
    main.dispose();
    writer.dispose();
    document.getElementById("btn-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    document.getElementById("wr-save").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(calls.length, 2);
  } finally {
    main.dispose();
    writer.dispose();
    appActions.invoke = invoke;
  }
});

test("views app: the shared review gate precedes B43 and permits B55 after remount", () => {
  views.mountHistoryGalleryFeature().dispose();
  const owner = views.mountHistoryGalleryFeature();
  const restore = owner.restoreClick;
  const gallery = owner.galleryClick;
  let restores = 0;
  let galleries = 0;
  owner.restoreClick = (event) => {
    if (!event.target.closest('[data-action="restore-snapshot"]')) return false;
    restores++;
    return true;
  };
  owner.galleryClick = (event) => {
    if (!event.target.closest('[data-action="gallery-open"]')) return false;
    galleries++;
    return true;
  };
  const button = document.createElement("button");
  document.getElementById("history-panel").append(button);
  window.__hostedTest.setSession({ role: "review", docId: "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  try {
    button.dataset.action = "restore-snapshot";
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(restores, 0);
    button.dataset.action = "gallery-open";
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(galleries, 1);
    window.__hostedTest.setSession({ role: "edit", docId: null });
    button.dataset.action = "restore-snapshot";
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(restores, 1);
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
    owner.restoreClick = restore;
    owner.galleryClick = gallery;
    owner.dispose();
    button.remove();
  }
});
