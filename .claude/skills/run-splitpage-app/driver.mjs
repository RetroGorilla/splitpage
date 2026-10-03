import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    port: 8791, cdpPort: 9333, root: path.resolve(HERE, "..", "..", ".."),
    shotDir: path.join(os.tmpdir(), "splitpage-shots"),
    headed: false, script: null, runId: null, chrome: null, bind: "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = a.replace(/^--?/, "").toLowerCase();
    if (a[0] !== "-") throw new Error(`unexpected argument: ${a}`);
    switch (flag) {
      case "port": out.port = parseInt(argv[++i], 10); break;
      case "cdpport": case "cdp-port": out.cdpPort = parseInt(argv[++i], 10); break;
      case "root": out.root = path.resolve(argv[++i]); break;
      case "shotdir": case "shot-dir": out.shotDir = path.resolve(argv[++i]); break;
      case "script": out.script = argv[++i]; break;
      case "runid": case "run-id": out.runId = argv[++i]; break;
      case "chrome": out.chrome = argv[++i]; break;
      case "bind": out.bind = argv[++i]; break;
      case "headed": out.headed = true; break;
      case "h": case "help":
        console.log("usage: node driver.mjs --script <file> [--port N] [--cdp-port N] [--root DIR] [--shot-dir DIR] [--chrome PATH] [--bind ADDRESS] [--headed]");
        process.exit(0);
        break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.runId) opts.runId = Math.random().toString(16).slice(2, 10);
fs.mkdirSync(opts.shotDir, { recursive: true });

const log = (m) => process.stderr.write(`[driver] ${m}\n`);
const out1 = (m) => process.stdout.write(`${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
};

let server = null;
const SERVER_ATTEMPTS = 3;

function listenOnce(handler, port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.once("error", reject);
    s.listen(port, opts.bind, () => { s.removeListener("error", reject); resolve(s); });
  });
}

async function startServer() {
  if (server) return;
  const root = opts.root;
  const handler = (req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
    catch { res.statusCode = 400; return res.end(); }
    if (p === "/") p = "/index.html";
    const f = path.resolve(root, "." + p);
    if (f !== root && !f.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
    let body;
    try {
      if (!fs.statSync(f).isFile()) { res.statusCode = 404; return res.end(); }
      body = fs.readFileSync(f);
    } catch { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", MIME[path.extname(f).toLowerCase()] || "application/octet-stream");
    res.setHeader("Content-Length", body.length);
    res.end(body);
  };
  const reasons = [];
  for (let attempt = 1; attempt <= SERVER_ATTEMPTS; attempt++) {
    const port = attempt === 1 ? opts.port : 0;
    try {
      server = await listenOnce(handler, port);
      opts.port = server.address().port;
      log(`server up on http://localhost:${opts.port}/ (root ${root})`);
      return;
    } catch (e) {
      reasons.push(`${port === 0 ? "a fresh port" : "port " + port}: ${e.code ?? e.message}`);
      log(`static server attempt ${attempt} of ${SERVER_ATTEMPTS} failed: ${reasons[reasons.length - 1]}`);
      if (attempt < SERVER_ATTEMPTS) await sleep(250);
    }
  }
  const e = new Error(`static server did not come up after ${SERVER_ATTEMPTS} attempts (${reasons.join("; ")})`);
  e.fatal = true;
  e.notStarted = true;
  throw e;
}

function findBrowser() {
  if (opts.chrome) {
    if (!fs.existsSync(opts.chrome)) throw new Error(`--chrome not found: ${opts.chrome}`);
    return opts.chrome;
  }
  if (process.env.SPLITPAGE_CHROME && fs.existsSync(process.env.SPLITPAGE_CHROME)) {
    return process.env.SPLITPAGE_CHROME;
  }
  const cands = [];
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      if (!/^chromium-/.test(d)) continue;
      cands.push(path.join(pw, d, "chrome-linux", "chrome"));
      cands.push(path.join(pw, d, "chrome-linux64", "chrome"));
      cands.push(path.join(pw, d, "chrome-mac", "Chromium.app", "Contents/MacOS/Chromium"));
      cands.push(path.join(pw, d, "chrome-mac-arm64", "Chromium.app", "Contents/MacOS/Chromium"));
      cands.push(path.join(pw, d, "chrome-win", "chrome.exe"));
      cands.push(path.join(pw, d, "chrome-win64", "chrome.exe"));
      try {
        for (const sub of fs.readdirSync(path.join(pw, d))) {
          if (!/^chrome-/.test(sub)) continue;
          cands.push(path.join(pw, d, sub, "chrome"));
          cands.push(path.join(pw, d, sub, "chrome.exe"));
        }
      } catch { }
    }
  }
  if (process.platform === "win32") {
    cands.push(`${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`);
    cands.push(`${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`);
  }
  cands.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  try {
    const p = execFileSync("sh", ["-c", "command -v google-chrome || command -v chromium || command -v chrome"], { encoding: "utf8" }).trim();
    if (p) return p;
  } catch {}
  throw new Error("no Chromium/Edge found — pass --chrome <path> or set SPLITPAGE_CHROME");
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

let browserProc = null;
let userDataDir = null;
async function startBrowser() {
  if (browserProc) return;
  if (await portInUse(opts.cdpPort)) {
    const e = new Error(
      `CDP port ${opts.cdpPort} is already in use, probably by a browser left over from an earlier run. ` +
      `Pass a different --cdp-port, or close whatever holds it` +
      (process.platform === "win32" ? " (see \"Orphaned browsers\" in SKILL.md)." : "."));
    e.fatal = true;
    throw e;
  }
  const exe = findBrowser();
  userDataDir = path.join(os.tmpdir(), `splitpage-edge-${opts.runId}-${Math.random().toString(16).slice(2, 10)}`);
  const args = [
    `--remote-debugging-port=${opts.cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--disable-features=Translate,msEdgeSplitScreen,msImplicitSignin",
    "--window-size=1440,960",
  ];
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }
  if (process.env.SPLITPAGE_CHROME_ARGS) {
    args.push(...process.env.SPLITPAGE_CHROME_ARGS.split(/\s+/).filter(Boolean));
  }
  if (!opts.headed) args.unshift("--headless=new");
  args.push("about:blank");
  browserProc = spawn(exe, args, { stdio: ["ignore", "ignore", "ignore"], detached: false });
  browserProc.on("error", (e) => { throw new Error(`failed to launch ${exe}: ${e.message}`); });
  log(`browser pid=${browserProc.pid} exe=${exe} cdp=${opts.cdpPort} headless=${!opts.headed}`);
}

function sweepBrowsers(dir) {
  if (process.platform !== "win32" || !dir) return;
  const ps = [
    "$d = $env:SPLITPAGE_SWEEP_DIR",
    "for ($i = 0; $i -lt 3; $i++) {",
    "  $p = @(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -ErrorAction Stop |",
    "    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) })",
    "  if ($p.Count -eq 0) { break }",
    "  $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "  Start-Sleep -Milliseconds 300",
    "}",
  ].join("\n");
  try {
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], {
      stdio: "ignore", timeout: 30000,
      env: { ...process.env, SPLITPAGE_SWEEP_DIR: path.basename(dir) },
    });
  } catch (e) {
    log(`browser sweep failed: ${e.message}`);
  }
}

let ws = null;
let msgId = 0;
const pending = new Map();
const consoleLines = [];

async function connectCdp() {
  if (ws) return;
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${opts.cdpPort}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(300);
  }
  if (!wsUrl) throw new Error(`no CDP page target on port ${opts.cdpPort}`);
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`CDP ${msg.method || ""}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const a = (msg.params.args || []).map((x) => (x.value !== undefined ? String(x.value) : x.description)).join(" ");
      consoleLines.push(`${msg.params.type}: ${a}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      consoleLines.push(`exception: ${msg.params.exceptionDetails?.exception?.description}`);
    } else if (msg.method === "Log.entryAdded") {
      consoleLines.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
    }
  });
  ws.addEventListener("close", () => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("CDP websocket closed")); }
    pending.clear();
  });
  log("cdp connected");
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
if (!/[?&]wizard=1(&|$)/.test(location.search)) {
  try {
    if (!localStorage.getItem('splitpage-onboarding')) {
      localStorage.setItem('splitpage-onboarding', JSON.stringify({ v: 1, done: true, skipped: true, at: 'harness' }));
    }
  } catch (e) {}
}
if (!/[?&]newtab=1(&|$)/.test(location.search)) { window.__splitpageNoNewTab = true; }
window.__splitpageNoRemote = true;
`,
  });
  await send("Log.enable");
}

function send(method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

async function js(expr, timeoutMs = 30000) {
  const r = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
  }, timeoutMs);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error(`JS error: ${d}`);
  }
  return r.result.value;
}

function formatVal(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

function truthy(v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return false;
    if (v.length === 1) return truthy(v[0]);
    return true;
  }
  return !!v;
}

let checks = 0;
let failures = 0;

async function expectThat(rest) {
  checks++;
  let expr = rest, want = null, hasWant = false;
  const i = rest.lastIndexOf("==");
  if (i > 0 && !"=!<>".includes(rest[i - 1])) {
    expr = rest.slice(0, i).trim();
    want = rest.slice(i + 2).trim();
    hasWant = true;
  }
  const got = await js(expr);
  if (hasWant) {
    const g = formatVal(got);
    if (g.toLowerCase() === want.toLowerCase()) { out1(`PASS ${expr} == ${want}`); return; }
    failures++;
    out1(`FAIL ${expr}`);
    out1(`     expected: ${want}`);
    out1(`     actual:   ${g}`);
    return;
  }
  if (truthy(got)) { out1(`PASS ${expr}`); return; }
  failures++;
  out1(`FAIL ${expr}  (got ${formatVal(got)})`);
}

async function waitFor(expr, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (truthy(await js(`!!(${expr})`))) return true; } catch {}
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${expr}`);
}

async function go(target) {
  const url = /^https?:\/\//.test(target) ? target
    : target.startsWith("/") ? `http://localhost:${opts.port}${target}`
    : `http://localhost:${opts.port}/${target}`;
  await send("Page.navigate", { url });
  await waitFor('document.readyState === "complete"', 30000);
  out1(`at ${url}`);
}

const ROLES = "button,a,[role=button],[role=menuitem],[role=tab],label,summary,li,div,span";
function resolveSel(sel) {
  const m = /^text(\*?)=(.*)$/.exec(sel);
  if (m) {
    const contains = m[1] === "*";
    const t = m[2].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const test = contains ? `t.indexOf("${t}") !== -1` : `t === "${t}"`;
    return `(Array.from(document.querySelectorAll('${ROLES}')).filter(e=>{if(e.offsetParent===null)return false;const t=(e.innerText||'').trim();return ${test};}).sort((a,b)=>a.getElementsByTagName('*').length-b.getElementsByTagName('*').length)[0])`;
  }
  const s = sel.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `document.querySelector('${s}')`;
}

async function measureForClick(e, sel) {
  const attempts = 6;
  let box = null;
  for (let i = 1; i <= attempts; i++) {
    box = await js(`
(() => { const el = ${e}; if (!el) return null;
  const r0 = el.getBoundingClientRect();
  const inView = r0.top >= 0 && r0.left >= 0 && r0.bottom <= window.innerHeight && r0.right <= window.innerWidth;
  if (!inView) el.scrollIntoView({block:'center'});
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const hit = !!(top && (top === el || el.contains(top)));
  const topDesc = top ? (top.id ? '#' + top.id
    : (top.tagName || '').toLowerCase() + (typeof top.className === 'string' && top.className.trim()
        ? '.' + top.className.trim().replace(/\\s+/g, '.') : '')) : null;
  return {x, y, w: r.width, h: r.height, hit, topDesc}; })()
`);
    if (!box) throw new Error(`no element for: ${sel}`);
    if (box.w > 0 && box.h > 0 && box.hit) {
      if (i > 1) log(`click ${sel}: layout settled on attempt ${i}`);
      return box;
    }
    if (i === attempts) break;
    await js(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    await sleep(30 * i);
  }
  if (box.w <= 0 || box.h <= 0) throw new Error(`element has zero size: ${sel}`);
  log(`click ${sel}: elementFromPoint at ${Math.trunc(box.x)},${Math.trunc(box.y)} still hits ${box.topDesc || "nothing"}, not ${sel} or a descendant, after ${attempts} attempts — dispatching anyway`);
  return box;
}

async function clickEl(sel) {
  const e = resolveSel(sel);
  const box = await measureForClick(e, sel);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type, x: Math.trunc(box.x), y: Math.trunc(box.y), button: "left", clickCount: 1,
    });
  }
  out1(`clicked ${sel} at ${Math.trunc(box.x)},${Math.trunc(box.y)}`);
}

async function focusEl(sel) {
  const e = resolveSel(sel);
  const ok = await js(`(() => { const el = ${e}; if (!el) return false; el.focus(); return document.activeElement === el || el.contains(document.activeElement); })()`);
  if (!ok) throw new Error(`could not focus: ${sel}`);
  out1(`focused ${sel}`);
}

async function setCaret(sel, where = "end") {
  const e = resolveSel(sel);
  const collapse = where === "start" ? "true" : "false";
  const n = await js(`
(() => { const el = ${e}; if (!el) return null;
  el.scrollIntoView({block:'center'}); el.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(${collapse});
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  return (el.innerText || '').length; })()
`);
  if (n === null || n === undefined) throw new Error(`no element for: ${sel}`);
  out1(`caret ${where} of ${sel} (len ${n})`);
}

async function typeText(text) {
  await send("Input.insertText", { text });
  out1(`typed ${text.length} chars`);
}

async function pressChars(text) {
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
  out1(`pressed ${text.length} chars`);
}

async function imeInput(rest) {
  const m = /^(set|commit|cancel)(?: ([\s\S]*))?$/.exec(rest);
  if (!m) throw new Error("ime needs: set <text> | commit <text> | cancel");
  const text = m[2] ?? "";
  if (m[1] === "set") await send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  else if (m[1] === "commit") await send("Input.insertText", { text });
  else await send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  out1(`ime ${m[1]} ${text.length} chars`);
}

const KEY_MAP = {
  enter:     { key: "Enter",     code: "Enter",     vk: 13, text: "\r" },
  tab:       { key: "Tab",       code: "Tab",       vk: 9,  text: "\t" },
  escape:    { key: "Escape",    code: "Escape",    vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowup:   { key: "ArrowUp",   code: "ArrowUp",   vk: 38 },
  arrowleft:  { key: "ArrowLeft",  code: "ArrowLeft",  vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  delete:    { key: "Delete",    code: "Delete",    vk: 46 },
  home:      { key: "Home",      code: "Home",      vk: 36 },
  end:       { key: "End",       code: "End",       vk: 35 },
  keyz:      { key: "z",         code: "KeyZ",      vk: 90 },
  keyf:      { key: "f",         code: "KeyF",      vk: 70 },
  keym:      { key: "m",         code: "KeyM",      vk: 77 },
  keya:      { key: "a",         code: "KeyA",      vk: 65 },
  keyb:      { key: "b",         code: "KeyB",      vk: 66 },
  keyi:      { key: "i",         code: "KeyI",      vk: 73 },
  keyu:      { key: "u",         code: "KeyU",      vk: 85 },
  keyh:      { key: "h",         code: "KeyH",      vk: 72 },
  keyy:      { key: "y",         code: "KeyY",      vk: 89 },
  keys:      { key: "s",         code: "KeyS",      vk: 83 },
  keyo:      { key: "o",         code: "KeyO",      vk: 79 },
  keye:      { key: "e",         code: "KeyE",      vk: 69 },
  keyk:      { key: "k",         code: "KeyK",      vk: 75 },
  keyc:      { key: "c",         code: "KeyC",      vk: 67 },
  keyx:      { key: "x",         code: "KeyX",      vk: 88 },
  keyv:      { key: "v",         code: "KeyV",      vk: 86 },
  keyp:      { key: "p",         code: "KeyP",      vk: 80 },
  keyt:      { key: "t",         code: "KeyT",      vk: 84 },
};
const KEY_NAMES = "Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Delete, Home, End, KeyZ, KeyF, KeyM, KeyA, KeyB, KeyI, KeyU, KeyH, KeyY, KeyS, KeyO, KeyE, KeyK, KeyC, KeyX, KeyV, KeyP, KeyT";

async function mouseEvent(rest) {
  const m = /^\s*(down|move|up|right|hover)\s+(.+)$/.exec(rest);
  if (!m) throw new Error("mouse needs: down|move|up|right|hover <js giving {x,y}>");
  const pt = await js(m[2]);
  if (!pt) throw new Error(`mouse ${m[1]}: no point from ${m[2]}`);
  const x = Math.trunc(pt.x), y = Math.trunc(pt.y);
  if (m[1] === "down") await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  else if (m[1] === "move") await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  else if (m[1] === "hover") await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  else if (m[1] === "up") await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  else {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
  }
  out1(`mouse ${m[1]} at ${x},${y}`);
}

async function pressKey(name, mods = "") {
  const k = KEY_MAP[String(name).toLowerCase()];
  if (!k) throw new Error(`unknown key '${name}' (have: ${KEY_NAMES})`);
  let m = 0;
  if (/ctrl/.test(mods)) m |= 2;
  if (/shift/.test(mods)) m |= 8;
  if (/alt/.test(mods)) m |= 1;
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: m };
  const down = { type: "keyDown", ...base };
  if (k.text && m === 0) down.text = k.text;
  await send("Input.dispatchKeyEvent", down);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  out1(`key ${mods} ${name}`);
}

async function setViewport(rest) {
  if (/^\s*reset\s*$/.test(rest)) {
    await send("Emulation.clearDeviceMetricsOverride");
    await send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    out1("viewport reset");
    return;
  }
  const p = rest.trim().split(/\s+/);
  if (p.length < 2) throw new Error("viewport needs: <width> <height> [mobile]");
  const w = parseInt(p[0], 10), h = parseInt(p[1], 10);
  const mobile = p.length >= 3 && /mobile/.test(p[2]);
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  out1(`viewport ${w}x${h}${mobile ? " mobile" : ""}`);
}

async function shot(name = "shot") {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 60000);
  const p = path.join(opts.shotDir, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, "base64"));
  out1(`shot ${p}`);
}

async function invokeLine(line) {
  line = line.trim();
  if (!line || line.startsWith("#")) return true;
  const i = line.indexOf(" ");
  const cmd = i < 0 ? line : line.slice(0, i);
  const rest = i < 0 ? "" : line.slice(i + 1);
  switch (cmd.toLowerCase()) {
    case "open":
      await startServer(); await startBrowser(); await connectCdp();
      await go(rest || "/index.html");
      break;
    case "goto": await go(rest); break;
    case "eval": out1(formatVal(await js(rest))); break;
    case "expect": await expectThat(rest); break;
    case "wait":
      checks++;
      try { await waitFor(rest, 20000); out1(`PASS (waited) ${rest}`); }
      catch { failures++; out1(`FAIL (timeout) ${rest}`); }
      break;
    case "waitsel":
      await waitFor(`document.querySelector('${rest}')`, 20000);
      out1(`ok: ${rest}`);
      break;
    case "click": await clickEl(rest); break;
    case "mouse": await mouseEvent(rest); break;
    case "jsclick": {
      const e = resolveSel(rest);
      const ok = await js(`(()=>{const el=${e}; if(!el) return false; el.click(); return true;})()`);
      if (!ok) throw new Error(`no element for: ${rest}`);
      out1(`jsclicked ${rest}`);
      break;
    }
    case "focus": await focusEl(rest); break;
    case "caret": {
      const m = /^(.*)\s+start$/.exec(rest);
      if (m) await setCaret(m[1], "start"); else await setCaret(rest, "end");
      break;
    }
    case "type": await typeText(rest); break;
    case "press": await pressChars(rest); break;
    case "ime": await imeInput(rest); break;
    case "key": {
      const p = rest.trim().split(/\s+/);
      if (p.length >= 2) await pressKey(p[1], p[0].toLowerCase()); else await pressKey(p[0]);
      break;
    }
    case "text": {
      const e = resolveSel(rest);
      out1(formatVal(await js(`(()=>{const el=${e}; return el ? el.innerText : null;})()`)));
      break;
    }
    case "count": out1(formatVal(await js(`document.querySelectorAll('${rest}').length`))); break;
    case "sel": out1(resolveSel(rest)); break;
    case "viewport": await setViewport(rest); break;
    case "shot": await shot(rest || "shot"); break;
    case "logs":
      if (consoleLines.length === 0) out1("(no console output)");
      else for (const l of consoleLines) out1(l);
      break;
    case "sleep": await sleep(parseInt(rest, 10)); break;
    case "quit": return false;
    default: throw new Error(`unknown command: ${cmd}`);
  }
  return true;
}

async function main() {
  let exit = 0;
  try {
    let lines;
    if (opts.script) {
      if (!fs.existsSync(opts.script)) throw new Error(`script not found: ${opts.script}`);
      lines = fs.readFileSync(opts.script, "utf8").replace(/^﻿/, "").split(/\r?\n/);
    } else {
      lines = fs.readFileSync(0, "utf8").replace(/^﻿/, "").split(/\r?\n/);
    }
    for (const line of lines) {
      try { if (!(await invokeLine(line))) break; }
      catch (e) {
        if (e.notStarted) { out1(`NOT STARTED: ${e.message}`); checks++; }
        else out1(`ERROR: ${e.message}`);
        failures++; exit = 1;
        if (e.fatal) break;
      }
    }
    if (checks === 0 && failures === 0) {
      out1("WARNING: no expect/wait assertions ran - this proved nothing.");
    }
    const passed = checks - failures;
    let summary = `RESULT: ${passed}/${checks} checks passed`;
    if (failures > 0) summary += ` - ${failures} FAILED`;
    out1("");
    out1(summary);
    if (failures > 0 || checks === 0) exit = 1;
  } catch (e) {
    out1(`ERROR: ${e.message}`);
    exit = 1;
  } finally {
    try { ws?.close(); } catch {}
    if (browserProc) { try { browserProc.kill("SIGKILL"); } catch {} }
    sweepBrowsers(userDataDir);
    if (server) { try { server.close(); } catch {} }
    if (userDataDir) {
      await sleep(300);
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }
    log(`done (exit ${exit})`);
  }
  process.exit(exit);
}

main();
