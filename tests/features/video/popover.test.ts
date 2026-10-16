import { test } from "node:test";
import assert from "node:assert/strict";
import { mountVideoPopover } from "../../../src/features/video/popover.ts";
import type { VideoPopoverRoutes } from "../../../src/features/video/popover.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML = '<div class="field-wrap" id="wrap">' +
    '<div class="link-popover"><input id="link-input"><button data-action="link-confirm" id="link-ok"></button></div>' +
    '<div class="video-popover"><input id="video-input"><button data-action="video-confirm" id="ok"><span id="ok-label">Add</span></button>' +
    '<button data-action="video-cancel" id="cancel"></button></div></div><button data-action="video-confirm" id="loose"></button>';
  const byId = (id: string): HTMLElement => win.document.getElementById(id) as HTMLElement;
  return { win, byId };
}

function harness(p: ReturnType<typeof page>) {
  const calls: string[] = [];
  const name = (wrap: Element | null): string => (wrap ? wrap.id : "none");
  const mount = (): VideoPopoverRoutes => mountVideoPopover({
    window: p.win,
    ports: {
      confirm: (wrap) => { calls.push("confirm:" + name(wrap)); },
      cancel: (wrap) => { calls.push("cancel:" + name(wrap)); }
    }
  });
  return { calls, mount };
}

function click(p: ReturnType<typeof page>, routes: VideoPopoverRoutes, id: string): boolean {
  let handled = false;
  const target = p.byId(id);
  const listen = (e: Event): void => { handled = routes.click(e as MouseEvent); };
  p.win.document.addEventListener("click", listen);
  target.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true, cancelable: true }));
  p.win.document.removeEventListener("click", listen);
  return handled;
}

function key(p: ReturnType<typeof page>, routes: VideoPopoverRoutes, id: string, k: string) {
  const out = { handled: false, prevented: false, stopped: false };
  const target = p.byId(id);
  const listen = (e: Event): void => { out.handled = routes.keydown(e as KeyboardEvent); out.prevented = e.defaultPrevented; };
  const outer = (): void => { out.stopped = false; };
  p.win.document.body.addEventListener("keydown", listen);
  p.win.document.addEventListener("keydown", outer);
  out.stopped = true;
  target.dispatchEvent(new p.win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  p.win.document.body.removeEventListener("keydown", listen);
  p.win.document.removeEventListener("keydown", outer);
  return out;
}

test("video popover: Add and Cancel route to the owner with their field wrap, including clicks on inner content", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(click(p, routes, "ok"), true);
  assert.equal(click(p, routes, "ok-label"), true);
  assert.equal(click(p, routes, "cancel"), true);
  assert.equal(click(p, routes, "loose"), true, "a confirm outside any field wrap still routes, with no wrap");
  assert.deepEqual(h.calls, ["confirm:wrap", "confirm:wrap", "cancel:wrap", "confirm:none"]);
});

test("video popover: clicks on anything else are left to the shared route", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(click(p, routes, "link-ok"), false);
  assert.equal(click(p, routes, "video-input"), false);
  assert.deepEqual(h.calls, []);
});

test("video popover: Enter confirms and Escape cancels without reaching outer handlers; other keys are kept in the input", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const enter = key(p, routes, "video-input", "Enter");
  assert.deepEqual([enter.handled, enter.prevented], [true, true]);
  const esc = key(p, routes, "video-input", "Escape");
  assert.deepEqual([esc.handled, esc.prevented, esc.stopped], [true, true, true], "Escape stops at the popover, so the modal stays open");
  const typed = key(p, routes, "video-input", "a");
  assert.deepEqual([typed.handled, typed.prevented], [true, false], "typing in the input is the input's, not the editor's");
  assert.deepEqual(h.calls, ["confirm:wrap", "cancel:wrap"]);
});

test("video popover: keys outside the video input are not its", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const out = key(p, routes, "link-input", "Enter");
  assert.deepEqual([out.handled, out.prevented], [false, false]);
  assert.deepEqual(h.calls, []);
});

test("video popover: after dispose nothing routes, and a fresh mount routes once", () => {
  const p = page();
  const h = harness(p);
  const first = h.mount();
  first.dispose();
  first.dispose();
  assert.equal(click(p, first, "ok"), false);
  assert.equal(key(p, first, "video-input", "Enter").handled, false);
  assert.deepEqual(h.calls, []);
  const second = h.mount();
  assert.equal(click(p, second, "ok"), true);
  assert.deepEqual(h.calls, ["confirm:wrap"]);
});
