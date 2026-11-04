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
      '<button data-action="delete-row" data-id="' + id + '"></button>' +
      '<button class="status-btn" data-action="cycle-status" data-id="' + id + '" id="status-' + id + '"><i id="status-dot-' + id + '"></i></button></div>').join("") +
    '<button class="hidden-shot-strip" data-action="expand-hidden-shot" data-ids="r4,r5" id="strip-btn"><span id="strip-label"></span></button>' +
    '</div><div id="panel"><button data-action="jump-row" data-row="r2" id="jump-r2"><span id="jump-label"></span></button>' +
    '<button data-action="jump-row" data-row="gone" id="jump-gone"></button>' +
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

function harness(p: ReturnType<typeof page>, mac = false) {
  const state = { dragging: null as string | null };
  const calls: string[] = [];
  const mount = (): RowRoutes => mountRowRoutes({
    window: p.win,
    rows: p.byId("rows"),
    ports: {
      mac,
      scriptCell: (cell) => cell.classList.contains("script"),
      openLink: (href) => { calls.push("open:" + href); },
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
      armDelete: (btn, id) => { calls.push("arm:" + id + ":" + btn.getAttribute("data-action")); },
      cycleStatus: (id) => { calls.push("status:" + id); },
      expandHidden: (ids) => { calls.push("expand:" + ids); },
      reveal: (id) => { calls.push("reveal:" + id); },
      gone: () => { calls.push("gone"); }
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

function beatClick(routes: RowRoutes, win: Realm, target: Element): boolean {
  let handled = false;
  target.addEventListener("click", function once(ev) {
    target.removeEventListener("click", once);
    handled = routes.beatClick(ev as MouseEvent);
  });
  target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  return handled;
}

test("row routes: a scene's status button cycles that scene's status, from inner content too", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(beatClick(routes, p.win, p.byId("status-r1")), true);
  assert.equal(beatClick(routes, p.win, p.byId("status-dot-r3")), true);
  assert.equal(beatClick(routes, p.win, p.byId("other")), false);
  assert.deepEqual(h.calls, ["status:r1", "status:r3"]);
  routes.dispose();
});

test("row routes: a hidden-shot strip expands its scenes", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(beatClick(routes, p.win, p.byId("strip-label")), true);
  assert.deepEqual(h.calls, ["expand:r4,r5"]);
  routes.dispose();
});

test("row routes: jump to scene reveals it, scrolls it to the centre and flashes it; a scene that is gone says so", () => {
  const p = page();
  const h = harness(p);
  const scrolled: unknown[] = [];
  p.win.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, opts?: boolean | ScrollIntoViewOptions) {
    scrolled.push([this.getAttribute("data-id"), opts]);
  };
  const routes = h.mount();
  p.row("r2").classList.add("just-merged");
  assert.equal(beatClick(routes, p.win, p.byId("jump-label")), true);
  assert.deepEqual(scrolled, [["r2", { behavior: "smooth", block: "center" }]]);
  assert.ok(p.row("r2").classList.contains("just-merged"), "the flash runs again");
  assert.equal(beatClick(routes, p.win, p.byId("jump-gone")), true);
  assert.deepEqual(h.calls, ["reveal:r2", "reveal:gone", "gone"], "revealed first, then found or reported gone");
  assert.equal(scrolled.length, 1);
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
  assert.equal(beatClick(first, p.win, p.byId("status-r1")), false, "nor the scene clicks");
  const second = h.mount();
  fire(p.win, p.byId("grip-r1"), "dragstart");
  assert.deepEqual(h.calls, ["drag:r1"], "the remount handles one drag start once");
  second.dispose();
});

test("row routes: dispose during a drag ends it: the dragged scene, its markers and the auto-scroll are released", () => {
  const p = page();
  const h = harness(p);
  const first = h.mount();
  p.row("r1").setAttribute("draggable", "true");
  fire(p.win, p.byId("grip-r1"), "dragstart");
  fire(p.win, p.byId("other"), "dragover", { clientX: 5, clientY: 2 });
  first.dispose();
  assert.equal(h.state.dragging, null);
  assert.deepEqual(h.calls, ["drag:r1", "scroll:5,2", "drag:null", "clear", "stop"]);
  first.dispose();
  assert.equal(h.calls.length, 5, "a second dispose does nothing");
  const second = h.mount();
  fire(p.win, p.byId("other"), "dragover", { clientX: 5, clientY: 2 });
  assert.equal(h.calls.length, 5, "the remount inherits no drag, so an edge dragover does not scroll");
  second.dispose();
});

function linkPage() {
  const p = page();
  p.byId("rows").insertAdjacentHTML("beforeend",
    '<div class="row" data-id="r9"><div class="cell-editable script" id="script">' +
    '<a href="https://example.com/a" id="web">a <b id="inner">link</b></a><a href="mailto:crew@example.com" id="mail">mail</a>' +
    '<a href="javascript:alert(1)" id="js">js</a><a href="file:///C:/win.ini" id="file">file</a><a href="data:text/html,hi" id="data">data</a>' +
    '<a id="bare">no address</a><span id="plain">words</span></div>' +
    '<div class="cell-editable" id="draft"><a href="https://example.com/draft" id="draft-link">draft</a></div></div>');
  return p;
}

function press(routes: RowRoutes, win: Realm, target: Element, init: Record<string, unknown>): { down: boolean; click: boolean; downPrevented: boolean; clickPrevented: boolean } {
  const out = { down: false, click: false, downPrevented: false, clickPrevented: false };
  const down = new win.MouseEvent("mousedown", Object.assign({ bubbles: true, cancelable: true, button: 0 }, init));
  const click = new win.MouseEvent("click", Object.assign({ bubbles: true, cancelable: true, button: 0 }, init));
  target.addEventListener("mousedown", function once(ev) { target.removeEventListener("mousedown", once); out.down = routes.linkMouseDown(ev as MouseEvent); }, { once: true });
  target.addEventListener("click", function once(ev) { target.removeEventListener("click", once); out.click = routes.linkClick(ev as MouseEvent); }, { once: true });
  target.dispatchEvent(down);
  target.dispatchEvent(click);
  out.downPrevented = down.defaultPrevented;
  out.clickPrevented = click.defaultPrevented;
  return out;
}

test("row routes: Ctrl+click on a link in a script cell opens it once and moves nothing", () => {
  const p = linkPage();
  const h = harness(p);
  const routes = h.mount();
  assert.deepEqual(press(routes, p.win, p.byId("web"), { ctrlKey: true }), { down: true, click: true, downPrevented: true, clickPrevented: true });
  assert.deepEqual(press(routes, p.win, p.byId("inner"), { ctrlKey: true }), { down: true, click: true, downPrevented: true, clickPrevented: true }, "from inside the link's formatting");
  assert.deepEqual(press(routes, p.win, p.byId("mail"), { ctrlKey: true }), { down: true, click: true, downPrevented: true, clickPrevented: true });
  assert.deepEqual(h.calls, ["open:https://example.com/a", "open:https://example.com/a", "open:mailto:crew@example.com"]);
  routes.dispose();
});

test("row routes: a link press that is not Ctrl+click, or not in a script cell, is left alone", () => {
  const p = linkPage();
  const h = harness(p);
  const routes = h.mount();
  const none = { down: false, click: false, downPrevented: false, clickPrevented: false };
  assert.deepEqual(press(routes, p.win, p.byId("web"), {}), none, "a plain click places the caret");
  assert.deepEqual(press(routes, p.win, p.byId("web"), { metaKey: true }), none, "Cmd is not the key off a Mac");
  assert.deepEqual(press(routes, p.win, p.byId("web"), { ctrlKey: true, shiftKey: true }), none);
  assert.deepEqual(press(routes, p.win, p.byId("web"), { ctrlKey: true, altKey: true }), none);
  assert.deepEqual(press(routes, p.win, p.byId("web"), { ctrlKey: true, button: 2 }), none, "the right button");
  assert.deepEqual(press(routes, p.win, p.byId("plain"), { ctrlKey: true }), none, "words that are not a link are the selection's");
  assert.deepEqual(press(routes, p.win, p.byId("bare"), { ctrlKey: true }), none, "an anchor with no address is not a link");
  assert.deepEqual(press(routes, p.win, p.byId("draft-link"), { ctrlKey: true }), none, "a box that is not a script cell");
  assert.deepEqual(h.calls, []);
  routes.dispose();
});

test("row routes: Cmd+click is the key on a Mac, Ctrl+click is not", () => {
  const p = linkPage();
  const h = harness(p, true);
  const routes = h.mount();
  const none = { down: false, click: false, downPrevented: false, clickPrevented: false };
  assert.deepEqual(press(routes, p.win, p.byId("web"), { ctrlKey: true }), none);
  assert.equal(press(routes, p.win, p.byId("web"), { metaKey: true }).click, true);
  assert.deepEqual(h.calls, ["open:https://example.com/a"]);
  routes.dispose();
});

test("row routes: an address the link policy refuses is claimed, never opened", () => {
  const p = linkPage();
  const h = harness(p);
  const routes = h.mount();
  for (const id of ["js", "file", "data"]) {
    assert.deepEqual(press(routes, p.win, p.byId(id), { ctrlKey: true }), { down: true, click: true, downPrevented: true, clickPrevented: true }, id);
  }
  assert.deepEqual(h.calls, []);
  routes.dispose();
});

test("row routes: after dispose a link press routes nothing", () => {
  const p = linkPage();
  const h = harness(p);
  const routes = h.mount();
  routes.dispose();
  assert.deepEqual(press(routes, p.win, p.byId("web"), { ctrlKey: true }), { down: false, click: false, downPrevented: false, clickPrevented: false });
  assert.deepEqual(h.calls, []);
});