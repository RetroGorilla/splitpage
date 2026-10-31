import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentPlainTags, mountPlainTagsFeature, stopPlainTagsFeature } from "../../src/bootstrap/wiring/plain-tags.ts";
import { plainTagOpen } from "../../src/features/tags/plain-tags.ts";

(globalThis as unknown as Record<string, unknown>).CSS = window.CSS;

test("plain-tag wiring exposes its open check, replaces its mount and clears both when stopped", () => {
  document.body.innerHTML = '<div id="rows"><div class="cell-editable" data-field="visualText" tabindex="0">Shot VFX:</div></div>';
  const cell = document.querySelector(".cell-editable") as HTMLElement;
  try {
    assert.equal(currentPlainTags(), null);
    assert.equal(plainTagOpen(cell), false);
    const first = mountPlainTagsFeature();
    assert.equal(currentPlainTags(), first);
    cell.focus();
    const range = document.createRange();
    range.setStart(cell.firstChild as Node, 9);
    range.collapse(true);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    first.maybeOpen({ inputType: "insertText", data: ":" }, cell);
    assert.equal(plainTagOpen(cell), true);
    assert.equal(plainTagOpen(document.body), false);
    const next = mountPlainTagsFeature();
    assert.notEqual(first, next);
    assert.equal(currentPlainTags(), next);
    assert.equal(cell.querySelector(".plain-tag-keyword"), null);
    assert.equal(plainTagOpen(cell), false);
    stopPlainTagsFeature();
    stopPlainTagsFeature();
    assert.equal(currentPlainTags(), null);
    assert.equal(plainTagOpen(), false);
  } finally {
    stopPlainTagsFeature();
  }
});
