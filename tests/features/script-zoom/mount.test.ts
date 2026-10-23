import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import { scriptZoomActions } from "../../../src/features/script-zoom/actions.ts";
import type { ScriptZoomPorts } from "../../../src/features/script-zoom/ports.ts";
import { fakeActions, fakePreferences, fakeScreen } from "../fakes.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;
const frames = new Map<number, FrameRequestCallback>();
let serial = 0;
realm.requestAnimationFrame = (run: FrameRequestCallback): number => {
  const id = ++serial;
  frames.set(id, run);
  return id;
};
realm.cancelAnimationFrame = (id: number): void => { frames.delete(id); };
win.document.elementFromPoint = () => null;
win.document.body.innerHTML = '<div id="root"><div id="rows"></div></div>';

const zoom = await import("../../../src/features/script-zoom/script-zoom.js");

function ports() {
  const view = fakeScreen();
  const runner = fakeActions();
  const preferences = fakePreferences(1.25);
  const given: ScriptZoomPorts = {
    screen: view.screen,
    actions: runner.actions,
    scale: preferences.preferences,
    changes: preferences.changes
  };
  return { given, view: view.state, runner, preferences };
}

function finishFrames(): void {
  for (let i = 0; frames.size && i < 100; i++) {
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run(0);
  }
  assert.equal(frames.size, 0);
}

function press(key: string): KeyboardEvent {
  const event = new win.KeyboardEvent("keydown", { key: key, ctrlKey: true, bubbles: true, cancelable: true });
  win.document.dispatchEvent(event);
  return event;
}

test("the script zoom reads the view and runs its shortcuts only through its ports, and stops on dispose", () => {
  const { given, view, runner } = ports();
  const owner = zoom.__init(given);
  assert.equal(zoom.scriptScale(), 1.25);
  assert.equal(zoom.scriptViewActive(), true);
  view.prompter = true;
  assert.equal(zoom.scriptViewActive(), false);
  view.prompter = false;
  view.writer = true;
  assert.equal(zoom.scriptViewActive(), false);
  view.writer = false;
  view.loading = true;
  assert.equal(zoom.scriptViewActive(), false);
  assert.equal(press("=").defaultPrevented, true);
  press("-");
  press("0");
  assert.deepEqual(runner.calls.map(({ id, source }) => id + ":" + source), ["script-zoom-in:shortcut", "script-zoom-out:shortcut", "script-zoom-reset:shortcut"]);
  owner.dispose();
  press("=");
  assert.equal(runner.calls.length, 3);
});

test("zoom follows named preference notices and reads changes elsewhere without storing them again", () => {
  const { given, preferences } = ports();
  const owner = zoom.__init(given);
  try {
    assert.equal(preferences.listenerCount(), 1);
    preferences.emit({ name: "rundownMin", value: "1", elsewhere: false });
    assert.equal(zoom.scriptScale(), 1.25);
    preferences.emit({ name: "scriptScale", value: "1.333", elsewhere: false });
    finishFrames();
    assert.equal(zoom.scriptScale(), 1.333);
    assert.equal(win.document.getElementById("root")?.style.getPropertyValue("--script-scale"), "1.333");
    preferences.changeElsewhere(1.5, "0.8");
    finishFrames();
    assert.equal(zoom.scriptScale(), 1.5);
    preferences.changeElsewhere(1, null);
    finishFrames();
    assert.equal(zoom.scriptScale(), 1);
    assert.deepEqual(preferences.writes, []);
    zoom.setScriptScale(1.333, { now: true, quiet: true });
    finishFrames();
    assert.equal(zoom.scriptScale(), 1.333);
    assert.equal(preferences.preferences.scriptScale(), 1.33);
    assert.deepEqual(preferences.writes, ["1.33"]);
    zoom.resetScriptScale();
    finishFrames();
    assert.deepEqual(preferences.writes, ["1.33", null]);
  } finally {
    owner.dispose();
  }
  assert.equal(preferences.listenerCount(), 0);
  preferences.changeElsewhere(1.75);
  assert.equal(zoom.scriptScale(), 1);
});

test("zoom disposes its subscription, animation frames and readout before a fresh mount", () => {
  const first = ports();
  const owner = zoom.__init(first.given);
  zoom.setScriptScale(1.5, { now: true });
  zoom.stepScriptScale(1);
  assert.equal(frames.size, 2);
  assert.equal(win.document.getElementById("script-zoom-readout")?.hidden, false);
  owner.dispose();
  owner.dispose();
  assert.equal(frames.size, 0);
  assert.equal(first.preferences.listenerCount(), 0);
  assert.equal(win.document.getElementById("script-zoom-readout"), null);
  const next = ports();
  const mounted = zoom.__init(next.given);
  try {
    owner.dispose();
    assert.equal(next.preferences.listenerCount(), 1);
    assert.equal(zoom.scriptScale(), 1.25);
    assert.equal(press("=").defaultPrevented, true);
    assert.deepEqual(next.runner.calls, [{ id: "script-zoom-in", source: "shortcut" }]);
  } finally {
    mounted.dispose();
  }
  assert.equal(press("=").defaultPrevented, false);
});

test("zoom action definitions refuse unmounted features and follow the current owner and screen", () => {
  const registry = createActionRegistry();
  const runner = fakeActions(registry);
  const view = fakeScreen();
  const preferences = fakePreferences();
  const holder: { current: ReturnType<typeof zoom.__init> | null } = { current: null };
  const stop = registerAll(registry, scriptZoomActions(() => holder.current));
  const mount = (): ReturnType<typeof zoom.__init> => zoom.__init({
    screen: view.screen, actions: runner.actions, scale: preferences.preferences, changes: preferences.changes
  });
  try {
    assert.equal(registry.view("script-zoom-in")?.enabled, false);
    assert.equal(registry.invoke("script-zoom-in", "native-menu").kind, "unavailable");
    holder.current = mount();
    assert.equal(registry.view("script-zoom-in")?.visible, false);
    assert.equal(press("=").defaultPrevented, true);
    finishFrames();
    assert.equal(zoom.scriptScale(), 1.1);
    for (const blocker of ["loading", "prompter", "writer"] as const) {
      view.state[blocker] = true;
      assert.equal(press("=").defaultPrevented, false);
      assert.equal(registry.invoke("script-zoom-in", "shortcut").kind, "unavailable");
      assert.equal(registry.view("script-zoom-in", "native-menu")?.enabled, true);
      view.state[blocker] = false;
    }
    win.document.documentElement.classList.add("is-newtab-open");
    assert.equal(press("=").defaultPrevented, false);
    win.document.documentElement.classList.remove("is-newtab-open");
    holder.current?.dispose();
    holder.current = null;
    assert.equal(registry.invoke("script-zoom-reset", "button").kind, "unavailable");
    holder.current = mount();
    assert.equal(registry.invoke("script-zoom-reset", "button").kind, "ran");
    finishFrames();
    assert.equal(zoom.scriptScale(), 1);
  } finally {
    holder.current?.dispose();
    stop();
    win.document.documentElement.classList.remove("is-newtab-open");
  }
});
