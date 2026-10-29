import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { documentTransitions } from "../bootstrap/wiring/transition-owners.ts";
import { mountRowsRenderFeature, stopRowsRenderFeature } from "../bootstrap/wiring/render.ts";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { addRow } from "../bootstrap/wiring/rows.ts";
import { mountPanelListenersFeature, stopPanelListenersFeature } from "../bootstrap/wiring/panels.ts";
import { openWriter, closeWriter } from "../features/writer/writer.js";

window.Element.prototype.scrollIntoView = function () {};

await bootApp();
after(closeApp);

test("paint-driven Writer and rundown updates survive render replacement and stop/remount without duplicates", () => {
  documentTransitions().open({ from: { raw: {
    title: "Paint subscriptions", rows: [{ id: "r1", status: "todo", audioText: "One", visualText: "" }], comments: []
  } }, reason: "render-panel-mount" });
  const track = document.querySelector("#rundown .rundown-track");
  const writer = document.getElementById("writer-doc");
  Object.defineProperty(track, "clientWidth", { configurable: true, value: 900 });
  openWriter();
  const html = Object.getOwnPropertyDescriptor(window.Element.prototype, "innerHTML");
  let writes = 0;
  Object.defineProperty(writer, "innerHTML", {
    configurable: true,
    get() { return html.get.call(this); },
    set(value) { writes++; html.set.call(this, value); }
  });
  const writerRows = () => Array.from(writer.querySelectorAll(".wr-block"), (el) => el.getAttribute("data-row"));
  const rundownRows = () => Array.from(document.querySelectorAll("#rundown .rd-block"), (el) => el.getAttribute("data-row"));
  const expectedRows = () => currentDocument().rows.map((row) => row.id);
  function addAndCheck(label) {
    writes = 0;
    assert.ok(addRow(null));
    assert.deepEqual(writerRows(), expectedRows(), label + ": Writer follows the real scene command");
    assert.deepEqual(rundownRows(), expectedRows(), label + ": the stats-driven rundown follows the paint");
    assert.equal(writes, 1, label + ": exactly one Writer paint");
  }
  try {
    assert.equal(writerRows().length, 1);
    addAndCheck("before replacement");
    const first = mountRowsRenderFeature();
    assert.equal(first.renderFirstDraw(), true);
    addAndCheck("after replacement");
    stopRowsRenderFeature();
    writes = 0;
    assert.ok(addRow(null));
    assert.equal(writes, 0, "no paint is announced while rendering is stopped");
    const second = mountRowsRenderFeature();
    assert.equal(second.renderFirstDraw(), true);
    addAndCheck("after stop/remount");
    first.dispose();
    addAndCheck("after the retired mount is disposed again");
    stopPanelListenersFeature();
    writes = 0;
    second.render();
    assert.equal(writes, 0, "the panel owner still removes its paint subscription");
    mountPanelListenersFeature();
    mountPanelListenersFeature();
    addAndCheck("after replacing the panel subscriptions twice");
  } finally {
    delete writer.innerHTML;
    delete track.clientWidth;
    mountPanelListenersFeature();
    closeWriter();
  }
});

test("replacing the render mount preserves the screen wiring's session subscriptions", () => {
  const first = mountRowsRenderFeature();
  assert.equal(first.renderFirstDraw(), true);
  documentTransitions().open({ from: { raw: { title: "First replacement", rows: [], comments: [] } }, reason: "render-mount" });
  assert.equal(document.getElementById("doc-title").value, "First replacement");
  stopRowsRenderFeature();
  documentTransitions().open({ from: { raw: { title: "While render is stopped", rows: [], comments: [] } }, reason: "render-stopped" });
  const second = mountRowsRenderFeature();
  assert.equal(second.renderFirstDraw(), true);
  documentTransitions().open({ from: { raw: { title: "Second replacement", rows: [], comments: [] } }, reason: "render-remount" });
  assert.equal(document.getElementById("doc-title").value, "Second replacement");
});
