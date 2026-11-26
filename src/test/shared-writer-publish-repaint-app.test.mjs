import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { adoptReplacement, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { updateTagGhost } from "../features/tags/production-tags.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { forceLeaveSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { paintWriterForScreen, repaintWriterAfterPublish, writerControls } from "../bootstrap/wiring/writer.ts";
import { onPainted } from "../features/rows/render.ts";
import { setTimeout as delay } from "node:timers/promises";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;

function cleanSession() {
  if (!sharedSession() || hook.leave().ok) return;
  forceLeaveSharedSession();
  const allowed = () => ({ allowed: true });
  adoptReplacement(migrateRows({ title: "Standby", rows: [] }),
    createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
}

async function openSharedWriter(t, rows = [
  { id: "r1", audioText: "Hello", visualText: "Look" }, { id: "r2", audioText: "There", visualText: "" }
], productionTags = []) {
  adoptReplacement(migrateRows({ schema: 2, title: "Native script", rows, productionTags }));
  t.mock.method(notices, "show", () => {});
  assert.deepEqual(await hook.enter(), { ok: true });
  t.after(cleanSession);
  const control = writerControls();
  control.openWriter();
  t.after(() => { control.closeWriter(); });
  await Promise.resolve();
  const flow = control.writerFlowControl();
  const repaints = t.mock.method(flow, "repaint");
  return { control, flow, repaints };
}

function sampleAfterPublish(t, read) {
  const samples = [];
  t.after(onSessionChange(() => { samples.push(read()); }));
  return samples;
}

function between(t, step) {
  const stop = onPainted(kind => { if (kind === "screen") step(); });
  t.after(stop);
}

test("a shared publish repaints the Writer once when its screen paint already painted it", async t => {
  const { repaints } = await openSharedWriter(t);
  let screens = 0;
  between(t, () => { screens++; });
  assert.equal(hook.nativePeer.titleType(0, "A ").kind, "written");
  await delay(55);
  assert.equal(screens, 1, "the title change paints the whole screen");
  assert.equal(repaints.mock.callCount(), 1);
  assert.equal(document.getElementById("writer-title").value, "A Native script");
});

test("the session listener repaints the Writer in full unless the screen painted the same document in this task", async t => {
  const { repaints } = await openSharedWriter(t);
  repaintWriterAfterPublish();
  assert.equal(repaints.mock.callCount(), 1, "no screen paint ran");
  paintWriterForScreen();
  await Promise.resolve();
  repaintWriterAfterPublish();
  assert.equal(repaints.mock.callCount(), 3, "the screen paint ran in an earlier task");
  paintWriterForScreen();
  repaintWriterAfterPublish();
  repaintWriterAfterPublish();
  assert.equal(repaints.mock.callCount(), 5, "one screen paint answers one session listener");
});

test("a visual box whose anchor moves between the screen paint and the session listener is placed again", async t => {
  const { flow } = await openSharedWriter(t);
  const root = document.getElementById("writer-doc");
  root.focus();
  flow.caret("r1", 2);
  flow.openVisual("r1");
  const box = document.querySelector(".wr-flow-visual-box");
  assert.equal(box.hidden, false);
  const beat = root.querySelector('.wr-beat[data-id="r1"]');
  let bottom = 120;
  beat.getClientRects = () => [{ left: 40, right: 400, top: bottom - 20, bottom, width: 360, height: 20 }];
  between(t, () => { bottom = 260; });
  const tops = sampleAfterPublish(t, () => box.style.top);
  assert.equal(hook.nativePeer.titleType(0, "B ").kind, "written");
  await delay(55);
  assert.equal(tops[0], "268px", "sampled as the publish ends, before any selection event can place it");
});

test("a tag suggestion whose text moves between the screen paint and the session listener follows it", async t => {
  const { flow } = await openSharedWriter(t, [{ id: "r1", audioText: "Hello [Cam", visualText: "" }],
    [{ id: "t_camera", cat: "prop", name: "Camera", owner: "", notes: "", status: "needed" }]);
  const root = document.getElementById("writer-doc");
  root.focus();
  flow.caret("r1", "end");
  let top = 120;
  const rects = window.Range.prototype.getClientRects;
  window.Range.prototype.getClientRects = () => [{ left: 40, right: 90, top, bottom: top + 18, width: 50, height: 18 }];
  t.after(() => { window.Range.prototype.getClientRects = rects; });
  updateTagGhost(root.querySelector('.wr-beat[data-id="r1"]'));
  const ghost = document.getElementById("tag-ghost");
  assert.equal(ghost.classList.contains("is-visible"), true);
  assert.equal(ghost.style.top, "120px");
  between(t, () => { top = 260; });
  const tops = sampleAfterPublish(t, () => ghost.classList.contains("is-visible") ? ghost.style.top : "hidden");
  assert.equal(hook.nativePeer.titleType(0, "C ").kind, "written");
  await delay(55);
  assert.equal(tops[0], "260px", "sampled as the publish ends, before any selection event can place it");
});

test("a title that loses focus between the screen paint and the session listener shows the shared title", async t => {
  const { control } = await openSharedWriter(t);
  const title = document.getElementById("writer-title");
  title.focus();
  paintWriterForScreen();
  title.value = "stale";
  title.blur();
  repaintWriterAfterPublish();
  assert.equal(title.value, "Native script");
  assert.equal(control.drawWriter().title, "Native script");
});

test("a screen paint that fails clears its mark first, so the session listener repaints in full", async t => {
  const { repaints } = await openSharedWriter(t);
  const title = document.getElementById("writer-title");
  paintWriterForScreen();
  assert.equal(repaints.mock.callCount(), 1);
  const value = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  let failing = true;
  Object.defineProperty(title, "value", { configurable: true, get() { return value.get.call(this); },
    set(next) { if (failing) { failing = false; throw new Error("title write failed"); } value.set.call(this, next); } });
  t.after(() => { delete title.value; });
  assert.throws(() => paintWriterForScreen(), /title write failed/);
  assert.equal(repaints.mock.callCount(), 1);
  repaintWriterAfterPublish();
  assert.equal(repaints.mock.callCount(), 2);
  assert.equal(title.value, "Native script");
});
