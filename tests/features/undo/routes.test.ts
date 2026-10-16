import { test } from "node:test";
import assert from "node:assert/strict";
import { mountUndoRoutes, undoGesture } from "../../../src/features/undo/routes.ts";
import type { UndoDirection, UndoHooks, UndoRoutes } from "../../../src/features/undo/routes.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;


const ROUTED: ReadonlySet<string> = new Set(["keydown", "beforeinput"]);
const MOVED_ON = "Something else has changed since — Ctrl+Z undoes one step at a time.";

interface Keys { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }

function page() {
  const win = jsdomWindow() as unknown as Realm;
  win.document.body.innerHTML = '<input id="field"><textarea id="area"></textarea><select id="pick"></select><div id="outside" tabindex="0"></div>' +
    '<div id="rows"><div class="cell-editable script" id="rows-script"></div><div class="cell-editable" id="rows-note"></div></div>' +
    '<div id="writer-doc"><div class="cell-editable script" id="writer-script"></div><div class="cell-editable" id="writer-note"></div></div>';
  const doc = win.document;
  for (const id of ["rows-script", "rows-note", "writer-script", "writer-note"]) {
    const el = doc.getElementById(id) as HTMLElement;
    el.setAttribute("contenteditable", "true");
    Object.defineProperty(el, "isContentEditable", { value: true });
  }
  const byId = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement;
  byId("rows-script").closest(".cell-editable");
  return { win, doc, byId, roots: [byId("rows"), byId("writer-doc")] };
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
  const state = { stale: false, review: false, writer: false, latest: null as unknown, installs: 0, releases: 0 };
  const replays: UndoDirection[] = [];
  const warnings: string[] = [];
  const hooks: UndoHooks[] = [];
  const after = (): void => {};
  const sent = (): boolean => true;
  const mount = (): UndoRoutes => mountUndoRoutes({
    window: p.win,
    roots: p.roots,
    ports: {
      replay: (dir) => { replays.push(dir); },
      writerStep: () => state.writer,
      stale: () => state.stale,
      reviewOnly: () => state.review,
      scriptCell: (el) => el.classList.contains("script"),
      latest: () => state.latest,
      warn: (message) => { warnings.push(message); },
      commentsAreSent: sent,
      afterReplay: after,
      install: (h) => {
        state.installs++;
        hooks.push(h);
        return () => { state.releases++; };
      }
    }
  });
  return { state, replays, warnings, hooks, after, sent, mount };
}

function keydown(p: ReturnType<typeof page>, target: EventTarget, key: string, mods: Keys = {}): KeyboardEvent {
  const e = new p.win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(e);
  return e;
}

function beforeinput(p: ReturnType<typeof page>, target: EventTarget, inputType: string): Event {
  const e = new p.win.Event("beforeinput", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "inputType", { value: inputType });
  target.dispatchEvent(e);
  return e;
}

test("the gesture reads Ctrl or Meta with Z, Shift+Z and Y, and nothing with Alt or no modifier", () => {
  const p = page();
  const gesture = (key: string, mods: Keys) => undoGesture(new p.win.KeyboardEvent("keydown", { key, ...mods }));
  assert.equal(gesture("z", { ctrlKey: true }), "undo");
  assert.equal(gesture("Z", { metaKey: true }), "undo");
  assert.equal(gesture("Z", { ctrlKey: true, shiftKey: true }), "redo");
  assert.equal(gesture("y", { ctrlKey: true }), "redo");
  assert.equal(gesture("Y", { metaKey: true }), "redo");
  assert.equal(gesture("y", { ctrlKey: true, shiftKey: true }), null);
  assert.equal(gesture("z", { ctrlKey: true, altKey: true }), null);
  assert.equal(gesture("z", {}), null);
  assert.equal(gesture("x", { ctrlKey: true }), null);
});

test("each shortcut on the page replays once in its direction and is taken from the browser", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const cases: Array<[string, Keys, UndoDirection]> = [
    ["z", { ctrlKey: true }, "undo"],
    ["Z", { ctrlKey: true, shiftKey: true }, "redo"],
    ["y", { ctrlKey: true }, "redo"],
    ["z", { metaKey: true }, "undo"]
  ];
  for (const [key, mods, dir] of cases) {
    h.replays.length = 0;
    const e = keydown(p, p.byId("outside"), key, mods);
    assert.deepEqual(h.replays, [dir], key + " " + JSON.stringify(mods));
    assert.equal(e.defaultPrevented, true);
  }
  routes.dispose();
});

test("Alt, plain keys and a gesture already handled do nothing", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const alt = keydown(p, p.byId("outside"), "z", { ctrlKey: true, altKey: true });
  const plain = keydown(p, p.byId("outside"), "z");
  const other = keydown(p, p.byId("outside"), "s", { ctrlKey: true });
  assert.equal(alt.defaultPrevented || plain.defaultPrevented || other.defaultPrevented, false);
  const handled = new p.win.KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true });
  handled.preventDefault();
  assert.equal(routes.key(handled), false);
  assert.deepEqual(h.replays, []);
  routes.dispose();
});

test("a focused field or a non-script editable owns its undo, and a focused script cell does not", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  for (const id of ["field", "area", "pick", "rows-note", "writer-note"]) {
    p.byId(id).focus();
    assert.equal(p.doc.activeElement, p.byId(id));
    const e = new p.win.KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true });
    assert.equal(routes.key(e), false, id);
    assert.equal(e.defaultPrevented, false, id);
  }
  assert.deepEqual(h.replays, []);
  p.byId("rows-script").focus();
  assert.equal(routes.key(new p.win.KeyboardEvent("keydown", { key: "y", ctrlKey: true, cancelable: true })), true);
  p.byId("writer-script").focus();
  assert.equal(routes.key(new p.win.KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true })), true);
  assert.deepEqual(h.replays, ["redo", "undo"]);
  routes.dispose();
});

test("review-only leaves the gesture to the browser and replays nothing", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  h.state.review = true;
  const e = keydown(p, p.byId("outside"), "z", { ctrlKey: true });
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(h.replays, []);
  routes.dispose();
});

test("the window route skips keys inside a root, so a root's own handler processes the gesture once", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const own = (e: Event) => { routes.key(e as KeyboardEvent); };
  p.roots.forEach((root) => { root.addEventListener("keydown", own); });
  keydown(p, p.byId("rows"), "z", { ctrlKey: true });
  keydown(p, p.byId("writer-script"), "z", { ctrlKey: true, shiftKey: true });
  assert.deepEqual(h.replays, ["undo", "redo"]);
  p.roots.forEach((root) => { root.removeEventListener("keydown", own); });
  keydown(p, p.byId("rows-note"), "z", { ctrlKey: true });
  assert.deepEqual(h.replays, ["undo", "redo"]);
  routes.dispose();
});

test("history input on a script cell in either root replays once and is cancelled; elsewhere it is left alone", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  for (const id of ["rows-script", "writer-script"]) {
    h.replays.length = 0;
    const undo = beforeinput(p, p.byId(id), "historyUndo");
    const redo = beforeinput(p, p.byId(id), "historyRedo");
    assert.deepEqual(h.replays, ["undo", "redo"], id);
    assert.equal(undo.defaultPrevented && redo.defaultPrevented, true, id);
  }
  h.replays.length = 0;
  const note = beforeinput(p, p.byId("rows-note"), "historyUndo");
  const typed = beforeinput(p, p.byId("writer-script"), "insertText");
  const root = beforeinput(p, p.byId("rows"), "historyUndo");
  assert.equal(note.defaultPrevented || typed.defaultPrevented || root.defaultPrevented, false);
  assert.deepEqual(h.replays, []);
  routes.dispose();
});

test("a stale screen replays nothing, and a Writer step takes the gesture before the document", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  h.state.stale = true;
  routes.step("undo");
  assert.equal(keydown(p, p.byId("outside"), "z", { ctrlKey: true }).defaultPrevented, true);
  beforeinput(p, p.byId("rows-script"), "historyRedo");
  assert.deepEqual(h.replays, []);
  h.state.stale = false;
  h.state.writer = true;
  routes.step("redo");
  keydown(p, p.byId("outside"), "z", { ctrlKey: true });
  assert.deepEqual(h.replays, []);
  h.state.writer = false;
  routes.step("redo");
  assert.deepEqual(h.replays, ["redo"]);
  routes.dispose();
});

test("the toast's Undo replays only while its entry is the latest, and warns once anything else has changed", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  const entry = {};
  h.state.latest = entry;
  routes.undoIfLatest(entry);
  assert.deepEqual(h.replays, ["undo"]);
  assert.deepEqual(h.warnings, []);
  h.state.latest = {};
  routes.undoIfLatest(entry);
  assert.deepEqual(h.replays, ["undo"]);
  assert.deepEqual(h.warnings, [MOVED_ON]);
  h.state.latest = entry;
  (h.hooks[0] as UndoHooks).onRefused("a scene was removed", "undo");
  h.state.latest = null;
  routes.undoIfLatest(entry);
  assert.deepEqual(h.replays, ["undo"]);
  assert.deepEqual(h.warnings, [MOVED_ON, "Could not undo — a scene was removed.", MOVED_ON]);
  routes.dispose();
});

test("the installed hooks pass the ports through and word a refusal exactly", () => {
  const p = page();
  const h = harness(p);
  const routes = h.mount();
  assert.equal(h.state.installs, 1);
  const hooks = h.hooks[0] as UndoHooks;
  assert.equal(hooks.afterApply, h.after);
  assert.equal(hooks.commentsAreSent, h.sent);
  hooks.onRefused(undefined, "redo");
  hooks.onRefused("", "undo");
  hooks.onRefused("the scene is locked", "undo");
  assert.deepEqual(h.warnings, [
    "Could not redo — the document has changed since.",
    "Could not undo — the document has changed since.",
    "Could not undo — the scene is locked."
  ]);
  routes.dispose();
});

test("dispose removes every listener and releases once; a remount replays exactly once per gesture", () => {
  const p = page();
  const tallies = [counted(p.win), ...p.roots.map(counted)];
  const h = harness(p);
  const first = h.mount();
  assert.deepEqual(tallies.map((t) => t.added), [1, 1, 1]);
  first.dispose();
  first.dispose();
  assert.deepEqual(tallies.map((t) => t.removed), [1, 1, 1]);
  assert.equal(h.state.releases, 1);

  keydown(p, p.byId("outside"), "z", { ctrlKey: true });
  beforeinput(p, p.byId("rows-script"), "historyUndo");
  first.step("undo");
  first.undoIfLatest(h.state.latest);
  assert.equal(first.key(new p.win.KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true })), false);
  assert.deepEqual(h.replays, []);
  assert.deepEqual(h.warnings, []);

  const second = h.mount();
  assert.equal(h.state.installs, 2);
  keydown(p, p.byId("outside"), "z", { ctrlKey: true });
  beforeinput(p, p.byId("writer-script"), "historyRedo");
  assert.deepEqual(h.replays, ["undo", "redo"]);
  second.dispose();
  assert.deepEqual(tallies.map((t) => t.added - t.removed), [0, 0, 0]);
  assert.equal(h.state.releases, 2);
});
