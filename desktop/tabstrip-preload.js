"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (location.origin === "splitpage://tabstrip") {
  const channelDirections = new Map();
  for (const entry of ipcRenderer.sendSync("splitpage:ipc-table-sync") || []) {
    if (!channelDirections.has(entry.name)) channelDirections.set(entry.name, new Set());
    channelDirections.get(entry.name).add(entry.direction);
  }

  const channel = (name, direction) => {
    const directions = channelDirections.get(name);
    if (!directions || !directions.has(direction)) {
      throw new Error("splitpage: " + name + " (" + direction + ") is not a channel this origin may use");
    }
    return name;
  };

  const invoke = (name, ...args) => ipcRenderer.invoke(channel(name, "invoke"), ...args);
  const send = (name, ...args) => ipcRenderer.send(channel(name, "send"), ...args);
  const sendSync = (name, ...args) => ipcRenderer.sendSync(channel(name, "sendSync"), ...args);
  const receive = (name, handler) => ipcRenderer.on(channel(name, "receive"), handler);

  let shellStateCallback = null;

  receive("splitpage:tabstrip-state", (_event, state) => {
    if (shellStateCallback) shellStateCallback(state);
  });

  const windowId = sendSync("splitpage:tabstrip-window-id-sync");

  contextBridge.exposeInMainWorld("splitpageTabStrip", {
    windowId,
    platform: process.platform,

    getShellState() {
      return invoke("splitpage:tabstrip-get-state");
    },

    onShellStateChanged(cb) {
      shellStateCallback = cb;
    },

    newTab() {
      send("splitpage:tabstrip-new-tab");
    },

    activateTab(tabId) {
      send("splitpage:tabstrip-activate", tabId);
    },

    closeTab(tabId) {
      send("splitpage:tabstrip-close", tabId);
    },

    reorderTab(tabId, index) {
      send("splitpage:tabstrip-reorder", tabId, index);
    },

    moveTabHere(tabId, dropIndex) {
      send("splitpage:tabstrip-move-here", tabId, dropIndex);
    },

    tearOffToNewWindow(tabId, screenX, screenY) {
      send("splitpage:tabstrip-tear-off", tabId, screenX, screenY);
    }
  });
}
