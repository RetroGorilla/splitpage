"use strict";

import type { DesktopMainCommon, DesktopMainTab } from "./ipc-boundaries.d.ts";
import type { DesktopFileService } from "./file-service.ts";

const { TAB_OR_WINDOW_ID_RE, mintTabOrWindowId }: {
  TAB_OR_WINDOW_ID_RE: RegExp;
  mintTabOrWindowId: () => string;
} = require("./desktop-state");

function createTabRegistry({ pathKey }: Pick<DesktopFileService, "pathKey">) {
  const tabs: DesktopMainCommon["tabs"] = new Map();
  const windowsById: DesktopMainCommon["windowsById"] = new Map();
  const webContentsIdToTabId = new Map<number, string>();
  const pathToTabId = new Map<string, string>();

  function mintUniqueTabId(preferred?: unknown) {
    if (typeof preferred === "string" && TAB_OR_WINDOW_ID_RE.test(preferred) && !tabs.has(preferred)) return preferred;
    let id = mintTabOrWindowId();
    while (tabs.has(id)) id = mintTabOrWindowId();
    return id;
  }

  function mintUniqueWindowId(preferred?: unknown) {
    if (typeof preferred === "string" && TAB_OR_WINDOW_ID_RE.test(preferred) && !windowsById.has(preferred)) return preferred;
    let id = mintTabOrWindowId();
    while (windowsById.has(id)) id = mintTabOrWindowId();
    return id;
  }

  function firstWindowRecord() {
    const it = windowsById.values().next();
    return it.done ? null : it.value;
  }

  function claimRoutingKey<K>(map: Map<K, string>, key: K, tabId: string) {
    const owner = map.get(key);
    if (owner && owner !== tabId && tabs.has(owner)) return false;
    map.set(key, tabId);
    return true;
  }

  function indexTabSource(tab: Pick<DesktopMainTab, "id" | "source">) {
    if (tab.source.kind === "file") claimRoutingKey(pathToTabId, pathKey(tab.source.absPath), tab.id);
  }

  function unindexTabSource(tab: Pick<DesktopMainTab, "id">) {
    for (const [key, id] of pathToTabId) if (id === tab.id) pathToTabId.delete(key);
  }

  return {
    tabs,
    windowsById,
    webContentsIdToTabId,
    pathToTabId,
    mintUniqueTabId,
    mintUniqueWindowId,
    firstWindowRecord,
    claimRoutingKey,
    indexTabSource,
    unindexTabSource
  };
}

export type { createTabRegistry };

module.exports = { createTabRegistry };
