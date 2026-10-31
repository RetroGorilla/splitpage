"use strict";

const {
  APP_ORIGIN, TABSTRIP_ORIGIN, channelFor, channelsForOrigin, checkArgs
} = require("./ipc-channels");

function createIpcSetup({ ipcMain, app, testMode, windowsById }) {
  function senderOriginOf(event) {
    const url = event.senderFrame && event.senderFrame.url;
    if (typeof url !== "string") return null;
    if (url.startsWith(APP_ORIGIN + "/")) return APP_ORIGIN;
    if (url.startsWith(TABSTRIP_ORIGIN + "/")) return TABSTRIP_ORIGIN;
    return null;
  }

  function isTrustedSender(event) {
    return senderOriginOf(event) === APP_ORIGIN;
  }

  function isTrustedTabStripSender(event) {
    if (senderOriginOf(event) !== TABSTRIP_ORIGIN) return false;
    for (const w of windowsById.values()) {
      if (!w.win.isDestroyed() && w.win.webContents === event.sender) return true;
    }
    return false;
  }

  function ipcRefusalReason(channel, event, args) {
    if (!channel) return "unknown channel";
    const origin = senderOriginOf(event);
    if (!origin || !channel.allowedOrigins.includes(origin)) return "untrusted sender";
    const trusted = origin === APP_ORIGIN ? isTrustedSender(event) : isTrustedTabStripSender(event);
    if (!trusted) return "untrusted sender";
    const bad = checkArgs(channel.argsSchema, args);
    return bad ? channel.name + ": " + bad : null;
  }

  function logIpcRefusal(name, reason) {
    if (testMode) console.error("[splitpage-test] ipc refused " + name + ": " + reason);
  }

  function ipcChannelRow(name, direction) {
    const channel = channelFor(name, direction);
    if (!channel) throw new Error(`ipc: ${name} (${direction}) is not in desktop/ipc-channels.js`);
    return channel;
  }

  function ipcHandle(name, fn) {
    const channel = ipcChannelRow(name, "invoke");
    ipcMain.handle(name, (event, ...args) => {
      const reason = ipcRefusalReason(channel, event, args);
      if (reason) { logIpcRefusal(name, reason); throw new Error(reason); }
      return fn(event, ...args);
    });
  }

  function ipcOn(name, fn) {
    const channel = ipcChannelRow(name, "send");
    ipcMain.on(name, (event, ...args) => {
      const reason = ipcRefusalReason(channel, event, args);
      if (reason) { logIpcRefusal(name, reason); return; }
      fn(event, ...args);
    });
  }

  function ipcOnSync(name, fn) {
    const channel = ipcChannelRow(name, "sendSync");
    ipcMain.on(name, (event, ...args) => {
      const reason = ipcRefusalReason(channel, event, args);
      if (reason) { logIpcRefusal(name, reason); event.returnValue = channel.refusal; return; }
      try {
        event.returnValue = fn(event, ...args);
      } catch (err) {
        logIpcRefusal(name, (err && err.message) || "handler failed");
        event.returnValue = channel.refusal;
      }
    });
  }

  function registerIpc(groups) {
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

module.exports = { createIpcSetup };
