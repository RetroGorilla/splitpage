"use strict";

import type { WebContents } from "electron";
import type { DesktopMainTab, DesktopMainWindow, DesktopTestModeIpcDependencies } from "./ipc-boundaries.d.ts";
import type { DesktopIpcReceiveArgs } from "../shared/desktop-contract.d.ts";

type RestoreNoticePayload = DesktopIpcReceiveArgs<"splitpage:restore-notice">[0];
interface RestoreNoticeDependencies extends Pick<DesktopTestModeIpcDependencies, "tabs" | "liveWindows"> {
  send: (contents: WebContents, payload: RestoreNoticePayload) => void;
}

function createRestoreNotice({ tabs, liveWindows, send }: RestoreNoticeDependencies) {
  let pending: { tabId: string; skipped: RestoreNoticePayload["skipped"] } | null = null;

  function set(tabId: string, skipped: RestoreNoticePayload["skipped"]) {
    pending = { tabId, skipped };
  }

  function isFor(tabId: string) {
    return !!pending && pending.tabId === tabId;
  }

  function deliver(tab: DesktopMainTab | null | undefined) {
    if (!pending || !tab || tab.view.webContents.isDestroyed()) return;
    const notice = pending;
    pending = null;
    try { send(tab.view.webContents, { skipped: notice.skipped }); }
    catch { }
  }

  function retarget(deadTabId: string, deadWindow: Pick<DesktopMainWindow, "activeTabId"> | null | undefined) {
    if (!pending || pending.tabId !== deadTabId) return;
    let next = deadWindow && deadWindow.activeTabId ? tabs.get(deadWindow.activeTabId) : null;
    if (!next) {
      for (const rec of liveWindows()) {
        next = rec.activeTabId ? tabs.get(rec.activeTabId) : null;
        if (next) break;
      }
    }
    if (!next) { pending = null; return; }
    if (next.ready) deliver(next);
    else pending.tabId = next.id;
  }

  return { set, isFor, deliver, retarget };
}

export type { createRestoreNotice };

module.exports = { createRestoreNotice };
