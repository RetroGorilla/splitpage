"use strict";

import type { createDraftStore } from "./drafts.ts";

import type { DesktopIpcArgs, DesktopWireTestShellResult } from "../shared/desktop-contract.d.ts";

import type { DesktopTestModeIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";
import type { TAB_OR_WINDOW_ID_RE as DesktopStateIdPattern } from "./desktop-state.ts";

const { TAB_OR_WINDOW_ID_RE }: { TAB_OR_WINDOW_ID_RE: typeof DesktopStateIdPattern } = require("./desktop-state.ts");

type TestTargetTab = Extract<DesktopWireTestShellResult, { windows: unknown }>["windows"][number]["tabs"][number];

function createTestModeIpc({
  testMode: TEST_MODE, app, BrowserWindow, Menu, tabOf, tabs, windowsById, requestCloseTab, draftStore,
  draftsPreviousSession, chooseDuplicateLoser, shellStateForWindow, createTab, activateTab, reorderTab,
  createTabWindow, moveTabToWindow, liveWindows, testExternalOpens, testChromiumLaunches, testVideoOpens,
  prompterShare, voiceHelperInstance
}: DesktopTestModeIpcDependencies) {
  function registerTestModeIpc({ ipcHandle, ipcOn }: Parameters<DesktopRegisterIpcGroup>[0]) {
    if (TEST_MODE) {
      ipcOn("splitpage:test-request-close", (event) => {
        const tab = tabOf(event);
        const w = tab ? windowsById.get(tab.windowId) : null;
        const win = w ? w.win : BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.close();
      });

      ipcOn("splitpage:test-request-close-tab", (event) => {
        const tab = tabOf(event);
        if (tab) requestCloseTab(tab.id);
      });

      ipcOn("splitpage:test-request-quit", () => {
        app.quit();
      });

      ipcHandle("splitpage:test-draft-status", async (event, tabId) => {
        const named = typeof tabId === "string" && TAB_OR_WINDOW_ID_RE.test(tabId) ? tabs.get(tabId) : null;
        const tab = named || tabOf(event);
        const id = tab ? tab.id : null;
        if (draftStore() && id) {
          try { return (draftStore() as ReturnType<typeof createDraftStore>).status(id); } catch { }
        }
        return {
          tabId: id, hasDraft: false, held: false, lastSeq: null, tombstoned: false,
          previousSession: draftsPreviousSession(), writes: 0, failures: 0
        };
      });

      ipcOn("splitpage:test-crash-renderer", (event) => {
        event.sender.forcefullyCrashRenderer();
      });

      ipcHandle("splitpage:test-dup-loser", async (event, a, b) => {
        const claim = (c: DesktopIpcArgs<"splitpage:test-dup-loser">[0]) => ({
          docId: String((c && c.docId) || ""),
          homeKey: String((c && c.homeKey) || ""),
          seq: Number((c && c.seq) || 0)
        });
        const ca = claim(a), cb = claim(b);
        const loser = chooseDuplicateLoser(ca, cb);
        return loser === ca ? "a" : loser === cb ? "b" : null;
      });

      ipcHandle("splitpage:test-shell", async (event, op, args) => {
        const caller = tabOf(event);
        const a = args || {};
        const listTargets = () => ({
          windows: [...windowsById.values()].map((w) => ({
            windowId: w.id,
            activeTabId: w.activeTabId,
            tabs: w.tabIds.map((id) => {
              const t = tabs.get(id);
              return t ? {
                tabId: id,
                title: t.title || "",
                dirty: !!t.dirty,
                pristine: !!t.pristine,
                path: t.source.kind === "file" ? t.source.absPath : null
              } : null;
            }).filter(Boolean as BooleanConstructor & ((tab: TestTargetTab | null) => tab is TestTargetTab))
          }))
        });

        switch (op) {
          case "getShellState": {
            const w = caller ? windowsById.get(caller.windowId) : null;
            return w ? shellStateForWindow(w.id) : null;
          }
          case "createTab": {
            const w = (a.windowId && windowsById.get(a.windowId)) || (caller && windowsById.get(caller.windowId));
            if (!w) throw new Error("test-shell: no such window");
            const created = createTab(w.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
            return created ? created.id : null;
          }
          case "activateTab":
            if (!tabs.has(a.tabId)) throw new Error("test-shell: no such tab");
            activateTab(a.tabId);
            return true;
          case "closeTab":
            if (!tabs.has(a.tabId)) throw new Error("test-shell: no such tab");
            requestCloseTab(a.tabId);
            return true;
          case "reorderTab":
            return reorderTab(a.tabId, a.index);
          case "moveTabToWindow": {
            const tab = tabs.get(a.tabId);
            if (!tab) throw new Error("test-shell: no such tab");
            if (a.windowId === null || a.windowId === undefined) {
              const created = createTabWindow({});
              return moveTabToWindow(tab.id, created.id, 0) ? created.id : null;
            }
            return moveTabToWindow(tab.id, a.windowId, a.index);
          }
          case "clickEditMenuItem": {
            const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === "Edit");
            const item = edit?.submenu?.items.find((entry) => entry.label === a.label);
            if (!item) throw new Error("test-shell: no Edit menu item " + a.label);
            const w = caller ? windowsById.get(caller.windowId) : null;
            item.click(undefined, w ? w.win : undefined, event.sender);
            return true;
          }
          case "listTargets":
            return listTargets();
          case "sessionEnd":
            for (const w of liveWindows()) w.win.emit("session-end", { reasons: ["logoff"], preventDefault() {} });
            return true;
          case "externalOpens":
            return testExternalOpens.slice();
          case "chromiumLaunches":
            return testChromiumLaunches.slice();
          case "videoFileOpens":
            return testVideoOpens.slice();
          case "prompterShareStatus":
            return prompterShare() ? (prompterShare() as NonNullable<ReturnType<typeof prompterShare>>).status() : { listening: false, port: null, shares: [] };
          case "voiceStatus":
            return voiceHelperInstance().status();
          default:
            throw new Error("test-shell: unknown op " + op);
        }
      });
    }
  }

  return { registerTestModeIpc };
}

export type { createTestModeIpc };

module.exports = { createTestModeIpc };
