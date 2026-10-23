import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "./jsdom.mjs";
import { fakeTextServices } from "../fakes.ts";
import { owned } from "../../../src/features/routing/owned.ts";
import { setCellSelection } from "../../../src/features/common/cell-selection.ts";
import type { DraftEditPorts } from "../../../src/features/editing/ports.ts";
import * as draft from "../../../src/features/editing/draft-edit.js";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
Object.assign(globalThis, { window: win, document: win.document });

function box(html = "one"): HTMLElement {
  const el = win.document.createElement("div");
  el.className = "cell-editable";
  el.setAttribute("contenteditable", "true");
  el.innerHTML = html;
  win.document.body.appendChild(el);
  setCellSelection(el, html.length);
  return el;
}

test("draft editing uses the text port and keeps undo, redo and composition local to its box", () => {
  const fake = fakeTextServices(win.document);
  const ports: DraftEditPorts = { text: fake.text };
  const owner = draft.__init(ports);
  const el = box();
  try {
    draft.noteDraftFocus(el);
    draft.noteDraftBeforeInput(el, { inputType: "insertText" });
    el.innerHTML = "ones";
    setCellSelection(el, 4);
    draft.noteDraftInput(el);
    draft.noteDraftComposition(el, true);
    assert.equal(draft.draftUndo(el), false);
    draft.noteDraftComposition(el, false);
    assert.equal(draft.draftUndo(el), true);
    assert.equal(el.innerHTML, "one");
    assert.equal(draft.draftRedo(el), true);
    assert.equal(el.innerHTML, "ones");
    assert.equal(draft.pasteIntoDraft(el, "", " more"), el);
    assert.equal(el.innerHTML, "ones more");
    assert.equal(draft.draftUndo(el), true);
    assert.equal(el.innerHTML, "ones");
    assert.ok(fake.calls.some(({ method }) => method === "storedHtmlFromDom"));
    assert.ok(fake.calls.some(({ method }) => method === "fromHtml"));
    assert.ok(fake.calls.some(({ method }) => method === "sanitizeHtml"));
    assert.ok(fake.calls.some(({ method }) => method === "inertBody"));
    const script = win.document.createElement("div");
    script.id = "rows";
    script.appendChild(el);
    win.document.body.appendChild(script);
    assert.equal(draft.draftUndo(el), false);
    script.remove();
  } finally {
    owner.dispose();
    el.remove();
  }
});

test("owned remount cancels draft timers, clears history and installs the new text port", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const first = fakeTextServices(win.document);
  const next = fakeTextServices(win.document);
  const holder = owned<ReturnType<typeof draft.__init>>();
  const el = box();
  const owner = holder.replace(() => draft.__init({ text: first.text } satisfies DraftEditPorts));
  try {
    draft.noteDraftFocus(el);
    el.innerHTML = "pending";
    draft.noteDraftInput(el);
    holder.replace(() => draft.__init({ text: next.text } satisfies DraftEditPorts));
    assert.equal(cleared.mock.callCount(), 1);
    owner.dispose();
    const count = first.calls.length;
    t.mock.timers.tick(800);
    assert.equal(first.calls.length, count);
    assert.deepEqual(next.calls, []);
    assert.equal(draft.draftUndo(el), false);
    assert.ok(next.calls.length > 0);
    draft.noteDraftInput(el);
    holder.stop();
    holder.stop();
    assert.equal(cleared.mock.callCount(), 2);
    const stopped = next.calls.length;
    t.mock.timers.tick(800);
    assert.equal(next.calls.length, stopped);
  } finally {
    holder.stop();
    el.remove();
    t.mock.timers.reset();
  }
});
