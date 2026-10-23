import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../../../tests/features/editing/jsdom.mjs";
import { fakeScreen } from "../../../tests/features/fakes.ts";
import { createActionRegistry, registerAll } from "../../application/actions.ts";
import { findActions } from "./actions.ts";
import type { FindControls } from "./ports.ts";

test("find retains shortcuts, overlay rules, selection and close routing", () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  const realm = globalThis as unknown as Record<string, unknown>;
  realm.document = win.document;
  realm.HTMLInputElement = win.HTMLInputElement;
  win.document.body.innerHTML = '<input id="find-input" value="needle">';
  const screen = fakeScreen();
  const registry = createActionRegistry();
  let open = false;
  let opened = 0;
  let closed = 0;
  let current: FindControls | null = null;
  const stop = registerAll(registry, findActions(() => current, { screen: screen.screen, flags: { findOpen: () => open } }));
  assert.equal(registry.invoke("find", "menu").kind, "unavailable");
  current = { openFindBar: () => { opened++; open = true; }, closeFindBar: () => { closed++; open = false; }, dispose: () => {} };
  assert.deepEqual(registry.view("find")?.keys, ["mod+f", "mod+shift+f", "mod+alt+f", "mod+alt+shift+f"]);
  assert.equal(registry.invoke("find", "menu").kind, "ran");
  const field = win.document.getElementById("find-input");
  assert.ok(field instanceof win.HTMLInputElement);
  field.setSelectionRange(0, 0);
  registry.invoke("find", "shortcut");
  assert.equal(opened, 1);
  assert.equal(field.selectionEnd, 6);
  for (const blocker of ["loading", "dialog", "tour", "prompter", "writer", "shotlist"] as const) {
    screen.state[blocker] = true;
    assert.equal(registry.invoke("find", "menu").kind, "unavailable", blocker);
    screen.state[blocker] = false;
  }
  screen.state.launcher = true;
  assert.equal(registry.invoke("find", "menu").kind, "ran");
  registry.invoke("find", "button", "close");
  assert.equal(closed, 1);
  assert.equal(open, false);
  assert.deepEqual(registry.list().map((action) => action.id), ["find"]);
  stop();
  assert.equal(registry.has("find"), false);
  win.close();
});
