import { test } from "node:test";
import assert from "node:assert/strict";
import { mountRowRoutes } from "../../../src/features/rows/routes.ts";
import type { RowRoutes } from "../../../src/features/rows/routes.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;

const ROUTED: ReadonlySet<string> = new Set(["dragstart", "dragend", "mouseup", "dragover"]);

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML = '<div id="rundown"><span id="strip"></span></div><div id="rows">' +
    ["r1", "r2", "r3"].map((id) => '<div class="row" data-id="' + id + '"><span class="grip" id="grip-' + id + '"></span>' +
      '<button data-action="row-menu" data-id="' + id + '"></button><button data-action="move-up" data-id="' + id + '"></button>' +
      '<button data-action="move-down" data-id="' + id + '"></button><button data-action="insert-below" data-id="' + id + '"></button>' +
      '<button data-action="delete-row" data-id="' + id + '"></button></div>').join("") +
    '</div><div class="add-row-bar"><button data-action="add-row" id="add"></button></div><div id="other"></div>';
  const byId = (id: string): HTMLElement => win.document.getElementById(id) as HTMLElement;
  const row = (id: string): HTMLElement => win.document.querySelector('.row[data-id="' + id + '"]') as HTMLElement;
  return { win, doc: win.document, byId, row };
}

function counted(target: EventTarget) {
  const tally = { added: 0, removed: 0 };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => { if (ROUTED.has(type)) tally.added++; add(type, fn, opts); };
  target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => { if (ROUTED.has(type)) tally.removed++; remove(type, fn, opts); };
  return tally;
}

function harness(p: ReturnType<typeof page>) {
  const state = { dragging: null as string | null };
  const calls: string[] = [];
  const mount = (): RowRoutes => mountRowRoutes({
    window: p.win,
    rows: p.byId("rows"),
    ports: {
      dragging: () => state.dragging,
      setDragging: (id) => { state.dragging = id; calls.push("drag:" + id); },
      clearMarkers: () => { calls.push("clear"); },
      markDrop: (row, y) => { calls.push("mark:" + row.getAttribute("data-id") + "@" + y); },
      scroll: (x, y) => { calls.push("scroll:" + x + "," + y); },
      stopScroll: () => { calls.push("stop"); },
      move: (id, target, after) => { calls.push("move:" + id + ">" + target + (after ? ":after" : ":before")); },
      add: (afterId) => { calls.push("add:" + afterId); },
      moveBy: (id, dir) => { calls.push("moveBy:" + id + ":" + dir); },
      toggleMenu: (btn, first) => { calls.push("menu:" + btn.getAttribute("data-id") + ":" + first); },
      armDelete: (btn, id) => { calls.push("arm:" + id + ":" + btn.getAttribute("data-action")); }
    }
  });
  return { state, calls, mount };
}

function fire(win: Realm, target: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
  const e = new win.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init));
  target.dispatchEvent(e);
  return e;
}

function routedClick(routes: RowRoutes, win: Realm, target: Element, detail = 1): { add: boolean; menu: boolean } {
  const e = new win.MouseEvent("click", { bubbles: true, cancelable: true, detail: detail });
  let result = { add: false, menu: false };
  target.addEventListener("click", function once(ev) {
    target.removeEventListener("click", once);
    result = { add: routes.addClick(ev as MouseEvent), menu: routes.menuClick(ev as MouseEvent) };
  });
  target.dispatchEvent(e);
  return result;
}

test("row routes: a drag starts only from a scene armed for dragging, and dragend clears it", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  fire(p.win, p.byId("grip-r1"), "dragstart");
  assert.deepEqual(h.calls, [], "a scene not armed by its grip does not drag");
  p.row("r1").setAttribute("draggable", "true");
  fire(p.win, p.byId("grip-r1"), "dragstart");
  assert.equal(h.state.dragging, "r1");
  assert.ok(p.row("r1").classList.contains("is-dragging"));
  fire(p.win, p.byId("rows"), "dragend");
  assert.equal(h.state.dragging, null);
  assert.deepEqual(h.calls, ["drag:r1", "drag:null", "clear"]);
  routes.dispose();
});

test("row routes: the window auto-scrolls while a scene drags, and stops over an expanded rundown", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  fire(p.win, p.byId("other"), "dragover", { clientX: 5, clientY: 9 });
  assert.deepEqual(h.calls, [], "no scene dragging, no scroll");
  h.state.dragging = "r1";
  fire(p.win, p.byId("other"), "dragover", { clientX: 5, clientY: 9 });
  fire(p.win, p.byId("strip"), "dragover", { clientX: 5, clientY: 9 });
  p.byId("rundown").classList.add("is-min");
  fire(p.win, p.byId("strip"), "dragover", { clientX: 6, clientY: 7 });
  assert.deepEqual(h.calls, ["scroll:5,9", "stop", "scroll:6,7"]);
  routes.dispose();
});

test("row routes: a mouseup with no scene dragging clears stale markers", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  fire(p.win, p.byId("other"), "mouseup");
  h.state.dragging = "r2";
  fire(p.win, p.byId("other"), "mouseup");
  assert.deepEqual(h.calls, ["clear"]);
  routes.dispose();
});

test("row routes: the shared dragover and drop take the scene-move route only while a scene drags", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const over = () => new p.win.MouseEvent("dragover", { bubbles: true, cancelable: true, clientY: 40 });
  const run = (target: Element, make: () => Event, route: (e: DragEvent) => boolean): { handled: boolean; prevented: boolean } => {
    let out = { handled: false, prevented: false };
    target.addEventListener(make().type, function once(ev) {
      target.removeEventListener(make().type, once);
      out = { handled: route(ev as DragEvent), prevented: false };
    });
    const e = make();
    target.dispatchEvent(e);
    out.prevented = e.defaultPrevented;
    return out;
  };
  assert.deepEqual(run(p.row("r2"), over, routes.dragOver), { handled: false, prevented: false }, "no scene dragging: falls through");
  h.state.dragging = "r1";
  assert.deepEqual(run(p.row("r1"), over, routes.dragOver), { handled: true, prevented: false }, "over itself: handled, no marker");
  assert.deepEqual(run(p.row("r3"), over, routes.dragOver), { handled: true, prevented: true });
  assert.deepEqual(run(p.byId("other"), over, routes.dragOver), { handled: true, prevented: false }, "outside a scene: handled, nothing marked");
  p.row("r3").classList.add("drop-after");
  const drop = () => new p.win.MouseEvent("drop", { bubbles: true, cancelable: true });
  assert.deepEqual(run(p.row("r3"), drop, routes.drop), { handled: true, prevented: true });
  assert.deepEqual(h.calls.filter((c) => !c.startsWith("scroll:")), ["mark:r3@40", "drag:null", "clear", "move:r1>r3:after"]);
  assert.deepEqual(run(p.row("r2"), drop, routes.drop), { handled: false, prevented: false }, "after the drop nothing drags");
  routes.dispose();
});

test("row routes: add-row and the scene menu commands route by action", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const q = (id: string, action: string) => p.row(id).querySelector('[data-action="' + action + '"]') as Element;
  assert.deepEqual(routedClick(routes, p.win, p.byId("add")), { add: true, menu: false });
  assert.deepEqual(routedClick(routes, p.win, q("r2", "row-menu"), 0), { add: false, menu: true });
  assert.deepEqual(routedClick(routes, p.win, q("r2", "move-up")), { add: false, menu: true });
  assert.deepEqual(routedClick(routes, p.win, q("r2", "move-down")), { add: false, menu: true });
  assert.deepEqual(routedClick(routes, p.win, q("r2", "insert-below")), { add: false, menu: true });
  assert.deepEqual(routedClick(routes, p.win, q("r3", "delete-row")), { add: false, menu: true });
  assert.deepEqual(routedClick(routes, p.win, p.byId("other")), { add: false, menu: false });
  assert.deepEqual(h.calls, ["add:null", "menu:r2:true", "moveBy:r2:-1", "moveBy:r2:1", "add:r2", "arm:r3:delete-row"]);
  routes.dispose();
});

test("row routes: dispose removes every registration it made and stops the routes; a remount has one of each", () => {
  const p = page();
  const rowsTally = counted(p.byId("rows"));
  const docTally = counted(p.doc);
  const winTally = counted(p.win);
  const h = harness(p);
  const first = h.mount();
  assert.deepEqual([rowsTally.added, docTally.added, winTally.added], [2, 1, 1]);
  first.dispose();
  first.dispose();
  assert.deepEqual([rowsTally.removed, docTally.removed, winTally.removed], [2, 1, 1], "symmetric, and a second dispose does nothing");
  p.row("r1").setAttribute("draggable", "true");
  h.state.dragging = null;
  fire(p.win, p.byId("grip-r1"), "dragstart");
  fire(p.win, p.byId("other"), "mouseup");
  assert.deepEqual(h.calls, [], "nothing reacts after dispose");
  assert.deepEqual(routedClick(first, p.win, p.byId("add")), { add: false, menu: false }, "a disposed owner routes nothing");
  const second = h.mount();
  fire(p.win, p.byId("grip-r1"), "dragstart");
  assert.deepEqual(h.calls, ["drag:r1"], "the remount handles one drag start once");
  second.dispose();
});
