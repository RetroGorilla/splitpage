"use strict";

const { TAB_OR_WINDOW_ID_RE, mintTabOrWindowId } = require("./desktop-state.ts");

function createTabRegistry({ pathKey }) {
  const tabs = new Map();
  const windowsById = new Map();
  const webContentsIdToTabId = new Map();
  const pathToTabId = new Map();

  function mintUniqueTabId(preferred) {
    if (typeof preferred === "string" && TAB_OR_WINDOW_ID_RE.test(preferred) && !tabs.has(preferred)) return preferred;
    let id = mintTabOrWindowId();
    while (tabs.has(id)) id = mintTabOrWindowId();
    return id;
  }

  function mintUniqueWindowId(preferred) {
    if (typeof preferred === "string" && TAB_OR_WINDOW_ID_RE.test(preferred) && !windowsById.has(preferred)) return preferred;
    let id = mintTabOrWindowId();
    while (windowsById.has(id)) id = mintTabOrWindowId();
    return id;
  }

  function firstWindowRecord() {
    const it = windowsById.values().next();
    return it.done ? null : it.value;
  }

  function claimRoutingKey(map, key, tabId) {
    const owner = map.get(key);
    if (owner && owner !== tabId && tabs.has(owner)) return false;
    map.set(key, tabId);
    return true;
  }

  function indexTabSource(tab) {
    if (tab.source.kind === "file") claimRoutingKey(pathToTabId, pathKey(tab.source.absPath), tab.id);
  }

  function unindexTabSource(tab) {
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

module.exports = { createTabRegistry };
