import { test } from "node:test";
import assert from "node:assert/strict";
import { mountMediaRoutes } from "../../../src/features/media/routes.ts";
import type { MediaRoutes } from "../../../src/features/media/routes.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML = '<input type="file" id="file-input">' +
    '<div id="rows">' +
    '<button data-action="image-add" data-id="r1"><span id="inner">Add picture</span></button>' +
    '<button data-action="image-add-more" data-id="r2">Add</button>' +
    '<button data-action="image-replace" data-id="r2" data-slot="2">Replace</button>' +
    '<button data-action="image-remove" data-id="r2" data-slot="1">Remove</button>' +
    '<a data-action="gallery-link" data-id="r3" data-slot="0" data-key="k1" href="https://youtu.be/abc">Watch</a>' +
    '<button data-action="gallery-link-remove" data-id="r3" data-slot="0" data-key="k1">x</button>' +
    '<button data-action="gallery-open" data-id="r2" data-slot="0">tile</button>' +
    "</div>";
  const doc = win.document;
  const byId = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement;
  const at = (selector: string): Element => doc.querySelector(selector) as Element;
  return { win, doc, byId, at, input: byId("file-input") as HTMLInputElement };
}

function harness(p: ReturnType<typeof page>) {
  const state = { chosen: 0 };
  const calls: string[] = [];
  const counts = { added: 0, removed: 0 };
  const target: EventTarget = p.input;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => { counts.added++; add(type, fn, opts); };
  target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => { counts.removed++; remove(type, fn, opts); };
  const mount = (): MediaRoutes => mountMediaRoutes({
    window: p.win,
    fileInput: p.input,
    ports: {
      choose: () => { state.chosen++; },
      addPicture: (rowId, file, slot) => { calls.push("add " + rowId + " " + file.name + " " + String(slot)); },
      removePicture: (rowId, slot) => { calls.push("remove " + rowId + " " + String(slot)); },
      removeLink: (rowId, slot, key) => { calls.push("unlink " + rowId + " " + String(slot) + " " + key); },
      openLink: (rowId, slot, key) => { calls.push("open " + rowId + " " + String(slot) + " " + key); }
    }
  });
  return { state, calls, counts, mount };
}

function click(p: ReturnType<typeof page>, target: Element): MouseEvent {
  const e = new p.win.MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

function routeClick(p: ReturnType<typeof page>, routes: MediaRoutes, target: Element): { picker: boolean; link: boolean; e: MouseEvent } {
  const e = new p.win.MouseEvent("click", { bubbles: true, cancelable: true });
  let picker = false, link = false;
  const listen = (ev: Event): void => {
    picker = routes.pickerClick(ev as MouseEvent);
    if (!picker) link = routes.linkClick(ev as MouseEvent);
  };
  p.doc.addEventListener("click", listen);
  target.dispatchEvent(e);
  p.doc.removeEventListener("click", listen);
  return { picker, link, e };
}

function pick(p: ReturnType<typeof page>, name: string | null): void {
  const files = name ? [new p.win.File(["x"], name, { type: "image/png" })] : [];
  Object.defineProperty(p.input, "files", { value: files, configurable: true });
  p.input.dispatchEvent(new p.win.Event("change", { bubbles: true }));
}

test("the picker buttons set the pending scene, open the chooser, and the chosen file goes to that scene once", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(routeClick(p, routes, p.byId("inner")).picker, true, "a click inside the button counts");
  assert.equal(h.state.chosen, 1);
  pick(p, "a.png");
  assert.deepEqual(h.calls, ["add r1 a.png undefined"]);
  pick(p, "b.png");
  assert.deepEqual(h.calls, ["add r1 a.png undefined"], "nothing pending: a second change adds nothing");
});

test("Replace remembers its slot for the next file; Add more does not", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  routeClick(p, routes, p.at('[data-action="image-replace"]'));
  pick(p, "r.png");
  routeClick(p, routes, p.at('[data-action="image-add-more"]'));
  pick(p, "m.png");
  assert.deepEqual(h.calls, ["add r2 r.png 2", "add r2 m.png undefined"]);
});

test("a change with no file clears the pending scene and slot and adds nothing", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  routeClick(p, routes, p.at('[data-action="image-replace"]'));
  pick(p, null);
  assert.deepEqual(h.calls, []);
  pick(p, "late.png");
  assert.deepEqual(h.calls, [], "no scene is pending after the empty change");
  routes.pick("r9");
  pick(p, "fresh.png");
  assert.deepEqual(h.calls, ["add r9 fresh.png undefined"], "and no slot is left over");
});

test("pick opens the chooser for a scene from outside the scene's buttons, and the chosen file goes to it once", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  routes.pick("r4");
  assert.equal(h.state.chosen, 1);
  pick(p, "g.png");
  pick(p, "again.png");
  assert.deepEqual(h.calls, ["add r4 g.png undefined"]);
  routes.dispose();
  routes.pick("r5");
  assert.equal(h.state.chosen, 1, "a disposed owner opens no chooser");
});

test("Remove, link off and link open route to their ports; opening a link prevents the default", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(routeClick(p, routes, p.at('[data-action="image-remove"]')).picker, true);
  const off = routeClick(p, routes, p.at('[data-action="gallery-link-remove"]'));
  assert.deepEqual([off.picker, off.link, off.e.defaultPrevented], [false, true, false]);
  const open = routeClick(p, routes, p.at('[data-action="gallery-link"]'));
  assert.deepEqual([open.picker, open.link, open.e.defaultPrevented], [false, true, true]);
  assert.deepEqual(h.calls, ["remove r2 1", "unlink r3 0 k1", "open r3 0 k1"]);
});

test("clicks the owner does not own pass on: the gallery tile stays with its own route", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const tile = routeClick(p, routes, p.at('[data-action="gallery-open"]'));
  assert.deepEqual([tile.picker, tile.link, tile.e.defaultPrevented], [false, false, false]);
  assert.deepEqual(h.calls, []);
});

test("dispose removes the file-input listener and turns the click routes off; a remount has exactly one listener", () => {
  const p = page();
  const h = harness(p);
  const first = h.mount();
  assert.equal(h.counts.added, 1);
  routeClick(p, first, p.byId("inner"));
  first.dispose();
  first.dispose();
  assert.equal(h.counts.removed, 1, "dispose is idempotent");
  assert.equal(routeClick(p, first, p.byId("inner")).picker, false);
  assert.equal(routeClick(p, first, p.at('[data-action="gallery-link"]')).link, false);
  pick(p, "late.png");
  assert.deepEqual(h.calls, [], "a disposed owner takes no file");
  const second = h.mount();
  assert.equal(h.counts.added - h.counts.removed, 1);
  routeClick(p, second, p.byId("inner"));
  pick(p, "now.png");
  assert.deepEqual(h.calls, ["add r1 now.png undefined"], "one handler: the file is added once");
  second.dispose();
  click(p, p.byId("inner"));
});
