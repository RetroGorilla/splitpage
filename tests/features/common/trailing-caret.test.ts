import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTrailingCaretSpot } from "../../../src/features/common/dom.ts";

test("trailing caret: appends exactly one zero-width text node after noneditable markup", () => {
  const container = document.createElement("div");
  container.innerHTML = '<span contenteditable="false">card</span>';
  const card = container.firstChild;
  ensureTrailingCaretSpot(container);
  assert.equal(container.childNodes.length, 2);
  assert.equal(container.firstChild, card);
  assert.equal(container.lastChild?.nodeType, 3);
  assert.equal(container.lastChild?.textContent, "\u200b");
  ensureTrailingCaretSpot(container);
  assert.equal(container.childNodes.length, 2);
});

test("trailing caret: leaves absent, empty, editable and text endings alone", () => {
  ensureTrailingCaretSpot(null);
  ensureTrailingCaretSpot(undefined);
  for (const html of ["", "text", "<b>text</b>", '<span contenteditable="true">text</span>']) {
    const container = document.createElement("div");
    container.innerHTML = html;
    ensureTrailingCaretSpot(container);
    assert.equal(container.innerHTML, html);
  }
});
