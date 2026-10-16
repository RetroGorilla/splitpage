import test from "node:test";
import assert from "node:assert/strict";
import { mountBroll } from "../../../src/features/broll/mount.ts";
import type { BrollPorts } from "../../../src/features/broll/mount.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;
const targets: Record<string, string[]> = {
  "broll-panel": ["click", "change", "focusout", "keydown", "input"],
  "broll-page": ["click", "change", "focusout", "keydown", "input", "change", "keydown"],
  window: ["keydown", "keydown"], document: ["focusin", "mousedown"],
  "broll-add-save": ["click"], "broll-close": ["click"], "btn-broll": ["click"]
};

function harness() {
  const win = jsdomWindow() as unknown as Realm;
  const doc = win.document;
  doc.body.innerHTML = Object.keys(targets).filter((id) => id !== "window" && id !== "document").map((id) => '<div id="' + id + '"></div>').join("");
  const el = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement;
  el("broll-page").innerHTML = '<button id="broll-page-close"></button><select id="broll-page-group"><option value="scene">Scene</option></select><textarea class="broll-page-note"></textarea>';
  const calls: string[] = [];
  const state = { page: false, menus: false, selected: false };
  const log = (name: string) => (): void => { calls.push(name); };
  const ports: BrollPorts = {
    click: (_event, root) => { calls.push("click:" + root.id); },
    change: log("change"), focusout: log("focusout"),
    keydown: log("keydown"), input: log("input"), add: log("add"),
    closePanel: log("close-panel"), openPanel: log("open-panel"),
    closePage: () => { calls.push("close-page"); state.page = false; },
    pageOpen: () => state.page,
    setPageGroup: (value) => { calls.push("group:" + value); },
    menusOpen: () => state.menus,
    closeMenus: () => { calls.push("close-menus"); state.menus = false; },
    hasSelection: () => state.selected,
    clearSelection: () => { calls.push("clear-selection"); state.selected = false; },
    render: log("render"),
    reset: () => { calls.push("reset"); state.menus = false; state.selected = false; state.page = false; }
  };
  const order: string[] = [];
  const records = Object.entries(targets).map(([id, expected]) => {
    const target: EventTarget = id === "window" ? win : id === "document" ? doc : el(id);
    const added: string[] = [];
    const held: { fn: EventListenerOrEventListenerObject | null; key: string }[] = [];
    const active: typeof held = [];
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const key = (type: string, opts?: boolean | EventListenerOptions): string => type + ((typeof opts === "boolean" ? opts : opts?.capture) ? "/C" : "");
    target.addEventListener = (type, fn, opts) => { const entry = { fn, key: key(type, opts) }; added.push(entry.key); held.push(entry); active.push(entry); order.push(id + ":" + entry.key); add(type, fn, opts); };
    target.removeEventListener = (type, fn, opts) => { const index = active.findIndex((entry) => entry.fn === fn && entry.key === key(type, opts)); assert.ok(index >= 0, id); active.splice(index, 1); remove(type, fn, opts); };
    return { id, target, expected, added, held, active };
  });
  function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    return event;
  }
  return { win, doc, el, calls, state, ports, records, order, fire, mount: () => mountBroll({ window: win, ports }) };
}

test("b-roll: all 19 S28 registrations preserve order, phase and multiplicity across disposal and remount", () => {
  const h = harness();
  let owner = h.mount();
  assert.equal(h.order.length, 19);
  assert.deepEqual(h.order, [
    ...(targets["broll-panel"] ?? []).map((type) => "broll-panel:" + type),
    ...(targets["broll-page"] ?? []).map((type) => "broll-page:" + type),
    "window:keydown", "document:focusin", "broll-add-save:click", "broll-close:click", "btn-broll:click", "document:mousedown", "window:keydown"
  ]);
  for (const r of h.records) assert.deepEqual(r.added, r.expected, r.id);
  owner.dispose();
  owner.dispose();
  assert.equal(h.calls.filter((call) => call === "reset").length, 1);
  for (const r of h.records) assert.equal(r.active.length, 0, r.id);
  owner = h.mount();
  for (const r of h.records) {
    assert.deepEqual(r.added, [...r.expected, ...r.expected], r.id);
    assert.equal(r.active.length, r.expected.length, r.id);
  }
  h.calls.length = 0;
  for (const r of h.records) for (const type of new Set(r.expected)) h.fire(r.target, type);
  assert.deepEqual(h.calls, ["click:broll-panel", "change", "focusout", "keydown", "input", "click:broll-page", "change", "focusout", "keydown", "input", "add", "close-panel", "open-panel"]);
  owner.dispose();
  h.calls.length = 0;
  for (const r of h.records) for (const type of new Set(r.expected)) h.fire(r.target, type);
  assert.deepEqual(h.calls, []);
  h.win.close();
});

test("b-roll: page delegates run before page-specific changes and Enter blur; Escape respects modal and prevention", () => {
  const h = harness();
  const owner = h.mount();
  h.fire(h.el("broll-page-group"), "change");
  assert.deepEqual(h.calls, ["change", "group:scene"]);
  h.calls.length = 0;
  const note = h.el("broll-page").querySelector("textarea") as HTMLTextAreaElement;
  note.blur = () => { h.calls.push("blur"); };
  assert.equal(h.fire(note, "keydown", { key: "Enter" }).defaultPrevented, true);
  assert.deepEqual(h.calls, ["keydown", "blur"]);
  h.state.page = true;
  h.doc.body.insertAdjacentHTML("beforeend", '<div class="modal-backdrop"></div>');
  h.calls.length = 0;
  h.fire(h.win, "keydown", { key: "Escape" });
  assert.deepEqual(h.calls, []);
  h.doc.querySelector(".modal-backdrop")?.remove();
  const event = new h.win.Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: "Escape" });
  event.preventDefault();
  h.win.dispatchEvent(event);
  assert.deepEqual(h.calls, []);
  h.state.selected = true;
  assert.equal(h.fire(h.doc.body, "keydown", { key: "Escape" }).defaultPrevented, true);
  assert.deepEqual(h.calls, ["close-page", "clear-selection", "render"]);
  owner.dispose();
  h.win.close();
});

test("b-roll: document menu dismissal and page focus trap retain their exclusions", () => {
  const h = harness();
  const owner = h.mount();
  h.doc.body.insertAdjacentHTML("beforeend", '<button id="outside"></button><button id="menu" class="broll-menu"></button><div class="toast"><button id="toast"></button></div>');
  h.state.menus = true;
  h.fire(h.el("menu"), "mousedown");
  assert.deepEqual(h.calls, []);
  h.fire(h.el("outside"), "mousedown");
  assert.deepEqual(h.calls, ["close-menus", "render"]);
  h.calls.length = 0;
  h.state.page = true;
  h.el("broll-page-close").focus = () => { h.calls.push("focus-page"); };
  h.fire(h.el("toast"), "focusin");
  h.fire(h.el("broll-page-close"), "focusin");
  assert.deepEqual(h.calls, []);
  h.fire(h.el("outside"), "focusin");
  assert.deepEqual(h.calls, ["focus-page"]);
  owner.dispose();
  h.win.close();
});

for (const scenario of ["dispose and reopen", "same-ID root replacement", "stale callback after remount", "normal callback"] as const) {
  test("b-roll: retained registration, " + scenario, () => {
    const h = harness();
    const owner = h.mount();
    const held = h.records.find((r) => r.id === "broll-add-save")?.held[0]?.fn as EventListener;
    let replacement: ReturnType<typeof mountBroll> | undefined;
    if (scenario === "dispose and reopen" || scenario === "stale callback after remount") {
      owner.dispose();
      replacement = h.mount();
    } else if (scenario === "same-ID root replacement") {
      const panel = h.el("broll-panel");
      panel.replaceWith(panel.cloneNode(true));
    }
    h.calls.length = 0;
    held(new h.win.Event("click"));
    assert.deepEqual(h.calls, scenario === "normal callback" ? ["add"] : []);
    owner.dispose();
    replacement?.dispose();
    h.win.close();
  });
}

test("b-roll: an absent panel installs no resources and an absent page omits only page resources", () => {
  const h = harness();
  h.el("broll-page").remove();
  let owner = h.mount();
  assert.equal(h.order.length, 10);
  owner.dispose();
  h.el("broll-panel").remove();
  h.order.length = 0;
  owner = h.mount();
  assert.deepEqual(h.order, []);
  owner.dispose();
  h.win.close();
});
