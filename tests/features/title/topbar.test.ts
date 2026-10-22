import test from "node:test";
import assert from "node:assert/strict";
import { mountTopbar } from "../../../src/features/title/topbar.ts";
import { heldTimers, viewHarness } from "../view-harness.ts";

test("topbar: dispose removes listeners and cancels pending frames, animations and timers", async (t) => {
  const h = viewHarness();
  t.after(() => h.window.close());
  for (const [name, value] of Object.entries({ Element: h.window.Element, ResizeObserver: undefined })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  Object.defineProperty(h.window, "requestAnimationFrame", { value: (callback: FrameRequestCallback): number => {
    const id = ++serial;
    frames.set(id, callback);
    return id;
  } });
  Object.defineProperty(h.window, "cancelAnimationFrame", { value: (id: number): void => { frames.delete(id); } });
  const advanceFrame = (): void => {
    const jobs = [...frames.values()];
    frames.clear();
    jobs.forEach((job) => job(0));
  };
  const timers = heldTimers(h.window, 180);
  t.after(() => timers.dispose());
  Object.defineProperty(h.document, "hidden", { value: false });
  const fontCallbacks: (() => void)[] = [];
  Object.defineProperty(h.document, "fonts", { value: { ready: new Promise<void>((resolve) => { fontCallbacks.push(resolve); }) } });
  const range = h.document.createRange();
  let measures = 0;
  Object.defineProperty(range, "getBoundingClientRect", { value: (): DOMRect => {
    measures++;
    return new h.window.DOMRect(0, 0, 72, 12);
  } });
  t.mock.method(h.document, "createRange", () => range);
  let cancelled = 0;
  Object.defineProperty(h.window.Element.prototype, "animate", { configurable: true, value: () => ({ cancel: (): void => { cancelled++; } }) });
  const topbar = h.document.querySelector<HTMLElement>(".topbar");
  assert.ok(topbar);
  const part = topbar.nextElementSibling;
  assert.ok(part);
  t.mock.method(part, "getBoundingClientRect", (): DOMRect => new h.window.DOMRect(0, topbar.classList.contains("is-condensed") ? 20 : 100, 300, 80));
  const owner = mountTopbar({ window: h.window });
  assert.ok(h.entries.length > 0);
  const button = h.el("btn-production");
  assert.equal(button.style.getPropertyValue("--label-w"), "72px");
  h.fire(button, "pointerenter", { pointerType: "touch" });
  assert.equal(button.classList.contains("is-label-open"), false);
  h.fire(button, "pointerenter", { pointerType: "mouse" });
  assert.equal(button.classList.contains("is-label-open"), true);
  h.fire(h.window, "resize");
  Object.defineProperty(h.window, "innerWidth", { configurable: true, value: h.window.innerWidth - 100 });
  h.fire(h.window, "resize");
  Object.defineProperty(h.window, "scrollY", { configurable: true, value: 100 });
  h.fire(h.window, "scroll");
  advanceFrame();
  assert.equal(topbar.classList.contains("is-condensing"), true);
  assert.equal(timers.pending.size, 1);
  h.fire(h.window, "scroll");
  assert.ok(frames.size > 0);
  owner.dispose();
  owner.dispose();
  assert.equal(h.entries.length, 0);
  assert.equal(frames.size, 0);
  assert.equal(timers.pending.size, 0);
  assert.equal(timers.cancelled.length, 1);
  assert.ok(cancelled > 0);
  assert.equal(topbar.classList.contains("is-condensed"), false);
  assert.equal(topbar.classList.contains("is-condensing"), false);
  assert.equal(button.classList.contains("is-label-open"), false);
  assert.equal(h.document.querySelector(".is-width-jump"), null);
  const measured = measures;
  const fontsReady = fontCallbacks[0];
  assert.ok(fontsReady);
  fontsReady();
  await Promise.resolve();
  assert.equal(measures, measured);
  h.fire(h.window, "scroll");
  assert.equal(frames.size, 0);
});

test("topbar: dispose disconnects resize observation and ignores a held observer callback", (t) => {
  const h = viewHarness();
  t.after(() => h.window.close());
  h.document.querySelectorAll(".btn-label").forEach((label) => label.remove());
  let disconnected = 0;
  const observers: Observer[] = [];
  const observed: Element[] = [];
  class Observer implements ResizeObserver {
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(this); }
    observe(target: Element): void { observed.push(target); }
    unobserve(): void {}
    disconnect(): void { disconnected++; }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "ResizeObserver", descriptor); else Reflect.deleteProperty(globalThis, "ResizeObserver"); });
  const owner = mountTopbar({ window: h.window });
  const row = h.document.querySelector(".topbar-row");
  assert.ok(row);
  assert.deepEqual(observed, [row]);
  owner.dispose();
  owner.dispose();
  assert.equal(disconnected, 1);
  assert.equal(h.entries.length, 0);
  const observer = observers[0];
  assert.ok(observer);
  observer.callback([], observer);
  assert.equal(h.document.querySelector(".is-width-jump"), null);
});
