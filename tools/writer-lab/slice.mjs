// Phase 0b: drives the real app with the flow writer switched on, in real Electron and headless Edge.
// usage: node tools/writer-lab/slice.mjs [--target electron|edge] [--only <text>] [--old-timing] [--profile]
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const arg = name => { const at = process.argv.indexOf("--" + name); return at === -1 ? null : process.argv[at + 1]; };
const target = arg("target") || "electron";
const only = arg("only");
const oldTiming = process.argv.includes("--old-timing");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

class Cdp {
  constructor(url) { this.url = url; this.n = 0; this.waiting = new Map(); this.problems = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.addEventListener("open", res, { once: true }); this.ws.addEventListener("error", rej, { once: true }); });
    this.ws.addEventListener("message", ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(w.method + ": " + msg.error.message)); else w.resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.problems.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.problems.push(msg.params.args.map(a => a.value ?? a.description).join(" "));
      } else if (this.heard?.has(msg.method)) {
        this.heard.get(msg.method)(msg.params);
      }
    });
  }
  on(method, fn) { (this.heard ??= new Map()).set(method, fn); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const n = ++this.n;
      this.waiting.set(n, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* closing */ } }
}

let cdp, mainCdp = null, pageUrl = "";
async function ev(expression) {
  const out = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  return out.result.value;
}
const settle = () => ev("new Promise(r => setTimeout(r, 15))");
async function poll(expression, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(expression).catch(() => false)) return true;
    await sleep(40);
  }
  return false;
}

const KEYS = {
  Backspace: [8, "Backspace"], Delete: [46, "Delete"], Enter: [13, "Enter", "\r"], ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"],
  ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], Home: [36, "Home"], End: [35, "End"], Escape: [27, "Escape"], Tab: [9, "Tab"]
};
async function key(name, mods = "") {
  let m = 0;
  if (/ctrl/.test(mods)) m |= 2;
  if (/shift/.test(mods)) m |= 8;
  if (/alt/.test(mods)) m |= 1;
  const known = KEYS[name];
  const vk = known ? known[0] : name.toUpperCase().charCodeAt(0);
  const code = known ? known[1] : "Key" + name.toUpperCase();
  const base = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m };
  const down = { type: "keyDown", ...base };
  if (known && known[2] && m === 0) down.text = known[2];
  if (!known && m === 0) down.text = name;
  await cdp.send("Input.dispatchKeyEvent", down);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await settle();
}
function virtualKey(ch) { return /^[a-z0-9 ]$/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0; }
async function typeChar(ch) {
  const vk = virtualKey(ch);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
async function type(text) { for (const ch of text) await typeChar(ch); await settle(); }
async function clickAt(selector) {
  const box = await ev(`(function(){const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const base = { x: box.x, y: box.y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  await settle();
}

const beat = (rowId, offset) => ({ kind: "beat", rowId, offset });
async function select(anchor, head) { await ev(`__writerFlowTest.place(${JSON.stringify({ anchor, head: head ?? anchor })})`); await settle(); }
const caret = (rowId, offset) => select(beat(rowId, offset));
const state = () => ev("window.__splitpageFormats.state()");
const sel = () => ev("__writerFlowTest.selection()");
const shown = () => ev(`Array.from(document.querySelectorAll("#writer-doc .wr-beat")).map(el => el.textContent.replace(/\\u200B/g, ""))`);
const plain = html => String(html ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
async function textOf(id) { return plain((await state()).rows.find(r => r.id === id)?.audioText); }
const withoutStamps = rows => rows.map(({ updatedAt: _a, updatedBy: _b, ...row }) => row);
async function snapshot() {
  const s = await state();
  return JSON.stringify({ rows: withoutStamps(s.rows), sections: s.sections ?? null, comments: s.comments.map(c => c.id) });
}
function same(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) return;
  let at = 0;
  while (at < x.length && at < y.length && x[at] === y[at]) at++;
  const from = Math.max(0, at - 60);
  throw new Error(`${label}: expected …${y.slice(from, at + 100)}…, got …${x.slice(from, at + 100)}…`);
}
function ok(value, label) { if (!value) throw new Error(label); }

const results = [];
async function t(name, body, opts = {}) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  const before = cdp.problems.length;
  try {
    await body();
    if (!opts.skipCheck) {
      const drift = await ev("__writerFlowTest.check()");
      if (drift.length) throw new Error("screen differs from the script: " + drift[0]);
    }
    if (cdp.problems.length > before) throw new Error("page error: " + cdp.problems[before]);
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, why: String(error.message || error).slice(0, 500) });
  }
}

let SCHEMA = 0;
const fixture = () => ({
  title: "Slice fixture", docId: "d" + "3".repeat(32), schema: SCHEMA,
  rows: [
    { id: "ra", audioText: "Alpha one.", visualText: "", status: "todo", imageRef: null },
    { id: "rb", audioText: "Bravo two.", visualText: "Desk shot", status: "shot", imageRef: null },
    { id: "rc", audioText: "Charlie <strong>bold</strong> end.", visualText: "", status: "todo", imageRef: null, paragraphStart: true },
    { id: "rd", audioText: "", visualText: "Street b-roll", status: "todo", imageRef: null },
    { id: "re", audioText: "Echo five", visualText: "", status: "todo", imageRef: null },
    { id: "rf", audioText: "Foxtrot six.", visualText: "", status: "todo", imageRef: null, paragraphStart: true }
  ],
  sections: [{ id: "s1", name: "Opening", firstSceneId: "ra" }, { id: "s2", name: "Middle", firstSceneId: "rf" }],
  comments: []
});

async function closeWriter() {
  await ev(`(function(){const w=document.getElementById("writer"); if(!w.hidden) document.getElementById("wr-close").click(); return true;})()`);
  await settle();
}
async function openWriter() {
  await ev(`document.getElementById("btn-write").click()`);
  ok(await poll(`!document.getElementById("writer").hidden && window.__writerFlowTest && __writerFlowTest.on()`, 4000), "the flow writer never opened");
  await settle();
}
async function loadDoc(raw) {
  await closeWriter();
  await ev(`window.__splitpageFormats.openFile(new File([${JSON.stringify(JSON.stringify(raw))}], "slice.splitpage")); true`);
  ok(await poll(`window.__splitpageFormats.state().title === ${JSON.stringify(raw.title)} && window.__splitpageFormats.state().docId === ${JSON.stringify(raw.docId)} && document.querySelectorAll("#rows .row").length === ${raw.rows.length}`), "the fixture never loaded");
  await settle();
}
async function fresh(raw) {
  await loadDoc(raw ?? fixture());
  await openWriter();
}

async function menuClick(role) {
  ok(mainCdp, "no connection to Electron's main process");
  const out = await mainCdp.send("Runtime.evaluate", {
    includeCommandLineAPI: true, returnByValue: true, awaitPromise: true,
    expression: `(function(){
      const { Menu, BrowserWindow, webContents } = process.mainModule ? process.mainModule.require("electron") : require("electron");
      const find = items => { for (const item of items) { if (item.label && item.label.toLowerCase() === ${JSON.stringify(role)}) return item; if (item.submenu) { const got = find(item.submenu.items); if (got) return got; } } return null; };
      const item = find(Menu.getApplicationMenu().items);
      if (!item) return "no " + ${JSON.stringify(role)} + " item in the application menu";
      const win = BrowserWindow.getAllWindows()[0];
      const page = webContents.getAllWebContents().find(c => c.getURL() === ${JSON.stringify(pageUrl)});
      if (!page) return "no web contents at " + ${JSON.stringify(pageUrl)};
      item.click(undefined, win, page);
      return "clicked";
    })()`
  });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  ok(String(out.result.value).startsWith("clicked"), String(out.result.value));
  await sleep(120);
  await settle();
  return out.result.value;
}

async function runChecks() {
  await t("open: the real app paints paragraphs, headings, numbers and a chip", async () => {
    await fresh();
    same(await ev(`Array.from(document.querySelectorAll("#writer-doc > *")).map(el => el.tagName + ":" + el.querySelectorAll(".wr-beat").length)`), ["H2:0", "DIV:2", "DIV:3", "H2:0", "DIV:1"], "layout");
    same(await ev(`document.querySelector('.wr-beat[data-id="rd"]').classList.contains("is-visual-only")`), true, "chip");
    same(await ev(`document.activeElement.id`), "writer-doc", "focus is in the host");
    same(await ev(`document.querySelectorAll("#writer-doc .wr-para").length`), 0, "no old cells");
  });

  await t("typing: native typing reaches the real session with no zero-width space", async () => {
    await fresh();
    await caret("ra", 5);
    await type("X");
    same(await textOf("ra"), "AlphaX one.", "text");
    ok(!JSON.stringify(await state()).includes("​"), "a zero-width space reached the document");
  });

  await t("undo: native typing, one Ctrl+Z, one Ctrl+Y, in the real undo stack", async () => {
    await fresh();
    const before = await snapshot();
    await caret("ra", 5);
    await type("XY");
    const typed = await snapshot();
    await key("z", "ctrl");
    same(await snapshot(), before, "after undo");
    same((await sel())?.head?.rowId, "ra", "caret stays in the beat");
    await key("y", "ctrl");
    same(await snapshot(), typed, "after redo");
    same((await sel())?.head, beat("ra", 7), "caret after redo");
  });

  await t("undo: Enter split restores the selection and row count", async () => {
    await fresh();
    const before = await snapshot();
    await caret("ra", 5);
    await key("Enter");
    same((await state()).rows.length, 7, "new row");
    const split = await snapshot();
    await key("z", "ctrl");
    same(await snapshot(), before, "after undo");
    same((await sel()).head, beat("ra", 5), "caret back");
    await key("y", "ctrl");
    same(await snapshot(), split, "after redo");
  });

  await t("undo: delete across beats restores text, visuals and selection direction", async () => {
    await fresh();
    const before = await snapshot();
    await select(beat("rc", 3), beat("ra", 2));
    await key("Backspace");
    same((await state()).rows.map(r => r.id), ["ra", "rc", "rd", "re", "rf"], "whole beat gone");
    await key("z", "ctrl");
    same(await snapshot(), before, "after undo");
    const back = await sel();
    same(back, { anchor: beat("rc", 3), head: beat("ra", 2) }, "selection and direction back");
  });

  await t("undo: past the writer's start closes it, and redo reopens it", async () => {
    await loadDoc(fixture());
    await ev(`document.querySelector('#rows .cell-editable[data-id="ra"][data-field="audioText"]').focus()`);
    await settle();
    await type("Q");
    await key("Tab");
    await openWriter();
    await caret("ra", 1);
    await type("W");
    await key("z", "ctrl");
    ok(await ev(`!document.getElementById("writer").hidden`), "first undo stays in the writer");
    await key("z", "ctrl");
    ok(await ev(`document.getElementById("writer").hidden`), "second undo leaves the writer");
  }, { skipCheck: true });

  await t("paint: a real full render keeps the beat elements and a selection across beats", async () => {
    await fresh();
    await ev(`document.querySelector('.wr-beat[data-id="rb"]').__kept = 1`);
    await select(beat("ra", 2), beat("rc", 4));
    const held = await sel();
    await ev(`window.__writerFlowTest.fullRender()`);
    await settle();
    same(await sel(), held, "selection survives");
    same(await ev(`document.querySelector('.wr-beat[data-id="rb"]').__kept`), 1, "same element");
  });

  await t("paint: a render after an outside change to the caret's beat keeps the caret by model position", async () => {
    await fresh();
    await caret("re", 4);
    await ev(`window.__writerFlowTest.outsideEdit("rc", "Changed elsewhere.")`);
    await settle();
    same(await shown().then(list => list[2]), "Changed elsewhere.", "the other beat repainted");
    same((await sel()).head, beat("re", 4), "caret unchanged");
    await ev(`window.__writerFlowTest.outsideEdit("re", "Echo five and more")`);
    await settle();
    same((await sel()).head, beat("re", 4), "caret kept after its own beat repainted");
    await type("!");
    same(await textOf("re"), "Echo! five and more", "typing lands at the kept caret");
  });

  await t("toolbar: a real click on B across beats, with focus and selection kept", async () => {
    await fresh();
    await select(beat("ra", 2), beat("rb", 3));
    await clickAt('.writer-bar .wr-fmt[data-cmd="bold"]');
    const s = await state();
    ok(/<strong>/.test(s.rows[0].audioText) && /<strong>/.test(s.rows[1].audioText), "both beats bold");
    same(await ev(`document.activeElement.id`), "writer-doc", "focus stays");
    same(await sel(), { anchor: beat("ra", 2), head: beat("rb", 3) }, "selection stays");
    ok(await ev(`document.querySelector('.wr-fmt[data-cmd="bold"]').classList.contains("is-active")`), "button lit");
    await key("z", "ctrl");
    ok(!/<strong>/.test((await state()).rows[0].audioText), "one undo clears both");
  });

  await t("toolbar: B with a caret marks the next typing", async () => {
    await fresh();
    await caret("ra", 5);
    await clickAt('.writer-bar .wr-fmt[data-cmd="bold"]');
    ok(await ev(`document.querySelector('.wr-fmt[data-cmd="bold"]').classList.contains("is-active")`), "button lit");
    await type("K");
    ok(/<strong>K<\/strong>/.test((await state()).rows[0].audioText), "typed bold: " + (await state()).rows[0].audioText);
  });

  await t("focus: the title box and back loses nothing", async () => {
    await fresh();
    await caret("ra", 5);
    await type("Z");
    await clickAt("#writer-title");
    same(await ev(`document.activeElement.id`), "writer-title", "title has focus");
    await type("!");
    ok((await state()).title.includes("!") || (await ev(`document.getElementById("writer-title").value`)).includes("!"), "title typed");
    await clickAt('.wr-beat[data-id="rb"]');
    same(await ev(`document.activeElement.id`), "writer-doc", "focus back in the host");
    same((await sel())?.head?.rowId, "rb", "caret in the clicked beat");
    same(await textOf("ra"), "AlphaZ one.", "text kept");
  });

  await t("comment: select, Comment, draft keeps its own undo, Post returns the caret", async () => {
    await fresh();
    await select(beat("rb", 0), beat("rb", 5));
    await clickAt('.writer-bar .wr-fmt[data-cmd="comment"]');
    ok(await poll(`document.getElementById("comment-modal").hidden === false && document.activeElement.id === "comment-body-editable"`, 2000), "the draft box never took the keyboard, active: " + await ev("document.activeElement.id"));
    const inDoc = await snapshot();
    ok(/cmt-anchor/.test((await state()).rows[1].audioText), "anchor in the beat");
    await type("Note");
    await key("z", "ctrl");
    same(await ev(`document.getElementById("comment-body-editable").textContent`), "", "Ctrl+Z undoes the draft");
    same(await snapshot(), inDoc, "and not the script");
    await type("Note");
    await clickAt("#comment-post");
    ok(await poll(`document.getElementById("comment-modal").hidden === true`, 2000), "the box closed");
    ok(await poll(`document.activeElement.id === "writer-doc"`, 2000), "focus back, active: " + await ev("document.activeElement.id"));
    const s = await state();
    same(s.comments.map(c => [c.rowId, c.field, c.quotedText]), [["rb", "audioText", "Bravo"]], "comment recorded");
    same((await sel())?.head?.rowId, "rb", "caret in the same beat");
    await caret("rb", 10);
    await type("!");
    ok((await textOf("rb")).endsWith("two.!"), "typing continues: " + await textOf("rb"));
  });

  await t("comment: Cancel removes the anchor and keeps the text and selection", async () => {
    await fresh();
    await select(beat("rb", 0), beat("rb", 5));
    await clickAt('.writer-bar .wr-fmt[data-cmd="comment"]');
    ok(await poll(`document.getElementById("comment-modal").hidden === false`, 2000), "box open");
    await clickAt("#comment-cancel");
    ok(await poll(`document.getElementById("comment-modal").hidden === true && document.activeElement.id === "writer-doc"`, 2000), "closed and focus back");
    ok(!/cmt-anchor/.test((await state()).rows[1].audioText), "anchor gone");
    same(await textOf("rb"), "Bravo two.", "text kept");
    same((await sel())?.head?.rowId, "rb", "selection in the same beat");
  });

  await t("close: the split view shows the writer's edits, and reopening is clean", async () => {
    await fresh();
    await caret("ra", 5);
    await type("X");
    await caret("rb", 5);
    await key("Enter");
    await closeWriter();
    same(await ev(`document.querySelector("#writer-doc").childElementCount`), 0, "host emptied");
    same(await ev(`document.querySelectorAll("#rows .row").length`), 7, "split view has the new row");
    same(await ev(`document.querySelector('#rows .cell-editable[data-id="ra"][data-field="audioText"]').textContent`), "AlphaX one.", "split view has the text");
    await openWriter();
    await caret("ra", 6);
    await type("Y");
    same(await textOf("ra"), "AlphaXY one.", "typing after reopening");
  });

  await t("close: typing alone, with no structural edit, reaches the split view", async () => {
    await fresh();
    await caret("ra", 5);
    await type("X");
    await closeWriter();
    same(await ev(`document.querySelector('#rows .cell-editable[data-id="ra"][data-field="audioText"]').textContent`), "AlphaX one.", "split view has the text");
  }, { skipCheck: true });

  await t("close: a new paragraph, a join and undo all reach the split view", async () => {
    await fresh();
    await caret("rb", 5);
    await key("Enter");
    await key("Enter");
    const rows = (await state()).rows;
    same(rows.length, 7, "one new beat");
    ok(rows[2].paragraphStart, "the new beat starts a paragraph");
    await key("z", "ctrl");
    await key("z", "ctrl");
    same((await state()).rows.length, 6, "undone");
    await closeWriter();
    same(await ev(`Array.from(document.querySelectorAll('#rows .cell-editable[data-field="audioText"]')).map(c => c.textContent).slice(0, 2)`), ["Alpha one.", "Bravo two."], "split view matches");
    same(await ev(`document.querySelectorAll("#rows .row").length`), 6, "split view row count");
  }, { skipCheck: true });

  await t("close: closing with Esc leaves focus in the split view and no writer listeners", async () => {
    await fresh();
    await caret("ra", 5);
    await key("Escape");
    ok(await ev(`document.getElementById("writer").hidden`), "closed");
    await ev(`document.querySelector('#rows .cell-editable[data-id="ra"][data-field="audioText"]').focus()`);
    await type("P");
    await settle();
    ok((await textOf("ra")).includes("P"), "the split view still types");
    await key("Tab");
  }, { skipCheck: true });
}

const timings = {};
const stats = list => {
  const sorted = list.slice().sort((a, b) => a - b);
  const round = n => Math.round(n * 10) / 10;
  return { n: sorted.length, p50: round(sorted[Math.floor(sorted.length * .5)]), p95: round(sorted[Math.floor(sorted.length * .95)]), max: round(sorted[sorted.length - 1]) };
};
const TYPED = "the quick brown fox jumps over the lazy dog";

// why: `typing` starts at keydown and `work` at the character. In off-screen Electron both sit near 60 ms on any script in
// either writer, with the page idle for most of it, so Electron's cost per key comes from --profile's task time instead.
async function installTimers() {
  await ev(`(function(){
    window.__typing = []; window.__work = []; window.__commands = []; window.__keyAt = 0; window.__charAt = 0;
    const host = document.getElementById("writer-doc");
    if (window.__timersOn) return true;
    window.__timersOn = true;
    host.addEventListener("keydown", () => {
      const at = performance.now();
      window.__keyAt = at;
      setTimeout(() => { void host.offsetHeight; window.__commands.push(performance.now() - at); }, 0);
    }, true);
    host.addEventListener("beforeinput", () => { window.__charAt = performance.now(); }, true);
    host.addEventListener("input", () => {
      const at = window.__keyAt, char = window.__charAt;
      if (at) setTimeout(() => { void host.offsetHeight; const now = performance.now(); window.__typing.push(now - at); window.__work.push(now - char); }, 0);
    }, true);
    return true;
  })()`);
}

async function caretInOldWriter(rowId, offset) {
  await ev(`(function(){
    const el = document.querySelector('#writer-doc .wr-para[data-id="${rowId}"]');
    el.focus();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    getSelection().collapse(node, ${offset});
    return true;
  })()`);
  await settle();
}

async function commandTime(name, mods) {
  await ev("window.__commands = []");
  await key(name, mods);
  await sleep(60);
  return Math.round((await ev("window.__commands[0] ?? -1")) * 10) / 10;
}

// Answers what the first keys after opening cost, and what makes Chromium restyle: its own records plus the DOM changes.
async function traceStyle() {
  const events = [];
  cdp.on("Tracing.dataCollected", params => { events.push(...params.value); });
  const done = new Promise(resolve => { cdp.on("Tracing.tracingComplete", resolve); });
  await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline.invalidationTracking", "v8", "blink"] } });
  if (mainCdp) {
    await mainCdp.send("Profiler.enable");
    await mainCdp.send("Profiler.setSamplingInterval", { interval: 500 });
    await mainCdp.send("Profiler.start");
  }
  await ev("window.__typing = []");
  for (const ch of TYPED) { await typeChar(ch); await settle(); }
  await sleep(1500);
  const spread = await ev("window.__typing");
  let mainHottest = null;
  if (mainCdp) {
    const { profile } = await mainCdp.send("Profiler.stop");
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const self = new Map();
    profile.samples.forEach((id, i) => {
      const f = byId.get(id).callFrame;
      const label = (f.functionName || "(anonymous)") + " " + String(f.url).split(/[\\/]/).pop() + ":" + f.lineNumber;
      self.set(label, (self.get(label) || 0) + (profile.timeDeltas[i] || 0));
    });
    mainHottest = [...self].filter(([label]) => !/^\(idle\)/.test(label)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, us]) => label + " " + Math.round(us / 1000) + "ms");
  }
  await cdp.send("Tracing.end");
  await done;
  await ev(`(function(){
    const say = n => n.nodeType === 1 ? n.tagName + (n.id ? "#" + n.id : "") + (n.className && typeof n.className === "string" ? "." + n.className.split(/\\s+/).join(".") : "") : "#text in " + say(n.parentNode);
    window.__seen = [];
    window.__watch = new MutationObserver(list => list.forEach(m => {
      const added = m.addedNodes.length > 3 ? m.addedNodes.length + " nodes" : Array.from(m.addedNodes).map(say).join(",");
      window.__seen.push(m.type + " " + (m.attributeName || "") + " on " + say(m.target) + (added ? " added " + added : ""));
    }));
    window.__watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    return true;
  })()`);
  await typeChar("m");
  await settle();
  await sleep(600);
  const mutations = await ev(`(function(){window.__watch.disconnect();return window.__seen;})()`);
  const worstKey = spread.indexOf(Math.max(...spread));
  const long = events.filter(e => e.ph === "X" && (e.dur || 0) > 150000).sort((a, b) => b.dur - a.dur).slice(0, 16).map(e => e.name + " " + Math.round(e.dur / 1000) + "ms" + (e.args?.data?.functionName ? " fn=" + e.args.data.functionName : "") + (e.args?.data?.url ? " " + String(e.args.data.url).slice(-30) : "") + (e.args?.elementCount ? " elements=" + e.args.elementCount : ""));
  const trees = events.filter(e => e.name === "UpdateLayoutTree").map(e => ({ ms: +((e.dur || 0) / 1000).toFixed(1), elements: e.args?.elementCount ?? e.args?.beginData?.elementCount ?? null }));
  const tally = new Map();
  events.filter(e => /InvalidationTracking$/.test(e.name) && /Style/.test(e.name)).forEach(e => {
    const d = e.args?.data ?? {};
    const label = [e.name.replace("InvalidationTracking", ""), d.reason, d.changedClass && "class:" + d.changedClass, d.changedAttribute && "attr:" + d.changedAttribute, d.changedId && "id:" + d.changedId, d.changedPseudo && "pseudo:" + d.changedPseudo, d.invalidationSet && "set", d.invalidatedSelectorId && "selector:" + d.invalidatedSelectorId, d.selectors && JSON.stringify(d.selectors).slice(0, 160), d.nodeName, d.extraData].filter(Boolean).join(" | ");
    tally.set(label, (tally.get(label) || 0) + 1);
  });
  const flood = /matched tagName|Related style rule/;
  return { worstKey, worstMs: spread[worstKey], keysOverHundred: spread.filter(ms => ms > 100).length, mainHottest, long, trees: trees.sort((a, b) => b.ms - a.ms).slice(0, 8), flood: [...tally].filter(([label]) => flood.test(label)).reduce((sum, [, n]) => sum + n, 0), reasons: [...tally].filter(([label]) => !flood.test(label)).sort((a, b) => b[1] - a[1]).slice(0, 12), mutations: mutations.filter(m => !/phone-tab|broll-badge/.test(m)) };
}

async function timing() {
  await t("timing: the same typing on the 6-beat script, to show what the measuring itself costs", async () => {
    if (oldTiming) { await loadDoc(fixture()); await ev(`document.getElementById("btn-write").click()`); await poll(`!document.getElementById("writer").hidden`, 4000); await settle(); }
    else await fresh();
    await installTimers();
    if (oldTiming) await caretInOldWriter("ra", 5); else await caret("ra", 5);
    for (const ch of TYPED) { await typeChar(ch); await settle(); }
    await sleep(100);
    timings[oldTiming ? "oldWriterSmall" : "flowWriterSmall"] = {
      typing: stats(await ev("window.__typing")),
      work: stats(await ev("window.__work")),
      visibility: await ev("document.visibilityState"),
      focused: await ev("document.hasFocus()"),
      timerGap: await ev(`new Promise(r => { const out = []; let last = performance.now(); let n = 0; const go = () => { const now = performance.now(); out.push(+(now - last).toFixed(1)); last = now; if (++n < 12) setTimeout(go, 0); else r(out); }; setTimeout(go, 0); })`)
    };
  }, { skipCheck: true });

  await t("timing: the real app on a 900-beat script", async () => {
    const raw = fixture();
    const base = raw.rows;
    raw.title = "Long";
    raw.docId = "d" + "4".repeat(32);
    raw.rows = [];
    for (let i = 0; i < 150; i++) base.forEach(row => { const { paragraphStart: _flag, ...kept } = row; raw.rows.push({ ...kept, id: row.id + i }); });
    raw.sections = [];
    await loadDoc(raw);
    await ev(`document.getElementById("btn-write").click()`);
    await poll(`!document.getElementById("writer").hidden`, 4000);
    await settle();
    await installTimers();
    const id = raw.rows[450].id;
    const out = {};
    if (oldTiming) await caretInOldWriter(id, 5); else await caret(id, 5);
    const profiling = process.argv.includes("--profile");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
    let startMetrics = null;
    if (profiling) {
      out.styleTrace = await traceStyle();
      await ev("window.__typing = []");
      await cdp.send("Performance.enable");
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
      startMetrics = await metrics();
    }
    for (const ch of TYPED) { await typeChar(ch); await settle(); }
    await sleep(100);
    out.typing = stats(await ev("window.__typing"));
    out.work = stats(await ev("window.__work"));
    if (profiling) {
      const endMetrics = await metrics();
      const { profile } = await cdp.send("Profiler.stop");
      const per = TYPED.length;
      const part = name => +(((endMetrics[name] - startMetrics[name]) * 1000) / per).toFixed(1);
      out.perKey = { script: part("ScriptDuration"), style: part("RecalcStyleDuration"), layout: part("LayoutDuration"), task: part("TaskDuration") };
      const self = new Map();
      const gap = profile.timeDeltas;
      const byId = new Map(profile.nodes.map(n => [n.id, n]));
      profile.samples.forEach((id, i) => {
        const f = byId.get(id).callFrame;
        const label = (f.functionName || "(anonymous)") + (f.lineNumber >= 0 ? ":" + f.lineNumber + ":" + f.columnNumber : "");
        self.set(label, (self.get(label) || 0) + (gap[i] || 0));
      });
      out.hottest = [...self].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([label, us]) => label + " " + (us / 1000 / per).toFixed(1) + "ms");
    }
    out.enterMs = await commandTime("Enter");
    out.undoMs = await commandTime("z", "ctrl");
    timings[oldTiming ? "oldWriter" : "flowWriter"] = out;
  }, { skipCheck: oldTiming });
}

async function electron() {
  const exe = path.join(repo, "desktop", "node_modules", "electron", "dist", "electron.exe");
  const port = await freePort();
  const inspect = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "writer-slice-"));
  const savePath = path.join(profile, "slice-save.splitpage");
  const dialogs = path.join(profile, "dialogs.json");
  fs.writeFileSync(dialogs, JSON.stringify([savePath]));
  const env = { ...process.env, SPLITPAGE_USER_DATA: profile, SPLITPAGE_TEST: "1", SPLITPAGE_NO_UPDATE_CHECK: "1", SPLITPAGE_TEST_DIALOGS: dialogs };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(exe, [`--inspect=${inspect}`, path.join(repo, "desktop"), `--remote-debugging-port=${port}`], { env, stdio: "ignore" });
  const list = async base => (await fetch(`http://127.0.0.1:${base}/json/list`)).json();
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    try {
      const pages = (await list(port)).filter(t => t.type === "page" && !t.url.startsWith("devtools:"));
      for (const candidate of pages) {
        const probe = new Cdp(candidate.webSocketDebuggerUrl);
        await probe.open();
        const out = await probe.send("Runtime.evaluate", { expression: "!!document.getElementById('btn-write')", returnByValue: true });
        probe.close();
        if (out.result.value) { page = candidate; break; }
      }
    } catch { /* starting */ }
    if (!page) await sleep(250);
  }
  ok(page, "Electron never opened the app's page");
  pageUrl = page.url;
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  let main = null;
  for (let i = 0; i < 40 && !main; i++) {
    try { main = (await list(inspect))[0]; } catch { /* starting */ }
    if (!main) await sleep(150);
  }
  ok(main, "no inspector on Electron's main process");
  mainCdp = new Cdp(main.webSocketDebuggerUrl);
  await mainCdp.open();
  await mainCdp.send("Runtime.enable");
  // why: test windows stay out of Adam's way; a position off screen keeps the window rendering, unlike hiding it
  await mainCdp.send("Runtime.evaluate", {
    includeCommandLineAPI: true,
    expression: `(process.mainModule ? process.mainModule.require("electron") : require("electron")).BrowserWindow.getAllWindows().forEach(win => win.setPosition(-20000, -20000))`
  });
  return {
    savePath,
    version: (await cdp.send("Browser.getVersion")).product,
    stop: async () => {
      cdp.close();
      mainCdp.close();
      try { process.kill(proc.pid); } catch { /* gone */ }
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    },
    profile
  };
}

async function edge() {
  const exe = [`${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`].find(p => fs.existsSync(p));
  const server = http.createServer((req, res) => {
    const file = path.join(repo, new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "index.html");
    if (!file.startsWith(repo) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "writer-slice-"));
  const proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,960", url], { stdio: "ignore" });
  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page"); } catch { /* starting */ }
    if (!page) await sleep(200);
  }
  ok(page, "Edge never opened a page");
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  return {
    version: (await cdp.send("Browser.getVersion")).product,
    stop: async () => {
      cdp.close();
      server.close();
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    }
  };
}

async function boot() {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  ok(await poll("document.readyState === 'complete' && !!document.getElementById('btn-write')", 20000), "the app never loaded: " + cdp.problems.join(" | "));
  await ev(`localStorage.setItem("splitpage-writer-flow", ${oldTiming ? '"0"' : '"1"'}); true`);
  await cdp.send("Page.reload");
  await sleep(400);
  ok(await poll("!!window.__splitpageFormats && !!document.getElementById('btn-write') && document.querySelectorAll('#rows > *').length > 0 || !!document.querySelector('[data-newtab-action=new]')", 20000), "the app never came back: " + cdp.problems.join(" | "));
  await ev(`window.__onboarding && window.__onboarding.autoShowDecided && window.__onboarding.autoShowDecided()`).catch(() => {});
  await ev(`(function(){var m=document.getElementById('onboarding-modal');if(m&&!m.hidden){var s=m.querySelector('[data-onboard-action=skip]');if(s)s.click();}return true;})()`);
  await ev(`(function(){var n=document.querySelector('[data-newtab-action=new]');if(n&&n.offsetParent)n.click();return true;})()`);
  await settle();
  SCHEMA = await ev("window.__splitpageFormats.state().schema");
  ok(SCHEMA > 0, "no schema number");
}

async function main() {
  const session = target === "edge" ? await edge() : await electron();
  try {
    await boot();
    console.log("browser:", session.version);
    if (!oldTiming) {
      if (target === "electron") await electronFirstChecks();
      await runChecks();
      if (target === "electron") await electronChecks(session);
    }
    await timing();
  } finally {
    const passed = results.filter(r => r.pass).length;
    console.log(`passed ${passed} of ${results.length}`);
    results.filter(r => !r.pass).forEach(r => console.log("FAIL", r.name, "\n    ", r.why));
    console.log("timing", JSON.stringify(timings));
    await session.stop();
    process.exitCode = passed === results.length && results.length ? 0 : 1;
  }
}

// why: boot has just reloaded the page and nothing has been typed, so Chromium's own undo stack is truly empty here
async function electronFirstChecks() {
  await t("Electron menu: Edit > Undo and Redo on a fresh page, with no native typing since it loaded", async () => {
    await fresh();
    const before = await snapshot();
    await caret("ra", 5);
    await key("Enter");
    same((await state()).rows.length, 7, "split");
    await menuClick("undo");
    same(await snapshot(), before, "after the menu's Undo");
    await menuClick("redo");
    same((await state()).rows.length, 7, "after the menu's Redo");
  });
}

async function electronChecks(session) {
  await t("Electron menu: Edit > Undo after native typing goes through the document's undo", async () => {
    await fresh();
    const before = await snapshot();
    await caret("ra", 5);
    await type("XY");
    await menuClick("undo");
    same(await snapshot(), before, "after the menu's Undo");
    same(await shown().then(list => list[0]), "Alpha one.", "the screen matches");
    await menuClick("redo");
    same(await textOf("ra"), "AlphaXY one.", "after the menu's Redo");
  });

  await t("Electron menu: Edit > Undo and Redo after a flow command", async () => {
    await fresh();
    const before = await snapshot();
    await caret("ra", 5);
    await key("Enter");
    same((await state()).rows.length, 7, "split");
    await menuClick("undo");
    same(await snapshot(), before, "after the menu's Undo");
    same((await sel())?.head, beat("ra", 5), "caret restored");
    await menuClick("redo");
    same((await state()).rows.length, 7, "after the menu's Redo");
  });

  await t("Electron menu: Edit > Undo in the title box stays the box's own undo", async () => {
    await fresh();
    const was = await snapshot();
    await ev(`(function(){const t=document.getElementById("writer-title");t.focus();t.setSelectionRange(t.value.length,t.value.length);return true;})()`);
    await type("ZZ");
    same(await ev(`document.getElementById("writer-title").value`), "Slice fixtureZZ", "typed in the title");
    await menuClick("undo");
    ok(!(await ev(`document.getElementById("writer-title").value`)).includes("ZZ"), "the title's own undo took the words back");
    same(await snapshot(), was, "the script's rows didn't move");
  });

  await t("split view: Edit > Undo and Redo after typing in a cell, the writer closed", async () => {
    await loadDoc(fixture());
    await ev(`(function(){const c=document.querySelector('#rows .cell-editable[data-field="audioText"]');c.focus();const s=getSelection();s.selectAllChildren(c);s.collapseToEnd();return true;})()`);
    await type("XY");
    const typed = await textOf("ra");
    ok(typed.includes("XY"), "typing never reached the cell: " + typed);
    await menuClick("undo");
    const undone = await textOf("ra");
    ok(!undone.includes("Y"), "after the menu's Undo: " + undone);
    await menuClick("redo");
    same(await textOf("ra"), typed, "after the menu's Redo");
  }, { skipCheck: true });

  await t("save: Save right after typing writes the words, the flags and no zero-width space, and it reopens the same", async () => {
    await fresh();
    await caret("ra", 5);
    await type("S");
    await caret("rb", 5);
    await key("Enter");
    await key("Enter");
    const file = session.savePath;
    const asked = await ev(`(function(){try{return String(window.__desktopTest.runMenuCommand('save-as'));}catch(e){return "threw "+e.message;}})()`);
    const end = Date.now() + 8000;
    while (Date.now() < end && !fs.existsSync(file)) await sleep(60);
    if (!fs.existsSync(file)) {
      const seen = await ev(`(async function(){const i=await window.splitpageDesktop.getSessionInfo();return {dialogs:i.testDialogsSeen,dirty:document.getElementById("btn-save").classList.contains("is-dirty"),wizard:!document.getElementById("onboarding-modal").hidden};})()`);
      throw new Error("no saved file at " + file + "; the command returned " + asked + "; " + JSON.stringify(seen));
    }
    const raw = fs.readFileSync(file, "utf8");
    ok(!raw.includes("\\u200b") && !raw.includes("​"), "a zero-width space reached the file");
    const disk = JSON.parse(raw);
    same(plain(disk.rows[0].audioText), "AlphaS one.", "typed words on disk");
    const live = await state();
    same(disk.rows.map(r => [r.id, !!r.paragraphStart]), live.rows.map(r => [r.id, !!r.paragraphStart]), "flags on disk");
    ok(disk.rows.some(r => r.paragraphStart), "a flag on disk");
    const layout = () => ev(`Array.from(document.querySelectorAll("#writer-doc > *")).map(el => el.tagName + ":" + el.querySelectorAll(".wr-beat").length)`);
    const wrote = await layout();
    const stamp = fs.statSync(file).mtimeMs;
    await caret("ra", 6);
    await type("Q");
    await ev(`(function(){window.__desktopTest.runMenuCommand('save');return true;})()`);
    const until = Date.now() + 8000;
    while (Date.now() < until && fs.statSync(file).mtimeMs === stamp) await sleep(60);
    ok(fs.statSync(file).mtimeMs !== stamp, "plain Save didn't write the file again");
    const second = fs.readFileSync(file, "utf8");
    same(plain(JSON.parse(second).rows[0].audioText), "AlphaSQ one.", "the word typed right before a plain Save, on disk");
    await loadDoc({ ...JSON.parse(raw), title: "Reopened" });
    await openWriter();
    same(await layout(), wrote, "same paragraphs after reopening");
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
