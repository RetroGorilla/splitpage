// Compares ways of painting the gap between beats when the first beat ends mid-sentence.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 9431;
const exe = `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`;
const profile = path.join(os.tmpdir(), "writer-gap-" + process.pid);
fs.mkdirSync(profile, { recursive: true });
const browser = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=1100,700", "--enable-features=WinUseBrowserSpellChecker", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const waiting = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject, method }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async expression => {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  return out.result.value;
};
async function key(name, vk, mods = 0) {
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(15);
}
async function typeChar(ch) {
  const vk = ch.toUpperCase().charCodeAt(0);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

const CSS = `
body { font: 22px/1.7 Georgia, serif; margin: 30px; background: #fff; color: #111; }
#doc { outline: none; white-space: pre-wrap; max-width: 900px; }
.margin .b + .b { margin-left: .28em; }
.before .b + .b::before { content: " "; white-space: pre; }
.gap { white-space: pre; user-select: none; }
`;
const A = "We went to the store", B = "and bought some milk";
const candidates = {
  margin: `<div id="doc" class="margin" contenteditable spellcheck="true"><span class="b" id="A">${A}</span><span class="b" id="B">${B}</span></div>`,
  before: `<div id="doc" class="before" contenteditable spellcheck="true"><span class="b" id="A">${A}</span><span class="b" id="B">${B}</span></div>`,
  noneditable: `<div id="doc" contenteditable spellcheck="true"><span class="b" id="A">${A}</span><span class="gap" contenteditable="false"> </span><span class="b" id="B">${B}</span></div>`,
  zwsp: `<div id="doc" class="margin" contenteditable spellcheck="true"><span class="b" id="A">${A}</span>​<span class="b" id="B">${B}</span></div>`
};
const WHERE = `(() => { const s = getSelection(); const n = s.focusNode; const e = n.nodeType === 3 ? n.parentElement : n; const owner = e.closest(".b")?.id ?? e.className ?? e.id; return owner + ":" + s.focusOffset; })()`;
const place = (idName, at) => ev(`(() => { const t = document.getElementById("${idName}").firstChild; document.getElementById("doc").focus(); getSelection().collapse(t, ${at}); })()`);

async function probe(name, html) {
  const out = {};
  await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><style>${CSS}</style>${html}`) });
  await sleep(250);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const point = await ev(`(() => { const t = document.getElementById("A").firstChild; const r = document.createRange(); r.setStart(t, 16); r.setEnd(t, 19); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 2 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 2 });
  await sleep(30);
  out.doubleClickStore = await ev("getSelection().toString()");

  await place("A", 15);
  const words = [];
  for (let i = 0; i < 3; i++) { await key("ArrowRight", 39, 2); words.push(await ev(WHERE)); }
  out.ctrlRightFromStore = words.join(" ");

  await place("A", 19);
  const steps = [];
  for (let i = 0; i < 4; i++) { await key("ArrowRight", 39); steps.push(await ev(WHERE)); }
  out.rightFromNearEnd = steps.join(" ");

  await place("B", 2);
  const backs = [];
  for (let i = 0; i < 4; i++) { await key("ArrowLeft", 37); backs.push(await ev(WHERE)); }
  out.leftFromB = backs.join(" ");

  await ev(`window.__targets = []; document.getElementById("doc").addEventListener("beforeinput", e => { const r = e.getTargetRanges()[0]; const name = n => (n.nodeType === 3 ? n.parentElement : n).id || (n.nodeType === 3 ? n.parentElement : n).className; window.__targets.push(e.inputType + (r ? " " + name(r.startContainer) + ":" + r.startOffset + "-" + name(r.endContainer) + ":" + r.endOffset : "")); e.preventDefault(); });`);
  await place("B", 0);
  await key("Backspace", 8, 2);
  await place("A", 20);
  await key("Delete", 46, 2);
  await place("B", 0);
  await key("Backspace", 8);
  await place("A", 20);
  await key("Delete", 46);
  out.deleteTargets = await ev("window.__targets");

  await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><style>${CSS}</style>${html}`) });
  await sleep(250);
  await place("A", 20);
  await typeChar("x");
  await place("B", 0);
  await typeChar("y");
  await sleep(30);
  out.typedAtEdges = await ev(`document.getElementById("doc").innerHTML`);

  await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><style>${CSS}</style>${html}`) });
  await sleep(250);
  await place("A", 20);
  await typeChar(" ");
  await key("Backspace", 8);
  await place("B", 20);
  await typeChar(" ");
  await sleep(1200);
  await ev(`document.activeElement.blur(); document.getElementById("doc").focus();`);
  await sleep(600);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(here, "dist", `gap-${name}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  out.screenshot = file;
  return out;
}

try {
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find(t => t.type === "page");
      if (target) {
        ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
        ws.addEventListener("message", e => {
          const msg = JSON.parse(e.data);
          const w = msg.id && waiting.get(msg.id);
          if (w) { waiting.delete(msg.id); if (msg.error) w.reject(new Error(w.method + ": " + msg.error.message)); else w.resolve(msg.result); }
        });
      }
    } catch { await sleep(250); }
  }
  await send("Page.enable");
  await send("Runtime.enable");
  for (const [name, html] of Object.entries(candidates)) {
    console.log("== " + name);
    console.log(JSON.stringify(await probe(name, html), null, 1));
  }
} finally {
  try { ws?.close(); } catch { /* closing */ }
  browser.kill();
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${path.basename(profile)}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", timeout: 30000 }); } catch { /* best effort */ }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}
process.exit(0);
