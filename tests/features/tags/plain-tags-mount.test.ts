import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startPlainTags } from "../../../src/features/tags/plain-tags.ts";
import type { PlainTagPorts } from "../../../src/features/tags/ports.ts";
import type { CellEditResult, CellEdit } from "../../../src/application/editing/cell-editing.ts";
import { namedTagId, projection } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { fakeDocument, fakeTagCategories, fakeTextServices } from "../fakes.ts";
import { createRichText } from "../../../src/adapters/richtext/richtext.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;
realm.CSS = win.CSS;

const ZWSP = String.fromCharCode(0x200B);

function fixture(html: string, model: string | Run[]) {
  win.document.body.innerHTML = '<div id="rows"><div class="cell-editable" data-field="visualText" tabindex="0">' + html + "</div></div>";
  const cell = win.document.querySelector(".cell-editable") as HTMLElement;
  const text = fakeTextServices(win.document);
  const changes: CellEditResult[] = [];
  const ports: PlainTagPorts = {
    renderCategories: fakeTagCategories().renderCategories,
    document: fakeDocument(null).document,
    cells: {
      edit: (target: Element, change: CellEdit) => {
        assert.equal(target, cell);
        const runs: Run[] = typeof model === "string" ? [{ text: model, marks: {} }] : model;
        const res = change(runs, null);
        if (!res) return null;
        changes.push(res);
        return target;
      }
    },
    text: text.text
  };
  return { cell, ports, changes, calls: text.calls };
}

function caretAt(node: Node, offset: number): void {
  const range = win.document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = win.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
}

function typedColon(): Pick<InputEvent, "inputType" | "data"> {
  return { inputType: "insertText", data: ":" };
}

for (const [html, words] of [
  ["VFX: explosion in the background", "explosion in the background"],
  ["VFX: glow <strong>across</strong> the logo", "glow across the logo"],
  ["VFX: flare<br>next line", "flare"],
  ["VFX: flare<br>next paragraph<br>", "flare"],
  ['VFX: rain <span class="tag-anchor" data-tag-cat="prop" data-tag-name="umbrella">umbrella</span> roof', "rain"],
  ['VFX: glow <a href="https://example.com/">link</a> after', "glow"]
] as const) {
  test("immediate Tab tags existing words up to the line boundary: " + html, () => {
    const rich = createRichText({ DOMParser: win.DOMParser, images: { known: () => null, fromDataUrl: () => null }, ids: { id: () => "unused", docId: () => "unused" } });
    const h = fixture(html, rich.decode(html));
    const control = startPlainTags({ ...h.ports, text: { fromHtml: rich.decode, storedHtmlFromDom: rich.storedHtmlFromDom } });
    try {
      h.cell.focus();
      caretAt(h.cell.firstChild as Node, 4);
      control.maybeOpen(typedColon(), h.cell);
      assert.equal(control.isOpen(), true);
      assert.equal(control.close(), true);
      assert.equal(h.changes.length, 1);
      const result = h.changes[0] as CellEditResult;
      assert.deepEqual(result.records, { tags: [{ cat: "vfx", name: words }] });
      assert.equal(result.cell.filter(run => run.marks.tag === namedTagId("vfx", words)).map(run => run.text).join(""), words);
    } finally {
      control.dispose();
    }
  });
}

for (const typed of [" new", " "]) {
  test("typing before existing words keeps Tab's current caret boundary: " + JSON.stringify(typed), () => {
    const h = fixture("VFX: old words", "VFX:" + typed + " old words");
    const control = startPlainTags(h.ports);
    try {
      h.cell.focus();
      caretAt(h.cell.firstChild as Node, 4);
      control.maybeOpen(typedColon(), h.cell);
      const tail = h.cell.querySelector(".plain-tag-keyword")?.nextSibling as Text;
      tail.insertData(1, typed);
      caretAt(tail, 1 + typed.length);
      assert.equal(control.close(), true);
      assert.equal(control.isOpen(), false);
      assert.equal(h.changes.length, typed.trim() ? 1 : 0);
      if (h.changes.length) {
        const result = h.changes[0] as CellEditResult;
        assert.deepEqual(result.records, { tags: [{ cat: "vfx", name: "new" }] });
        assert.equal(projection(result.cell), "new old words");
      }
    } finally {
      control.dispose();
    }
  });
}

test("plain tags mount with fake ports: the keyword opens, Tab edits through the cells port and the listeners hear it", () => {
  const h = fixture("Shot VFX:", "Shot VFX: flare");
  const control = startPlainTags(h.ports);
  try {
    h.cell.focus();
    caretAt(h.cell.firstChild as Node, 9);
    control.maybeOpen(typedColon(), h.cell);
    assert.equal(control.isOpen(h.cell), true);
    assert.equal(control.isOpen(), true);
    const span = h.cell.querySelector(".plain-tag-keyword") as HTMLElement;
    assert.equal(span.textContent, "VFX:");
    assert.equal(control.emptyAtCaret(), true);
    const tail = span.nextSibling as Text;
    assert.equal(tail.data, ZWSP);
    tail.appendData(" flare");
    caretAt(tail, tail.length);
    control.refresh();
    assert.equal(control.isOpen(h.cell), true);
    assert.equal(control.emptyAtCaret(), false);
    let heard = 0;
    const off = control.onTagged(() => { heard++; });
    assert.equal(control.close(), true);
    off();
    assert.equal(heard, 1);
    assert.equal(control.isOpen(), false);
    assert.equal(h.changes.length, 1);
    const change = h.changes[0] as CellEditResult;
    assert.equal(projection(change.cell), "Shot flare");
    assert.deepEqual(change.sel, { from: 10, to: 10 });
    assert.deepEqual(change.records, { tags: [{ cat: "vfx", name: "flare" }] });
    assert.equal(h.calls.length, 0);
  } finally {
    control.dispose();
  }
});

test("a keyword at the start of a text node reads the character before it through the text port", () => {
  const h = fixture("<b>x</b>VFX:", "xVFX:");
  const control = startPlainTags(h.ports);
  try {
    h.cell.focus();
    caretAt(h.cell.lastChild as Node, 4);
    control.maybeOpen(typedColon(), h.cell);
    assert.equal(control.isOpen(), false);
    assert.deepEqual(h.calls.map((c) => c.method), ["storedHtmlFromDom", "fromHtml"]);
  } finally {
    control.dispose();
  }
});

test("dispose puts an open keyword back and a second mount starts closed", () => {
  const h = fixture("Shot VFX:", "Shot VFX:");
  const first = startPlainTags(h.ports);
  h.cell.focus();
  caretAt(h.cell.firstChild as Node, 9);
  first.maybeOpen(typedColon(), h.cell);
  assert.equal(first.isOpen(h.cell), true);
  first.dispose();
  first.dispose();
  assert.equal(h.cell.querySelector(".plain-tag-keyword"), null);
  assert.equal(h.cell.textContent, "Shot VFX:");
  const second = startPlainTags(h.ports);
  try {
    assert.equal(second.isOpen(), false);
    assert.equal(second.close(), false);
    assert.equal(h.changes.length, 0);
  } finally {
    second.dispose();
  }
});
