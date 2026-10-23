import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import type { ScriptZoomPorts } from "../../../src/features/script-zoom/ports.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;
realm.requestAnimationFrame = (): number => 1;
realm.cancelAnimationFrame = (): void => {};
win.document.body.innerHTML = '<div id="root"><div id="rows"></div></div>';

const zoom = await import("../../../src/features/script-zoom/script-zoom.js");

function ports(view: { doc: boolean; prompter: boolean; writer: boolean }, ran: string[]): ScriptZoomPorts {
  return {
    hasDocument: () => view.doc,
    prompterIsOpen: () => view.prompter,
    runAction: (id, source) => { ran.push(id + ":" + source); return { kind: "ran", id: id }; },
    scriptScale: () => 1.25,
    setScriptScale: () => {},
    clearScriptScale: () => {},
    isScriptScaleKey: (key) => key === "zoom-key",
    preferenceEvent: "test:pref",
    writerOpen: () => view.writer
  };
}

function press(key: string): KeyboardEvent {
  const event = new win.KeyboardEvent("keydown", { key: key, ctrlKey: true, bubbles: true, cancelable: true });
  win.document.dispatchEvent(event);
  return event;
}

test("the script zoom reads the view and runs its shortcuts only through its ports, and stops on dispose", () => {
  const view = { doc: true, prompter: false, writer: false };
  const ran: string[] = [];
  const owner = zoom.__init(ports(view, ran));
  assert.equal(zoom.scriptScale(), 1.25);
  assert.equal(zoom.scriptViewActive(), true);
  view.prompter = true;
  assert.equal(zoom.scriptViewActive(), false);
  view.prompter = false;
  view.writer = true;
  assert.equal(zoom.scriptViewActive(), false);
  view.writer = false;
  view.doc = false;
  assert.equal(zoom.scriptViewActive(), false);
  assert.equal(press("=").defaultPrevented, true);
  press("-");
  press("0");
  assert.deepEqual(ran, ["script-zoom-in:shortcut", "script-zoom-out:shortcut", "script-zoom-reset:shortcut"]);
  owner.dispose();
  press("=");
  assert.equal(ran.length, 3);
});
