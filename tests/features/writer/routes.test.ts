import { test } from "node:test";
import assert from "node:assert/strict";
import { mountWriterRoutes } from "../../../src/features/writer/routes.ts";
import type { WriterRoutes } from "../../../src/features/writer/routes.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;

const ROUTED: ReadonlySet<string> = new Set(["input", "paste", "copy", "cut", "keydown", "click"]);

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML = '<div id="writer"><div class="writer-bar">' +
    '<button class="wr-fmt" data-cmd="bold" id="bold"><span id="bold-icon">B</span></button>' +
    '<button id="wr-gutter-mode">Visuals</button><button id="wr-export">Export</button><button id="wr-close">Close</button></div>' +
    '<div id="writer-doc"><div class="wr-para" id="p1" data-id="r1" data-field="audioText" contenteditable="true">One</div></div></div>';
  const byId = (id: string): HTMLElement => win.document.getElementById(id) as HTMLElement;
  return { win, byId };
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
  const calls: string[] = [];
  const shared = (name: string) => (e: Event) => { calls.push(name + ":" + e.type + ":" + (e.target as Element).id); };
  const mount = (): WriterRoutes => mountWriterRoutes({
    window: p.win,
    doc: p.byId("writer-doc"),
    bar: p.win.document.querySelector(".writer-bar") as Element,
    ports: {
      input: shared("input"),
      keydown: shared("keydown"),
      editKeydown: (e) => { calls.push("edit:" + e.key); },
      format: (btn) => { calls.push("format:" + btn.getAttribute("data-cmd")); },
      gutter: () => { calls.push("gutter"); },
      exportNarration: () => { calls.push("export"); }
    }
  });
  return { calls, mount };
}

function fire(p: ReturnType<typeof page>, id: string, type: string): void {
  const Ctor = type === "keydown" ? p.win.KeyboardEvent : type === "click" ? p.win.MouseEvent : p.win.Event;
  p.byId(id).dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, key: "Enter" } as KeyboardEventInit));
}

test("writer routes: input on the Writer reaches the shared route once; the clipboard is not the Writer's", () => {
  const p = page();
  const h = harness(p);
  h.mount();
  for (const type of ["input", "paste", "copy", "cut"]) fire(p, "p1", type);
  assert.deepEqual(h.calls, ["input:input:p1"], "paste, copy and cut belong to the clipboard owner");
});

test("writer routes: the Writer's own keydown runs in capture, before the shared bubble keydown", () => {
  const p = page();
  const h = harness(p);
  p.byId("writer-doc").addEventListener("keydown", () => { h.calls.push("earlier-capture"); }, true);
  h.mount();
  fire(p, "p1", "keydown");
  assert.deepEqual(h.calls, ["earlier-capture", "edit:Enter", "keydown:keydown:p1"],
    "a capture registered before the mount (composition) still runs first");
});

test("writer routes: a capture-phase stop on the Writer keeps the bubble route from running", () => {
  const p = page();
  const calls: string[] = [];
  mountWriterRoutes({
    window: p.win,
    doc: p.byId("writer-doc"),
    bar: p.win.document.querySelector(".writer-bar") as Element,
    ports: {
      input: () => {},
      keydown: () => { calls.push("bubble"); },
      editKeydown: (e) => { calls.push("edit"); e.stopPropagation(); },
      format: () => {}, gutter: () => {}, exportNarration: () => {}
    }
  });
  fire(p, "p1", "keydown");
  assert.deepEqual(calls, ["edit"], "Enter split and the Backspace join stop the event as before");
});

test("writer routes: the bar routes formatting first, then the gutter and the narration export", () => {
  const p = page();
  const h = harness(p);
  h.mount();
  fire(p, "bold-icon", "click");
  fire(p, "wr-gutter-mode", "click");
  fire(p, "wr-export", "click");
  fire(p, "wr-close", "click");
  assert.deepEqual(h.calls, ["format:bold", "gutter", "export"], "a click on another bar button is not the bar route's");
});

test("writer routes: dispose removes every registration, and a remount handles each event once", () => {
  const p = page();
  const doc = counted(p.byId("writer-doc"));
  const bar = counted(p.win.document.querySelector(".writer-bar") as Element);
  const h = harness(p);
  const first = h.mount();
  assert.equal(doc.added, 3);
  assert.equal(bar.added, 1);
  first.dispose();
  first.dispose();
  assert.equal(doc.removed, 3);
  assert.equal(bar.removed, 1);
  fire(p, "p1", "input");
  fire(p, "p1", "keydown");
  fire(p, "bold", "click");
  assert.deepEqual(h.calls, [], "nothing reaches a disposed owner");
  h.mount();
  fire(p, "p1", "input");
  fire(p, "p1", "keydown");
  fire(p, "bold", "click");
  assert.deepEqual(h.calls, ["input:input:p1", "edit:Enter", "keydown:keydown:p1", "format:bold"]);
});
