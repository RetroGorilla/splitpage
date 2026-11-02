"use strict";

import type { DesktopIpcContract } from "../shared/desktop-contract.d.ts";

import type { App, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { DesktopChannelRow, DesktopIpcArgs, DesktopIpcResult } from "../shared/desktop-contract.d.ts";
import type { DesktopIpcEvent, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";
import type { DesktopMainWindow } from "./main-types.d.ts";
import type { DesktopChannel, DesktopChannelModule } from "./ipc-channels.ts";

type ChannelName<D extends DesktopChannelRow["direction"]> = Extract<DesktopChannel, { direction: D }>["name"];
type ChannelHandler<C extends keyof DesktopIpcContract, E> =
  (event: E, ...args: DesktopIpcArgs<C>) => DesktopIpcResult<C> | Promise<DesktopIpcResult<C>>;

export interface DesktopIpcWrappers {
  ipcHandle: <C extends ChannelName<"invoke">>(name: C, fn: ChannelHandler<C, IpcMainInvokeEvent>) => void;
  ipcOn: <C extends ChannelName<"send">>(name: C, fn: (event: IpcMainEvent, ...args: DesktopIpcArgs<C>) => void) => void;
  ipcOnSync: <C extends ChannelName<"sendSync">>(name: C, fn: (event: IpcMainEvent, ...args: DesktopIpcArgs<C>) => DesktopIpcResult<C>) => void;
}

interface IpcSetupDependencies {
  ipcMain: Pick<IpcMain, "handle" | "on">;
  app: Pick<App, "getVersion">;
  testMode: boolean;
  windowsById: Map<string, DesktopMainWindow>;
}


const {
  APP_ORIGIN, TABSTRIP_ORIGIN, channelFor, channelsForOrigin, checkArgs
}: DesktopChannelModule = require("./ipc-channels.ts");

function createIpcSetup({ ipcMain, app, testMode, windowsById }: IpcSetupDependencies) {
  function senderOriginOf(event: DesktopIpcEvent) {
    const url = event.senderFrame && event.senderFrame.url;
    if (typeof url !== "string") return null;
    if (url.startsWith(APP_ORIGIN + "/")) return APP_ORIGIN;
    if (url.startsWith(TABSTRIP_ORIGIN + "/")) return TABSTRIP_ORIGIN;
    return null;
  }

  function isTrustedSender(event: DesktopIpcEvent) {
    return senderOriginOf(event) === APP_ORIGIN;
  }

  function isTrustedTabStripSender(event: DesktopIpcEvent) {
    if (senderOriginOf(event) !== TABSTRIP_ORIGIN) return false;
    for (const w of windowsById.values()) {
      if (!w.win.isDestroyed() && w.win.webContents === event.sender) return true;
    }
    return false;
  }

  function ipcRefusalReason(channel: DesktopChannelRow | null, event: DesktopIpcEvent, args: readonly unknown[]) {
    if (!channel) return "unknown channel";
    const origin = senderOriginOf(event);
    if (!origin || !channel.allowedOrigins.includes(origin)) return "untrusted sender";
    const trusted = origin === APP_ORIGIN ? isTrustedSender(event) : isTrustedTabStripSender(event);
    if (!trusted) return "untrusted sender";
    const bad = checkArgs(channel.argsSchema, args);
    return bad ? channel.name + ": " + bad : null;
  }

  function logIpcRefusal(name: string, reason: unknown) {
    if (testMode) console.error("[splitpage-test] ipc refused " + name + ": " + reason);
  }

  function ipcChannelRow(name: string, direction: DesktopChannelRow["direction"]) {
    const channel = channelFor(name, direction);
    if (!channel) throw new Error(`ipc: ${name} (${direction}) is not in desktop/ipc-channels.ts`);
    return channel;
  }

  function ipcHandle<C extends ChannelName<"invoke">>(name: C, fn: ChannelHandler<C, IpcMainInvokeEvent>) {
    const channel = ipcChannelRow(name, "invoke");
    ipcMain.handle(name, (event, ...args) => {
      const reason = ipcRefusalReason(channel, event, args);
      if (reason) { logIpcRefusal(name, reason); throw new Error(reason); }
      return fn(event, ...args as DesktopIpcArgs<C>);
    });
  }

  function ipcOn<C extends ChannelName<"send">>(name: C, fn: (event: IpcMainEvent, ...args: DesktopIpcArgs<C>) => void) {
    const channel = ipcChannelRow(name, "send");
    ipcMain.on(name, (event, ...args) => {
      const reason = ipcRefusalReason(channel, event, args);
      if (reason) { logIpcRefusal(name, reason); return; }
      fn(event, ...args as DesktopIpcArgs<C>);
    });
  }

  function ipcOnSync<C extends ChannelName<"sendSync">>(name: C, fn: (event: IpcMainEvent, ...args: DesktopIpcArgs<C>) => DesktopIpcResult<C>) {
    const channel = ipcChannelRow(name, "sendSync");
    ipcMain.on(name, (event, ...args) => {
      const reason = ipcRefusalReason(channel, event, args);
      if (reason) { logIpcRefusal(name, reason); event.returnValue = channel.refusal; return; }
      try {
        event.returnValue = fn(event, ...args as DesktopIpcArgs<C>);
      } catch (err) {
        logIpcRefusal(name, (err && (err as Error).message) || "handler failed");
        event.returnValue = channel.refusal;
      }
    });
  }

  function registerIpc(groups: Record<"registerFileIpc" | "registerShellIpc" | "registerDocumentIpc" | "registerHistoryBlobIpc" | "registerTabStripIpc" | "registerTestModeIpc" | "registerPrintIpc", DesktopRegisterIpcGroup>) {
    const wrappers = { ipcHandle, ipcOn, ipcOnSync };

    ipcOnSync("splitpage:ipc-table-sync", (event) => channelsForOrigin(senderOriginOf(event)));

    groups.registerFileIpc(wrappers);

    ipcOnSync("splitpage:get-app-version-sync", () => app.getVersion());

    groups.registerShellIpc(wrappers);
    groups.registerDocumentIpc(wrappers);
    groups.registerHistoryBlobIpc(wrappers);
    groups.registerTabStripIpc(wrappers);

    ipcOnSync("splitpage:is-test-mode-sync", () => testMode);

    groups.registerTestModeIpc(wrappers);

    groups.registerPrintIpc(wrappers);
  }

  return { registerIpc };
}

export type { createIpcSetup };

module.exports = { createIpcSetup };
