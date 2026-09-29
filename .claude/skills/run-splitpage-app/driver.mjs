/*
 * Splitpage driver, Node edition — serves the app on http://localhost:<port>/
 * and drives a headless Chromium over the Chrome DevTools Protocol.
 *
 * A line-for-line port of driver.ps1, which only runs on Adam's Windows
 * machine (PowerShell 5.1 + .NET + msedge.exe). This one runs anywhere Node 22
 * and a Chromium build exist — in particular the Linux cloud container, where
 * there is no PowerShell and no Edge. The two drivers read the SAME test
 * scripts and print the SAME lines, so a suite is never rewritten for one of
 * them: `tests/*.txt` stay the single source of truth and run-tests.ps1's
 * "RESULT:" parsing still works if it is ever pointed here.
 *
 * Node built-ins only, like every other harness in this repo: node:http for
 * the static server, the global WebSocket (Node 22) for CDP, node:child_process
 * for the browser. No npm install, nothing to keep in sync.
 *
 *   node .claude/skills/run-splitpage-app/driver.mjs --script tests/01-core.txt
 *   ... --port 8795 --cdp-port 9337   pin the ports
 *   ... --headed                      real window (needs a DISPLAY; try xvfb-run)
 *   ... --chrome <path>               override browser discovery
 *
 * See SKILL.md for the command list.
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ args */
function parseArgs(argv) {
  const out = {
    port: 8791, cdpPort: 9333, root: path.resolve(HERE, "..", "..", ".."),
    shotDir: path.join(os.tmpdir(), "splitpage-shots"),
    headed: false, script: null, runId: null, chrome: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // PowerShell-style single-dash flags are accepted too, so a command line
    // copied out of SKILL.md or HANDOFF.md works against either driver.
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
      case "headed": out.headed = true; break;
      case "h": case "help":
        console.log("usage: node driver.mjs --script <file> [--port N] [--cdp-port N] [--root DIR] [--shot-dir DIR] [--chrome PATH] [--headed]");
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

/* -------------------------------------------------------- static server */
/* Mirrors driver.ps1's own HttpListener rather than reusing start.mjs:
   start.mjs also opens the URL in a real browser window. */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
};

let server = null;
async function startServer() {
  if (server) return;
  const root = opts.root;
  server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
    catch { res.statusCode = 400; return res.end(); }
    if (p === "/") p = "/index.html";
    const f = path.resolve(root, "." + p);
    // path.resolve collapses "..", so a request can never climb out of root.
    if (f !== root && !f.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
    let body;
    try {
      if (!fs.statSync(f).isFile()) { res.statusCode = 404; return res.end(); }
      body = fs.readFileSync(f);
    } catch { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", MIME[path.extname(f).toLowerCase()] || "application/octet-stream");
    res.setHeader("Content-Length", body.length);
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  log(`server up on http://localhost:${opts.port}/ (root ${root})`);
}

/* -------------------------------------------------------------- browser */
/* Edge on Windows, Playwright's Chromium in the cloud container, or whatever
   chromium/chrome is on PATH. --chrome overrides all of it. */
function findBrowser() {
  if (opts.chrome) {
    if (!fs.existsSync(opts.chrome)) throw new Error(`--chrome not found: ${opts.chrome}`);
    return opts.chrome;
  }
  if (process.env.SPLITPAGE_CHROME && fs.existsSync(process.env.SPLITPAGE_CHROME)) {
    return process.env.SPLITPAGE_CHROME;
  }
  const cands = [];
  // The container sets PLAYWRIGHT_BROWSERS_PATH and forbids re-downloading, so
  // look inside it rather than shelling out to playwright.
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      if (!/^chromium-/.test(d)) continue;      // headless_shell can't screenshot a real window
      // Playwright's own layout, which has changed under us: older builds
      // unpack to chrome-linux/, and the Chrome-for-Testing builds newer
      // Playwright downloads unpack to chrome-linux64/. Both are listed
      // rather than one being picked, because a machine can hold either —
      // and getting this wrong does not fail loudly, it falls through to
      // whatever is on PATH. On a GitHub runner that is /usr/bin/chromium,
      // a snap wrapper that starts and never opens a CDP port, so the whole
      // suite fails with "no CDP page target" and nothing says why.
      cands.push(path.join(pw, d, "chrome-linux", "chrome"));
      cands.push(path.join(pw, d, "chrome-linux64", "chrome"));
      cands.push(path.join(pw, d, "chrome-mac", "Chromium.app", "Contents/MacOS/Chromium"));
      cands.push(path.join(pw, d, "chrome-mac-arm64", "Chromium.app", "Contents/MacOS/Chromium"));
      cands.push(path.join(pw, d, "chrome-win", "chrome.exe"));
      cands.push(path.join(pw, d, "chrome-win64", "chrome.exe"));
      // And a catch-all for the next rename: any chrome-*/ holding an
      // executable called chrome (or chrome.exe).
      try {
        for (const sub of fs.readdirSync(path.join(pw, d))) {
          if (!/^chrome-/.test(sub)) continue;
          cands.push(path.join(pw, d, sub, "chrome"));
          cands.push(path.join(pw, d, sub, "chrome.exe"));
        }
      } catch { /* not a directory — the next candidate will do */ }
    }
  }
  if (process.platform === "win32") {
    cands.push(`${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`);
    cands.push(`${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`);
  }
  // google-chrome before chromium: on Ubuntu (and so on a GitHub runner)
  // /usr/bin/chromium is a snap wrapper that cannot be driven over CDP,
  // while google-chrome is a real binary.
  cands.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  try {
    const p = execFileSync("sh", ["-c", "command -v google-chrome || command -v chromium || command -v chrome"], { encoding: "utf8" }).trim();
    if (p) return p;
  } catch {}
  throw new Error("no Chromium/Edge found — pass --chrome <path> or set SPLITPAGE_CHROME");
}

/* True when something already accepts connections on 127.0.0.1:port. */
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
  // A browser still holding --cdp-port (a leftover from an earlier run, most
  // often) would answer /json/list in place of ours: connectCdp attaches to
  // it and every command then times out. Refuse up front instead.
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
  // The container runs as root, where Chromium's sandbox refuses to start.
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }
  // Escape hatch for environment-specific flags (a proxy, a CA, a feature
  // switch) without editing this file: SPLITPAGE_CHROME_ARGS="--a --b".
  if (process.env.SPLITPAGE_CHROME_ARGS) {
    args.push(...process.env.SPLITPAGE_CHROME_ARGS.split(/\s+/).filter(Boolean));
  }
  if (!opts.headed) args.unshift("--headless=new");
  args.push("about:blank");
  browserProc = spawn(exe, args, { stdio: ["ignore", "ignore", "ignore"], detached: false });
  browserProc.on("error", (e) => { throw new Error(`failed to launch ${exe}: ${e.message}`); });
  log(`browser pid=${browserProc.pid} exe=${exe} cdp=${opts.cdpPort} headless=${!opts.headed}`);
}

/* On Windows, killing the msedge.exe we spawned does not take down the real
   browser tree: it lives on, keeps --remote-debugging-port, and the next run
   on that port attaches to it. Stop every msedge.exe whose command line
   carries THIS run's profile directory. Never match by name alone, which
   would close the user's own Edge. Mirrors driver.ps1's sweep. */
function sweepBrowsers(dir) {
  if (process.platform !== "win32" || !dir) return;
  // The directory goes in through the environment, not the command string, so
  // nothing in it can be read as PowerShell. .Contains is a literal match
  // (-like would treat [ ] in a --run-id as wildcards). A second pass catches
  // any child that started while the first one was stopping its parent.
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
    // -EncodedCommand (UTF-16LE base64) sidesteps Windows argument quoting,
    // which mangles the embedded quotes and newlines of a plain -Command.
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], {
      stdio: "ignore", timeout: 30000,
      env: { ...process.env, SPLITPAGE_SWEEP_DIR: path.basename(dir) },
    });
  } catch (e) {
    log(`browser sweep failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ cdp */
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
  // A socket that dies mid-suite must fail the pending command, not hang it.
  ws.addEventListener("close", () => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("CDP websocket closed")); }
    pending.clear();
  });
  log("cdp connected");
  await send("Page.enable");
  await send("Runtime.enable");
  // Every suite runs in the light theme, whatever the machine's own (#169).
  // A headless browser takes prefers-color-scheme from the OS, so on a
  // machine set to dark mode the app drew its dark palette and every suite
  // that reads a colour back (12's gear rule, 94's and 96's lamps) failed
  // against values that are right in the light theme the suites are written
  // for. A suite that wants the dark theme says so by setting data-theme on
  // <html> itself (96 and 97 do). driver.ps1 does the same.
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  // The first-run wizard shows itself over the pristine demo (invariant #30),
  // which is exactly what every suite loads — and its backdrop swallows the
  // real mouse clicks the suites make. Mark onboarding as done before any
  // page script runs, unless the script asked for the wizard with ?wizard=1
  // (13-onboarding.txt does). Runs again on every navigation, so a suite
  // that removes the key and reloads without ?wizard=1 still gets no wizard.
  // The New Tab page (20j-newtab.js) shows itself over the same pristine
  // demo, for the same reason and with the same effect on every suite that
  // clicks into it — off unless the script asked for it with ?newtab=1
  // (30-new-tab.txt does).
  // No suite touches the network (#141, #168): __splitpageNoRemote keeps a
  // pasted YouTube or Vimeo link's thumbnail fetch and the gallery's player
  // frame off the real hosts unless the suite installs a fake of its own
  // (window.__videoTest, src/js/05v-video.js). driver.ps1 does the same.
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

/* driver.ps1's Format-Val. `undefined` prints as "null" because PowerShell has
   no undefined: CDP omits result.value and the variable lands as $null. Keep
   it that way — suites were written against that output. */
function formatVal(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/* PowerShell truthiness, which is not JS truthiness: an empty array is false
   there and true here, and a one-element array is its element. `expect` is
   specified against the PowerShell rules, so reproduce them. */
function truthy(v) {
  if (Array.isArray(v)) {
    if (v.length === 0) return false;
    if (v.length === 1) return truthy(v[0]);
    return true;
  }
  return !!v;
}

/* ----------------------------------------------------------- assertions */
let checks = 0;
let failures = 0;

// expect <js>            — truthy, right now, no waiting
// expect <js> == <value> — compare against a literal (string, number, bool)
// Splitting on the LAST '==' so the expression may contain '===' freely.
async function expectThat(rest) {
  checks++;
  let expr = rest, want = null, hasWant = false;
  const i = rest.lastIndexOf("==");
  // only treat it as a comparison if the '==' isn't part of '===' or '!=='
  if (i > 0 && !"=!<>".includes(rest[i - 1])) {
    expr = rest.slice(0, i).trim();
    want = rest.slice(i + 2).trim();
    hasWant = true;
  }
  const got = await js(expr);
  if (hasWant) {
    const g = formatVal(got);
    // PowerShell's -eq on strings is case-insensitive, and the suites lean on
    // it: `expect ... == false` compares against PowerShell's "False". Match
    // that or ~120 existing assertions would fail against a healthy app.
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

/* -------------------------------------------------------------- actions */
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

// A CSS selector, or one of:
//   text=Some Label   smallest visible element whose trimmed innerText EQUALS it
//   text*=Some Label  ... whose innerText CONTAINS it
// Prefer text*= for Splitpage's header buttons: Production and Comments grow a
// count badge inside them ("Production2"), so exact matching stops working the
// moment the document has any tags or comments.
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

// A box measured once and trusted can already be stale by the time the two
// Input.dispatchMouseEvent round trips actually reach Chromium. Confirmed
// cause (issue #31): a header button sits inside `.topbar`, which is
// `position: sticky` and condenses on scroll (src/js/20i-topbar.js) through
// a scroll listener that is deliberately rAF-coalesced, i.e. asynchronous.
// Calling `scrollIntoView` on an element that is already fully visible is
// its own trap on a sticky ancestor: Chromium computes the scroll target
// from the element's un-stuck static position, so "already visible" gets
// scrolled anyway — which is exactly the kind of scroll that flips
// `.is-condensed` a frame later and moves the button. Measured live: a
// pixel that was the button a moment before (`elementFromPoint` returning
// it, topbar condensed, scrollY 86) had the topbar decondensed and scrollY
// reset to 0 by the time the click's own box came back, moving the button
// out from under the coordinates already queued for dispatch. Fixed here by
// (1) not scrolling at all when the element is already fully in the
// viewport, (2) waiting two animation frames for any pending layout class
// toggle to land before trusting a measurement, and (3) confirming with
// `elementFromPoint` that the point about to be dispatched is really the
// element (or a descendant of it), retrying a few times before giving up.
// This also covers a panel that is mid open-transition (comments-panel's
// 0.18s transform) and briefly reports zero size.
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
    // Let a pending requestAnimationFrame (the condensing topbar, a CSS
    // transition finishing) land before measuring again.
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

// Focus a contenteditable AND drop the caret in it. Plain .focus() leaves the
// selection collapsed at offset 0 (or nowhere at all), so typed characters land
// at the top of the cell or are swallowed entirely.
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

// Per-character key events. Handlers that watch keydown — Splitpage's [ ] { }
// ~ ~ tag shortcuts do — never fire for Input.insertText.
async function pressChars(text) {
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
  out1(`pressed ${text.length} chars`);
}

const KEY_MAP = {
  enter:     { key: "Enter",     code: "Enter",     vk: 13, text: "\r" },
  tab:       { key: "Tab",       code: "Tab",       vk: 9,  text: "\t" },
  escape:    { key: "Escape",    code: "Escape",    vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowup:   { key: "ArrowUp",   code: "ArrowUp",   vk: 38 },
  // prompter scene-mode step keys (issue #26)
  arrowleft:  { key: "ArrowLeft",  code: "ArrowLeft",  vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  delete:    { key: "Delete",    code: "Delete",    vk: 46 },
  home:      { key: "Home",      code: "Home",      vk: 36 },
  end:       { key: "End",       code: "End",       vk: 35 },
  keyz:      { key: "z",         code: "KeyZ",      vk: 90 },
  keyf:      { key: "f",         code: "KeyF",      vk: 70 },
  keym:      { key: "m",         code: "KeyM",      vk: 77 },
  // the rich-text shortcuts, which are otherwise only reachable by calling
  // execCommand directly — which tests the browser, not Splitpage's handler
  keya:      { key: "a",         code: "KeyA",      vk: 65 },
  keyb:      { key: "b",         code: "KeyB",      vk: 66 },
  keyi:      { key: "i",         code: "KeyI",      vk: 73 },
  keyu:      { key: "u",         code: "KeyU",      vk: 85 },
  // Ctrl/Cmd+Alt+H: hide-shot-scenes toggle (issue #25)
  keyh:      { key: "h",         code: "KeyH",      vk: 72 },
  // Ctrl+Y: redo, the other spelling of Ctrl+Shift+Z
  keyy:      { key: "y",         code: "KeyY",      vk: 89 },
  // the File menu's shortcuts (#145-#147): Save / Save a copy, Open,
  // Export…, and the command menu
  keys:      { key: "s",         code: "KeyS",      vk: 83 },
  keyo:      { key: "o",         code: "KeyO",      vk: 79 },
  keye:      { key: "e",         code: "KeyE",      vk: 69 },
  keyk:      { key: "k",         code: "KeyK",      vk: 75 },
  // the clipboard's own keys (#204: copy, cut and paste whole scenes)
  keyc:      { key: "c",         code: "KeyC",      vk: 67 },
  keyx:      { key: "x",         code: "KeyX",      vk: 88 },
  keyv:      { key: "v",         code: "KeyV",      vk: 86 },
  // the annotation editor's tool keys (P, H, T, E; 2026-09-27)
  keyp:      { key: "p",         code: "KeyP",      vk: 80 },
  keyt:      { key: "t",         code: "KeyT",      vk: 84 },
};
const KEY_NAMES = "Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Delete, Home, End, KeyZ, KeyF, KeyM, KeyA, KeyB, KeyI, KeyU, KeyH, KeyY, KeyS, KeyO, KeyE, KeyK, KeyC, KeyX, KeyV, KeyP, KeyT";

// mouse down|move|up|right <js expression giving {x, y}> — one real CDP mouse
// event at a viewport point the page works out (#204: a drag out of a text
// box, which only a held button moving across the page can make). `move`
// carries the held left button; `right` is a right-click (press + release).
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
  // PowerShell hashtable lookup is case-insensitive; the suites write `key Tab`
  // and `key ctrl Enter`, so keep names case-insensitive here too.
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

// viewport 375 812 mobile   — width height [mobile]
// viewport reset
// "mobile" also sets touch points and a mobile UA, which is what flips
// Splitpage's (hover: none) rules and its IS_TOUCH gestures.
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
  // maxTouchPoints must be 1..16 even when disabling: CDP validates the field
  // before it looks at `enabled`, so passing 0 threw on every non-mobile
  // `viewport <w> <h>` and counted as a failing check.
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  out1(`viewport ${w}x${h}${mobile ? " mobile" : ""}`);
}

async function shot(name = "shot") {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 60000);
  const p = path.join(opts.shotDir, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, "base64"));
  out1(`shot ${p}`);
}

/* --------------------------------------------------------------- runner */
async function invokeLine(line) {
  line = line.trim();
  if (!line || line.startsWith("#")) return true;
  // Split on the FIRST space only — splitting on \s+ would eat a leading space
  // in the argument, and "press  [gaffer tape]" needs that space to survive.
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
    // selectors may contain spaces, so only a trailing " start" is an arg
    case "caret": {
      const m = /^(.*)\s+start$/.exec(rest);
      if (m) await setCaret(m[1], "start"); else await setCaret(rest, "end");
      break;
    }
    case "type": await typeText(rest); break;
    case "press": await pressChars(rest); break;
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
      // Always UTF-8, and strip a BOM: the suites carry em dashes and bullets
      // in their assertions, and decoding them wrong fails a healthy app.
      lines = fs.readFileSync(opts.script, "utf8").replace(/^﻿/, "").split(/\r?\n/);
    } else {
      lines = fs.readFileSync(0, "utf8").replace(/^﻿/, "").split(/\r?\n/);
    }
    for (const line of lines) {
      try { if (!(await invokeLine(line))) break; }
      catch (e) {
        out1(`ERROR: ${e.message}`); failures++; exit = 1;
        // Nothing after this line could run; don't print a FAIL per command.
        if (e.fatal) break;
      }
    }
    // A run that asserted nothing is a run that proved nothing.
    if (checks === 0 && failures === 0) {
      out1("WARNING: no expect/wait assertions ran - this proved nothing.");
    }
    const passed = checks - failures;
    let summary = `RESULT: ${passed}/${checks} checks passed`;
    if (failures > 0) summary += ` - ${failures} FAILED`;
    out1("");
    out1(summary);
    // The RESULT line stays the contract for run-tests.ps1, but the exit code
    // has to agree with it or a CI job built on this driver is green on red.
    // A suite that asserted nothing counts as a failure for the same reason.
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
