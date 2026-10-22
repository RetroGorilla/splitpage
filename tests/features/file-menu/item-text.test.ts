import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMenuItemText } from "../../../src/features/file-menu/item-text.ts";

function item(html: string): HTMLElement {
  const el = document.createElement("button");
  el.innerHTML = html;
  return el;
}

test("a label goes into the item's label span, or replaces the whole text when there is none", () => {
  const items = createMenuItemText();
  const withSpan = item('<span class="mi-label">Open</span><span class="mi-keys">K</span>');
  items.setLabel(withSpan, "Open recent");
  assert.equal(withSpan.querySelector(".mi-label")?.textContent, "Open recent");
  assert.ok(withSpan.querySelector(".mi-keys"));
  const plain = item("Open");
  items.setLabel(plain, "Close");
  assert.equal(plain.textContent, "Close");
  items.setLabel(null, "ignored");
  items.setLabel(undefined, "ignored");
});

test("a reason shows in the item's reason span, and an empty reason hides it", () => {
  const items = createMenuItemText();
  const el = item('<span class="mi-label">Paste</span><span class="mi-why" hidden></span>');
  const why = el.querySelector(".mi-why") as HTMLElement;
  items.setReason(el, "Nothing to paste");
  assert.equal(why.textContent, "Nothing to paste");
  assert.equal(why.hidden, false);
  items.setReason(el, "");
  assert.equal(why.textContent, "");
  assert.equal(why.hidden, true);
  items.setReason(item("No span"), "ignored");
  items.setReason(null, "ignored");
});
