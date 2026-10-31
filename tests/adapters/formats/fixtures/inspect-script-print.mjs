import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { log } from "node:console";
import assert from "node:assert/strict";

const out = process.argv[2];
const lists = process.argv[3] === "--lists";
assert.ok(out, "Pass an output directory");
mkdirSync(out, { recursive: true });
const chrome = process.env.SPLITPAGE_CHROME || join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe");
assert.ok(existsSync(chrome), "Set SPLITPAGE_CHROME to a Chromium executable");
const browser = spawn(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=" + (process.env.PRINT_CDP_PORT || "15780"), "--user-data-dir=" + join(out, "profile"), "about:blank"],
{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let ws;
const pending = new Map();
let id = 0;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chromium endpoint timed out")), 30000);
    browser.once("error", reject);
    browser.stderr.on("data", (data) => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(String(data));
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const targets = await (await globalThis.fetch(endpoint.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*/, "/json/list"))).json();
  const page = targets.find((target) => target.type === "page");
  assert.ok(page, "No Chromium page target");
  ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  await once(ws, "open");
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + " timed out")); }, 30000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { media: "print" });
  await send("Emulation.setDeviceMetricsOverride", { width: 701, height: 940, deviceScaleFactor: 1, mobile: false });
  let checks = 0;
  const records = [];
  const cases = lists ? ["prop-rich", "gear-rich", "shots-rich", "script-rich", "prop-empty", "gear-empty", "shots-empty", "script-empty",
    "prop-long", "gear-long", "shots-long", "script-long", "flagged-location", "shot-person", "unshot-scene"] : ["rich", "empty", "long"];
  for (const kind of cases) {
    const path = fileURLToPath(new globalThis.URL(`_${lists ? "list" : "script"}-print-${kind}.html`, import.meta.url));
    await send("Page.navigate", { url: pathToFileURL(path).href });
    await evaluate(`new Promise(resolve => { const ready = async () => { await document.fonts.ready; await Promise.all(Array.from(document.images, i => i.decode())); resolve(true); }; if (document.readyState === 'complete') ready(); else addEventListener('load', ready, {once:true}); })`);
    const result = await evaluate(`({print:matchMedia('print').matches,width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,cells:Array.from(document.querySelectorAll('td')).every(e=>e.scrollWidth<=e.clientWidth+1),images:Array.from(document.images).every(e=>e.naturalWidth>0&&e.getBoundingClientRect().width<=e.parentElement.getBoundingClientRect().width),text:document.querySelector('main').textContent})`);
    assert.equal(result.print, true); checks++;
    assert.equal(result.scroll, result.width); checks++;
    assert.equal(result.cells, true); checks++;
    assert.equal(result.images, true); checks++;
    if (kind === "long") {
      assert.match(result.text, /Visual line 179/); checks++;
      assert.match(result.text, /Audio line 159/); checks++;
      assert.match(result.text, /Scene 18 audio/); checks++;
    }
    if (lists) {
      if (kind.endsWith("long")) {
        if (kind.startsWith("prop") || kind.startsWith("script")) { assert.match(result.text, /Packing note line 99/); checks++; }
        if (kind.startsWith("shots") || kind.startsWith("script")) { assert.match(result.text, /Shot description line 109/); checks++; }
        if (kind.startsWith("gear")) { assert.match(result.text, /Spare 089/); checks++; }
      }
      if (kind === "script-rich" || kind === "script-long") {
        assert.match(result.text, /End reply/); checks++;
        const order = await evaluate("Array.from(document.querySelectorAll('section'), e => e.id)");
        assert.deepEqual(order, ["script", "production-breakdown", "broll-shot-list", "comments"]); checks++;
      }
      const layout = await evaluate("({heads:Array.from(document.querySelectorAll('thead'), e=>getComputedStyle(e).display),landscape:!!document.querySelector('.shot-list')&&getComputedStyle(document.querySelector('#broll-shot-list')).page,boxes:document.querySelectorAll('.list-checkbox').length})");
      assert.ok(layout.heads.every((display) => display === "table-header-group")); checks++;
      if (kind.startsWith("shots") || kind === "script-rich" || kind === "script-long") { assert.equal(layout.landscape, "shot-list"); checks++; }
    }
    const pdf = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true, generateTaggedPDF: true });
    const bytes = Buffer.from(pdf.data, "base64");
    const pages = (bytes.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
    assert.ok(lists ? (kind.endsWith("long") ? pages >= 2 : pages >= 1) : kind === "long" ? pages >= 5 : pages === (kind === "empty" ? 1 : 2), `${kind}: ${pages} pages`); checks++;
    if (lists && (kind.startsWith("shots") || kind.startsWith("script") && !kind.endsWith("empty"))) {
      assert.match(bytes.toString("latin1"), /\/MediaBox \[0 0 792 612\]/); checks++;
    }
    if (lists && kind.startsWith("script")) { assert.match(bytes.toString("latin1"), /\/MediaBox \[0 0 612 792\]/); checks++; }
    writeFileSync(join(out, kind + ".pdf"), bytes);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(out, kind + ".png"), Buffer.from(shot.data, "base64"));
    records.push(`${kind}: ${pages} printed pages; print media, cell wrapping, image bounds and horizontal clipping passed`);
  }
  writeFileSync(join(out, "summary.txt"), records.join("\n") + `\n${checks}/${checks} checks passed\n`);
  log(records.join("\n"));
  log(`${checks}/${checks} checks passed`);
} finally {
  ws?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  if (browser.exitCode === null) {
    if (process.platform === "win32") {
      const kill = spawn("taskkill", ["/T", "/F", "/PID", String(browser.pid)], { stdio: "ignore", windowsHide: true });
      await once(kill, "exit");
    } else browser.kill("SIGKILL");
    if (browser.exitCode === null) await once(browser, "exit");
  }
}
