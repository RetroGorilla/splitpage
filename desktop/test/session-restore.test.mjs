import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createSessionRestore } = require("../session-restore.ts");

test("a tab restores its standalone draft before trying the persisted shared reference", () => {
  const shared = { deployment: "relay", script: "script", address: "https://relay.example" };
  const tabId = "a".repeat(32);
  const other = "b".repeat(32);
  const window = { id: "window", activeTabId: tabId, tabIds: [] };
  const persisted = {
    windows: [{ windowId: window.id, activeTabId: tabId, tabs: [
      { tabId, source: { kind: "blank" }, shared },
      { tabId: other, source: { kind: "blank" }, shared }
    ] }]
  };
  const tabs = new Map(), windowsById = new Map([[window.id, window]]);
  const held = [];
  let written;
  const restore = createSessionRestore({
    desktopState: { read: () => persisted },
    draftsList: () => [{ tabId, status: "ok" }],
    draftStore: () => ({ hold: id => held.push(id) }),
    tabs, windowsById,
    createTabWindow: () => window,
    createTab: (_window, options) => {
      const tab = { ...options, id: options.tabId };
      tabs.set(tab.id, tab);
      window.tabIds.push(tab.id);
      return tab;
    },
    activateTab: id => { window.activeTabId = id; },
    liveWindows: () => [window],
    firstWindowRecord: () => window,
    payloadForSource: () => null,
    argvFilesToOpen: [],
    restoreShared: true,
    persistShellState: () => { written = [...tabs.values()]; }
  });
  restore.restoreSessionAtLaunch();
  assert.equal(window.activeTabId, tabId);
  assert.deepEqual(held, [tabId]);
  assert.deepEqual(written.map(tab => [tab.id, tab.launchIntent.type, tab.shared]), [
    [tabId, "restore-draft", shared],
    [other, "blank", shared]
  ]);
});
