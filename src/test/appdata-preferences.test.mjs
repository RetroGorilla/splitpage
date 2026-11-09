import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { preferences } from "../bootstrap/wiring/preferences-owner.ts";
import { brollView, commentSorting } from "../bootstrap/wiring/ports/preferences.ts";
import { openBrollPanel } from "../features/broll/panel.ts";
import { openCommentsPanel } from "../features/comments/comments.ts";
import { openProductionPanel, openGearPanel } from "../features/tags/panels.ts";

await bootApp();
const nodeCustomEvent = globalThis.CustomEvent;
globalThis.CustomEvent = window.CustomEvent;
after(async () => { globalThis.CustomEvent = nodeCustomEvent; await closeApp(); });

const EXPORTED_PREFS = '{"onboarding":null,"tourDone":null,"commentAuthor":null,"writerSize":null,"taggingHelpDismissed":null,"autosave":null,"commentsSort":"recent","panelGrouping":null,"theme":null,"clock":null,"personColor":null,"defaultWpm":null,"hideShot":null,"prompterMirror":null,"prompterFlip":null,"prompterSceneMode":null,"rundownMin":null,"videoThumbs":null,"tagIcons":null,"scriptScale":null}';
const PARSED_PREFS = '{"onboarding":null,"tourDone":null,"commentAuthor":null,"commentsSort":"recent","panelGrouping":null,"writerSize":null,"taggingHelpDismissed":null,"autosave":null,"theme":null,"clock":null,"personColor":null,"defaultWpm":null,"hideShot":null,"prompterMirror":null,"prompterFlip":null,"prompterSceneMode":null,"rundownMin":null,"videoThumbs":null,"tagIcons":null,"scriptScale":null}';

test("app data: comments sort round trip keeps the exported and parsed preference bytes", async () => {
  localStorage.clear();
  preferences().setCommentsSort("recent");
  preferences().setCommentFilter({ mode: "resolved", assignee: "Ada" });
  const exported = await window.__appDataTest.build();
  assert.equal(JSON.stringify(exported.prefs), EXPORTED_PREFS);
  const text = JSON.stringify(exported);
  assert.equal(JSON.stringify(window.__appDataTest.parse(text).prefs), PARSED_PREFS);
  localStorage.clear();
  await window.__appDataTest.importText(text);
  assert.equal(preferences().commentsSort(), "recent");
  assert.equal(commentSorting.current(), "recent");
  assert.deepEqual(preferences().commentFilter(), { mode: "open", assignee: "" });
  assert.equal(JSON.stringify((await window.__appDataTest.build()).prefs), EXPORTED_PREFS);
});

test("app data: panel choices survive export and import", async () => {
  localStorage.clear();
  preferences().setPanelGrouping("broll", "by-scene");
  preferences().setCommentsSort("by-scene");
  const exported = await window.__appDataTest.build();
  localStorage.clear();
  await window.__appDataTest.importText(JSON.stringify(exported));
  assert.equal(preferences().panelGrouping("broll"), "by-scene");
  assert.equal(preferences().commentsSort(), "by-scene");
  assert.equal(commentSorting.current(), "by-scene");
  localStorage.clear();
  commentSorting.choose("position");
});

test("app data: Production and Gear choices round trip independently and update open panels", async () => {
  localStorage.clear();
  preferences().setPanelGrouping("production", "by-scene");
  preferences().setPanelGrouping("gear", "by-scene");
  const exported = await window.__appDataTest.build();
  localStorage.clear();
  preferences().setPanelGrouping("broll", "flat");
  openProductionPanel();
  openGearPanel();
  await window.__appDataTest.importText(JSON.stringify(exported));
  assert.equal(preferences().panelGrouping("broll"), "flat");
  assert.equal(preferences().panelGrouping("production"), "by-scene");
  assert.equal(preferences().panelGrouping("gear"), "by-scene");
  assert.equal(document.querySelector('#gear-modes [data-group="by-scene"]').getAttribute("aria-checked"), "true");
  openProductionPanel();
  assert.equal(document.querySelector('#production-modes [data-group="by-scene"]').getAttribute("aria-checked"), "true");
  localStorage.clear();
});

test("app data: existing Production and Gear choices survive a conflicting import", async () => {
  localStorage.clear();
  preferences().setPanelGrouping("production", "cat");
  preferences().setPanelGrouping("gear", "flat");
  await window.__appDataTest.importText(JSON.stringify({ format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: { panelGrouping: '{"production":"by-scene","gear":"by-scene"}' } }));
  assert.equal(preferences().panelGrouping("production"), "cat");
  assert.equal(preferences().panelGrouping("gear"), "flat");
  localStorage.clear();
});

test("app data: imported legacy grouping uses the Comments sort as its single source", async () => {
  localStorage.clear();
  await window.__appDataTest.importText(JSON.stringify({ format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: { panelGrouping: '{"comments":"by-scene"}' } }));
  assert.equal(preferences().commentsSort(), "by-scene");
  assert.equal(localStorage.getItem("splitpage-panel-grouping"), null);
  openCommentsPanel();
  preferences().setCommentsSort("recent");
  assert.equal(commentSorting.current(), "recent");
  assert.equal(document.getElementById("comments-sort").value, "recent");
  localStorage.clear();
});

test("app data: importing a choice updates an already open B-roll panel", async () => {
  localStorage.clear();
  brollView.setGroup("scene");
  openBrollPanel();
  await window.__appDataTest.importText(JSON.stringify({ format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: { panelGrouping: '{"broll":"by-scene"}' } }));
  assert.equal(window.__brollTest.view().group, "by-scene");
  localStorage.clear();
});

test("app data: importing a choice updates an already open Comments panel", async () => {
  localStorage.clear();
  commentSorting.choose("position");
  openCommentsPanel();
  await window.__appDataTest.importText(JSON.stringify({ format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: { commentsSort: "by-scene" } }));
  assert.equal(document.getElementById("comments-sort").value, "by-scene");
  localStorage.clear();
});

test("app data: imported comments grouping preserves an existing legacy sort after restart", async () => {
  localStorage.clear();
  preferences().setCommentsSort("recent");
  commentSorting.choose("recent");
  await window.__appDataTest.importText(JSON.stringify({
    format: "splitpage-app-data", version: 1, history: { docs: [], older: [] },
    prefs: { panelGrouping: '{"comments":"by-scene"}' }
  }));
  assert.equal(commentSorting.current(), "recent");
  assert.equal(preferences().commentsSort(), "recent");
  localStorage.clear();
});

test("app data: imported B-roll grouping applies when the panel is opened", async () => {
  localStorage.clear();
  brollView.setGroup("scene");
  await window.__appDataTest.importText(JSON.stringify({
    format: "splitpage-app-data", version: 1, history: { docs: [], older: [] },
    prefs: { panelGrouping: '{"broll":"by-scene"}' }
  }));
  openBrollPanel();
  assert.equal(window.__brollTest.view().group, "by-scene");
  localStorage.clear();
});

test("app data: imported Comments grouping updates the sort control on open", async () => {
  localStorage.clear();
  commentSorting.choose("position");
  await window.__appDataTest.importText(JSON.stringify({
    format: "splitpage-app-data", version: 1, history: { docs: [], older: [] },
    prefs: { panelGrouping: '{"comments":"by-scene"}' }
  }));
  openCommentsPanel();
  assert.equal(document.getElementById("comments-sort").value, "by-scene");
  localStorage.clear();
  commentSorting.choose("position");
});

test("app data: comments sort validation and preservation of a local value stay unchanged", async () => {
  for (const value of ["position", "recent", "by-scene", "unknown", "Recent", "", 1, null]) {
    localStorage.removeItem("splitpage-comments-sort");
    const text = JSON.stringify({
      format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: { commentsSort: value }
    });
    await window.__appDataTest.importText(text);
    assert.equal(localStorage.getItem("splitpage-comments-sort"), value === "position" || value === "recent" || value === "by-scene" ? value : null);
  }
  preferences().setCommentsSort("position");
  await window.__appDataTest.importText(JSON.stringify({
    format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: { commentsSort: "recent" }
  }));
  assert.equal(preferences().commentsSort(), "position");
});
