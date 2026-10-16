import { test } from "node:test";
import assert from "node:assert/strict";
import { mountEditorToolbar } from "../../../src/features/editing/toolbar.ts";
import type { EditorToolbarRoutes } from "../../../src/features/editing/toolbar.ts";
import { jsdomWindow } from "./jsdom.mjs";

type Realm = Window & typeof globalThis;

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML = '<div class="field-wrap" id="wrap">' +
    '<div class="mini-toolbar"><button data-cmd="bold" id="bold"><b id="bold-label">B</b></button><button id="plain"></button></div>' +
    '<div class="cell-editable" id="cell" contenteditable="true"></div>' +
    '<div class="link-popover"><input id="link-input"><button data-action="link-confirm" id="link-ok"><span id="link-ok-label">Add</span></button>' +
    '<button data-action="link-cancel" id="link-cancel"></button></div>' +
    '<div class="video-popover"><input id="video-input"></div></div>' +
    '<button data-action="link-confirm" id="loose"></button><button data-cmd="bold" id="stray"></button>';
  const byId = (id: string): HTMLElement => win.document.getElementById(id) as HTMLElement;
  return { win, byId };
}

function harness(p: ReturnType<typeof page>) {
  const calls: string[] = [];
  const name = (el: Element | null): string => (el ? el.id : "none");
  const mount = (): EditorToolbarRoutes => mountEditorToolbar({
    window: p.win,
    ports: {
      command: (button) => { calls.push("command:" + name(button)); },
      confirmLink: (wrap) => { calls.push("confirm:" + name(wrap)); },
      cancelLink: (wrap) => { calls.push("cancel:" + name(wrap)); },
      format: (cell, command) => { calls.push("format:" + name(cell) + ":" + command); }
    }
  });
  return { calls, mount };
}

function click(p: ReturnType<typeof page>, routes: EditorToolbarRoutes, id: string): boolean {
  let handled = false;
  const listen = (e: Event): void => { handled = routes.click(e as MouseEvent); };
  p.win.document.addEventListener("click", listen);
  p.byId(id).dispatchEvent(new p.win.MouseEvent("click", { bubbles: true, cancelable: true }));
  p.win.document.removeEventListener("click", listen);
  return handled;
}

function key(p: ReturnType<typeof page>, id: string, init: KeyboardEventInit, route: (e: KeyboardEvent) => boolean) {
  const out = { handled: false, prevented: false, stopped: true };
  const listen = (e: Event): void => { out.handled = route(e as KeyboardEvent); out.prevented = e.defaultPrevented; };
  const outer = (): void => { out.stopped = false; };
  p.win.document.body.addEventListener("keydown", listen);
  p.win.document.addEventListener("keydown", outer);
  p.byId(id).dispatchEvent(new p.win.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init)));
  p.win.document.body.removeEventListener("keydown", listen);
  p.win.document.removeEventListener("keydown", outer);
  return out;
}

test("editor toolbar: a toolbar button runs its command with the button, from inner content too", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(click(p, routes, "bold-label"), true);
  assert.equal(click(p, routes, "plain"), false, "a toolbar button with no command is not routed");
  assert.equal(click(p, routes, "stray"), false, "a command button outside a toolbar is not routed");
  assert.deepEqual(h.calls, ["command:bold"]);
});

test("editor toolbar: the link popover's Add and Cancel route with their field wrap", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(click(p, routes, "link-ok-label"), true);
  assert.equal(click(p, routes, "link-cancel"), true);
  assert.equal(click(p, routes, "loose"), true, "a confirm outside a wrap still routes, with no wrap");
  assert.equal(click(p, routes, "cell"), false);
  assert.deepEqual(h.calls, ["confirm:wrap", "cancel:wrap", "confirm:none"]);
});

test("editor toolbar: Enter and Escape in the link box confirm and cancel; Escape stops at the popover; other keys are taken but do nothing", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.deepEqual(key(p, "link-input", { key: "Enter" }, routes.keydown), { handled: true, prevented: true, stopped: false });
  assert.deepEqual(key(p, "link-input", { key: "Escape" }, routes.keydown), { handled: true, prevented: true, stopped: true });
  assert.deepEqual(key(p, "link-input", { key: "a" }, routes.keydown), { handled: true, prevented: false, stopped: false });
  assert.deepEqual(key(p, "video-input", { key: "Enter" }, routes.keydown), { handled: false, prevented: false, stopped: false }, "the video box is not the link box");
  assert.deepEqual(key(p, "cell", { key: "Enter" }, routes.keydown), { handled: false, prevented: false, stopped: false });
  assert.deepEqual(h.calls, ["confirm:wrap", "cancel:wrap"]);
});

test("editor toolbar: Ctrl or Cmd with B, I or U formats the cell, any case; nothing else does", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const cell = p.byId("cell");
  const fmt = (init: KeyboardEventInit) => key(p, "cell", init, (e) => routes.formatKey(e, cell));
  assert.deepEqual(fmt({ key: "b", ctrlKey: true }), { handled: true, prevented: true, stopped: false });
  assert.deepEqual(fmt({ key: "I", ctrlKey: true, shiftKey: true }), { handled: true, prevented: true, stopped: false });
  assert.deepEqual(fmt({ key: "u", metaKey: true }), { handled: true, prevented: true, stopped: false });
  assert.deepEqual(fmt({ key: "b" }), { handled: false, prevented: false, stopped: false }, "no modifier, no format");
  assert.deepEqual(fmt({ key: "k", ctrlKey: true }), { handled: false, prevented: false, stopped: false });
  assert.deepEqual(fmt({ key: "constructor", ctrlKey: true }), { handled: false, prevented: false, stopped: false }, "only the map's own keys");
  assert.deepEqual(h.calls, ["format:cell:bold", "format:cell:italic", "format:cell:underline"]);
});

test("editor toolbar: dispose turns every route off and a remount routes once", () => {
  const p = page();
  const h = harness(p);
  const first = h.mount();
  first.dispose();
  first.dispose();
  assert.equal(click(p, first, "bold"), false);
  assert.equal(key(p, "link-input", { key: "Enter" }, first.keydown).handled, false);
  assert.equal(key(p, "cell", { key: "b", ctrlKey: true }, (e) => first.formatKey(e, p.byId("cell"))).handled, false);
  assert.deepEqual(h.calls, [], "nothing routes after dispose");
  const second = h.mount();
  assert.equal(click(p, second, "bold"), true);
  assert.deepEqual(h.calls, ["command:bold"], "the remount handles one click once");
  second.dispose();
});
