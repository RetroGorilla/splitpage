import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import type { Blocker, ScreenState } from "../../../src/application/screen.ts";
import { updateActions } from "../../../src/features/update/actions.ts";

const NOTHING: ScreenState = {
  loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false
};

test("About keeps its Help metadata and calls showAbout through the update action port", () => {
  let opened = 0;
  const registry = createActionRegistry();
  const stop = registerAll(registry, updateActions({ screen: () => NOTHING, showAbout: () => { opened++; } }));
  assert.deepEqual(registry.list(), [{
    id: "about", label: "About Splitpage", group: "Help", icon: "i-info", words: "version about",
    keys: [], enabled: true, visible: true, reason: "", checked: null
  }]);
  assert.deepEqual(registry.invoke("about", "menu"), { kind: "ran", id: "about" });
  assert.equal(opened, 1);
  stop();
  assert.deepEqual(registry.list(), []);
});

test("About reads the current screen and refuses only dialogs and tours", () => {
  let screen = NOTHING;
  let opened = 0;
  const registry = createActionRegistry();
  registerAll(registry, updateActions({ screen: () => screen, showAbout: () => { opened++; } }));
  for (const blocker of Object.keys(NOTHING) as Blocker[]) {
    screen = { ...NOTHING, [blocker]: true };
    const reason = blocker === "dialog" ? "Close the open dialog first" : blocker === "tour" ? "Finish or skip the tour first" : null;
    const before = opened;
    for (const source of ["menu", "command-menu", "shortcut", "button", "native-menu"] as const) {
      assert.deepEqual(registry.invoke("about", source), reason
        ? { kind: "unavailable", id: "about", reason }
        : { kind: "ran", id: "about" });
    }
    assert.equal(opened, before + (reason ? 0 : 5));
  }
  screen = { ...NOTHING, dialog: true, tour: true };
  assert.equal(registry.view("about")?.reason, "Close the open dialog first");
  screen = NOTHING;
  assert.deepEqual(registry.invoke("about", "menu"), { kind: "ran", id: "about" });
});
