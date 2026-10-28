import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import { writerActions } from "../../../src/features/writer/actions.ts";

test("Write is unavailable before mount and after stop, and each mounted owner receives its action", () => {
  document.body.innerHTML = '<button id="btn-write"></button>';
  let owner: { openWriter: () => void } | null = null;
  let first = 0;
  let second = 0;
  const registry = createActionRegistry();
  const unregister = registerAll(registry, writerActions(() => owner, { screen: () => ({ loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false }) }));
  try {
    assert.equal(registry.view("write", "command-menu")?.enabled, false);
    assert.equal(registry.invoke("write", "button").kind, "unavailable");
    owner = { openWriter: () => { first++; } };
    assert.equal(registry.view("write", "command-menu")?.enabled, true);
    assert.equal(registry.invoke("write", "button").kind, "ran");
    assert.equal(first, 1);
    owner = null;
    assert.equal(registry.view("write", "command-menu")?.enabled, false);
    assert.equal(registry.invoke("write", "button").kind, "unavailable");
    owner = { openWriter: () => { second++; } };
    assert.equal(registry.view("write", "command-menu")?.enabled, true);
    assert.equal(registry.invoke("write", "button").kind, "ran");
    assert.equal(first, 1);
    assert.equal(second, 1);
  } finally {
    unregister();
  }
});
