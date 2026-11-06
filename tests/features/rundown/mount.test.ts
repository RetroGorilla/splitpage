import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { DocumentView } from "../../../src/application/session/document-session.ts";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import { rundownMinimizeActions, rundownBeatActions } from "../../../src/features/rundown/actions.ts";
import type { RundownControls } from "../../../src/features/rundown/actions.ts";
import type { RundownPorts } from "../../../src/features/rundown/ports.ts";
import { startRundown as mountRundown, isRundownMinimized, toggleRundownMinimized } from "../../../src/features/rundown/rundown.ts";
import { fakeActions, fakeDocument, fakePreferenceChanges, fakeScreen } from "../fakes.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

function setup(initial: DocumentView | null = null) {
  document.body.innerHTML = '<div id="rows"><div class="row" data-id="r1"><div class="audio-cell"><div class="cell-editable" tabindex="0"></div></div></div></div><div id="rundown"><div class="rundown-track"><div class="rundown-blocks"></div><div class="rundown-ruler"></div></div></div><button id="menu-rundown-min"></button>';
  const stored: boolean[] = [];
  const drag: string[] = [];
  const changes = fakePreferenceChanges();
  const actions = fakeActions();
  const source = fakeDocument(initial);
  const ports: RundownPorts = {
    document: source.document,
    text: {
      cellOf: () => Object.freeze([]),
      productionReaders: {} as RundownPorts["text"]["productionReaders"],
      cacheSeal: ((value: unknown) => value) as RundownPorts["text"]["cacheSeal"]
    },
    rowDrag: { dragging: () => null, end: () => { drag.push("end"); } },
    cells: { moveRow: (rowId, targetId, after) => { drag.push(`move ${rowId} ${targetId} ${String(after)}`); } },
    actions: actions.actions,
    minimized: { rundownMin: () => false, setRundownMin: (on) => { stored.push(on); } },
    changes: changes.changes
  };
  return { stored, drag, changes, actions, source, owner: mountRundown(ports) };
}

test("rundown: the toggle runs its action and minimising stores through the preference port", () => {
  const { stored, actions, owner } = setup();
  const toggle = document.querySelector<HTMLButtonElement>(".rundown-toggle");
  assert.ok(toggle);
  toggle.click();
  assert.deepEqual(actions.calls, [{ id: "toggle-rundown-min", source: "button" }]);
  toggleRundownMinimized();
  assert.equal(isRundownMinimized(), true);
  assert.deepEqual(stored, [true]);
  assert.equal(document.getElementById("menu-rundown-min")?.getAttribute("aria-checked"), "true");
  owner.dispose();
});

test("rundown: a rundownMin change in this window follows without storing; other names and other windows are ignored", () => {
  const { stored, changes, owner } = setup();
  changes.emit({ name: "rundownMin", value: "1", elsewhere: false });
  assert.equal(isRundownMinimized(), true);
  changes.emit({ name: "clock", value: "0", elsewhere: false });
  changes.emit({ name: "rundownMin", value: "0", elsewhere: true });
  assert.equal(isRundownMinimized(), true);
  changes.emit({ name: "rundownMin", value: "0", elsewhere: false });
  assert.equal(isRundownMinimized(), false);
  assert.deepEqual(stored, []);
  owner.dispose();
});

test("rundown: going to a scene reveals it through the reveal-row action and focuses its script cell", () => {
  const { actions, owner } = setup();
  const cell = document.querySelector<HTMLElement>(".cell-editable");
  const scrolled: unknown[] = [];
  const row = document.querySelector<HTMLElement>("#rows .row");
  if (row) row.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => { scrolled.push(options); };
  owner.goToBeat("r1");
  assert.deepEqual(scrolled, [{ block: "center" }]);
  assert.deepEqual(actions.calls, [{ id: "reveal-row", source: "button", input: "r1" }]);
  assert.equal(document.activeElement, cell);
  owner.dispose();
});

test("rundown: keyboard activation keeps the existing jump and focuses the beat", () => {
  const { actions, owner } = setup();
  const button = document.createElement("button");
  button.className = "rd-block";
  button.dataset.row = "r1";
  document.querySelector(".rundown-blocks")?.append(button);
  const scrolled: unknown[] = [];
  const row = document.querySelector<HTMLElement>("#rows .row");
  assert.ok(row);
  row.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => { scrolled.push(options); };
  button.click();
  assert.deepEqual(scrolled, [{ block: "center" }]);
  assert.deepEqual(actions.calls, [{ id: "reveal-row", source: "button", input: "r1" }]);
  assert.equal(document.activeElement, row.querySelector(".cell-editable"));
  owner.dispose();
});

test("rundown: a pointer navigation focuses the beat before measuring its scroll destination", () => {
  const { owner } = setup();
  const row = document.querySelector<HTMLElement>("#rows .row");
  assert.ok(row);
  const cell = row.querySelector(".cell-editable");
  const button = document.createElement("button");
  button.className = "rd-block";
  button.dataset.row = "r1";
  document.querySelector(".rundown-blocks")?.append(button);
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
  const focusedAtMeasurement: boolean[] = [];
  row.scrollIntoView = () => { focusedAtMeasurement.push(document.activeElement === cell); };
  try {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    assert.deepEqual(focusedAtMeasurement, [true]);
  } finally {
    window.matchMedia = originalMatchMedia;
    owner.dispose();
  }
});

test("rundown: replacing the document cancels a click even when the connected target row is reused", (t) => {
  const original = migrateRows({ title: "Original", rows: [{ id: "r1", audioText: "Original beat" }] }, fakeMigration().ports);
  const replacement = migrateRows({ title: "Replacement", rows: [{ id: "r1", audioText: "Replacement beat" }] }, fakeMigration().ports);
  const { source, owner } = setup(original);
  const row = document.querySelector<HTMLElement>('#rows .row[data-id="r1"]');
  assert.ok(row);
  const button = document.createElement("button");
  button.className = "rd-block";
  button.dataset.row = "r1";
  document.querySelector(".rundown-blocks")?.append(button);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const writes: number[] = [];
  let scrollY = 100;
  const overrides = {
    scrollY: { get: () => scrollY },
    matchMedia: { value: () => ({ matches: false }) },
    requestAnimationFrame: { value: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; } },
    cancelAnimationFrame: { value: (id: number) => { frames.delete(id); } },
    scrollTo: { value: (options: ScrollToOptions) => { scrollY = options.top ?? scrollY; writes.push(scrollY); } }
  };
  for (const [name, descriptor] of Object.entries(overrides)) {
    const original = Object.getOwnPropertyDescriptor(window, name);
    Object.defineProperty(window, name, { configurable: true, ...descriptor });
    t.after(() => { if (original) Object.defineProperty(window, name, original); else Reflect.deleteProperty(window, name); });
  }
  t.mock.method(window.performance, "now", () => 1000);
  row.scrollIntoView = () => { scrollY = 1100; writes.push(scrollY); };
  function frame(now: number): void {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(now);
  }
  try {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    frame(1100);
    assert.equal(window.scrollY, 975);
    const stale = [...frames.values()][0];
    assert.ok(stale);
    source.replace(replacement);
    assert.notEqual(source.document.current(), original);
    assert.deepEqual(source.document.current()?.rows.map((beat) => beat.id), original.rows.map((beat) => beat.id));
    assert.equal(document.querySelector('#rows .row[data-id="r1"]'), row);
    assert.equal(row.isConnected, true);
    assert.equal(frames.size, 0);
    scrollY = 2378;
    const writeCount = writes.length;
    stale(1200);
    for (const now of [1120, 1160, 1200, 1300]) frame(now);
    assert.equal(writes.length, writeCount);
    assert.equal(window.scrollY, 2378);
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    frame(1200);
    assert.equal(window.scrollY, 1100);
    assert.equal(frames.size, 0);
  } finally {
    owner.dispose();
  }
});

test("rundown: dispose removes its listeners and subscriptions and reports it is no longer mounted", () => {
  const { actions, changes, source, owner } = setup();
  const toggle = document.querySelector<HTMLButtonElement>(".rundown-toggle");
  assert.equal(changes.listenerCount(), 1);
  assert.equal(source.replacedListenerCount(), 1);
  owner.dispose();
  assert.equal(owner.mounted(), false);
  assert.equal(changes.listenerCount(), 0);
  assert.equal(source.replacedListenerCount(), 0);
  toggle?.click();
  assert.deepEqual(actions.calls, []);
});

test("rundown actions: refused while the rundown is not mounted, and run on the mounted one", () => {
  let current: RundownControls | null = null;
  const ran: string[] = [];
  const registry = createActionRegistry();
  const screen = fakeScreen({ loading: true });
  registerAll(registry, [...rundownMinimizeActions(() => current, screen.screen), ...rundownBeatActions(() => current)]);
  assert.equal(registry.invoke("toggle-rundown-min", "button").kind, "unavailable");
  assert.equal(registry.invoke("go-to-scene", "button", "r1").kind, "unavailable");
  current = { minimized: () => true, toggleMinimized: () => { ran.push("toggle"); }, goToBeat: (rowId) => { ran.push("go " + String(rowId)); } };
  assert.equal(registry.view("toggle-rundown-min", "button")?.checked, true);
  assert.equal(registry.invoke("toggle-rundown-min", "menu").kind, "unavailable");
  assert.equal(registry.invoke("toggle-rundown-min", "button").kind, "ran");
  assert.equal(registry.invoke("go-to-scene", "button", "r1").kind, "ran");
  assert.equal(registry.view("go-to-scene")?.visible, false);
  assert.deepEqual(ran, ["toggle", "go r1"]);
});
