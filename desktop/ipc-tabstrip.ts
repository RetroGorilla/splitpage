"use strict";

import type { DesktopIpcEvent, DesktopTabStripIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";
import type { DesktopMainTab } from "./main-types.d.ts";

function createTabStripIpc({
  tabStripWindowOf, shellStateForWindow, tabs, createTab, activateTab, requestCloseTab, reorderTab,
  moveTabToWindow, tearOffToNewWindow, recents, focusShared
}: DesktopTabStripIpcDependencies) {
  function routeSharedRecent(tab: DesktopMainTab, fileId: string) {
    const entry = recents.findSharedRecent(fileId);
    if (!entry) return null;
    if (focusShared(entry)) return { where: "other-tab" } as const;
    const { deployment, script } = entry;
    const opened = createTab(tab.windowId, {
      source: { kind: "shared", deployment, script },
      launchIntent: { type: "open-shared" }
    });
    return opened ? { where: "new-tab" } as const : null;
  }

  function registerTabStripIpc({ ipcHandle, ipcOn, ipcOnSync }: Parameters<DesktopRegisterIpcGroup>[0]) {
    ipcOnSync("splitpage:tabstrip-window-id-sync", (event) => {
      const w = tabStripWindowOf(event);
      return w ? w.id : null;
    });

    ipcHandle("splitpage:tabstrip-get-state", async (event) => {
      const w = tabStripWindowOf(event);
      return w ? shellStateForWindow(w.id) : null;
    });

    const stripTab = (_event: DesktopIpcEvent, tabId: string) => tabs.get(tabId) || null;

    ipcOn("splitpage:tabstrip-new-tab", (event) => {
      const w = tabStripWindowOf(event);
      if (w) createTab(w.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
    });

    ipcOn("splitpage:tabstrip-activate", (event, tabId) => {
      const tab = stripTab(event, tabId);
      if (tab) activateTab(tab.id);
    });

    ipcOn("splitpage:tabstrip-close", (event, tabId) => {
      const tab = stripTab(event, tabId);
      if (tab) requestCloseTab(tab.id);
    });

    ipcOn("splitpage:tabstrip-reorder", (event, tabId, index) => {
      const tab = stripTab(event, tabId);
      if (tab && Number.isInteger(index)) reorderTab(tab.id, index);
    });

    ipcOn("splitpage:tabstrip-move-here", (event, tabId, dropIndex) => {
      const tab = stripTab(event, tabId);
      const w = tab ? tabStripWindowOf(event) : null;
      if (tab && w) moveTabToWindow(tab.id, w.id, Number.isInteger(dropIndex) ? dropIndex : undefined);
    });

    ipcOn("splitpage:tabstrip-tear-off", (event, tabId, screenX, screenY) => {
      const tab = stripTab(event, tabId);
      if (tab) tearOffToNewWindow(tab.id, Number(screenX), Number(screenY));
    });
  }

  return { registerTabStripIpc, routeSharedRecent };
}

export type { createTabStripIpc };

module.exports = { createTabStripIpc };
