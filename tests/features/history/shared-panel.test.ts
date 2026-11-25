import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { createSharedHistoryPanel } from "../../../src/features/history/shared-panel.ts";
import type { SharedHistoryPreview, SharedHistorySource, SharedHistoryVersion } from "../../../src/features/history/ports.ts";
import { fakeNotices } from "../fakes.ts";

const version: SharedHistoryVersion = { id: "old", at: 1, names: ["Ada"] };
const otherVersion: SharedHistoryVersion = { id: "new", at: 2, names: ["Bea"] };
const preview: SharedHistoryPreview = {
  title: "Old version", outline: [], loadPictures: async () => {}, saveCopy: async () => true
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(fields: Partial<SharedHistorySource> = {}) {
  document.body.innerHTML = '<section id="history-panel"><div id="history-list"></div></section>';
  const list = document.querySelector<HTMLElement>("#history-list");
  assert.ok(list);
  const source: SharedHistorySource = {
    online: () => true, list: async () => [version], read: async () => preview, putBack: () => false, ...fields
  };
  let current = source;
  const panel = createSharedHistoryPanel({
    active: () => true, current: () => current, onChange: () => () => {}
  }, time => time.toISOString(), fakeNotices().notices.show, async () => {});
  list.addEventListener("click", event => { panel.click(event); });
  const click = (selector: string) => {
    const button = list.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    button.click();
    return button;
  };
  return { panel, list, click, replace: (fields: Partial<SharedHistorySource>) => { current = { ...source, ...fields }; } };
}

test("a failed relay list explains how to retry and can be reopened", async t => {
  let fail = true;
  const { panel, list } = setup({
    async list() {
      if (fail) throw new Error("relay list failure");
      return [version];
    }
  });
  t.after(panel.dispose);
  await panel.render();
  assert.match(list.querySelector('[role="status"]')?.textContent ?? "", /Could not load versions.*reopen Version history/);
  assert.equal(list.querySelector("[data-shared-version]"), null);
  fail = false;
  await panel.render();
  assert.ok(list.querySelector('[data-shared-version="old"]'));
});

test("a failed version open focuses Back to versions and returns to the list", async t => {
  const { panel, list, click } = setup({ read: async () => { throw new Error("relay read failure"); } });
  t.after(panel.dispose);
  await panel.render();
  click('[data-shared-version="old"]');
  await settle();
  assert.match(list.querySelector('[role="status"]')?.textContent ?? "", /Could not open this version/);
  const back = list.querySelector<HTMLButtonElement>('[data-shared-history="back"]');
  assert.equal(back?.textContent, "Back to versions");
  assert.equal(document.activeElement, back);
  click('[data-shared-history="back"]');
  await settle();
  assert.ok(list.querySelector('[data-shared-version="old"]'));
  assert.equal(list.querySelector('[role="status"]'), null);
});

test("shared history restores focus to the chosen version and to the panel trigger", async t => {
  const { panel, list, click } = setup({ list: async () => [version, otherVersion] });
  t.after(panel.dispose);
  const shell = list.parentElement;
  assert.ok(shell);
  shell.insertAdjacentHTML("afterbegin", '<h2 id="history-panel-title">Version history</h2><button id="history-close">Close</button>');
  const trigger = document.createElement("button");
  document.body.prepend(trigger);
  trigger.focus();
  panel.focusOnOpen(trigger, () => { shell.hidden = true; panel.close(); });
  assert.equal(shell.getAttribute("role"), "dialog");
  assert.equal(shell.hasAttribute("aria-modal"), false);
  assert.equal(document.activeElement?.id, "history-close");
  const view = document.defaultView;
  assert.ok(view);
  const key = (key: string, shiftKey = false) => document.activeElement?.dispatchEvent(
    new view.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  await panel.render();
  assert.equal(key("Tab", true), true);
  list.querySelector<HTMLElement>('[data-shared-version="new"]')?.focus();
  assert.equal(key("Tab"), true);
  click('[data-shared-version="new"]');
  await settle();
  assert.equal(document.activeElement?.textContent, preview.title);
  list.querySelector<HTMLElement>('[data-shared-history="back"]')?.focus();
  click('[data-shared-history="back"]');
  await settle();
  assert.equal(document.activeElement?.getAttribute("data-shared-version"), otherVersion.id);
  key("Escape");
  assert.equal(shell.hidden, true);
  assert.equal(document.activeElement, trigger);
});

test("a late version list cannot replace the versions for a different script", async t => {
  const held = deferred<readonly SharedHistoryVersion[]>();
  const { panel, list, replace } = setup({ list: () => held.promise });
  t.after(panel.dispose);
  const rendering = panel.render();
  replace({ list: async () => [otherVersion] });
  await panel.render();
  held.resolve([version]);
  await rendering;
  assert.ok(list.querySelector('[data-shared-version="new"]'));
  assert.equal(list.querySelector('[data-shared-version="old"]'), null);
});

for (const result of ["success", "failure"]) {
  test("a late version open " + result + " cannot repaint after the script changes", async t => {
    const held = deferred<SharedHistoryPreview>();
    const { panel, list, click, replace } = setup({ read: () => held.promise });
    t.after(panel.dispose);
    await panel.render();
    click('[data-shared-version="old"]');
    assert.equal(list.querySelector('[role="status"]')?.textContent, "Opening version…");
    replace({ list: async () => [otherVersion] });
    if (result === "success") held.resolve(preview); else held.reject(new Error("late relay read failure"));
    await settle();
    assert.equal(list.querySelector('[role="status"]')?.textContent, "Opening version…");
    assert.equal(list.querySelector(".shared-history-preview"), null);
    assert.equal(list.querySelector('[data-shared-history="back"]'), null);
    await panel.render();
    assert.ok(list.querySelector('[data-shared-version="new"]'));
  });
}
