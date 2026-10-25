import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { createPendingBanner } from "../../../src/features/recovery/pending-banner.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;

function page() {
  win.document.body.innerHTML = '<div id="draft-pending-banner" hidden><span id="draft-pending-text"></span>' +
    '<button id="draft-pending-copy">Open a copy</button></div>';
}

test("the banner shows the text, wires its button once, and hides", () => {
  page();
  const banner = createPendingBanner(win.document);
  let copies = 0;
  assert.equal(banner.show("Waiting for the server", () => { copies++; }), true);
  assert.equal(banner.show("Still waiting", () => { copies += 100; }), true);
  const el = win.document.getElementById("draft-pending-banner");
  assert.equal(el?.hidden, false);
  assert.equal(win.document.getElementById("draft-pending-text")?.textContent, "Still waiting");
  win.document.getElementById("draft-pending-copy")?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  assert.equal(copies, 1, "the first wiring is the only one");
  banner.hide();
  assert.equal(el?.hidden, true);
});

test("without the banner or its text, nothing is shown", () => {
  win.document.body.innerHTML = '<div id="draft-pending-banner" hidden></div>';
  const banner = createPendingBanner(win.document);
  assert.equal(banner.show("Waiting", () => {}), false);
  win.document.body.innerHTML = "";
  assert.equal(banner.show("Waiting", () => {}), false);
  banner.hide();
});
