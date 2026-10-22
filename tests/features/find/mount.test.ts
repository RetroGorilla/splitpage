import test from "node:test";
import assert from "node:assert/strict";
import { mountFind } from "../../../src/features/find/mount.ts";
import type { FindPorts } from "../../../src/features/find/mount.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;
const targets: Record<string, string> = {
  "find-close": "click", "find-next": "click", "find-prev": "click",
  "find-replace": "click", "find-replace-all": "click", "find-tag": "click",
  "find-tag-go": "click", "find-tag-cancel": "click", "find-tag-cats": "click",
  "find-case": "click", "find-input": "input", findbar: "keydown"
};

function harness() {
  const win = jsdomWindow() as unknown as Realm;
  const doc = win.document;
  doc.body.innerHTML = '<div id="findbar">' + Object.keys(targets).filter((id) => id !== "findbar").map((id) =>
    id === "find-input" ? '<input id="find-input">' : id === "find-tag-cats" ?
    '<div id="find-tag-cats"><button class="tag-cat-btn" data-tag-cat="prop"><span>Prop</span></button></div>' :
    '<button id="' + id + '"><span>Action</span></button>').join("") + '<input id="replace-input"></div>';
  const el = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement;
  const calls: string[] = [];
  const state = { matchCase: false, bulk: false };
  const queryStates: string[] = [];
  const log = (name: string) => (): void => { calls.push(name); };
  const ports: FindPorts = {
    closeFindBar: log("close"), stepFind: (direction) => { calls.push("step:" + direction); },
    replaceCurrent: log("replace"), replaceAll: log("replace-all"), toggleBulkTag: log("toggle"),
    runBulkTag: log("run"), closeBulkTag: () => { calls.push("close-bulk"); state.bulk = false; },
    pickBulkTagCat: (category) => { calls.push("category:" + category); },
    findQueryChanged: () => {
      calls.push("query");
      queryStates.push([state.matchCase, el("find-case").classList.contains("is-active"), el("find-case").getAttribute("aria-pressed")].join(":"));
    },
    leaveFindAtMatch: log("leave"), bulkTagOpen: () => state.bulk,
    getFindMatchCase: () => state.matchCase,
    setFindMatchCase: (value) => { state.matchCase = value; calls.push("case:" + value); }
  };
  function fire(target: EventTarget, type: string, init: KeyboardEventInit = {}): Event {
    const event = type === "keydown" ? new win.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }) :
      new win.Event(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }
  const mount = () => mountFind({ window: win, ports });
  const category = (): HTMLElement => el("find-tag-cats").querySelector("span") as HTMLElement;
  return { win, doc, el, calls, state, queryStates, mount, fire, category };
}

test("find: all 12 registrations preserve order and bubble phase across dispose and remount", () => {
  const h = harness();
  const order: string[] = [];
  const records = Object.entries(targets).map(([id, expected]) => {
    const target = h.el(id);
    const added: string[] = [];
    const active: { type: string; fn: EventListenerOrEventListenerObject | null; capture: boolean }[] = [];
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const phase = (options?: boolean | EventListenerOptions): boolean => typeof options === "boolean" ? options : !!options?.capture;
    target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
      assert.equal(phase(options), false, id + ":" + type);
      added.push(type); active.push({ type, fn, capture: phase(options) }); order.push(id + ":" + type);
      add(type, fn, options);
    };
    target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void => {
      const index = active.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === phase(options));
      assert.ok(index >= 0, id + ":" + type);
      active.splice(index, 1);
      remove(type, fn, options);
    };
    return { id, expected, added, active };
  });
  let owner = h.mount();
  try {
    const expectedOrder = Object.entries(targets).map(([id, type]) => id + ":" + type);
    assert.equal(order.length, 12);
    assert.deepEqual(order, expectedOrder);
    for (const r of records) { assert.deepEqual(r.added, [r.expected], r.id); assert.equal(r.active.length, 1, r.id); }
    owner.dispose(); owner.dispose();
    for (const r of records) assert.equal(r.active.length, 0, r.id);
    owner = h.mount();
    assert.deepEqual(order, [...expectedOrder, ...expectedOrder]);
    for (const r of records) { assert.deepEqual(r.added, [r.expected, r.expected], r.id); assert.equal(r.active.length, 1, r.id); }
    owner.dispose();
    for (const r of records) assert.equal(r.active.length, 0, r.id);
  } finally { owner.dispose(); h.win.close(); }
});

test("find: every row acts once after remount and none acts after disposal", () => {
  const h = harness();
  h.mount().dispose();
  const owner = h.mount();
  function exercise(): void {
    for (const [id, type] of Object.entries(targets)) {
      h.fire(id === "find-tag-cats" ? h.category() : h.el(id), type, { key: "Enter" });
    }
  }
  try {
    exercise();
    assert.deepEqual(h.calls, ["close", "step:1", "step:-1", "replace", "replace-all", "toggle", "run", "close-bulk", "category:prop", "case:true", "query", "query", "step:1"]);
    assert.equal(h.doc.activeElement, h.el("find-tag"));
    owner.dispose();
    h.calls.length = 0;
    exercise();
    assert.deepEqual(h.calls, []);
  } finally { owner.dispose(); h.win.close(); }
});

test("find: case updates state, class and ARIA before each query refresh", () => {
  const h = harness();
  const owner = h.mount();
  try {
    const child = h.el("find-case").firstElementChild as Element;
    h.fire(child, "click");
    h.fire(child, "click");
    assert.deepEqual(h.calls, ["case:true", "query", "case:false", "query"]);
    assert.deepEqual(h.queryStates, ["true:true:true", "false:false:false"]);
    assert.equal(h.state.matchCase, false);
  } finally { owner.dispose(); h.win.close(); }
});

test("find: Enter navigation, replacement and button exclusions retain default and propagation behavior", () => {
  const h = harness();
  const owner = h.mount();
  let bubbled = 0;
  h.doc.addEventListener("keydown", () => { bubbled++; });
  const cases: readonly [string, string, boolean, string[], boolean][] = [
    ["find-input", "Enter", false, ["step:1"], true],
    ["find-input", "Enter", true, ["step:-1"], true],
    ["replace-input", "Enter", false, ["replace"], true],
    ["replace-input", "Enter", true, ["replace"], true],
    ["find-next", "Enter", false, [], false],
    ["find-next", "Enter", true, [], false],
    ["find-input", "ArrowDown", false, [], false]
  ];
  try {
    for (const [id, key, shiftKey, expected, prevented] of cases) {
      h.calls.length = 0;
      const event = h.fire(h.el(id), "keydown", { key, shiftKey });
      assert.deepEqual(h.calls, expected, id + ":" + key + ":" + shiftKey);
      assert.equal(event.defaultPrevented, prevented);
    }
    assert.equal(bubbled, cases.length);
  } finally { owner.dispose(); h.win.close(); }
});

test("find: Escape closes bulk tagging and returns focus before leaving the match; categories delegate only to their buttons", () => {
  const h = harness();
  const owner = h.mount();
  let bubbled = 0;
  h.doc.addEventListener("keydown", () => { bubbled++; });
  try {
    h.state.bulk = true;
    h.el("find-input").focus();
    let event = h.fire(h.el("find-input"), "keydown", { key: "Escape" });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.calls, ["close-bulk"]);
    assert.equal(h.doc.activeElement, h.el("find-tag"));
    h.calls.length = 0;
    event = h.fire(h.el("find-tag"), "keydown", { key: "Escape" });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.calls, ["leave"]);
    assert.equal(bubbled, 0);
    h.calls.length = 0;
    h.state.bulk = true;
    h.el("find-input").focus();
    h.fire(h.el("find-tag-cancel"), "click");
    assert.deepEqual(h.calls, ["close-bulk"]);
    assert.equal(h.doc.activeElement, h.el("find-tag"));
    h.calls.length = 0;
    h.fire(h.el("find-tag-cats"), "click");
    assert.deepEqual(h.calls, []);
    h.fire(h.category(), "click");
    assert.deepEqual(h.calls, ["category:prop"]);
  } finally { owner.dispose(); h.win.close(); }
});

test("find: disposal removes every listener newest first and silences retained callbacks", () => {
  const h = harness();
  const added: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject | null; options: boolean | AddEventListenerOptions | undefined }[] = [];
  const removed: typeof added = [];
  for (const target of Object.keys(targets).map((id) => h.el(id))) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void => {
      added.push({ target, type, fn, options });
      add(type, fn, options);
    };
    target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void => {
      removed.push({ target, type, fn, options });
      remove(type, fn, options);
    };
  }
  const owner = h.mount();
  try {
    assert.equal(added.length, 12);
    owner.dispose();
    owner.dispose();
    assert.equal(removed.length, 12);
    assert.deepEqual(removed, [...added].reverse());
    h.calls.length = 0;
    for (const entry of added) {
      assert.equal(typeof entry.fn, "function");
      (entry.fn as EventListener)(new h.win.Event(entry.type));
    }
    assert.deepEqual(h.calls, []);
  } finally { owner.dispose(); h.win.close(); }
});

test("find: detached targets remain live until disposal without a connectivity guard", () => {
  const h = harness();
  const owner = h.mount();
  const target = h.el("find-close");
  target.replaceWith(target.cloneNode(true));
  try {
    h.fire(target, "click");
    assert.deepEqual(h.calls, ["close"]);
    owner.dispose();
    h.calls.length = 0;
    h.fire(target, "click");
    assert.deepEqual(h.calls, []);
  } finally { owner.dispose(); h.win.close(); }
});
