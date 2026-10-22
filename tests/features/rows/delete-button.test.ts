import { test } from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { armDeleteButton, disarmDeleteButton } from "../../../src/features/rows/delete-button.ts";

test("row delete confirmation changes only the armed class and the menu label", () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  try {
    const btn = win.document.createElement("button");
    btn.className = "gutter-btn danger";
    btn.setAttribute("aria-label", "Delete row");
    btn.innerHTML = '<span class="row-menu-label">Delete</span><svg></svg>';
    armDeleteButton(btn);
    assert.equal(btn.className, "gutter-btn danger armed");
    assert.equal(btn.querySelector(".row-menu-label")?.textContent, "Click again to delete");
    assert.equal(btn.getAttribute("aria-label"), "Delete row");
    assert.equal(btn.querySelectorAll("svg").length, 1);
    disarmDeleteButton(btn);
    assert.equal(btn.className, "gutter-btn danger");
    assert.equal(btn.querySelector(".row-menu-label")?.textContent, "Delete");
    assert.equal(btn.getAttribute("aria-label"), "Delete row");
    const iconOnly = win.document.createElement("button");
    armDeleteButton(iconOnly);
    assert.equal(iconOnly.className, "armed");
    assert.equal(iconOnly.innerHTML, "");
    disarmDeleteButton(iconOnly);
    assert.equal(iconOnly.className, "");
    assert.equal(iconOnly.innerHTML, "");
  } finally {
    win.close();
  }
});