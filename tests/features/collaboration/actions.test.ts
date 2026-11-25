import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionRegistry } from "../../../src/application/actions.ts";
import { shareScriptAction } from "../../../src/features/collaboration/actions.ts";

test("the share action opens only for an eligible standalone document outside a modal", () => {
  const registry = createActionRegistry();
  const screen = { loading: false, dialog: false, tour: false, launcher: false, prompter: false, writer: false, shotlist: false };
  let visible = false, opened = 0;
  registry.register(shareScriptAction({ screen: () => screen, visible: () => visible, open: () => { opened++; } }));
  assert.equal(registry.view("share-script")?.visible, false);
  assert.equal(registry.invoke("share-script", "menu").kind, "unavailable");
  visible = true;
  screen.dialog = true;
  assert.equal(registry.invoke("share-script", "command-menu").kind, "unavailable");
  screen.dialog = false;
  assert.equal(registry.view("share-script")?.label, "Share this script…");
  assert.equal(registry.invoke("share-script", "command-menu").kind, "ran");
  assert.equal(opened, 1);
});
