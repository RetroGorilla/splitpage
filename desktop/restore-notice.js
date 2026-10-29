"use strict";

function createRestoreNotice({ tabs, liveWindows, send }) {
  let pending = null;

  function set(tabId, skipped) {
    pending = { tabId, skipped };
  }

  function isFor(tabId) {
    return !!pending && pending.tabId === tabId;
  }

  function deliver(tab) {
    if (!pending || !tab || tab.view.webContents.isDestroyed()) return;
    const notice = pending;
    pending = null;
    try { send(tab.view.webContents, { skipped: notice.skipped }); }
    catch { }
  }

  function retarget(deadTabId, deadWindow) {
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

module.exports = { createRestoreNotice };
