import test from "node:test";
import assert from "node:assert/strict";
import { mountOverlay } from "../../../src/features/overlay/mount.ts";
import type { OverlayPorts, OverlayMount } from "../../../src/features/overlay/mount.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;
const expectedOrder = ["document:mousedown/C", "toolbar:mousedown/B", "window:keydown/B", "writer-bar:mousedown/B", "document:focusin/B", "window:keydown/B"];

function harness() {
  const win = jsdomWindow() as unknown as Realm;
  const doc = win.document;
  doc.body.innerHTML = '<div class="toolbar" id="toolbar"><button class="btn"><span id="toolbar-button"></span></button><input id="toolbar-input"></div>' +
    '<div class="row-menu-wrap"><button id="menu-item"></button></div><input id="outside">' +
    '<div id="production-panel" hidden></div><div id="comment-modal" hidden></div><div id="comments-panel" hidden></div>' +
    '<div id="writer"><div id="writer-doc"><p class="wr-para" id="first" tabindex="0"></p><p class="wr-para" id="second" tabindex="0"></p></div><button id="wr-close"></button>' +
    '<div class="writer-bar" id="writer-bar"><button class="wr-fmt"><span id="writer-button"></span></button><input id="writer-input"></div></div>' +
    '<div class="modal-backdrop" id="modal"><input id="modal-input"></div><div class="toast"><button id="toast-button"></button></div>';
  const el = (id: string): HTMLElement => {
    const target = doc.getElementById(id);
    assert.ok(target, id);
    return target;
  };
  doc.querySelector(".toolbar");
  const calls: string[] = [];
  const state = { selected: false, writer: false, painting: false, ghost: false };
  const log = (name: string) => (): void => { calls.push(name); };
  const ports: OverlayPorts = {
    closeRowMenus: log("close-menus"), selectedKeys: () => state.selected ? ["tag"] : [],
    clearProductionSelection: () => { calls.push("clear-selection"); state.selected = false; },
    renderProduction: log("render"), closeCommentComposer: (cancelled) => { calls.push("composer:" + cancelled); },
    closeCommentsPanel: log("comments"), writerOpen: () => state.writer,
    paintingScreen: () => state.painting, hasTagGhost: () => state.ghost,
    hideTagGhost: () => { calls.push("ghost"); state.ghost = false; }, closeWriter: log("writer"),
    focus: (target) => { calls.push("focus:" + target.id); target.focus(); }
  };
  const order: string[] = [];
  const records = [
    { id: "document", target: doc as EventTarget, expected: ["mousedown/C", "focusin/B"] },
    { id: "toolbar", target: el("toolbar") as EventTarget, expected: ["mousedown/B"] },
    { id: "window", target: win as EventTarget, expected: ["keydown/B", "keydown/B"] },
    { id: "writer-bar", target: el("writer-bar") as EventTarget, expected: ["mousedown/B"] }
  ].map(({ id, target, expected }) => {
    const added: string[] = [];
    const held: { fn: EventListenerOrEventListenerObject | null; key: string }[] = [];
    const active: typeof held = [];
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const key = (type: string, options?: boolean | EventListenerOptions): string => type + ((typeof options === "boolean" ? options : options?.capture) ? "/C" : "/B");
    target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void => {
      const entry = { fn, key: key(type, options) };
      added.push(entry.key); held.push(entry); active.push(entry); order.push(id + ":" + entry.key);
      add(type, fn, options);
    };
    target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void => {
      const index = active.findIndex((entry) => entry.fn === fn && entry.key === key(type, options));
      assert.ok(index >= 0, id + ":" + type);
      active.splice(index, 1);
      remove(type, fn, options);
    };
    return { id, expected, added, held, active };
  });
  function fire(target: EventTarget, type: string, key?: string): Event {
    const event = key === undefined ? new win.Event(type, { bubbles: true, cancelable: true }) :
      new win.KeyboardEvent(type, { bubbles: true, cancelable: true, key });
    target.dispatchEvent(event);
    return event;
  }
  const begin = () => mountOverlay({ window: win, ports });
  function stages(owner: OverlayMount): void {
    owner.mountToolbar(); owner.mountCommentsEscape(); owner.mountWriterBar(); owner.mountWriterFocus();
  }
  const mount = () => { const owner = begin(); stages(owner); return owner; };
  return { win, doc, el, calls, state, ports, order, records, fire, begin, stages, mount };
}

test("overlay: all six registrations retain target, order, phase and multiplicity across disposal and remount", () => {
  const h = harness();
  let owner = h.begin();
  try {
    assert.deepEqual(h.order, [expectedOrder[0]]);
    h.stages(owner); h.stages(owner);
    assert.deepEqual(h.order, expectedOrder);
    for (const r of h.records) { assert.deepEqual(r.added, r.expected, r.id); assert.equal(r.active.length, r.expected.length, r.id); }
    owner.dispose(); owner.dispose(); h.stages(owner);
    for (const r of h.records) assert.equal(r.active.length, 0, r.id);
    assert.deepEqual(h.order, expectedOrder);
    owner = h.mount();
    assert.deepEqual(h.order, [...expectedOrder, ...expectedOrder]);
    for (const r of h.records) { assert.deepEqual(r.added, [...r.expected, ...r.expected], r.id); assert.equal(r.active.length, r.expected.length, r.id); }
    owner.dispose();
    for (const r of h.records) assert.equal(r.active.length, 0, r.id);
  } finally { owner.dispose(); h.win.close(); }
});

test("overlay: captured outside mousedown closes menus before a target stops propagation and shields nested menu targets", () => {
  const h = harness();
  const owner = h.mount();
  h.el("outside").addEventListener("mousedown", (event) => { h.calls.push("target"); event.stopPropagation(); });
  try {
    const event = h.fire(h.el("outside"), "mousedown");
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(h.calls, ["close-menus", "target"]);
    h.calls.length = 0;
    h.fire(h.el("menu-item"), "mousedown");
    assert.deepEqual(h.calls, []);
    h.fire(h.doc, "mousedown");
    assert.deepEqual(h.calls, ["close-menus"]);
    owner.dispose(); h.calls.length = 0;
    h.fire(h.el("outside"), "mousedown");
    assert.deepEqual(h.calls, ["target"]);
  } finally { owner.dispose(); h.win.close(); }
});

test("overlay: toolbar and Writer formatting retain selection only for their button descendants", () => {
  const h = harness();
  const owner = h.mount();
  try {
    for (const id of ["toolbar-button", "writer-button"]) assert.equal(h.fire(h.el(id), "mousedown").defaultPrevented, true, id);
    for (const id of ["toolbar", "toolbar-input", "writer-bar", "writer-input"]) assert.equal(h.fire(h.el(id), "mousedown").defaultPrevented, false, id);
    owner.dispose();
    for (const id of ["toolbar-button", "writer-button"]) assert.equal(h.fire(h.el(id), "mousedown").defaultPrevented, false, id);
  } finally { owner.dispose(); h.win.close(); }
});

test("overlay: Escape clears visible production selection before composer or panel without stopping later handlers", () => {
  const h = harness();
  const owner = h.mount();
  let later = 0;
  h.win.addEventListener("keydown", () => { later++; });
  try {
    h.state.selected = true;
    h.el("production-panel").hidden = false;
    h.el("comment-modal").hidden = false;
    h.el("comments-panel").hidden = false;
    assert.equal(h.fire(h.win, "keydown", "Escape").defaultPrevented, true);
    assert.deepEqual(h.calls, ["clear-selection", "render"]);
    h.calls.length = 0;
    assert.equal(h.fire(h.win, "keydown", "Escape").defaultPrevented, false);
    assert.deepEqual(h.calls, ["composer:true"]);
    h.calls.length = 0; h.el("comment-modal").hidden = true;
    h.fire(h.win, "keydown", "Escape");
    assert.deepEqual(h.calls, ["comments"]);
    h.calls.length = 0; h.el("comments-panel").hidden = true;
    h.fire(h.win, "keydown", "Escape"); h.fire(h.win, "keydown", "Enter");
    assert.deepEqual(h.calls, []);
    assert.equal(later, 5);
    h.state.selected = true; h.el("production-panel").hidden = true; h.el("comment-modal").hidden = false;
    h.fire(h.win, "keydown", "Escape");
    assert.deepEqual(h.calls, ["composer:true"]);
    assert.equal(h.state.selected, true);
  } finally { owner.dispose(); h.win.close(); }
});

test("overlay: Writer focus trap preserves paint, closed Writer, modal, toast and internal-focus exceptions", () => {
  const h = harness();
  const owner = h.mount();
  try {
    h.fire(h.el("outside"), "focusin");
    h.state.writer = true; h.state.painting = true;
    h.fire(h.el("outside"), "focusin");
    h.state.painting = false;
    for (const id of ["first", "second", "wr-close", "writer-input", "modal-input", "toast-button"]) h.fire(h.el(id), "focusin");
    h.fire(h.doc, "focusin");
    assert.deepEqual(h.calls, []);
    h.el("outside").focus();
    assert.deepEqual(h.calls, ["focus:first"]);
    assert.equal(h.doc.activeElement, h.el("first"));
    h.calls.length = 0; h.el("modal").hidden = true;
    h.fire(h.el("modal-input"), "focusin");
    assert.deepEqual(h.calls, ["focus:first"]);
    h.calls.length = 0; h.el("first").remove();
    h.fire(h.el("outside"), "focusin");
    assert.deepEqual(h.calls, ["focus:second"]);
    h.calls.length = 0; h.el("second").remove();
    h.fire(h.el("outside"), "focusin");
    assert.deepEqual(h.calls, ["focus:wr-close"]);
    h.calls.length = 0; h.el("wr-close").remove();
    h.fire(h.el("outside"), "focusin");
    assert.deepEqual(h.calls, []);
    owner.dispose(); h.el("writer-doc").innerHTML = '<p class="wr-para" tabindex="0"></p>';
    h.el("outside").focus();
    assert.deepEqual(h.calls, []);
    assert.equal(h.doc.activeElement, h.el("outside"));
  } finally { owner.dispose(); h.win.close(); }
});

test("overlay: Writer Escape dismisses the ghost before closing and preserves interleaved window handler order", () => {
  const h = harness();
  h.win.addEventListener("keydown", () => { h.calls.push("before"); });
  const owner = h.begin();
  owner.mountCommentsEscape();
  h.win.addEventListener("keydown", () => { h.calls.push("between"); });
  owner.mountWriterFocus();
  h.win.addEventListener("keydown", () => { h.calls.push("after"); });
  try {
    h.state.writer = true; h.state.ghost = true; h.el("comment-modal").hidden = false;
    assert.equal(h.fire(h.win, "keydown", "Escape").defaultPrevented, false);
    assert.deepEqual(h.calls, ["before", "composer:true", "between", "ghost", "after"]);
    h.calls.length = 0;
    h.fire(h.win, "keydown", "Escape");
    assert.deepEqual(h.calls, ["before", "composer:true", "between", "writer", "after"]);
    h.calls.length = 0; h.state.writer = false;
    h.fire(h.win, "keydown", "Escape");
    assert.deepEqual(h.calls, ["before", "composer:true", "between", "after"]);
    h.calls.length = 0; h.state.writer = true;
    h.fire(h.win, "keydown", "Enter");
    assert.deepEqual(h.calls, ["before", "between", "after"]);
  } finally { owner.dispose(); h.win.close(); }
});

test("overlay: every row acts once after remount and retained handlers stop at disposal", () => {
  const h = harness();
  const prior = h.mount();
  prior.dispose();
  const owner = h.mount();
  try {
    h.state.writer = true; h.el("comments-panel").hidden = false;
    h.fire(h.el("outside"), "mousedown");
    h.fire(h.el("toolbar-button"), "mousedown");
    h.fire(h.win, "keydown", "Escape");
    h.fire(h.el("writer-button"), "mousedown");
    h.fire(h.el("outside"), "focusin");
    assert.deepEqual(h.calls, ["close-menus", "close-menus", "comments", "writer", "close-menus", "focus:first"]);
    owner.dispose(); h.calls.length = 0;
    for (const r of h.records) {
      for (const entry of r.held) {
        assert.equal(typeof entry.fn, "function");
        const event = new h.win.KeyboardEvent(entry.key.split("/")[0] as string, { key: "Escape" });
        Object.defineProperty(event, "target", { value: h.el("outside") });
        (entry.fn as EventListener)(event);
      }
    }
    assert.deepEqual(h.calls, []);
    h.fire(h.win, "keydown", "Escape"); h.fire(h.el("outside"), "mousedown"); h.fire(h.el("outside"), "focusin");
    assert.deepEqual(h.calls, []);
  } finally { owner.dispose(); h.win.close(); }
});

test("overlay: disposal removes every listener newest first and silences retained callbacks", () => {
  const h = harness();
  const added: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject | null; options: boolean | AddEventListenerOptions | undefined }[] = [];
  const removed: typeof added = [];
  for (const target of [h.doc, h.win, h.el("toolbar"), h.el("writer-bar")]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void => {
      added.push({ target, type, fn, options });
      assert.ok(fn);
      add(type, fn, options);
    };
    target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void => {
      removed.push({ target, type, fn, options });
      assert.ok(fn);
      remove(type, fn, options);
    };
  }
  const owner = h.mount();
  try {
    assert.equal(added.length, 6);
    assert.deepEqual(added.filter((entry) => entry.options === true).map((entry) => [entry.target, entry.type]), [[h.doc, "mousedown"]]);
    owner.dispose();
    owner.dispose();
    assert.equal(removed.length, 6);
    assert.deepEqual(removed, [...added].reverse());
    h.calls.length = 0;
    for (const entry of added) {
      assert.equal(typeof entry.fn, "function");
      (entry.fn as EventListener)(new h.win.Event(entry.type));
    }
    assert.deepEqual(h.calls, []);
  } finally { owner.dispose(); h.win.close(); }
});

test("overlay: detached targets keep their open-only behavior until disposal", () => {
  const h = harness();
  const owner = h.mount();
  const button = h.el("toolbar-button");
  h.el("toolbar").remove();
  try {
    assert.equal(h.fire(button, "mousedown").defaultPrevented, true);
    owner.dispose();
    assert.equal(h.fire(button, "mousedown").defaultPrevented, false);
  } finally { owner.dispose(); h.win.close(); }
});
