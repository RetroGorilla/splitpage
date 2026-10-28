import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import { startCommandMenu } from "../../../src/features/command-menu/command-menu.ts";
import { commandMenuActions } from "../../../src/features/command-menu/actions.ts";
import type { CommandMenuPorts } from "../../../src/features/command-menu/ports.ts";

function setup() {
  document.body.innerHTML = '<button id="outside">Outside</button><button id="btn-command">Commands</button>' +
    '<div id="cmdk" class="cmdk-backdrop" hidden><input id="cmdk-input"><div id="cmdk-list"></div><button id="cmdk-close">Close</button></div>';
  window.HTMLElement.prototype.scrollIntoView = () => {};
  localStorage.clear();
  const actions = createActionRegistry();
  const calls: string[] = [];
  let listing = false;
  let fileOpen = true;
  actions.register({ id: "close-file-menu", label: "Close", group: "File", availability: () => ({ enabled: true, visible: false }), run: () => { calls.push("close-file"); fileOpen = false; } });
  actions.register({ id: "test-zebra", label: "Zebra", group: "View", availability: () => ({ enabled: listing || el("cmdk").hidden === true }), run: () => { calls.push("zebra"); } });
  actions.register({ id: "test-disabled", label: "Disabled", group: "View", availability: () => ({ enabled: false, reason: "Unavailable" }), run: () => { calls.push("disabled"); } });
  const ports: CommandMenuPorts = {
    actions,
    exports: { exporters: () => [] },
    selection: createEditorSelection<Element, Range, Element>({ epoch: () => 1, order: () => [], keys: () => [] }),
    screen: {
      launcherShown: () => !el("cmdk").hidden,
      askingFromLauncher: (read) => { listing = true; try { return read(); } finally { listing = false; } }
    },
    exportActionName: (action) => action,
    exportActionReason: () => "",
    runExportAction: (action) => { calls.push(action); },
    fileMenuOpen: () => fileOpen,
    refreshFileMenu: () => { calls.push("refresh"); }
  };
  return { ports, calls, actions };
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  assert.ok(node);
  return node;
}

function key(value: string) {
  el("cmdk-input").dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}

test("command menu mounts with fake ports, lists live availability, runs commands and restores focus", () => {
  const h = setup();
  const mounted = startCommandMenu(h.ports);
  const unregister = registerAll(h.actions, commandMenuActions(() => mounted, () => ({ loading: false, dialog: false, launcher: mounted.commandMenuOpen(), tour: false, prompter: false, writer: false, shotlist: false })));
  try {
    el("outside").focus();
    el("btn-command").click();
    assert.equal(mounted.commandMenuOpen(), true);
    assert.equal(document.activeElement, el("cmdk-input"));
    assert.deepEqual(h.calls, ["close-file", "refresh"]);
    const disabled = document.querySelector<HTMLElement>('[data-cmd="test-disabled"]');
    assert.ok(disabled);
    assert.equal(disabled.getAttribute("aria-disabled"), "true");
    disabled.click();
    assert.equal(mounted.commandMenuOpen(), true);
    key("Enter");
    assert.deepEqual(h.calls, ["close-file", "refresh", "zebra"]);
    assert.equal(mounted.commandMenuOpen(), false);
    assert.equal(document.activeElement, el("outside"));
    assert.deepEqual(JSON.parse(localStorage.getItem("splitpage-recent-commands") ?? "[]"), ["test-zebra"]);
    mounted.openCommandMenu();
    key("Escape");
    assert.equal(mounted.commandMenuOpen(), false);
  } finally {
    unregister();
    mounted.dispose();
  }
});

test("dispose removes all command-menu listeners and test hook; remount installs exactly one set", () => {
  const h = setup();
  let mounted = startCommandMenu(h.ports);
  for (let round = 0; round < 2; round++) {
    mounted.openCommandMenu();
    const input = el("cmdk-input") as HTMLInputElement;
    mounted.dispose();
    mounted.dispose();
    assert.equal(el("cmdk").hidden, true);
    assert.equal(el("cmdk-list").innerHTML, "");
    assert.equal("__commandTest" in window, false);
    input.value = "zebra";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    el("btn-command").click();
    assert.equal(el("cmdk-list").innerHTML, "");
    assert.equal(el("cmdk").hidden, true);
    mounted = startCommandMenu(h.ports);
    mounted.openCommandMenu();
    const before = h.calls.filter((call) => call === "zebra").length;
    key("Enter");
    assert.equal(h.calls.filter((call) => call === "zebra").length, before + 1);
  }
  mounted.dispose();
});
