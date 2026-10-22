import test from "node:test";
import assert from "node:assert/strict";
import { mountPhoneBar } from "../../../src/features/notices/phone-bar.ts";
import { heldTimers, viewHarness } from "../view-harness.ts";

test("phone bar: dispose removes the listener, disconnects the observer and leaves no timers", (t) => {
  const h = viewHarness();
  t.after(() => h.window.close());
  const notifications: (() => void)[] = [];
  let disconnected = 0;
  const observed: Node[] = [];
  class Observer {
    constructor(callback: () => void) { notifications.push(callback); }
    observe(node: Node): void { observed.push(node); }
    disconnect(): void { disconnected++; }
  }
  for (const [name, value] of Object.entries({ Element: h.window.Element, MutationObserver: Observer })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
  const timers = heldTimers(h.window, 180);
  t.after(() => timers.dispose());
  const owner = mountPhoneBar({ window: h.window });
  assert.deepEqual(h.entries.map((entry) => entry.key), ["phone-bar:click/B"]);
  assert.ok(observed.includes(h.el("production-panel")));
  assert.ok(observed.includes(h.el("production-badge")));
  const tab = h.document.querySelector<HTMLElement>('.phone-tab[data-for="btn-production"]');
  assert.ok(tab);
  let clicks = 0;
  t.mock.method(h.el("btn-production"), "click", (): void => { clicks++; });
  h.fire(tab, "click");
  assert.equal(clicks, 1);
  h.el("production-badge").hidden = false;
  h.el("production-badge").textContent = "2";
  const notify = notifications[0];
  assert.ok(notify);
  notify();
  const count = tab.querySelector<HTMLElement>(".phone-tab-count");
  assert.ok(count);
  assert.equal(count.textContent, "2");
  assert.match(tab.getAttribute("aria-label") ?? "", /2 items$/);
  owner.dispose();
  owner.dispose();
  assert.equal(h.entries.length, 0);
  assert.equal(disconnected, 1);
  assert.equal(timers.pending.size, 0);
  h.fire(tab, "click");
  assert.equal(clicks, 1);
  h.el("production-badge").textContent = "3";
  notify();
  assert.equal(count.textContent, "2");
});
