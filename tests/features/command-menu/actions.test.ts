import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import type { ActionSource } from "../../../src/application/actions.ts";
import { commandMenuActions } from "../../../src/features/command-menu/actions.ts";
import type { CommandMenuMount } from "../../../src/features/command-menu/ports.ts";
import { owned } from "../../../src/features/routing/owned.ts";
import { fakeScreen } from "../fakes.ts";

test("command-menu actions refuse an absent mount before startup and after stop, then follow a remount", () => {
  const screen = fakeScreen();
  const feature = owned<CommandMenuMount>();
  const registry = createActionRegistry();
  const unregister = registerAll(registry, commandMenuActions(feature.owner, screen.screen));
  const sources: readonly ActionSource[] = ["menu", "command-menu", "shortcut", "button", "native-menu"];
  const calls: string[] = [];
  const mount = (name: string) => feature.replace(() => {
    let open = false;
    return {
      commandMenuOpen: () => open,
      openCommandMenu: () => { open = true; calls.push(name + ":open"); return true; },
      closeCommandMenu: () => { open = false; calls.push(name + ":close"); },
      dispose: () => { calls.push(name + ":dispose"); }
    };
  });
  const assertUnavailable = () => {
    assert.equal(registry.has("command-menu"), true);
    for (const source of sources) {
      assert.equal(registry.view("command-menu", source)?.enabled, false, source);
      assert.deepEqual(registry.invoke("command-menu", source), { kind: "unavailable", id: "command-menu", reason: "" }, source);
    }
  };
  try {
    assertUnavailable();
    assert.deepEqual(calls, []);
    mount("first");
    assert.equal(registry.view("command-menu", "shortcut")?.enabled, true);
    assert.equal(registry.invoke("command-menu", "shortcut").kind, "ran");
    assert.equal(registry.invoke("command-menu", "shortcut").kind, "ran");
    assert.deepEqual(calls, ["first:open", "first:close"]);
    feature.stop();
    assertUnavailable();
    assert.deepEqual(calls, ["first:open", "first:close", "first:dispose"]);
    mount("second");
    assert.equal(registry.view("command-menu", "shortcut")?.enabled, true);
    assert.equal(registry.invoke("command-menu", "shortcut").kind, "ran");
    assert.deepEqual(calls, ["first:open", "first:close", "first:dispose", "second:open"]);
  } finally {
    feature.stop();
    unregister();
  }
});
