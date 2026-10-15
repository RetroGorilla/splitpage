import { test } from "node:test";
import assert from "node:assert/strict";
import { editorBlur, mountEditorFocus } from "../../../src/features/editing/focus.ts";
import type { EditorFocusPorts } from "../../../src/features/editing/focus.ts";
import { jsdomWindow } from "./jsdom.mjs";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const doc: Document = win.document;

function surfaces() {
  doc.body.innerHTML =
    '<div id="rows"><div class="field-wrap"><div class="cell-editable" data-id="r1" data-field="audioText" tabindex="0"></div><button class="inside">x</button></div></div>' +
    '<div id="writer-doc"><div class="cell-editable wr-para" data-id="r1" data-field="audioText" tabindex="0"></div></div>' +
    '<div id="other"><div class="cell-editable draft" tabindex="0"></div></div>';
  return {
    rows: doc.getElementById("rows") as HTMLElement,
    writer: doc.getElementById("writer-doc") as HTMLElement,
    gridCell: doc.querySelector("#rows .cell-editable") as HTMLElement,
    inside: doc.querySelector("#rows .inside") as HTMLElement,
    para: doc.querySelector("#writer-doc .wr-para") as HTMLElement,
    draft: doc.querySelector("#other .cell-editable") as HTMLElement
  };
}

function harness(over: Partial<EditorFocusPorts> = {}) {
  const calls: string[] = [];
  const state = { suppressed: false, fresh: null as Element | null };
  const ports: EditorFocusPorts = {
    isScriptCell: (el) => !!el.closest("#rows, #writer-doc"),
    blurSuppressed: () => state.suppressed,
    leftEditable: () => { calls.push("left"); },
    blurredCell: (el) => { calls.push("blurred:" + (el.getAttribute("data-id") || "draft")); },
    typeAtMarks: () => state.fresh,
    typed: (el, data) => { calls.push("typed:" + (el.getAttribute("data-id") || "") + ":" + data); },
    focusedRow: (id) => { calls.push("row:" + id); },
    focusedParagraph: (el) => { calls.push("para:" + (el.getAttribute("data-id") || "")); },
    selectionChanged: (active) => { calls.push("selection:" + (active && active.getAttribute("data-id") || "none")); },
    ...over
  };
  return { calls, state, ports };
}

function focusout(target: Element, related: Element | null = null): void {
  target.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true, relatedTarget: related }));
}

function focusin(target: Element): void {
  target.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
}

function beforeinput(target: Element, data: string, composing = false): Event {
  const e = new win.Event("beforeinput", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "inputType", { value: "insertText" });
  Object.defineProperty(e, "data", { value: data });
  Object.defineProperty(e, "isComposing", { value: composing });
  target.dispatchEvent(e);
  return e;
}

function counted(targets: EventTarget[]) {
  const tally = { added: 0, removed: 0 };
  targets.forEach((t) => {
    const add = t.addEventListener.bind(t);
    const remove = t.removeEventListener.bind(t);
    t.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) => { tally.added++; add(type, fn, o); };
    t.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) => { tally.removed++; remove(type, fn, o); };
  });
  return tally;
}

test("a blur syncs its cell unless a paint or an undo is running, or the focus stays in the same field", () => {
  const s = surfaces();
  const h = harness();
  const dispose = mountEditorFocus({ rows: s.rows, writer: s.writer, doc: doc, ports: h.ports });
  focusout(s.gridCell);
  focusout(s.para);
  assert.deepEqual(h.calls, ["left", "blurred:r1", "left", "blurred:r1"]);
  h.calls.length = 0;
  h.state.suppressed = true;
  focusout(s.gridCell);
  focusout(s.para);
  assert.deepEqual(h.calls, ["left", "left"], "a paint's own blur only tidies up, it never writes the old DOM back");
  h.state.suppressed = false;
  h.calls.length = 0;
  focusout(s.gridCell, s.inside);
  assert.deepEqual(h.calls, ["left"], "focus moving within the field's own controls is not a blur of the field");
  dispose();
});

test("typed text at pending marks or a direction edge is taken over once, and composition or other input is left alone", () => {
  const s = surfaces();
  const h = harness();
  const dispose = mountEditorFocus({ rows: s.rows, writer: s.writer, doc: doc, ports: h.ports });
  assert.equal(beforeinput(s.gridCell, "a").defaultPrevented, false, "nothing pending: the browser types it");
  h.state.fresh = s.para;
  assert.equal(beforeinput(s.para, "b").defaultPrevented, true);
  assert.equal(beforeinput(s.para, "c", true).defaultPrevented, false, "never during a composition");
  assert.equal(beforeinput(s.draft, "d").defaultPrevented, false, "not a script cell");
  assert.deepEqual(h.calls, ["typed:r1:b"]);
  dispose();
});

test("focus and selection are remembered: the focused scene, the Writer paragraph, and each selection change", () => {
  const s = surfaces();
  const h = harness();
  const dispose = mountEditorFocus({ rows: s.rows, writer: s.writer, doc: doc, ports: h.ports });
  focusin(s.gridCell);
  focusin(s.para);
  focusin(s.draft);
  assert.deepEqual(h.calls, ["row:r1", "para:r1", "row:r1"], "a box with no scene is not remembered");
  s.para.focus();
  h.calls.length = 0;
  doc.dispatchEvent(new win.Event("selectionchange"));
  assert.deepEqual(h.calls, ["selection:r1"]);
  dispose();
});

test("dispose and remount leave exactly one handler per row: seven bindings, all removed, one call per event", () => {
  const s = surfaces();
  const tally = counted([s.rows, s.writer, doc]);
  const h = harness();
  const first = mountEditorFocus({ rows: s.rows, writer: s.writer, doc: doc, ports: h.ports });
  assert.equal(tally.added, 7);
  first();
  assert.equal(tally.removed, 7);
  focusout(s.gridCell);
  focusin(s.para);
  doc.dispatchEvent(new win.Event("selectionchange"));
  assert.deepEqual(h.calls, [], "a disposed mount hears nothing");
  const second = mountEditorFocus({ rows: s.rows, writer: s.writer, doc: doc, ports: h.ports });
  focusout(s.gridCell);
  focusin(s.para);
  assert.deepEqual(h.calls, ["left", "blurred:r1", "para:r1", "row:r1"], "one handler each after remount");
  first();
  assert.equal(tally.removed, 7, "a second dispose removes nothing");
  second();
  assert.equal(tally.removed, 14);
});

test("the shared blur handler serves other roots without a mount", () => {
  const s = surfaces();
  const h = harness();
  const blur = editorBlur(h.ports);
  s.draft.addEventListener("focusout", blur);
  focusout(s.draft);
  assert.deepEqual(h.calls, ["left", "blurred:draft"]);
  s.draft.removeEventListener("focusout", blur);
});
