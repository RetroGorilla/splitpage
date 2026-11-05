import { test } from "node:test";
import assert from "node:assert/strict";
import { mountFlowTopbar } from "../../../src/features/title/flow-topbar.ts";
import { viewHarness } from "../view-harness.ts";

test("the shared writer toolbar preserves an additional button supplied by another phase", (t) => {
  const h = viewHarness();
  t.after(() => h.window.close());
  Object.defineProperty(h.window, "localStorage", { value: { getItem: () => "1" } });
  const button = h.document.createElement("button");
  button.className = "wr-fmt";
  button.setAttribute("data-cmd", "visual");
  button.textContent = "Visual";
  const bar = h.document.querySelector(".writer-bar") as HTMLElement;
  bar.append(button);
  const mounted = mountFlowTopbar(h.window);
  t.after(mounted.dispose);
  assert.equal(button.parentElement, bar);
  assert.equal(button.isConnected, true);
});

test("the switched shared header restores the existing controls when it unmounts", async (t) => {
  const h = viewHarness();
  t.after(() => h.window.close());
  Object.defineProperty(h.window, "localStorage", { value: { getItem: () => "1" } });
  const mode = h.document.getElementById("btn-write") as HTMLElement;
  const close = h.document.getElementById("wr-close") as HTMLElement;
  const originalMode = mode.outerHTML;
  const originalClose = close.outerHTML;
  const originalParent = close.parentElement;
  const mounted = mountFlowTopbar(h.window);
  const writer = h.document.getElementById("writer") as HTMLElement;
  writer.hidden = false;
  mounted.refresh();
  await Promise.resolve();
  assert.ok(h.document.body.classList.contains("writer-flow-open"));
  assert.ok(close.closest(".topbar-row"));
  mounted.dispose();
  assert.equal(close.parentElement, originalParent);
  assert.equal(mode.outerHTML, originalMode);
  assert.equal(close.outerHTML, originalClose);
  assert.equal(h.document.querySelector(".writer-format"), null);
  writer.hidden = true;
  await Promise.resolve();
  assert.equal(h.document.body.classList.contains("writer-flow-bar"), false);
});
