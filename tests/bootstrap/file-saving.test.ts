import "../../src/test/_dom.mjs";
import "../../src/test/_preferences-started.mjs";
import "../../src/test/_location-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mountFileSavingFeature, stopFileSavingFeature, updateAutoSaveMenu, wireFileSaving } from "../../src/bootstrap/wiring/file-saving.ts";
import { autoSaveTarget, saveDestinations, setAutoSaveEnabled, startSaves } from "../../src/bootstrap/wiring/save-owners.ts";
import { setHome } from "../../src/legacy/location-bridge.ts";
import type { OperationContext } from "../../src/application/session/operation.ts";

test("the file saving wiring fills the owner's ports from the live bridges and keeps the autosave menu in step", () => {
  document.body.innerHTML = '<button id="menu-autosave"></button>';
  const item = document.getElementById("menu-autosave") as HTMLElement;
  updateAutoSaveMenu();
  assert.equal(item.getAttribute("aria-checked"), null, "nothing is drawn before the owner is wired");

  const synced: string[] = [];
  const saving = wireFileSaving({ copyHistory: () => {}, syncIdentity: () => { synced.push("sync"); }, setBaseline: () => {} });
  const stopSaves = startSaves(saving.savePorts({ capture: () => ({}) as OperationContext, stillOwns: () => true }), { start: () => null, stop: () => {} });
  const drop = saveDestinations().register(saving.destination());
  try {
    setHome("file", { handle: { name: "a.md" }, format: "md", name: "a.md" });
    assert.equal(autoSaveTarget(), "file");
    setHome("file", { handle: { name: "old.html" }, format: "html", name: "old.html" });
    assert.equal(autoSaveTarget(), null);

    setAutoSaveEnabled(false);
    assert.equal(item.getAttribute("aria-checked"), "false");
    assert.equal(item.classList.contains("is-on"), false);
    setAutoSaveEnabled(true);
    assert.equal(item.getAttribute("aria-checked"), "true");
    assert.equal(item.classList.contains("is-on"), true);

    mountFileSavingFeature();
    mountFileSavingFeature();
    window.dispatchEvent(new window.Event("blur"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    assert.deepEqual(synced, []);
  } finally {
    stopFileSavingFeature();
    drop();
    stopSaves();
    saving.dispose();
    setHome("none");
    document.body.innerHTML = "";
  }
});
