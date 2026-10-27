import { bootApp, closeApp } from "./_app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { documentTransitions } from "../legacy/transition-bridge.ts";
import { mountRowsRenderFeature, stopRowsRenderFeature } from "../bootstrap/wiring/render.ts";

await bootApp();
after(closeApp);

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
