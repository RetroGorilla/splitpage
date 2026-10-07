"use strict";

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.resolve(HERE, "..", "tabstrip", "tabstrip.css");
let port = 0;
let cdpPort = 0;
let userDataDir = "";

const log = (m) => process.stderr.write(`[tabstrip-width] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond, msg) {
  if (cond) {
    log(`PASS ${msg}`);
  } else {
    failures++;
    log(`FAIL ${msg}`);
  }
}

function harnessHtml(stripWidth) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;}body{width:${stripWidth}px;}</style>
<link rel="stylesheet" href="/tabstrip.css">
</head><body>
<div class="tabstrip">
  <div class="tabstrip__tabs" id="tabs"></div>
  <button type="button" class="tabstrip__new">+</button>
</div>
<script>
window.buildTabs = function (titles) {
  var tabsEl = document.getElementById("tabs");
  tabsEl.textContent = "";
  titles.forEach(function (title, i) {
    var el = document.createElement("div");
    el.className = "tab" + (i === 0 ? " tab--active" : "");
    var titleEl = document.createElement("span");
    titleEl.className = "tab__title";
    titleEl.textContent = title;
    el.appendChild(titleEl);
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab__close";
    closeBtn.textContent = "\\u00d7";
    el.appendChild(closeBtn);
    tabsEl.appendChild(el);
  });
};
window.setTitle = function (index, title) {
  var tabsEl = document.getElementById("tabs");
  tabsEl.children[index].querySelector(".tab__title").textContent = title;
};
window.measure = function () {
  var tabsEl = document.getElementById("tabs");
  var tabs = Array.prototype.slice.call(tabsEl.children);
  return tabs.map(function (el) {
    var titleEl = el.querySelector(".tab__title");
    return {
      width: el.getBoundingClientRect().width,
      titleScrollWidth: titleEl.scrollWidth,
      titleClientWidth: titleEl.clientWidth,
    };
  });
};
window.tabsRowWidth = function () {
  return document.getElementById("tabs").getBoundingClientRect().width;
};
</script>
</body></html>`;
}

let server = null;
function startServer(stripWidth) {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/tabstrip.css") {
        let body;
        try {
          body = fs.readFileSync(CSS_PATH);
        } catch (e) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", "text/css; charset=utf-8");
        return res.end(body);
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(harnessHtml(stripWidth));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
}

function findBrowser() {
  if (process.env.SPLITPAGE_CHROME && fs.existsSync(process.env.SPLITPAGE_CHROME)) {
    return process.env.SPLITPAGE_CHROME;
  }
  const cands = [];
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      if (!/^chromium-/.test(d)) continue;
      cands.push(path.join(pw, d, "chrome-linux", "chrome"));
      cands.push(path.join(pw, d, "chrome-mac", "Chromium.app", "Contents/MacOS/Chromium"));
      cands.push(path.join(pw, d, "chrome-win", "chrome.exe"));
    }
  }
  cands.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    const p = execFileSync("sh", ["-c", "command -v chromium || command -v google-chrome || command -v chrome"], {
      encoding: "utf8",
    }).trim();
    if (p) return p;
  } catch {}
  throw new Error("no Chromium/Edge found — pass SPLITPAGE_CHROME=<path>");
}

let browserProc = null;
function startBrowser() {
  const exe = findBrowser();
  userDataDir = path.join(os.tmpdir(), `splitpage-tabstrip-test-${Math.random().toString(16).slice(2, 10)}`);
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1440,960",
  ];
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }
  if (process.env.SPLITPAGE_CHROME_ARGS) {
    args.push(...process.env.SPLITPAGE_CHROME_ARGS.split(/\s+/).filter(Boolean));
  }
  args.push("about:blank");
  browserProc = spawn(exe, args, { stdio: ["ignore", "ignore", "ignore"], detached: false });
  browserProc.on("error", (e) => {
    throw new Error(`failed to launch ${exe}: ${e.message}`);
  });
  log(`browser pid=${browserProc.pid} exe=${exe}`);
}

let ws = null;
let msgId = 0;
const pending = new Map();

async function connectCdp() {
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      if (!cdpPort) {
        const first = fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0];
        cdpPort = Number(first);
      }
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(300);
  }
  if (!wsUrl) throw new Error(`no CDP page target on port ${cdpPort}`);
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`CDP ${msg.method || ""}: ${msg.error.message}`));
      else resolve(msg.result);
    }
  });
  ws.addEventListener("close", () => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP websocket closed"));
    }
    pending.clear();
  });
  await send("Page.enable");
  await send("Runtime.enable");
}

function send(method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function navigate(url) {
  const loaded = new Promise((resolve) => {
    const handler = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.method === "Page.loadEventFired") {
        ws.removeEventListener("message", handler);
        resolve();
      }
    };
    ws.addEventListener("message", handler);
  });
  await send("Page.navigate", { url });
  await loaded;
}

async function evaluate(expression, awaitPromise = false) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) {
    throw new Error(`eval failed: ${result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}

async function main() {
  await startServer(1440);
  startBrowser();
  await connectCdp();
  await navigate(`http://127.0.0.1:${port}/`);

  const titles = ["Ad", "Promo cut", "Penguin doc ep 1", "Penguin documentary episode 1"];
  const others = ["Ad", "Ad"];
  const widthsPerTitle = [];
  for (const t of titles) {
    await evaluate(`window.buildTabs(${JSON.stringify([t, ...others])})`);
    const m = await evaluate("window.measure()");
    widthsPerTitle.push(m);
    log(`title=${JSON.stringify(t)} widths=${m.map((x) => x.width.toFixed(1)).join(",")}`);
  }

  const TARGET = 180;
  const allWidths = widthsPerTitle.flat().map((x) => x.width);
  const firstWidth = allWidths[0];
  const allEqualToTarget = allWidths.every((w) => Math.abs(w - TARGET) < 0.5);
  const stableAcrossTitles = allWidths.every((w) => Math.abs(w - firstWidth) < 0.5);

  check(
    allEqualToTarget,
    `case 1: every tab sits at the ${TARGET}px target regardless of any tab's title (got: ${allWidths.map((w) => w.toFixed(1)).join(", ")})`
  );
  check(
    stableAcrossTitles,
    `case 1: tab width is unchanged as the active tab's title grows from ${JSON.stringify(titles[0])} to ${JSON.stringify(titles[titles.length - 1])}`
  );

  const untouchedTabWidths = widthsPerTitle.map((m) => m[1].width);
  check(
    untouchedTabWidths.every((w) => Math.abs(w - untouchedTabWidths[0]) < 0.5),
    `case 1: the two untouched "Ad" tabs keep a constant width as tab 0's title changes (got: ${untouchedTabWidths.map((w) => w.toFixed(1)).join(", ")})`
  );

  const longTitleMeasure = widthsPerTitle[widthsPerTitle.length - 1][0];
  check(
    longTitleMeasure.titleScrollWidth > longTitleMeasure.titleClientWidth,
    `case 2: a title too long for its tab overflows internally (scrollWidth ${longTitleMeasure.titleScrollWidth} > clientWidth ${longTitleMeasure.titleClientWidth}) instead of resizing the pill`
  );

  await startServer2(900);
  await navigate(`http://127.0.0.1:${port}/`);
  const manyTitles = [];
  for (let i = 0; i < 12; i++) manyTitles.push(`Tab ${i}`);
  await evaluate(`window.buildTabs(${JSON.stringify(manyTitles)})`);
  const manyMeasure = await evaluate("window.measure()");
  const manyWidths = manyMeasure.map((x) => x.width);
  const MIN_WIDTH = 76;
  log(`12-tab @900px widths=${manyWidths.map((w) => w.toFixed(1)).join(",")}`);
  check(
    manyWidths.every((w) => w >= MIN_WIDTH - 0.5),
    `case 3: with 12 tabs in a 900px strip, no tab shrinks below its ${MIN_WIDTH}px min-width (got: ${manyWidths.map((w) => w.toFixed(1)).join(", ")})`
  );
  check(
    manyWidths.some((w) => w < TARGET - 0.5),
    `case 3: with 12 tabs in a 900px strip, tabs actually shrink below the ${TARGET}px target (real space pressure engages)`
  );

  const rowWidth = await evaluate("window.tabsRowWidth()");
  const stripEl = await evaluate(`document.querySelector(".tabstrip").getBoundingClientRect().width`);
  check(
    rowWidth < stripEl - 0.5,
    `case 3: the tab row (${rowWidth.toFixed(1)}px) does not consume the whole 900px-wide title bar (${stripEl.toFixed(1)}px) — some chrome is left draggable`
  );

  log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

async function startServer2(stripWidth) {
  await new Promise((resolve) => server.close(resolve));
  await startServer(stripWidth);
}

async function cleanup() {
  try {
    if (ws) ws.close();
  } catch {}
  try {
    if (browserProc) browserProc.kill();
  } catch {}
  try {
    if (server) server.close();
  } catch {}
}

main()
  .catch((e) => {
    log(`ERROR: ${e.stack || e.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
