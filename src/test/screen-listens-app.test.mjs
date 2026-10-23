import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { adoptReplacement, liveSession, onSessionChange, runCommand, sessionStamps, stampDocument } = await import("../legacy/session-bridge.ts");
const { changeSet } = await import("../application/session/change-set.ts");
const { editStamp } = await import("../application/commands/save-stamps.ts");
const { migrateRows } = await import("../js/02-state.js");
const { sceneStatusCommand } = await import("../application/commands/scene-status.ts");
const { sceneLengthCommand } = await import("../application/commands/scene-length.ts");
const { registerTagCommand } = await import("../application/commands/production-records.ts");
const { wordsPerMinuteCommand } = await import("../application/commands/document-settings.ts");
const { addSceneCommand } = await import("../application/commands/rows.ts");
const { cellEditing, paintGuard } = await import("../legacy/editor-bridge.ts");
const { preferences, viewFlags } = await import("../legacy/preferences-bridge.ts");
const { documentLocation } = await import("../legacy/location-bridge.ts");
const { expandHiddenShotStrip, setHideShotScenes } = await import("../js/01b-hide-shot.js");
const { flushEdits, redo, undo } = await import("../js/12a-undo.js");
const writer = await import("../js/19-writer.js");

after(closeApp);

const idle = (ms) => new Promise((r) => setTimeout(r, ms));
const counts = () => window.__renderTest.counts();
const reset = () => window.__renderTest.reset();
const rowEl = (id) => document.querySelector('#rows > .row[data-id="' + id + '"]');
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const readTime = (id) => rowEl(id).querySelector(".row-read").textContent;
const statusWord = (id) => rowEl(id).querySelector(".status-word").textContent;

function script() {
  return migrateRows({
    title: "Listening",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One two three four five six seven eight.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Nine ten.", status: "shot" },
      { id: "r3", visualText: "Card", audioText: "Eleven.", status: "todo" }
    ]
  });
}

function open() {
  if (viewFlags().writerOpen()) writer.closeWriter();
  if (viewFlags().hideShot()) setHideShotScenes(false);
  adoptReplacement(script());
  flushEdits();
  reset();
}

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function typeChar(el, ch) {
  el.focus();
  const node = lastText(el);
  node.data += ch;
  const r = document.createRange();
  r.setStart(node, node.data.length);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
}

test("a document that arrives repaints the whole screen once, before the arrival returns", () => {
  open();
  adoptReplacement(migrateRows({ title: "Arrived", rows: [{ id: "a1", visualText: "", audioText: "Here.", status: "todo" }] }));
  assert.equal(counts().render, 1);
  assert.ok(rowEl("a1"), "the new scene is on screen with no call after the arrival");
  assert.equal(rowEl("r1"), null);
  assert.equal(document.getElementById("doc-title").value, "Arrived");
});

test("a command that adds a scene repaints the whole screen once, inside the command", () => {
  open();
  let during = null;
  const stop = onSessionChange(() => { during = !!rowEl("n1"); });
  const outcome = runCommand(addSceneCommand("r1", "n1", sessionStamps));
  stop();
  assert.equal(outcome.kind, "applied");
  assert.equal(during, true, "the screen had painted by the time later listeners heard the change");
  assert.equal(counts().render, 1);
  assert.deepEqual(Array.from(document.querySelectorAll("#rows > .row")).map((el) => el.getAttribute("data-id")), ["r1", "n1", "r2", "r3"]);
});

test("a scene status change repaints only that row, and its read times, with no whole-screen paint", () => {
  open();
  const others = [rowEl("r1"), rowEl("r3")].map((el) => el.querySelector(".gutter").outerHTML);
  runCommand(sceneStatusCommand("r3", sessionStamps));
  assert.equal(counts().render, 0);
  assert.equal(counts().rowsPainted, 1);
  assert.notEqual(statusWord("r3"), "To do");
  assert.deepEqual([rowEl("r1"), rowEl("r3")].map((el) => el.querySelector(".gutter").outerHTML)[0], others[0]);
});

test("a row change the screen cannot paint as one row, because the row is not on screen, repaints the whole screen once", () => {
  open();
  setHideShotScenes(true);
  reset();
  assert.equal(rowEl("r2"), null);
  runCommand(sceneLengthCommand("r2", 40, sessionStamps));
  assert.equal(counts().render, 1);
  setHideShotScenes(false);
});

test("a change to the tag list alone repaints the production views in the same call, with no whole-screen paint", () => {
  open();
  const badge = document.getElementById("production-badge");
  const before = badge.hidden ? "" : badge.textContent;
  runCommand(registerTagCommand({ cat: "prop", name: "Lamp" }));
  assert.equal(counts().render, 0);
  assert.equal(badge.hidden, false);
  assert.notEqual(badge.textContent, before);
});

test("a words-per-minute change repaints the screen and its read times once", () => {
  open();
  const before = readTime("r1");
  runCommand(wordsPerMinuteCommand(60));
  assert.equal(counts().render, 1);
  assert.notEqual(readTime("r1"), before);
});

test("an undo and a redo each repaint the screen once, and the repaint is not read back as an edit", () => {
  open();
  runCommand(addSceneCommand("r1", "n2", sessionStamps));
  flushEdits();
  reset();
  undo();
  flushEdits();
  assert.equal(rowEl("n2"), null);
  assert.equal(counts().render, 1);
  redo();
  flushEdits();
  assert.ok(rowEl("n2"), "the redo is still there, so the undo's repaint made no edit of its own");
  assert.equal(counts().render, 2);
});

test("typing repaints nothing: no whole-screen paint, no row and no cell, and the read time follows at the idle refresh", async () => {
  open();
  await idle(300);
  const el = cellOf("r1", "audioText");
  const node = lastText(el);
  const before = readTime("r1");
  reset();
  for (const word of [" nine", " ten", " eleven", " twelve", " thirteen", " fourteen", " fifteen", " sixteen"]) {
    for (const ch of word) typeChar(el, ch);
  }
  assert.deepEqual([counts().render, counts().rowsPainted, counts().cellsPainted], [0, 0, 0], "55 keys, no paint");
  assert.equal(lastText(el), node, "the caret's text node survives every key");
  assert.equal(readTime("r1"), before, "the read time waits for the idle refresh, as before");
  await idle(400);
  assert.notEqual(readTime("r1"), before, "the idle refresh paints the read time");
  assert.deepEqual([counts().render, counts().rowsPainted, counts().cellsPainted], [0, 0, 0]);
});

test("an edit made through the cell editor is not repainted: the page already shows it", () => {
  open();
  const el = cellOf("r3", "audioText");
  el.focus();
  const done = cellEditing().edit(el, (cell) => ({ cell: cell.concat([{ text: "!", marks: {} }]) }));
  assert.equal(done, el);
  assert.deepEqual([counts().render, counts().cellsPainted], [0, 0]);
  assert.match(liveSession().read((doc) => doc.rows[2].audioText), /Eleven\.!/);
});

test("row work left by a shown edit runs when the edit ends, not inside it", () => {
  open();
  let inside = null;
  paintGuard().whileShown(() => {
    runCommand(sceneStatusCommand("r1", sessionStamps));
    inside = counts().rowsPainted;
  });
  assert.equal(inside, 0, "nothing paints while the page leads");
  assert.equal(counts().rowsPainted, 1, "the status part is painted once the shown edit ends");
});

test("hiding shot scenes, and opening a hidden strip, repaint the screen through the hide-shot state", () => {
  open();
  setHideShotScenes(true);
  assert.equal(counts().render, 1);
  assert.equal(rowEl("r2"), null);
  const strip = document.querySelector("#rows .hidden-shot-strip");
  assert.ok(strip);
  expandHiddenShotStrip(strip.getAttribute("data-ids"));
  assert.equal(counts().render, 2);
  assert.ok(rowEl("r2"));
  setHideShotScenes(false);
});

test("the clock and the author name repaint the screen through the preferences", () => {
  open();
  const clock = preferences().clock();
  preferences().setClock(clock === "24" ? "12" : "24");
  assert.equal(counts().render, 1);
  preferences().setCommentAuthor("Rae " + Date.now());
  assert.equal(counts().render, 2);
  preferences().setDefaultWpm(170);
  assert.equal(counts().render, 2, "a preference the screen does not show paints nothing");
  preferences().setClock(clock);
});

test("a clock changed in another tab repaints the screen through the preferences", () => {
  open();
  const clock = preferences().clock();
  const other = clock === "24" ? "12" : "24";
  localStorage.setItem("splitpage-clock", other);
  window.dispatchEvent(new window.StorageEvent("storage", { key: "splitpage-clock", newValue: other }));
  assert.equal(counts().render, 1);
  localStorage.setItem("splitpage-clock", clock);
  window.dispatchEvent(new window.StorageEvent("storage", { key: "splitpage-clock", newValue: clock }));
  assert.equal(counts().render, 2);
});

test("a stamp that rewrites a scene's text repaints the screen once; a save stamp paints nothing", () => {
  open();
  stampDocument({
    name: "rewrite",
    plan: () => ({
      changes: changeSet({ cells: [{ rowId: "r3", field: "audioText" }] }),
      apply: (live) => { live.rows[2].audioText = "Stamped."; }
    })
  });
  assert.equal(counts().render, 1);
  assert.equal(cellOf("r3", "audioText").textContent, "Stamped.");
  stampDocument(editStamp({ lastEditedBy: "Ann", lastEditedAt: new Date().toISOString() }));
  assert.equal(counts().render, 1);
});

test("a location change repaints only when review or edit permission changes", () => {
  open();
  documentLocation().markWrittenOut(!documentLocation().writtenOut());
  assert.equal(counts().render, 0);
  window.__hostedTest.setSession({ role: "review", docId: "doc-review" });
  assert.ok(counts().render >= 1);
  assert.equal(cellOf("r1", "audioText").getAttribute("contenteditable"), "false");
  window.__hostedTest.setSession({ role: "edit", docId: "doc-review" });
  assert.equal(cellOf("r1", "audioText").getAttribute("contenteditable"), "true");
  window.__hostedTest.setSession({ docId: null });
});

test("closing the writer repaints the screen once", () => {
  open();
  writer.openWriter();
  reset();
  writer.closeWriter();
  assert.equal(counts().render, 1);
  assert.equal(liveSession().read((doc) => doc.rows.length), 3);
});
