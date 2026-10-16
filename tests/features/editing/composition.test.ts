import { test } from "node:test";
import assert from "node:assert/strict";
import { mountComposition } from "../../../src/features/editing/composition.ts";
import type { CompositionCell, CompositionOwner } from "../../../src/features/editing/composition.ts";
import { jsdomWindow } from "./jsdom.mjs";

interface Mark { readonly n: number; readonly cell: string }

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const doc: Document = win.document;

function root(): HTMLElement {
  const el = doc.createElement("div");
  el.innerHTML = '<div class="cell" data-id="r1" data-field="audioText"></div><div class="cell" data-id="r2" data-field="audioText"></div><div class="draft"></div>';
  doc.body.appendChild(el);
  return el;
}

function harness() {
  const state = { epoch: 1, serial: 0, current: null as Mark | null };
  const drops: Array<{ mark: number; cancelled: boolean }> = [];
  const listeners = { count: 0 };
  const ports = {
    cellOf: (target: EventTarget | null): CompositionCell | null => {
      const el = target as Element | null;
      const cell = el && el.closest ? el.closest(".cell") : null;
      return cell ? { rowId: cell.getAttribute("data-id") as string, field: cell.getAttribute("data-field") as string } : null;
    },
    epoch: () => state.epoch,
    mark: (cell: CompositionCell): Mark => {
      state.current = { n: ++state.serial, cell: cell.rowId };
      return state.current;
    },
    dropEmptySince: (mark: Mark, cancelled: boolean): boolean => {
      drops.push({ mark: mark.n, cancelled: cancelled });
      return false;
    }
  };
  return { state, drops, listeners, ports };
}

function cell(rootEl: Element, id: string): Element {
  return rootEl.querySelector('[data-id="' + id + '"]') as Element;
}

function compose(target: Element, type: "compositionstart" | "compositionend", data = ""): void {
  const e = new win.Event(type, { bubbles: true });
  Object.defineProperty(e, "data", { value: data });
  target.dispatchEvent(e);
}

function key(target: Element, composing: boolean): void {
  const e = new win.Event("keydown", { bubbles: true });
  Object.defineProperty(e, "isComposing", { value: composing });
  Object.defineProperty(e, "keyCode", { value: composing ? 229 : 65 });
  target.dispatchEvent(e);
}

function input(inputType: string): Event {
  const e = new win.Event("input");
  Object.defineProperty(e, "inputType", { value: inputType });
  return e;
}

function counted(target: EventTarget) {
  const tally = { added: 0, removed: 0 };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => { tally.added++; add(type, fn, opts); };
  target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => { tally.removed++; remove(type, fn, opts); };
  return tally;
}

function mount(h: ReturnType<typeof harness>, roots: EventTarget[]): CompositionOwner {
  return mountComposition<Mark>({ roots: roots, ports: h.ports });
}

test("control: a composition marks at its start, ends through the drop, and a cancel arms one check for the next composition input", () => {
  const h = harness();
  const el = root();
  const owner = mount(h, [el]);
  compose(cell(el, "r1"), "compositionstart");
  assert.equal(owner.composing(), true);
  compose(cell(el, "r1"), "compositionend", "か");
  assert.deepEqual(h.drops, [{ mark: 1, cancelled: false }]);
  owner.settle(input("insertCompositionText"));
  assert.equal(h.drops.length, 1, "a committed composition arms nothing");

  compose(cell(el, "r1"), "compositionstart");
  compose(cell(el, "r1"), "compositionend", "");
  owner.settle(input("deleteCompositionText"));
  assert.deepEqual(h.drops.slice(1), [{ mark: 2, cancelled: true }, { mark: 2, cancelled: true }]);
  owner.settle(input("insertCompositionText"));
  assert.equal(h.drops.length, 3, "the check runs once");

  compose(cell(el, "r1"), "compositionstart");
  compose(cell(el, "r1"), "compositionend", "");
  key(cell(el, "r1"), false);
  owner.settle(input("deleteCompositionText"));
  assert.equal(h.drops.length, 4, "a keydown outside the IME disarms the check");
  owner.dispose();
  el.remove();
});

test("an end outside a script cell, or in another cell than the start, drops nothing", () => {
  const h = harness();
  const el = root();
  const owner = mount(h, [el]);
  compose(el.querySelector(".draft") as Element, "compositionstart");
  assert.equal(owner.composing(), false, "a draft box is not this owner's");
  compose(cell(el, "r1"), "compositionstart");
  compose(cell(el, "r2"), "compositionend", "");
  assert.deepEqual(h.drops, []);
  assert.equal(owner.composing(), false);
  owner.dispose();
  el.remove();
});

test("dispose and reopen while a composition is held: the old mount drops nothing, and the new one has exactly one listener of each", () => {
  const h = harness();
  const el = root();
  const tally = counted(el);
  const first = mount(h, [el]);
  assert.equal(tally.added, 3);
  compose(cell(el, "r1"), "compositionstart");
  first.dispose();
  assert.equal(tally.removed, 3);
  assert.equal(first.composing(), false);
  const second = mount(h, [el]);
  compose(cell(el, "r1"), "compositionend", "");
  assert.deepEqual(h.drops, [], "the end of a composition the old mount held reaches nobody");
  compose(cell(el, "r1"), "compositionstart");
  compose(cell(el, "r1"), "compositionend", "x");
  assert.deepEqual(h.drops, [{ mark: 2, cancelled: false }], "one handler: one drop per end");
  first.dispose();
  assert.equal(tally.removed, 3, "a second dispose removes nothing");
  second.dispose();
  el.remove();
});

test("a same-id document replacement while a composition is held: the end does not reach the new document's history", () => {
  const h = harness();
  const el = root();
  const owner = mount(h, [el]);
  compose(cell(el, "r1"), "compositionstart");
  h.state.epoch = 2;
  assert.equal(owner.composing(), false, "the composition belonged to the old document");
  compose(cell(el, "r1"), "compositionend", "");
  assert.deepEqual(h.drops, []);

  compose(cell(el, "r1"), "compositionstart");
  compose(cell(el, "r1"), "compositionend", "");
  assert.equal(h.drops.length, 1);
  h.state.epoch = 3;
  owner.settle(input("deleteCompositionText"));
  assert.equal(h.drops.length, 1, "an armed check from the old document never runs in the new one");
  owner.dispose();
  el.remove();
});

test("a stale completion after remount: a check armed before dispose never runs on the new mount", () => {
  const h = harness();
  const el = root();
  const first = mount(h, [el]);
  compose(cell(el, "r1"), "compositionstart");
  compose(cell(el, "r1"), "compositionend", "");
  assert.equal(h.drops.length, 1);
  first.dispose();
  const second = mount(h, [el]);
  first.settle(input("deleteCompositionText"));
  second.settle(input("deleteCompositionText"));
  assert.equal(h.drops.length, 1);
  second.dispose();
  el.remove();
});
