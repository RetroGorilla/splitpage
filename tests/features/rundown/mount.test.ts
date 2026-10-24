import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import { rundownMinimizeActions, rundownSceneActions } from "../../../src/features/rundown/actions.ts";
import type { RundownControls } from "../../../src/features/rundown/actions.ts";
import type { RundownPorts } from "../../../src/features/rundown/ports.ts";
import { __init as mountRundown, isRundownMinimized, toggleRundownMinimized } from "../../../src/features/rundown/rundown.js";
import { fakeActions, fakeDocument, fakePreferenceChanges, fakeReview, fakeScreen } from "../fakes.ts";

function setup() {
  document.body.innerHTML = '<div id="rows"><div class="row" data-id="r1"><div class="audio-cell"><div class="cell-editable" tabindex="0"></div></div></div></div><div id="rundown"><div class="rundown-track"><div class="rundown-blocks"></div><div class="rundown-ruler"></div></div></div><button id="menu-rundown-min"></button>';
  const stored: boolean[] = [];
  const drag: string[] = [];
  const changes = fakePreferenceChanges();
  const actions = fakeActions();
  const ports: RundownPorts = {
    document: fakeDocument().document,
    text: {
      cellOf: () => Object.freeze([]),
      productionReaders: {} as RundownPorts["text"]["productionReaders"],
      cacheSeal: ((value: unknown) => value) as RundownPorts["text"]["cacheSeal"]
    },
    rowDrag: { dragging: () => null, end: () => { drag.push("end"); } },
    cells: { moveRow: (rowId, targetId, after) => { drag.push(`move ${rowId} ${targetId} ${String(after)}`); } },
    review: fakeReview().review,
    actions: actions.actions,
    minimized: { rundownMin: () => false, setRundownMin: (on) => { stored.push(on); } },
    changes: changes.changes
  };
  return { stored, drag, changes, actions, owner: mountRundown(ports) };
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
  owner.goToScene("r1");
  assert.deepEqual(scrolled, [{ block: "center" }]);
  assert.deepEqual(actions.calls, [{ id: "reveal-row", source: "button", input: "r1" }]);
  assert.equal(document.activeElement, cell);
  owner.dispose();
});

test("rundown: dispose removes its listeners and preference subscription and reports it is no longer mounted", () => {
  const { actions, changes, owner } = setup();
  const toggle = document.querySelector<HTMLButtonElement>(".rundown-toggle");
  assert.equal(changes.listenerCount(), 1);
  owner.dispose();
  assert.equal(owner.mounted(), false);
  assert.equal(changes.listenerCount(), 0);
  toggle?.click();
  assert.deepEqual(actions.calls, []);
});

test("rundown actions: refused while the rundown is not mounted, and run on the mounted one", () => {
  let current: RundownControls | null = null;
  const ran: string[] = [];
  const registry = createActionRegistry();
  const screen = fakeScreen({ loading: true });
  registerAll(registry, [...rundownMinimizeActions(() => current, screen.screen), ...rundownSceneActions(() => current)]);
  assert.equal(registry.invoke("toggle-rundown-min", "button").kind, "unavailable");
  assert.equal(registry.invoke("go-to-scene", "button", "r1").kind, "unavailable");
  current = { minimized: () => true, toggleMinimized: () => { ran.push("toggle"); }, goToScene: (rowId) => { ran.push("go " + String(rowId)); } };
  assert.equal(registry.view("toggle-rundown-min", "button")?.checked, true);
  assert.equal(registry.invoke("toggle-rundown-min", "menu").kind, "unavailable");
  assert.equal(registry.invoke("toggle-rundown-min", "button").kind, "ran");
  assert.equal(registry.invoke("go-to-scene", "button", "r1").kind, "ran");
  assert.equal(registry.view("go-to-scene")?.visible, false);
  assert.deepEqual(ran, ["toggle", "go r1"]);
});
