"use strict";

import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";
import type * as NodeChildProcess from "node:child_process";

const fs: typeof NodeFs = require("node:fs");
const path: typeof NodePath = require("node:path");
const { execFile, spawn: nodeSpawn }: typeof NodeChildProcess = require("node:child_process");

const BROWSERS: { id: string; name: string; exe: string; progId: RegExp; win: [string, string][]; mac: string; linux: string[] }[] = [
  {
    id: "edge", name: "Microsoft Edge", exe: "msedge.exe", progId: /^MSEdgeHTM/i,
    win: [["ProgramFiles(x86)", "Microsoft\\Edge\\Application\\msedge.exe"], ["ProgramFiles", "Microsoft\\Edge\\Application\\msedge.exe"]],
    mac: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    linux: ["microsoft-edge", "microsoft-edge-stable"]
  },
  {
    id: "chrome", name: "Google Chrome", exe: "chrome.exe", progId: /^ChromeHTML/i,
    win: [["ProgramFiles", "Google\\Chrome\\Application\\chrome.exe"], ["ProgramFiles(x86)", "Google\\Chrome\\Application\\chrome.exe"], ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"]],
    mac: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    linux: ["google-chrome", "google-chrome-stable"]
  },
  {
    id: "brave", name: "Brave", exe: "brave.exe", progId: /^BraveHTML/i,
    win: [["ProgramFiles", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"], ["LOCALAPPDATA", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"]],
    mac: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    linux: ["brave-browser", "brave"]
  },
  {
    id: "vivaldi", name: "Vivaldi", exe: "vivaldi.exe", progId: /^VivaldiHTM/i,
    win: [["LOCALAPPDATA", "Vivaldi\\Application\\vivaldi.exe"], ["ProgramFiles", "Vivaldi\\Application\\vivaldi.exe"]],
    mac: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    linux: ["vivaldi", "vivaldi-stable"]
  },
  {
    id: "opera", name: "Opera", exe: "opera.exe", progId: /^Opera/i,
    win: [["LOCALAPPDATA", "Programs\\Opera\\opera.exe"], ["ProgramFiles", "Opera\\opera.exe"]],
    mac: "/Applications/Opera.app/Contents/MacOS/Opera",
    linux: ["opera"]
  },
  {
    id: "chromium", name: "Chromium", exe: "chromium.exe", progId: /^ChromiumHTM/i,
    win: [["LOCALAPPDATA", "Chromium\\Application\\chrome.exe"]],
    mac: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    linux: ["chromium", "chromium-browser"]
  }
];

const USER_CHOICE_KEY = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice";
const APP_PATHS = "\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\";

function defaultRegQuery(env: NodeJS.ProcessEnv) {
  const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
  const reg = path.join(systemRoot, "System32", "reg.exe");
  return (key: string, valueName: string | null) => new Promise<string | null | undefined>((resolve) => {
    const args = ["query", key].concat(valueName ? ["/v", valueName] : ["/ve"]);
    execFile(reg, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(stdout));
      resolve(m ? m[1] : null);
    });
  });
}

function isFile(exists: (file: string) => boolean, p: string) {
  try { return !!p && exists(p); } catch { return false; }
}

async function windowsCandidates(entry: (typeof BROWSERS)[number], env: NodeJS.ProcessEnv, regQuery: ReturnType<typeof defaultRegQuery>, exists: (file: string) => boolean) {
  const found = [];
  for (const hive of ["HKCU", "HKLM"]) {
    let v;
    try { v = await regQuery(hive + APP_PATHS + entry.exe, null); } catch { v = null; }
    if (v) {
      const expanded = v.replace(/^"|"$/g, "").replace(/%([^%]+)%/g, (all: string, name: string) => env[name] || all);
      found.push(expanded);
    }
  }
  for (const [base, rel] of entry.win) {
    if (env[base]) found.push(path.win32.join(env[base], rel));
  }
  return found.find((p) => isFile(exists, p)) || null;
}

async function findChromiumBrowsers(options?: { platform?: string; env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean; regQuery?: ReturnType<typeof defaultRegQuery> }) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const exists = opts.exists || ((p) => fs.statSync(p).isFile());
  const out = [];
  if (platform === "win32") {
    const regQuery = opts.regQuery || defaultRegQuery(env);
    let progId: Awaited<ReturnType<ReturnType<typeof defaultRegQuery>>> = null;
    try { progId = await regQuery(USER_CHOICE_KEY, "ProgId"); } catch { progId = null; }
    const order = BROWSERS.slice();
    const def = progId ? order.findIndex((b) => b.progId.test(progId as string)) : -1;
    if (def > 0) order.unshift(order.splice(def, 1)[0] as (typeof BROWSERS)[number]);
    for (const entry of order) {
      const p = await windowsCandidates(entry, env, regQuery, exists);
      if (p) out.push({ id: entry.id, name: entry.name, path: p });
    }
  } else if (platform === "darwin") {
    for (const entry of BROWSERS) {
      if (isFile(exists, entry.mac)) out.push({ id: entry.id, name: entry.name, path: entry.mac });
    }
  } else {
    const dirs = String(env.PATH || "").split(":").filter(Boolean);
    for (const entry of BROWSERS) {
      let hit = null;
      for (const cmd of entry.linux) {
        for (const dir of dirs) {
          const p = path.posix.join(dir, cmd);
          if (isFile(exists, p)) { hit = p; break; }
        }
        if (hit) break;
      }
      if (hit) out.push({ id: entry.id, name: entry.name, path: hit });
    }
  }
  return out;
}

function chromiumBrowserName(id: unknown) {
  const entry = BROWSERS.find((b) => b.id === id);
  return entry ? entry.name : null;
}

function launchChromiumBrowser(browser: Awaited<ReturnType<typeof findChromiumBrowsers>>[number], url: string, spawnFn?: typeof nodeSpawn) {
  const spawn = spawnFn || nodeSpawn;
  return new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(browser.path, [url], { detached: true, stdio: "ignore", windowsHide: false });
    } catch (err) { reject(err); return; }
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export type { findChromiumBrowsers, launchChromiumBrowser, chromiumBrowserName, BROWSERS };

module.exports = { findChromiumBrowsers, launchChromiumBrowser, chromiumBrowserName, BROWSERS };
