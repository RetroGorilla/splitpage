/* Splitpage desktop — finding a Chromium browser for "Use Chromium Speech
 * Recognition" (issue #123).
 *
 * WHY. Present in Browser (main.js section 9b) opens the teleprompter in the
 * DEFAULT browser, and since #122 Follow My Voice there listens through this
 * app. Someone who would rather have Chrome's or Edge's own recogniser (the
 * Web Speech API) needs the page in a Chromium browser, whatever the default
 * is — so this finds one that is installed, and main starts it with the
 * prompter's URL instead of handing the URL to shell.openExternal. That also
 * steps round a default browser whose ProgID has no open command
 * (0x80070483), where openExternal opens nothing at all.
 *
 * WHERE IT LOOKS.
 *   Windows  the default browser first, if it is a Chromium one (its
 *            UserChoice ProgId under HKCU\…\UrlAssociations\http); then, in
 *            the order below, each browser's App Paths entry (HKCU, then
 *            HKLM) and its usual install folders. Edge ships with Windows,
 *            so in practice there is always one.
 *   macOS    the .app bundles in /Applications.
 *   Linux    the usual command names on PATH.
 *
 * WHAT IT NEVER DOES. Take a path or a URL from the page. The executable is
 * one this file found on disk from its own table, and main builds the URL.
 *
 * Plain CommonJS, Node built-ins only, no Electron: main.js requires it, and
 * desktop/test/chromium-browsers.test.mjs drives it with a fake file system
 * and registry. Listed in electron-builder.yml's `files` for the same reason
 * drafts.js is.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn: nodeSpawn } = require("node:child_process");

/* Most likely first, after the default browser. Edge leads because Windows
   always has it. */
const BROWSERS = [
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

/* `reg.exe query <key> [/v name | /ve]`: the value's data, or null. */
function defaultRegQuery(env) {
  const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
  const reg = path.join(systemRoot, "System32", "reg.exe");
  return (key, valueName) => new Promise((resolve) => {
    const args = ["query", key].concat(valueName ? ["/v", valueName] : ["/ve"]);
    execFile(reg, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(stdout));
      resolve(m ? m[1] : null);
    });
  });
}

function isFile(exists, p) {
  try { return !!p && exists(p); } catch { return false; }
}

async function windowsCandidates(entry, env, regQuery, exists) {
  const found = [];
  for (const hive of ["HKCU", "HKLM"]) {
    let v;
    try { v = await regQuery(hive + APP_PATHS + entry.exe, null); } catch { v = null; }
    if (v) {
      const expanded = v.replace(/^"|"$/g, "").replace(/%([^%]+)%/g, (all, name) => env[name] || all);
      found.push(expanded);
    }
  }
  for (const [base, rel] of entry.win) {
    if (env[base]) found.push(path.win32.join(env[base], rel));
  }
  return found.find((p) => isFile(exists, p)) || null;
}

/* Installed Chromium browsers, the default browser first if it is one.
   opts: platform, env, exists(path), regQuery(key, valueName) — all
   replaceable for tests. Resolves to [{id, name, path}]. */
async function findChromiumBrowsers(options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const exists = opts.exists || ((p) => fs.statSync(p).isFile());
  const out = [];
  if (platform === "win32") {
    const regQuery = opts.regQuery || defaultRegQuery(env);
    let progId = null;
    try { progId = await regQuery(USER_CHOICE_KEY, "ProgId"); } catch { progId = null; }
    const order = BROWSERS.slice();
    const def = progId ? order.findIndex((b) => b.progId.test(progId)) : -1;
    if (def > 0) order.unshift(order.splice(def, 1)[0]);
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

/* The display name for a browser id, from this file's own table. */
function chromiumBrowserName(id) {
  const entry = BROWSERS.find((b) => b.id === id);
  return entry ? entry.name : null;
}

/* Starts `browser` (one findChromiumBrowsers answered) on `url`, detached:
   from then on it is the person's own browser, not a child of this app. */
function launchChromiumBrowser(browser, url, spawnFn) {
  const spawn = spawnFn || nodeSpawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(browser.path, [url], { detached: true, stdio: "ignore", windowsHide: false });
    } catch (err) { reject(err); return; }
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

module.exports = { findChromiumBrowsers, launchChromiumBrowser, chromiumBrowserName, BROWSERS };
