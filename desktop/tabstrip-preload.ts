"use strict";

import type { DesktopChannel } from "./ipc-channels.ts";
import type { DesktopChannelRow, DesktopIpcArgs, DesktopIpcContract, DesktopIpcReceiveArgs, DesktopIpcResult } from "../shared/desktop-contract.d.ts";

type TabstripPreloadChannelName<D extends DesktopChannelRow["direction"]> = Extract<DesktopChannel, { direction: D }>["name"];
type TabstripPreloadCall<C extends keyof DesktopIpcContract> = (...args: DesktopIpcArgs<C>) => DesktopIpcResult<C>;

interface TabstripPreloadBridge {
  windowId: DesktopIpcResult<"splitpage:tabstrip-window-id-sync">;
  platform: NodeJS.Platform;
  getShellState: () => Promise<DesktopIpcResult<"splitpage:tabstrip-get-state">>;
  onShellStateChanged: (callback: (state: DesktopIpcArgs<"splitpage:tabstrip-state">[0]) => void) => void;
  newTab: TabstripPreloadCall<"splitpage:tabstrip-new-tab">;
  activateTab: TabstripPreloadCall<"splitpage:tabstrip-activate">;
  closeTab: TabstripPreloadCall<"splitpage:tabstrip-close">;
  reorderTab: TabstripPreloadCall<"splitpage:tabstrip-reorder">;
  moveTabHere: TabstripPreloadCall<"splitpage:tabstrip-move-here">;
  tearOffToNewWindow: TabstripPreloadCall<"splitpage:tabstrip-tear-off">;
}

interface TabstripPreloadElectronBoundary {
  contextBridge: { exposeInMainWorld: (name: string, value: TabstripPreloadBridge) => void };
  ipcRenderer: {
    invoke: <C extends TabstripPreloadChannelName<"invoke">>(name: C, ...args: DesktopIpcArgs<C>) => Promise<DesktopIpcResult<C>>;
    send: <C extends TabstripPreloadChannelName<"send">>(name: C, ...args: DesktopIpcArgs<C>) => void;
    sendSync: <C extends TabstripPreloadChannelName<"sendSync">>(name: C, ...args: DesktopIpcArgs<C>) => DesktopIpcResult<C>;
    on: <C extends TabstripPreloadChannelName<"receive">>(name: C, handler: (event: unknown, ...args: DesktopIpcReceiveArgs<C>) => void) => void;
  };
}

const { contextBridge, ipcRenderer }: TabstripPreloadElectronBoundary = require("electron");

if (location.origin === "splitpage://tabstrip") {
  const channelDirections = new Map<keyof DesktopIpcContract, Set<DesktopChannelRow["direction"]>>();
  for (const entry of ipcRenderer.sendSync("splitpage:ipc-table-sync") || []) {
    if (!channelDirections.has(entry.name)) channelDirections.set(entry.name, new Set());
    (channelDirections.get(entry.name) as Set<DesktopChannelRow["direction"]>).add(entry.direction);
  }

  const channel = <C extends keyof DesktopIpcContract>(name: C, direction: DesktopChannelRow["direction"]): C => {
    const directions = channelDirections.get(name);
    if (!directions || !directions.has(direction)) {
      throw new Error("splitpage: " + name + " (" + direction + ") is not a channel this origin may use");
    }
    return name;
  };

  const invoke = <C extends TabstripPreloadChannelName<"invoke">>(name: C, ...args: DesktopIpcArgs<C>) => ipcRenderer.invoke(channel(name, "invoke"), ...args);
  const send = <C extends TabstripPreloadChannelName<"send">>(name: C, ...args: DesktopIpcArgs<C>) => ipcRenderer.send(channel(name, "send"), ...args);
  const sendSync = <C extends TabstripPreloadChannelName<"sendSync">>(name: C, ...args: DesktopIpcArgs<C>) => ipcRenderer.sendSync(channel(name, "sendSync"), ...args);
  const receive = <C extends TabstripPreloadChannelName<"receive">>(name: C, handler: (event: unknown, ...args: DesktopIpcReceiveArgs<C>) => void) => ipcRenderer.on(channel(name, "receive"), handler);

  let shellStateCallback: Parameters<TabstripPreloadBridge["onShellStateChanged"]>[0] | null = null;

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
