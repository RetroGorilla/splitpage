import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../application/actions.ts";
import type { Blocker, ScreenState } from "../../application/screen.ts";
import { fileMenuExportActions } from "./actions.ts";
import type { ExportAgainState, FileMenuExportControls } from "./ports.ts";

test("export actions follow the mounted controls, keep their keys and close the menu before opening", () => {
  const calls: string[] = [];
  const screen: Record<Blocker, boolean> = {
    loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false
  };
  let state: ExportAgainState = { label: "Export again as PDF", hidden: false, disabled: false, reason: "" };
  let current: FileMenuExportControls | null = null;
  const controls: FileMenuExportControls = {
    openExportDialog: () => { calls.push("open"); return true; },
    exportAgain: () => { calls.push("again"); },
    exportAgainItemState: () => state
  };
  const registry = createActionRegistry();
  const stop = registerAll(registry, fileMenuExportActions(() => current, {
    screen: (): ScreenState => screen,
    closeMenu: () => { calls.push("close"); }
  }));
  assert.deepEqual(registry.list().map((action) => ({ id: action.id, group: action.group })), [
    { id: "export", group: "File" },
    { id: "export-again", group: "Export" }
  ]);
  assert.equal(registry.view("export")?.enabled, false);
  assert.equal(registry.view("export-again")?.enabled, false);
  current = controls;
  assert.deepEqual(registry.view("export")?.keys, ["mod+e"]);
  registry.invoke("export", "shortcut");
  assert.deepEqual(calls, ["close", "open"]);
  assert.equal(registry.view("export-again")?.label, state.label);
  assert.equal(registry.view("export-again")?.visible, false);
  registry.invoke("export-again", "button");
  assert.deepEqual(calls, ["close", "open", "again"]);
  for (const blocker of Object.keys(screen) as Blocker[]) {
    screen[blocker] = true;
    assert.equal(registry.view("export")?.enabled, false, blocker);
    screen[blocker] = false;
  }
  state = { ...state, disabled: true, reason: "Nothing tagged yet" };
  assert.equal(registry.view("export-again", "button")?.reason, state.reason);
  assert.equal(registry.view("export-again", "native-menu")?.reason, "");
  screen.loading = true;
  assert.equal(registry.view("export-again")?.reason, "Still loading…");
  screen.loading = false;
  current = null;
  registry.invoke("export", "shortcut");
  registry.invoke("export-again", "button");
  assert.deepEqual(calls, ["close", "open", "again"]);
  stop();
  assert.deepEqual(registry.list(), []);
});
