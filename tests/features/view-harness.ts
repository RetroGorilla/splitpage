import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jsdomWindow } from "./editing/jsdom.mjs";

export type Registration = readonly [target: string, event: string, phase?: "C" | "B", passive?: boolean];
export type Owner = { dispose: () => void };

export function heldTimers(window: Window, delay: number) {
  const set = window.setTimeout;
  const clear = window.clearTimeout;
  const pending = new Map<number, () => void>();
  const held: (() => void)[] = [];
  const cancelled: number[] = [];
  let serial = 1000000;
  window.setTimeout = (handler: TimerHandler, ms?: number, ...args: unknown[]): number => {
    if (ms !== delay) return set(handler, ms, ...args);
    assert.equal(typeof handler, "function");
    const callback = handler as (...args: unknown[]) => void;
    const run = (): void => { callback(...args); };
    const id = ++serial;
    held.push(run);
    pending.set(id, run);
    return id;
  };
  window.clearTimeout = (id?: number): void => {
    if (id !== undefined && pending.delete(id)) cancelled.push(id);
    else clear(id);
  };
  return {
    pending, held, cancelled,
    advance(): void { const jobs = [...pending.values()]; pending.clear(); jobs.forEach((job) => job()); },
    dispose(): void { window.setTimeout = set; window.clearTimeout = clear; }
  };
}

export function viewHarness() {
  const window = jsdomWindow() as unknown as Window & typeof globalThis;
  const document = window.document;
  document.body.innerHTML = readFileSync(new URL("../../src/page.html", import.meta.url), "utf8");
  document.querySelectorAll("*");
  const calls: { name: string; args: unknown[] }[] = [];
  const log = (name: string) => (...args: unknown[]): void => { calls.push({ name, args }); };
  const el = (id: string): HTMLInputElement => {
    const node = document.getElementById(id);
    assert.ok(node, id);
    return node as HTMLInputElement;
  };
  let epoch = 0;
  const capture = (): (() => boolean) => { const mine = epoch; return () => epoch === mine; };
  const replaceDocument = (): void => { epoch++; };
  const entries: { target: EventTarget; listener: EventListenerOrEventListenerObject | null; key: string }[] = [];
  const held: typeof entries = [];
  const order: string[] = [];
  const key = (type: string, options?: boolean | EventListenerOptions): string => type + "/" + ((typeof options === "boolean" ? options : options?.capture) ? "C" : "B");
  const watched: EventTarget[] = [window, document, ...document.querySelectorAll("*")];
  for (const target of watched) {
    const node = target as HTMLElement;
    const name = target === window ? "window" : target === document ? "document" : node.id || (node.getAttribute("name") === "import-split" ? "import-split:" + (node as HTMLInputElement).value : node.tagName);
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void => {
      const passive = typeof options === "object" && options.passive !== undefined ? "/passive:" + options.passive : "";
      const entry = { target, listener, key: name + ":" + key(type, options) + passive };
      entries.push(entry);
      held.push(entry);
      order.push(entry.key);
      add(type, listener, options);
    };
    target.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void => {
      const index = entries.findIndex((entry) => entry.target === target && entry.listener === listener && entry.key.split("/passive:")[0] === name + ":" + key(type, options));
      assert.ok(index >= 0, name + ":" + type);
      entries.splice(index, 1);
      remove(type, listener, options);
    };
  }
  const fire = (target: EventTarget, type: string, props: Record<string, unknown> = {}): Event => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    return event;
  };
  function assertRemount(mount: () => Owner[], expected: readonly Registration[]): void {
    const wanted = expected.map(([target, type, phase = "B", passive]) => target + ":" + type + "/" + phase + (passive === undefined ? "" : "/passive:" + passive));
    let owners = mount();
    assert.deepEqual(order, wanted);
    owners.forEach((owner) => { owner.dispose(); owner.dispose(); });
    assert.equal(entries.length, 0);
    owners = mount();
    assert.deepEqual(order, [...wanted, ...wanted]);
    assert.deepEqual(entries.map((entry) => entry.key), wanted);
    calls.length = 0;
    for (const entry of held.slice(0, wanted.length)) {
      const event = new window.MouseEvent("click");
      Object.defineProperty(event, "target", { value: document.body });
      if (typeof entry.listener === "function") entry.listener(event);
      else entry.listener?.handleEvent(event);
    }
    assert.deepEqual(calls, []);
    owners.forEach((owner) => owner.dispose());
    assert.equal(entries.length, 0);
  }
  return { window, document, calls, log, el, fire, capture, replaceDocument, entries, held, order, assertRemount };
}
