import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { adoptReplacement, runCommand, sessionStamps } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { addCommentCommand, toggleResolveCommand } = await import("../application/commands/comments.ts");
const { addSceneCommand } = await import("../application/commands/rows.ts");
const { registerTagCommand } = await import("../application/commands/production-records.ts");
const { wordsPerMinuteCommand } = await import("../application/commands/document-settings.ts");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const { mountPanelListenersFeature, stopPanelListenersFeature } = await import("../bootstrap/wiring/panels.ts");
const writer = await import("../js/19-writer.js");

after(closeApp);

const el = (id) => document.getElementById(id);
const counts = () => window.__renderTest.counts();

function script() {
  return migrateRows({
    title: "Panels",
    docId: "d" + "a".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One two three four five six seven eight nine ten eleven twelve.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Four five.", status: "todo" }
    ]
  });
}

function open() {
  if (viewFlags().writerOpen()) writer.closeWriter();
  adoptReplacement(script());
  flushEdits();
  window.__renderTest.reset();
}

function comment(id) {
  return {
    id: id, rowId: "r1", field: "audioText", quote: "One", body: "Check this", author: "Rae",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", resolved: false, replies: []
  };
}

test("a comment added through the session updates the comments count and list with no direct call", () => {
  open();
  assert.equal(el("comments-badge").hidden, true);
  runCommand(addCommentCommand(comment("c1")));
  assert.equal(el("comments-badge").hidden, false);
  assert.equal(el("comments-badge").textContent, "1");
  runCommand(toggleResolveCommand("c1", sessionStamps));
  assert.equal(el("comments-badge").hidden, true);
});

test("an opened document paints the comments count, the stats chips and the presence bar once", () => {
  open();
  adoptReplacement(migrateRows({ title: "Arrived", comments: [comment("c2")], rows: [{ id: "a1", visualText: "", audioText: "Here it is.", status: "todo" }] }));
  assert.equal(el("comments-badge").hidden, false);
  assert.ok(el("runtime-chip").textContent.length > 0);
  assert.equal(counts().render, 1);
});

test("the tag count follows a tag registered through the session, without a whole-screen paint", () => {
  open();
  runCommand(registerTagCommand({ cat: "prop", name: "Lamp" }));
  assert.equal(counts().render, 0);
  assert.equal(el("production-badge").hidden, false);
});

test("an open writer repaints from a scene added through the session", () => {
  open();
  writer.openWriter();
  assert.equal(document.querySelectorAll("#writer-doc .wr-para").length > 0, true);
  const before = el("wr-scenes").textContent;
  runCommand(addSceneCommand("r1", "w1", sessionStamps));
  assert.equal(el("wr-scenes").textContent, String(Number(before) + 1));
  writer.closeWriter();
});

test("a reading-speed change that repaints the screen refreshes the length chips with no direct call", () => {
  open();
  const before = el("length-status").textContent;
  runCommand(wordsPerMinuteCommand(60));
  assert.notEqual(el("length-status").textContent, before);
});

test("the panel listeners stop when the feature is stopped", () => {
  open();
  stopPanelListenersFeature();
  runCommand(addCommentCommand(comment("c3")));
  assert.equal(el("comments-badge").hidden, true);
  mountPanelListenersFeature();
});
