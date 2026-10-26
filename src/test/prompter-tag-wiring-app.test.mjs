import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTagEntityContainer } from "../legacy/tag-entity-container.ts";

assert.throws(() => createTagEntityContainer("production-panel", () => {}), /not installed yet/);
await bootApp();
const { wireTagEntityContainer, openPrompter, closePrompter } = await import("../js/20-teleprompter.js");
after(closeApp);

test("tag container wiring is installed before the prompter can open and mounts per call", () => {
  const entry = readFileSync(new URL("../js/_entry.js", import.meta.url), "utf8");
  assert.ok(entry.indexOf("  mountTagPanelsFeature();") < entry.indexOf("  init_20_teleprompter();"));
  assert.equal(document.getElementById("prompter").hidden, true);
  const first = document.createElement("div");
  const second = document.createElement("div");
  first.id = "prompter-tag-first";
  second.id = "prompter-tag-second";
  document.body.append(first, second);
  const clicks = [];
  first.click();
  assert.deepEqual(clicks, []);
  const stopFirst = wireTagEntityContainer(first.id, () => { clicks.push("first"); });
  const stopSecond = wireTagEntityContainer(second.id, () => { clicks.push("second"); });
  try {
    first.click();
    second.click();
    assert.deepEqual(clicks, ["first", "second"]);
    stopFirst();
    first.click();
    second.click();
    assert.deepEqual(clicks, ["first", "second", "second"]);
    openPrompter();
    assert.equal(document.getElementById("prompter").hidden, false);
  } finally {
    closePrompter();
    stopFirst();
    stopSecond();
    first.remove();
    second.remove();
  }
});
