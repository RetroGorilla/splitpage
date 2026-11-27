import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { mountPresenceView } from "../../../src/features/collaboration/presence.ts";
import { cssAttr } from "../../../src/features/common/dom.ts";
import { fakePresenceView } from "../fakes.ts";
import { viewHarness } from "../view-harness.ts";

function subscribers<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    listen(listener: (value: T) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(value: T) { listeners.forEach(listener => listener(value)); },
    count: () => listeners.size
  };
}

function editor(t: TestContext) {
  const { window, document, el } = viewHarness();
  const original = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window, document, CSS: { escape: cssAttr } });
  t.after(() => {
    for (const key of ["window", "document", "CSS"] as const) {
      const descriptor = original[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  el("rows").innerHTML = ["A", "B", "C"].map(beat =>
    `<div class="cell-editable" tabindex="0" data-id="${beat}" data-field="audioText">Beat ${beat}</div>`).join("");
  const [first, removed, survivor] = document.querySelectorAll<HTMLElement>("#rows .cell-editable");
  assert.ok(first && removed && survivor);
  const cells = [first, removed, survivor] as const;
  const removals = subscribers<readonly string[]>(), localEdits = subscribers<undefined>();
  const point = { type: { client: 1, clock: 0 }, item: null, assoc: 0 } as const;
  const { collaboration, ports, published } = fakePresenceView({
    onBeatsRemoving: removals.listen,
    onLocalEdit: localEdits.listen,
    caret: (_location, _cell, ends) => ({ anchor: point, head: { ...point, item: { client: 1, clock: ends.head } } })
  });
  const dispose = mountPresenceView(ports);
  t.after(dispose);
  const connect = (connected: boolean) => collaboration.setRelay({ connected, firstSyncDone: true, pendingChangeCount: 0 });
  const sample = () => t.mock.timers.tick(100);
  collaboration.enter();
  connect(true);
  function select(cell: HTMLElement, anchor = 1, head = 4) {
    const text = cell.firstChild as Text;
    cell.focus();
    document.getSelection()?.setBaseAndExtent(text, anchor, text, head);
    document.dispatchEvent(new window.Event("selectionchange"));
  }
  function removeB() {
    removals.emit(["B"]);
    const focused = document.activeElement;
    cells[1].remove();
    if (focused === cells[1]) select(cells[0], 2, 2);
  }
  return { window, cells, connect, select, removeB, sample, last: () => published.at(-1), localEdits, dispose, removals };
}

test("deletion hides a selection placed before its first presence sample", t => {
  const h = editor(t);
  h.select(h.cells[0]);
  h.sample();
  h.select(h.cells[1]);
  h.removeB();
  h.sample();
  assert.equal(h.last()?.beat, "A");
  assert.equal(h.last()?.caret, null);
});

test("deletion elsewhere preserves a selection moved ahead of the presence sample", t => {
  const h = editor(t);
  h.select(h.cells[1]);
  h.sample();
  h.select(h.cells[2]);
  h.removeB();
  h.sample();
  assert.equal(h.last()?.beat, "C");
  assert.equal(h.last()?.caret?.head.item?.clock, 4);
});

test("a local edit resumes publication when the editor consumes its input", t => {
  const h = editor(t);
  h.select(h.cells[1]);
  h.sample();
  h.removeB();
  h.sample();
  assert.equal(h.last()?.caret, null);
  h.window.addEventListener("keydown", event => {
    event.stopImmediatePropagation();
    h.localEdits.emit(undefined);
    h.select(h.cells[2], 1, 1);
  }, { capture: true, once: true });
  h.cells[0].dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  h.sample();
  assert.equal(h.last()?.beat, "C");
  assert.equal(h.last()?.caret?.head.item?.clock, 1);
  assert.equal(h.localEdits.count(), 0);
});

test("relay reconnect keeps a recovered caret private until deliberate placement", t => {
  const h = editor(t);
  h.select(h.cells[1]);
  h.sample();
  h.removeB();
  h.sample();
  assert.equal(h.last()?.caret, null);
  h.connect(false);
  h.connect(true);
  h.sample();
  assert.equal(h.last()?.beat, "A");
  assert.equal(h.last()?.caret, null);
  h.cells[0].dispatchEvent(new h.window.Event("pointerdown", { bubbles: true }));
  h.select(h.cells[0], 3, 3);
  h.sample();
  assert.equal(h.last()?.caret?.head.item?.clock, 3);
  h.dispose();
  assert.equal(h.removals.count(), 0);
});
