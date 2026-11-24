"use strict";

import type * as Electron from "electron";
import type * as NodeFs from "node:fs/promises";
import type * as NodePath from "node:path";
import type { DesktopIpcEvent } from "./ipc-boundaries.d.ts";

const fs: typeof NodeFs = require("node:fs/promises");
const { join }: typeof NodePath = require("node:path");
const CSP = "default-src 'none'; style-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function createRelaySetupWindow(BrowserWindow: typeof Electron.BrowserWindow, root: string, origin: string) {
  const page = origin + "/index.html";
  let current: { win: Electron.BrowserWindow; result: Promise<boolean> } | null = null;

  async function serve(url: URL, method: string): Promise<Response | null> {
    if (url.protocol + "//" + url.host !== origin) return null;
    const file = url.pathname === "/index.html" ? "index.html" : url.pathname === "/setup.css" ? "setup.css" : null;
    if (!file || method !== "GET" || url.search || url.hash) return new Response("not found", { status: 404 });
    try {
      const contents = await fs.readFile(join(root, file));
      return new Response(contents, {
        headers: {
          "content-type": file === "index.html" ? "text/html; charset=utf-8" : "text/css; charset=utf-8",
          "content-security-policy": CSP,
          "cache-control": "no-store"
        }
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  function open(parent: Electron.BrowserWindow): Promise<boolean> {
    if (current && !current.win.isDestroyed()) {
      current.win.focus();
      return current.result;
    }
    const win = new BrowserWindow({
      parent, modal: true, width: 460, height: 335, show: false,
      resizable: false, minimizable: false, maximizable: false, autoHideMenuBar: true,
      webPreferences: {
        preload: join(root, "preload.js"), contextIsolation: true, sandbox: true,
        nodeIntegration: false, webSecurity: true, devTools: false
      }
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("will-frame-navigate", event => event.preventDefault());
    win.webContents.on("will-attach-webview", event => event.preventDefault());
    win.once("ready-to-show", () => win.show());
    const result = new Promise<boolean>(resolve => {
      let loaded = true;
      win.once("closed", () => {
        if (current?.win === win) current = null;
        resolve(loaded);
      });
      void win.loadURL(page).catch(() => {
        loaded = false;
        if (!win.isDestroyed()) win.destroy();
      });
    });
    current = { win, result };
    return result;
  }

  function trusts(event: DesktopIpcEvent): boolean {
    const win = current?.win;
    return !!win && !win.isDestroyed() && event.sender === win.webContents &&
      event.senderFrame === win.webContents.mainFrame && event.senderFrame?.url === page;
  }

  return { serve, open, trusts };
}

export type { createRelaySetupWindow };
module.exports = { createRelaySetupWindow };
