// Runs the page's acceptance set with real key events through the browser's debugging port.
// usage: node tools/writer-lab/accept.mjs [--browser <exe>] [--only <text>] [--port <n>]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = name => { const at = process.argv.indexOf("--" + name); return at === -1 ? null : process.argv[at + 1]; };
const port = Number(arg("port") || 9417);
const only = arg("only");
const exe = arg("browser") || [
  `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`
].find(p => fs.existsSync(p));
const page = pathToFileURL(path.join(here, "dist", "writer-lab.html")).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = path.join(os.tmpdir(), "writer-lab-" + process.pid);
fs.mkdirSync(profile, { recursive: true });
const isElectron = /electron\.exe$/i.test(exe);
const env = { ...process.env, WRITER_LAB_PAGE: path.join(here, "dist", "writer-lab.html") };
// why: T3 shells set this, and it would make Electron run as plain Node
delete env.ELECTRON_RUN_AS_NODE;
const browser = spawn(exe, isElectron
  ? [path.join(here, "electron-main.cjs"), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--disable-gpu"]
  : ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,960", "--enable-features=WinUseBrowserSpellChecker", page],
{ stdio: "ignore", env });

let ws, id = 0;
const waiting = new Map();
const problems = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject, method });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find(t => t.type === "page");
      if (target) {
        ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
        ws.addEventListener("message", ev => {
          const msg = JSON.parse(ev.data);
          if (msg.id && waiting.has(msg.id)) {
            const w = waiting.get(msg.id);
            waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(w.method + ": " + msg.error.message)); else w.resolve(msg.result);
          } else if (msg.method === "Runtime.exceptionThrown") {
            problems.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
          } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
            problems.push(msg.params.args.map(a => a.value ?? a.description).join(" "));
          }
        });
        return;
      }
    } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error("browser never opened its debugging port");
}
async function ev(expression) {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  return out.result.value;
}
const settle = () => ev("new Promise(r => setTimeout(r, 12))");

const KEYS = {
  Backspace: [8, "Backspace"], Delete: [46, "Delete"], Enter: [13, "Enter", "\r"], ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"],
  ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], Home: [36, "Home"], End: [35, "End"], Escape: [27, "Escape"]
};
const COMMANDS = { a: "selectAll" };
async function key(name, mods = "") {
  let m = 0;
  if (/ctrl/.test(mods)) m |= 2;
  if (/shift/.test(mods)) m |= 8;
  if (/alt/.test(mods)) m |= 1;
  const known = KEYS[name];
  const vk = known ? known[0] : name.toUpperCase().charCodeAt(0);
  const code = known ? known[1] : "Key" + name.toUpperCase();
  const base = { key: known ? name : name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m };
  const down = { type: "keyDown", ...base };
  if (known && known[2] && m === 0) down.text = known[2];
  if (!known && m === 0) down.text = name;
  if (m === 2 && COMMANDS[name]) down.commands = [COMMANDS[name]];
  await send("Input.dispatchKeyEvent", down);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await settle();
}
const closeBars = () => ev(`document.getElementById("find").hidden = true; document.getElementById("visual-box").hidden = true`);
async function type(text) {
  for (const ch of text) await typeChar(ch);
  await settle();
}
// why: a symbol's char code is another key's virtual code, so "#" would press End and "." would press Delete
function virtualKey(ch) {
  return /^[a-z0-9 ]$/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
}
async function typeChar(ch) {
  const vk = virtualKey(ch);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
const beat = (rowId, offset) => ({ kind: "beat", rowId, offset });
const heading = (sceneId, offset) => ({ kind: "heading", sceneId, offset });
async function select(anchor, head) {
  await ev(`__lab.surface.place(${JSON.stringify({ anchor, head: head ?? anchor })})`);
  await settle();
}
const caret = (rowId, offset) => select(beat(rowId, offset));
const rows = () => ev("__lab.rows()");
const textOf = async rowId => (await rows()).find(r => r.id === rowId)?.text;
const sel = () => ev("__lab.surface.selection()");
const fixture = () => ({
  title: "Fixture", docId: "d" + "1".repeat(32), schema: SCHEMA,
  rows: [
    { id: "ra", audioText: "Alpha one.", visualText: "", status: "todo", imageRef: null },
    { id: "rb", audioText: "Bravo two.", visualText: "Desk shot", status: "shot", imageRef: null, notes: "keep me" },
    { id: "rc", audioText: "Charlie <strong>bold</strong> end.", visualText: "", status: "todo", imageRef: null, paragraphStart: true },
    { id: "rd", audioText: "", visualText: "Street b-roll", status: "todo", imageRef: null },
    { id: "re", audioText: '<span class="cmt-anchor" data-cmt="c1">Echo</span> five', visualText: "", status: "todo", imageRef: null },
    { id: "rf", audioText: "Foxtrot six.", visualText: "", status: "todo", imageRef: null },
    { id: "rg", audioText: 'See <span class="tag-anchor" data-tag-cat="vfx" data-tag-name="lamp" contenteditable="false">lamp</span> here', visualText: "", status: "todo", imageRef: null },
    { id: "rh", audioText: "Hotel eight.", visualText: "", status: "todo", imageRef: null, paragraphStart: true },
    { id: "ri", audioText: "", visualText: "", status: "todo", imageRef: null, paragraphStart: true },
    { id: "rj", audioText: "Juliet ten.", visualText: "", status: "todo", imageRef: null, paragraphStart: true }
  ],
  sections: [{ id: "s1", name: "Opening", firstSceneId: "ra" }, { id: "s2", name: "Middle", firstSceneId: "rf" }],
  comments: [{ id: "c1", rowId: "re", field: "audioText", anchorId: "c1", quotedText: "Echo", author: "Adam", body: "A note", resolved: false, resolvedBy: null, resolvedAt: null, assignee: "", replies: [] }]
});
async function fresh(raw) {
  await closeBars();
  await ev(`__lab.setting("enter","double"); __lab.setting("tick","delete"); __lab.setting("gapTyping","here"); __lab.setting("markdown",true); __lab.load(${JSON.stringify(raw ?? fixture())})`);
  await settle();
}
const ids = list => list.map(r => r.id).join(",");
// why: undo stamps updatedAt and updatedBy on purpose, so they can't be part of "back to how it was"
const withoutStamps = list => list.map(({ updatedAt: _at, updatedBy: _by, ...row }) => row);
const snapshot = async () => JSON.stringify({ rows: withoutStamps(await ev("__lab.doc().rows")), sections: await ev("__lab.doc().sections ?? null"), comments: await ev("__lab.comments()") });
function same(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) return;
  let at = 0;
  while (at < x.length && at < y.length && x[at] === y[at]) at++;
  const from = Math.max(0, at - 50);
  throw new Error(`${label}: expected …${y.slice(from, at + 90)}…, got …${x.slice(from, at + 90)}…`);
}
function ok(value, label) { if (!value) throw new Error(label); }

const results = [];
const gapNotes = {};
let SCHEMA = 0;
async function t(name, body) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  const before = problems.length;
  try {
    await body();
    const drift = await ev("__lab.check()");
    if (drift.length) throw new Error("screen differs from the script: " + drift[0]);
    if (problems.length > before) throw new Error("page error: " + problems[before]);
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, why: String(error.message || error).slice(0, 400) });
  }
}
async function untouched(base, changed) {
  const now = await ev("__lab.doc().rows");
  for (const row of base) {
    if (changed.includes(row.id)) continue;
    const match = now.find(r => r.id === row.id);
    if (JSON.stringify(match) !== JSON.stringify(row)) throw new Error(`row ${row.id} changed: ${JSON.stringify(match)}`);
  }
}
async function undoRestores(before) {
  await key("z", "ctrl");
  same(await snapshot(), before, "after Ctrl+Z");
}

async function run() {
  await connect();
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.reload");
  for (let i = 0; i < 40; i++) {
    if (await ev("typeof __lab === 'object'").catch(() => false)) break;
    await sleep(100);
  }
  ok(await ev("typeof __lab === 'object'"), "the page never finished loading: " + problems.join(" | "));
  const version = (await send("Browser.getVersion")).product;
  SCHEMA = await ev("__lab.doc().schema");
  ok(SCHEMA > 0, "no schema number on the loaded document");

  await t("start: fixture opens with ids and flags kept", async () => {
    await fresh();
    same(ids(await rows()), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "ids");
    same((await rows()).filter(r => r.start).map(r => r.id), ["rc", "rh", "ri", "rj"], "flags");
  });

  await t("mapping: every offset maps to the screen and back", async () => {
    await fresh();
    for (const row of await rows()) {
      for (let at = 0; at <= row.text.length; at++) {
        // why: a tag is one unit on screen, so a caret can't sit inside the word "lamp"
        if (row.id === "rg" && at > 4 && at < 8) continue;
        await ev(`__lab.surface.place(${JSON.stringify({ anchor: beat(row.id, at), head: beat(row.id, at) })})`);
        const got = await sel();
        same(got.head, beat(row.id, at), "round trip");
      }
    }
  });

  await t("storage: no gap, zero-width space or padding is saved", async () => {
    await fresh();
    await caret("ra", 3);
    await type("xy");
    await caret("ri", 0);
    await type("z");
    for (const row of await rows()) {
      ok(!row.html.includes("​"), "zero-width space saved in " + row.id);
      ok(!/^\s|\s$/.test(row.text), "padding saved in " + row.id);
    }
  });

  await t("typing: middle of a beat stays in that beat, and Ctrl+Z undoes it", async () => {
    await fresh();
    const before = await snapshot();
    const base = await ev("__lab.doc().rows");
    await caret("ra", 5);
    await type("X");
    same(await textOf("ra"), "AlphaX one.", "text");
    await untouched(base, ["ra"]);
    await key("z", "ctrl");
    same(JSON.parse(await snapshot()).rows.find(r => r.id === "ra").audioText, JSON.parse(before).rows.find(r => r.id === "ra").audioText, "undo text");
  });

  await t("typing: end of a beat span stays in that beat", async () => {
    await fresh();
    await caret("ra", 10);
    await type("Z");
    same(await textOf("ra"), "Alpha one.Z", "text");
    same(await textOf("rb"), "Bravo two.", "next");
  });

  await t("typing: start of a run-on beat stays where the caret is", async () => {
    await fresh();
    await caret("rb", 0);
    await type("Q");
    same(await textOf("ra"), "Alpha one.", "before");
    same(await textOf("rb"), "QBravo two.", "after");
    same((await sel()).head, beat("rb", 1), "caret");
  });

  await t("typing: start of a paragraph stays in that beat", async () => {
    await fresh();
    await caret("rc", 0);
    await type("Q");
    same(await textOf("rc"), "QCharlie bold end.", "text");
    same(await textOf("rb"), "Bravo two.", "before");
  });

  await t("typing: at a bold edge and just past it", async () => {
    await fresh();
    await caret("rc", 12);
    await type("X");
    same(await textOf("rc"), "Charlie boldX end.", "text");
    ok((await rows()).find(r => r.id === "rc").html.includes("<strong>boldX</strong>"), "inherits bold from the left");
  });

  await t("typing: beside a tag", async () => {
    await fresh();
    await caret("rg", 4);
    await type("A");
    const after = (await rows()).find(r => r.id === "rg");
    ok(after.html.includes("tag-anchor"), "tag survives before");
    await select(beat("rg", after.text.indexOf("lamp") + 4));
    await type("B");
    const end = (await rows()).find(r => r.id === "rg");
    ok(end.html.includes('data-tag-name="lamp"'), "tag survives after");
    ok(/lamp<\/span>B|lamp<\/span>.*B/.test(end.html), "typed text stays outside the tag: " + end.html);
  });

  await t("typing: inside comment marks keeps the comment", async () => {
    await fresh();
    await caret("re", 2);
    await type("X");
    const after = (await rows()).find(r => r.id === "re");
    ok(after.html.includes('data-cmt="c1"'), "comment marks kept");
    same(await ev("__lab.comments()"), ["c1"], "comment kept");
  });

  await t("gap: one arrow press crosses from a beat's end to the next beat", async () => {
    await fresh();
    await caret("ra", 10);
    await key("ArrowRight");
    const once = await sel();
    await key("ArrowRight");
    const twice = await sel();
    same(once.head, beat("rb", 0), "first press stops just after the gap");
    same(twice.head, beat("rb", 1), "second press");
    await caret("rb", 1);
    await key("ArrowLeft");
    const leftOnce = await sel();
    await key("ArrowLeft");
    const back = await sel();
    same(leftOnce.head, beat("rb", 0), "left once");
    same(back.head, beat("ra", 10), "left twice");
    gapNotes.arrows = `right from ra:10 -> ${once.head.rowId}:${once.head.offset} -> ${twice.head.rowId}:${twice.head.offset}; left from rb:1 -> ${leftOnce.head.rowId}:${leftOnce.head.offset} -> ${back.head.rowId}:${back.head.offset}`;
  });

  const midSentence = () => ({
    title: "Mid sentence", docId: "d" + "4".repeat(32), schema: SCHEMA, comments: [],
    rows: [
      { id: "wa", audioText: "We went to the store", visualText: "", status: "todo", imageRef: null },
      { id: "wb", audioText: "and bought some milk", visualText: "", status: "todo", imageRef: null },
      { id: "wc", audioText: "<strong>then</strong> walked home", visualText: "", status: "todo", imageRef: null },
      { id: "wd", audioText: "Another paragraph here", visualText: "", status: "todo", imageRef: null, paragraphStart: true },
      { id: "we", audioText: "and it goes on", visualText: "", status: "todo", imageRef: null },
      { id: "wf", audioText: "Last paragraph", visualText: "", status: "todo", imageRef: null, paragraphStart: true }
    ]
  });
  const centerOf = (rowId, from, to) => ev(`(() => { const el = document.querySelector('.wr-beat[data-id="${rowId}"]'); const t = el.firstChild; const lead = t.data[0] === "\\u200B" ? 1 : 0; const r = document.createRange(); r.setStart(t, ${from} + lead); r.setEnd(t, ${to} + lead); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  async function clickTimes(point, times) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    for (let n = 1; n <= times; n++) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: n });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: n });
    }
    await settle();
  }

  await t("mid-sentence: double-click on the last word stops at the beat's edge", async () => {
    await fresh(midSentence());
    await clickTimes(await centerOf("wa", 16, 19), 2);
    same(await sel(), { anchor: beat("wa", 15), head: beat("wa", 20) }, "selection");
    await clickTimes(await centerOf("wb", 1, 2), 2);
    const range = await sel();
    same(range.anchor, beat("wb", 0), "start of the next beat's first word");
    ok(range.head.rowId === "wb" && range.head.offset <= 4, "end: " + JSON.stringify(range.head));
  });

  await t("mid-sentence: Ctrl+arrow stops at the boundary both ways", async () => {
    await fresh(midSentence());
    await caret("wa", 15);
    const right = [];
    for (let i = 0; i < 3; i++) { await key("ArrowRight", "ctrl"); const h = (await sel()).head; right.push(h.rowId + ":" + h.offset); }
    ok(right.includes("wa:20") || right.includes("wb:0"), "right: " + right.join(" "));
    await caret("wb", 3);
    const left = [];
    for (let i = 0; i < 2; i++) { await key("ArrowLeft", "ctrl"); const h = (await sel()).head; left.push(h.rowId + ":" + h.offset); }
    ok(left.includes("wb:0") || left.includes("wa:20"), "left: " + left.join(" "));
    gapNotes.ctrlMidSentence = right.join(" ") + " / " + left.join(" ");
  });

  await t("mid-sentence: word deletes each side of the gap take one word", async () => {
    await fresh(midSentence());
    await caret("wb", 0);
    await key("Backspace", "ctrl");
    same(await textOf("wa"), "We went to the ", "before");
    same(await textOf("wb"), "and bought some milk", "after");
    await fresh(midSentence());
    await caret("wa", 20);
    await key("Delete", "ctrl");
    same(await textOf("wa"), "We went to the store", "before");
    ok((await textOf("wb")).startsWith("bought"), JSON.stringify(await textOf("wb")));
  });

  await t("mid-sentence: typing either side of the gap, with both switch settings", async () => {
    await fresh(midSentence());
    await caret("wa", 20);
    await type("x");
    same(await textOf("wa"), "We went to the storex", "left of the gap");
    same(await textOf("wb"), "and bought some milk", "next");
    await fresh(midSentence());
    await ev(`__lab.setting("gapTyping","before")`);
    await caret("wb", 0);
    await type("y");
    same(await textOf("wa"), "We went to the storey", "right of the gap, other setting");
    await fresh(midSentence());
    await caret("wb", 0);
    await type("yz");
    same(await textOf("wa"), "We went to the store", "right of the gap: before");
    same(await textOf("wb"), "yzand bought some milk", "right of the gap: after");
    same((await sel()).head, beat("wb", 2), "caret");
    const zw = await ev(`document.querySelector('.wr-beat[data-id="wb"]').firstChild.data.split("\\u200B").length - 1`);
    same(zw, 1, "exactly one zero-width space left in the DOM");
  });

  await t("mid-sentence: typing just after a gap, before a bold word", async () => {
    await fresh(midSentence());
    await caret("wc", 0);
    await type("yz");
    same(await textOf("wb"), "and bought some milk", "before");
    same(await textOf("wc"), "yzthen walked home", "after");
    same((await sel()).head, beat("wc", 2), "caret");
    ok((await rows()).find(r => r.id === "wc").html.includes("then</strong>"), "bold word kept");
  });

  await t("mid-sentence: a space typed just after the gap is the next beat's, and the gap steps aside", async () => {
    await fresh(midSentence());
    await caret("wb", 0);
    await type(" ");
    same(await textOf("wa"), "We went to the store", "before");
    same(await textOf("wb"), " and bought some milk", "after");
    ok(await ev(`document.querySelector('.wr-beat[data-id="wb"]').classList.contains("no-gap")`), "no gap");
    same((await sel()).head, beat("wb", 1), "caret");
  });

  await t("mid-sentence: the zero-width space never reaches the script", async () => {
    await fresh(midSentence());
    await caret("wb", 3);
    await type("q");
    await key("Backspace");
    await caret("wc", 0);
    await key("Enter");
    await key("z", "ctrl");
    for (const row of await rows()) ok(!row.html.includes("​"), "saved in " + row.id);
    ok(await ev(`document.querySelector('.wr-beat[data-id="wb"]').textContent.includes("\\u200B")`), "still on screen");
  });

  await t("mid-sentence: a space typed at the end removes the gap and the screen's break", async () => {
    await fresh(midSentence());
    await caret("wa", 20);
    await type(" ");
    ok(await ev(`document.querySelector('.wr-beat[data-id="wb"]').classList.contains("no-gap")`), "no gap");
    ok(!(await ev(`document.querySelector('.wr-beat[data-id="wb"]').textContent.includes("\\u200B")`)), "no break needed");
    await key("Backspace");
    ok(await ev(`!document.querySelector('.wr-beat[data-id="wb"]').classList.contains("no-gap")`), "gap back");
    ok(await ev(`document.querySelector('.wr-beat[data-id="wb"]').textContent.includes("\\u200B")`), "break back");
  });

  await t("mid-sentence: lines wrap at the boundary, with no indent", async () => {
    await fresh(midSentence());
    const measured = await ev(`(() => {
      const doc = document.getElementById("doc");
      const was = doc.style.maxWidth;
      const a = document.querySelector('.wr-beat[data-id="wa"]'), b = document.querySelector('.wr-beat[data-id="wb"]');
      const rect = (el, from, to) => { const t = el.firstChild; const r = document.createRange(); r.setStart(t, from); r.setEnd(t, to); return r.getBoundingClientRect(); };
      let result = null;
      for (let width = 420; width > 150 && !result; width -= 2) {
        doc.style.maxWidth = width + "px";
        const lastA = rect(a, 19, 20), firstB = rect(b, 1, 2);
        if (firstB.top > lastA.top + 4) {
          const box = doc.getBoundingClientRect();
          const inner = box.left + parseFloat(getComputedStyle(doc).paddingLeft);
          const brokeInWord = rect(a, 15, 16).top !== lastA.top;
          result = { width, indent: firstB.left - inner, brokeInWord };
        }
      }
      doc.style.maxWidth = was;
      return result;
    })()`);
    ok(measured, "never wrapped at the boundary");
    ok(Math.abs(measured.indent) < 1, "indented by " + measured.indent);
    ok(!measured.brokeInWord, "the word broke across lines");
    gapNotes.wrap = measured;
  });

  await t("mid-sentence: triple-click takes the paragraph, and deleting doesn't pull up the next", async () => {
    await fresh(midSentence());
    await clickTimes(await centerOf("wd", 2, 3), 3);
    same(await sel(), { anchor: beat("wd", 0), head: beat("we", 14) }, "selection");
    const before = await snapshot();
    await key("Backspace");
    same(ids(await rows()), "wa,wb,wc,wf", "both beats gone, last paragraph stays");
    ok((await rows())[3].start, "next paragraph keeps its start");
    await undoRestores(before);
  });

  await t("mid-sentence: a selection starting right after the gap", async () => {
    await fresh(midSentence());
    await select(beat("wb", 0), beat("wb", 3));
    await type("the");
    same(await textOf("wb"), "the bought some milk", "replaced within the beat");
    same(await textOf("wa"), "We went to the store", "before untouched");
  });

  await t("edges: a beat starting and ending with a tag or bold", async () => {
    const raw = midSentence();
    raw.rows[3].audioText = '<span class="tag-anchor" data-tag-cat="vfx" data-tag-name="lamp" contenteditable="false">lamp</span> mid <strong>bold</strong>';
    raw.rows[4].audioText = '<span class="tag-anchor" data-tag-cat="vfx" data-tag-name="desk" contenteditable="false">desk</span>';
    await fresh(raw);
    await caret("wd", 0);
    await type("A");
    let row = (await rows()).find(r => r.id === "wd");
    same(row.text, "Alamp mid bold", "typed before a leading tag");
    ok(row.html.includes('data-tag-name="lamp"'), "tag kept");
    await caret("wd", row.text.length);
    await type("Z");
    row = (await rows()).find(r => r.id === "wd");
    ok(row.text.endsWith("boldZ"), row.text);
    await caret("we", 4);
    await type("B");
    const after = (await rows()).find(r => r.id === "we");
    same(after.text, "deskB", "typed after a trailing tag");
    ok(after.html.includes('data-tag-name="desk"'), "second tag kept");
    await key("ArrowLeft");
    await key("ArrowLeft");
    const head = (await sel()).head;
    ok(head.rowId === "we" && head.offset <= 4, "arrow over a tag: " + JSON.stringify(head));
  });

  await t("headings: every offset maps to the screen and back", async () => {
    await fresh();
    for (const scene of await ev("__lab.doc().sections")) {
      for (let at = 0; at <= scene.name.length; at++) {
        await ev(`__lab.surface.place(${JSON.stringify({ anchor: heading(scene.id, at), head: heading(scene.id, at) })})`);
        same((await sel()).head, heading(scene.id, at), "round trip");
      }
    }
  });

  const clickOn = async selector => {
    const box = await ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await clickTimes(box, 1);
  };

  await t("visual box: caret in a beat edits that beat's visual, and Done puts the caret back", async () => {
    await fresh();
    await caret("ra", 3);
    await clickOn("#open-visual");
    ok(await ev(`!document.getElementById("visual-box").hidden`), "box opens");
    same(await ev(`document.activeElement.id`), "visual-text", "focus in the box");
    await type("New shot");
    same((await rows())[0].visual, "New shot", "visual saved");
    await key("Escape");
    ok(await ev(`document.getElementById("visual-box").hidden`), "box closes");
    same(await ev(`document.activeElement.id`), "doc", "focus back");
    same((await sel()).head, beat("ra", 3), "caret back");
  });

  await t("visual box: selected words become their own beat once a visual is typed", async () => {
    await fresh(midSentence());
    await select(beat("wb", 4), beat("wb", 10));
    await clickOn("#open-visual");
    same(await textOf("wb"), "and bought some milk", "nothing splits just by opening");
    await type("Till");
    const now = await rows();
    same(now.length, 8, "split into three");
    same(now.slice(1, 4).map(r => r.text), ["and ", "bought", " some milk"], "pieces");
    same(now[2].visual, "Till", "visual on the chosen words");
    same(now[1].id, "wb", "the first piece keeps the id");
    same(await ev(`document.activeElement.id`), "visual-text", "still typing in the box");
    await key("Escape");
    same((await sel()).head.rowId, now[2].id, "selection on the new beat");
    await ev("__lab.flush()");
    await key("z", "ctrl");
    await key("z", "ctrl");
    same(await textOf("wb"), "and bought some milk", "undo puts it back");
    same((await rows()).length, 6, "undo removes the split");
  });

  await t("visual box: a selection across beats says why it can't", async () => {
    await fresh();
    await select(beat("ra", 3), beat("rb", 3));
    await clickOn("#open-visual");
    ok(await ev(`document.getElementById("visual-box").hidden`), "box stays closed");
    ok((await ev(`document.getElementById("notice").textContent`)).includes("within one beat"), "notice");
    ok(await ev(`document.querySelector('[title="Comments"], [data-one-beat]').disabled`), "one-beat buttons disabled");
  });

  await t("find: Ctrl+F, highlight without losing the box's focus, Enter moves, Esc selects", async () => {
    await fresh(midSentence());
    await caret("wa", 2);
    await key("f", "ctrl");
    same(await ev(`document.activeElement.id`), "find-text", "focus in Find");
    await type("store and");
    same(await ev(`document.getElementById("find-count").textContent`), "1 of 1", "matches across the gap");
    same(await ev(`document.activeElement.id`), "find-text", "focus stays");
    same(await ev(`CSS.highlights.get("wr-find-current").size`), 1, "painted");
    await key("Escape");
    ok(await ev(`document.getElementById("find").hidden`), "bar closes");
    same(await sel(), { anchor: beat("wa", 15), head: beat("wb", 3) }, "match selected");
    same(await ev(`CSS.highlights.has("wr-find-current")`), false, "highlight cleared");
  });

  await t("find: replace one and replace all, each one undo, keeping beats", async () => {
    await fresh();
    await caret("ra", 0);
    await key("f", "ctrl");
    await type("o");
    const total = await ev(`__lab.find("o").length`);
    ok(total > 3, "matches: " + total);
    await ev(`document.getElementById("find-replace").value = "0"`);
    await clickOn("#find-one");
    same(await ev(`__lab.find("o").length`), total - 1, "one replaced");
    same(await ev(`document.activeElement.id`), "find-replace", "focus stays in the replace box");
    const before = await snapshot();
    await clickOn("#find-all");
    same(await ev(`__lab.find("o").length`), 0, "all replaced");
    same(ids(await rows()), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "beats kept");
    same((await sel()) !== undefined, true, "selection readable");
    await ev(`document.getElementById("doc").focus()`);
    await key("z", "ctrl");
    same(await snapshot(), before, "one undo");
    await ev(`document.getElementById("find").hidden = true`);
  });

  await t("find: replacing across the gap keeps both beats", async () => {
    await fresh(midSentence());
    const match = (await ev(`__lab.find("store and")`))[0];
    await ev(`__lab.surface.apply("replace", () => __lab.replaceMatch(${JSON.stringify(match.range)}, "shop and"), null)`);
    await settle();
    same(await textOf("wa"), "We went to the shop and", "first beat takes the words");
    same(await textOf("wb"), " bought some milk", "second keeps the rest");
  });

  await t("switch: Enter as new paragraph", async () => {
    await fresh(midSentence());
    await ev(`__lab.setting("enter","single")`);
    await caret("wb", 3);
    await key("Enter");
    let now = await rows();
    same(now.length, 7, "splits");
    ok(now[2].start, "starts a paragraph");
    await fresh(midSentence());
    await ev(`__lab.setting("enter","single")`);
    await caret("wa", 20);
    await key("Enter");
    now = await rows();
    same(now.length, 6, "no new beat");
    ok(now[1].start, "next beat flagged");
    same((await sel()).head, beat("wb", 0), "caret");
    await fresh(midSentence());
    await ev(`__lab.setting("enter","single")`);
    await caret("wf", 14);
    await key("Enter");
    now = await rows();
    same(now.length, 7, "a new beat at the end");
    ok(now[6].start, "and a paragraph");
    await key("Enter");
    same((await rows()).length, 7, "Enter on a blank does nothing");
  });

  await t("switch: Backspace at a tick joins", async () => {
    await fresh(midSentence());
    await ev(`__lab.setting("tick","join")`);
    await caret("wb", 0);
    await key("Backspace");
    const now = await rows();
    same(now.length, 5, "joined");
    same(now[0].text, "We went to the store and bought some milk", "text");
  });

  await t("switch: tick styles and the visual-only style don't change the text or the caret", async () => {
    await fresh();
    for (const tick of ["line", "dot", "number", "none"]) {
      await ev(`document.querySelector('[data-setting="tickStyle"]').value = "${tick}"; document.querySelector('[data-setting="tickStyle"]').dispatchEvent(new Event("change"))`);
      await caret("ra", 10);
      await key("ArrowRight");
      same((await sel()).head, beat("rb", 0), tick + " caret");
    }
    await ev(`document.querySelector('[data-setting="tickStyle"]').value = "number"; document.querySelector('[data-setting="tickStyle"]').dispatchEvent(new Event("change"))`);
    same(await ev(`document.body.getAttribute("data-visual-only")`), "chip", "the chip is the default");
    await caret("rc", 17);
    await key("ArrowRight");
    same((await sel()).head.rowId, "rd", "into the chip");
    await type("x");
    same(await textOf("rd"), "x", "typing in a chip");
    await fresh();
    await ev(`document.querySelector('[data-setting="visualOnly"]').value = "line"; document.querySelector('[data-setting="visualOnly"]').dispatchEvent(new Event("change"))`);
    await caret("rc", 17);
    await key("ArrowRight");
    same((await sel()).head.rowId, "rd", "into the line");
    await ev(`document.querySelector('[data-setting="visualOnly"]').value = "chip"; document.querySelector('[data-setting="visualOnly"]').dispatchEvent(new Event("change"))`);
  });

  await t("numbers: every beat with words or a visual shows its number, including a paragraph's first", async () => {
    await fresh();
    same(await ev(`document.body.getAttribute("data-tick")`), "number", "numbers are the default");
    const shown = await ev(`Array.from(document.querySelectorAll(".wr-beat")).map(el => [el.getAttribute("data-id"), el.getAttribute("data-num"), getComputedStyle(el, "::before").content])`);
    same(shown.map(item => item[1]), ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5"], "a running count per scene");
    same(shown.find(item => item[0] === "ra")[2], '"A1"', "the script's first beat shows a number");
    same(shown.find(item => item[0] === "rc")[2], '"A3"', "a paragraph's first beat shows a number");
    same(shown.find(item => item[0] === "rd")[2], '"A4  ▣ Street b-roll"', "the chip shows its number");
    await caret("rc", 0);
    await key("Backspace");
    same((await sel()).head, beat("rc", 0), "the number doesn't move the caret");
    await caret("rc", 0);
    await type("Q");
    same(await textOf("rc"), "QCharlie bold end.", "typing lands after the number");
  });

  const SHA_A = "a".repeat(64), SHA_B = "b".repeat(64);
  const picture = sha => ({ sha256: sha, width: 640, height: 480, mime: "image/png" });
  const twoVisuals = () => {
    const raw = midSentence();
    Object.assign(raw.rows[0], { visualText: "Desk shot", imageRef: picture(SHA_A), status: "todo" });
    Object.assign(raw.rows[1], { visualText: "Street <strong>wide</strong>", imageRef: picture(SHA_B), status: "shot" });
    return raw;
  };

  await t("join: both visuals combine, with both pictures and the higher status, as one undo", async () => {
    await fresh(twoVisuals());
    const before = await snapshot();
    await caret("wb", 0);
    await key("Backspace", "alt");
    const now = await rows();
    same(now.length, 5, "joined");
    same(now[0].text, "We went to the store and bought some milk", "narration");
    const joined = (await ev("__lab.doc().rows"))[0];
    same(joined.id, "wa", "keeps the first beat's id");
    same(joined.visualText, "Desk shot<br>Street <strong>wide</strong>", "both visuals' words");
    same(joined.imageRef.sha256, SHA_A, "first picture");
    same(joined.moreImages.map(item => item.imageRef.sha256), [SHA_B], "second picture");
    same(joined.status, "shot", "higher status");
    ok((await ev(`document.getElementById("notice").textContent`)).includes("kept both visuals"), "says so");
    await ev(`__lab.load(JSON.parse(JSON.stringify(__lab.doc())))`);
    await settle();
    same((await ev("__lab.doc().rows"))[0].moreImages.length, 1, "survives reopening");
    await fresh(twoVisuals());
    await caret("wb", 0);
    await key("Backspace", "alt");
    await key("z", "ctrl");
    same(await snapshot(), before, "undo");
  });

  await t("join: the same picture in both beats is kept once", async () => {
    const raw = twoVisuals();
    raw.rows[1].imageRef = picture(SHA_A);
    await fresh(raw);
    await caret("wb", 0);
    await key("Backspace", "alt");
    const joined = (await ev("__lab.doc().rows"))[0];
    same(joined.imageRef.sha256, SHA_A, "picture");
    ok(!joined.moreImages, "no copy");
  });

  await t("join: a scene header still refuses, and changes nothing", async () => {
    await fresh();
    const before = await snapshot();
    await caret("rf", 0);
    await key("Backspace", "alt");
    same(await snapshot(), before, "unchanged");
    ok((await ev(`document.getElementById("notice").textContent`)).includes("scene header"), "says why");
  });

  await t("switch: scripts and the sentence rule load", async () => {
    const pick = async (name, value) => { await ev(`(() => { const c = document.querySelector('[data-setting="${name}"]'); c.value = "${value}"; c.dispatchEvent(new Event("change")); })()`); await settle(); };
    await pick("script", "blank");
    same((await rows()).length, 1, "blank has one beat");
    await caret((await rows())[0].id, 0);
    await type("hi");
    same((await rows())[0].text, "hi", "typing in the blank script");
    await pick("script", "demo");
    await pick("opening", "scene");
    const sceneRule = await ev(`document.querySelectorAll(".wr-par").length`);
    await pick("opening", "sentence");
    ok(await ev(`document.querySelectorAll(".wr-par").length`) > sceneRule, "sentence rule makes more paragraphs");
    await pick("script", "long");
    same((await rows()).length, 900, "long script");
    await pick("script", "demo");
    await clickOn("#reset");
    same((await rows()).length, 30, "start over");
  });

  await t("reopen: the edited script loads back exactly as it was", async () => {
    await fresh();
    await caret("rb", 5);
    await key("Enter");
    await type("x");
    await select(beat("re", 2), beat("rf", 3));
    await key("Backspace");
    await caret("ra", 2);
    await key("Enter", "alt");
    await ev("__lab.flush()");
    const before = await snapshot();
    await ev(`__lab.load(JSON.parse(JSON.stringify(__lab.doc())))`);
    await settle();
    same(await snapshot(), before, "reopened");
  });

  await t("gap: Ctrl+arrow moves by word across it", async () => {
    await fresh();
    await caret("ra", 6);
    const seen = [];
    let reached = false;
    for (let press = 0; press < 5 && !reached; press++) {
      await key("ArrowRight", "ctrl");
      const head = (await sel()).head;
      const last = seen[seen.length - 1];
      ok(!last || JSON.stringify(last) !== JSON.stringify(head), "a press didn't move: " + JSON.stringify(seen));
      seen.push(head);
      reached = head.rowId === "rb" && head.offset >= 5;
    }
    ok(reached, "never got into the next beat's words: " + JSON.stringify(seen));
    gapNotes.ctrlRight = seen.map(pos => pos.rowId + ":" + pos.offset).join(" ");
  });

  await t("gap: Shift+arrow selects across it", async () => {
    await fresh();
    await caret("ra", 9);
    for (let i = 0; i < 3; i++) await key("ArrowRight", "shift");
    const range = await sel();
    same(range.anchor, beat("ra", 9), "anchor");
    same(range.head.rowId, "rb", "head beat");
  });

  await t("gap: copy gives one space, once", async () => {
    await fresh();
    await select(beat("ra", 6), beat("rb", 5));
    const text = await ev(`(() => { const dt = new DataTransfer(); document.getElementById("doc").dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData("text/plain"); })()`);
    same(text, "one. Bravo", "copied text");
  });

  await t("gap: Find matches across it, and a lone space doesn't", async () => {
    await fresh();
    const across = await ev(`__lab.find("one. Bravo")`);
    same(across.length, 1, "across");
    same(across[0].range.anchor, beat("ra", 6), "start");
    same(across[0].range.head, beat("rb", 5), "end");
    const spaces = await ev(`__lab.find(" ")`);
    for (const match of spaces) ok(match.range.anchor.rowId === match.range.head.rowId, "lone space matched a gap");
  });

  await t("gap: typing a space at the boundary is an ordinary character", async () => {
    await fresh();
    await caret("ra", 10);
    await type(" ");
    same((await rows()).find(r => r.id === "ra").text, "Alpha one. ", "stored");
    ok(await ev(`document.querySelector('.wr-beat[data-id="rb"]').classList.contains("no-gap")`), "gap steps aside");
    await type("x");
    same(await textOf("ra"), "Alpha one. x", "keeps typing");
  });

  await t("select: replacing across beats keeps the first beat, removes those inside", async () => {
    await fresh();
    const base = await ev("__lab.doc().rows");
    const before = await snapshot();
    await select(beat("ra", 3), beat("rc", 8));
    await type("X");
    const now = await rows();
    same(ids(now), "ra,rc,rd,re,rf,rg,rh,ri,rj", "ids");
    same(now[0].text, "AlpX", "first");
    same(now[1].text, "bold end.", "last");
    await untouched(base, ["ra", "rb", "rc"]);
    await undoRestores(before);
  });

  await t("select: deleting across beats merges the paragraphs", async () => {
    await fresh();
    const before = await snapshot();
    await select(beat("rb", 5), beat("rc", 8));
    await key("Backspace");
    const now = await rows();
    same(ids(now), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "ids");
    same(now.find(r => r.id === "rb").text, "Bravo", "head");
    same(now.find(r => r.id === "rc").text, "bold end.", "tail");
    ok(!now.find(r => r.id === "rc").start, "paragraph break gone");
    await undoRestores(before);
  });

  await t("select: a selection inside one beat, even all of it, keeps the beat", async () => {
    await fresh();
    await select(beat("rb", 0), beat("rb", 10));
    await key("Delete");
    const now = await rows();
    same(ids(now), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "ids");
    same(now.find(r => r.id === "rb").text, "", "text");
    same(now.find(r => r.id === "rb").visual, "Desk shot", "visual");
  });

  await t("select: Ctrl+A then Delete leaves one empty beat, and one Ctrl+Z restores all", async () => {
    await fresh();
    const before = await snapshot();
    await caret("ra", 2);
    await key("a", "ctrl");
    await key("Delete");
    const now = await rows();
    same(now.length, 1, "one beat");
    same(now[0].text, "", "empty");
    same(await ev("__lab.comments()"), [], "comments");
    same(await ev("__lab.doc().sections ?? null"), null, "sections");
    await undoRestores(before);
  });

  await t("select: repainting while selected keeps the selection", async () => {
    await fresh();
    await select(beat("ra", 3), beat("rc", 4));
    const before = await sel();
    await ev("__lab.surface.paint()");
    await settle();
    same(await sel(), before, "selection");
  });

  await t("format: Ctrl+B across beats, then Ctrl+Z", async () => {
    await fresh();
    const before = await snapshot();
    await select(beat("ra", 6), beat("rb", 5));
    await key("b", "ctrl");
    const now = await rows();
    ok(now[0].html.includes("<strong>one.</strong>"), now[0].html);
    ok(now[1].html.includes("<strong>Bravo</strong>"), now[1].html);
    same(await sel(), { anchor: beat("ra", 6), head: beat("rb", 5) }, "selection stays");
    await undoRestores(before);
  });

  await t("format: pending bold applies to the next character only until the caret moves", async () => {
    await fresh();
    await caret("ra", 5);
    await key("b", "ctrl");
    await type("X");
    await type("Y");
    const html = (await rows())[0].html;
    ok(/<strong>XY?<\/strong>/.test(html), html);
    await caret("ra", 2);
    await key("b", "ctrl");
    await caret("ra", 3);
    await type("Z");
    ok(!(await rows())[0].html.includes("<strong>Z"), "pending cleared by moving");
  });

  await t("format: toolbar click keeps the selection and focus", async () => {
    await fresh();
    await select(beat("ra", 0), beat("rb", 5));
    const box = await ev(`(() => { const r = document.querySelector('[data-mark="i"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
    await settle();
    ok((await rows())[0].html.includes("<em>"), "italic applied");
    same(await ev(`document.activeElement.id`), "doc", "focus");
    same(await sel(), { anchor: beat("ra", 0), head: beat("rb", 5) }, "selection");
  });

  await t("enter: mid-beat starts a new beat, keeps the visual on the first half, and a second Enter starts the paragraph", async () => {
    await fresh();
    const before = await snapshot();
    await caret("rb", 5);
    await key("Enter");
    let now = await rows();
    same(now.length, 11, "count");
    same(now[1].text, "Bravo", "first half");
    same(now[1].visual, "Desk shot", "visual");
    same(now[2].text, " two.", "second half");
    ok(!now[2].start, "same paragraph after one Enter");
    same((await sel()).head, beat(now[2].id, 0), "caret");
    await key("Enter");
    now = await rows();
    same(now.length, 11, "second Enter adds no beat");
    ok(now[2].start, "second Enter starts the paragraph");
    same((await sel()).head, beat(now[2].id, 0), "caret stays");
    await key("Enter");
    same((await rows()).length, 12, "a third Enter pushes the text down with a new beat");
    await key("z", "ctrl");
    await key("z", "ctrl");
    await undoRestores(before);
  });

  await t("enter: at a beat's end makes a new beat to type in, and a second Enter leaves no empty beat behind", async () => {
    await fresh();
    await caret("ra", 10);
    await key("Enter");
    let now = await rows();
    same(now.length, 11, "new beat");
    same(now[1].text, "", "empty");
    ok(!now[1].start, "same paragraph");
    same((await sel()).head, beat(now[1].id, 0), "caret in it");
    await key("Enter");
    now = await rows();
    same(ids(now), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "the empty beat is gone");
    ok(now[1].start, "the next beat starts the paragraph");
    same((await sel()).head, beat("rb", 0), "caret");
    same(await textOf("ra"), "Alpha one.", "text before");
    same(await textOf("rb"), "Bravo two.", "text after");
  });

  await t("enter: at the last beat's end, the second Enter starts a paragraph, and a third does nothing", async () => {
    await fresh();
    await caret("rj", 11);
    await key("Enter");
    let now = await rows();
    same(now.length, 11, "new beat");
    ok(!now[10].start, "same paragraph");
    const blank = now[10].id;
    await key("Enter");
    now = await rows();
    same(now.length, 11, "still 11");
    ok(now[10].start, "now a paragraph");
    same((await sel()).head, beat(blank, 0), "caret");
    await key("Enter");
    same((await rows()).length, 11, "nothing on a blank paragraph");
    await type("New");
    same(await textOf(blank), "New", "typing");
  });

  await t("enter: at a paragraph's start pushes the text down, and at a scene's first beat keeps the scene above", async () => {
    await fresh();
    const before = await snapshot();
    await caret("rc", 0);
    await key("Enter");
    let now = await rows();
    same(now.length, 11, "new beat above");
    same(now[2].text, "", "empty");
    ok(now[2].start, "the empty beat takes the paragraph start");
    same(now[3].id, "rc", "text moves down");
    ok(!now[3].start, "same paragraph");
    same((await sel()).head, beat("rc", 0), "caret stays with the text");
    await undoRestores(before);
    await fresh();
    await caret("rf", 0);
    await key("Enter");
    now = await rows();
    const scene = (await ev("__lab.doc().sections")).find(s => s.id === "s2");
    same(scene.firstSceneId, now[5].id, "the scene moves to the new beat");
    same(now[6].id, "rf", "text below it");
    same(await ev(`document.querySelector('[data-scene="s2"]').nextElementSibling.querySelector('.wr-beat').getAttribute("data-id")`), now[5].id, "screen order");
  });

  await t("enter: on a chip makes a new beat after it, and the chip keeps its visual", async () => {
    await fresh();
    await caret("rd", 0);
    await key("Enter");
    const now = await rows();
    same(now.length, 11, "new beat");
    same(now[3].visual, "Street b-roll", "chip keeps the visual");
    same(now[4].text, "", "new beat is empty");
    same((await sel()).head, beat(now[4].id, 0), "caret after the chip");
  });

  await t("enter: over a selection across beats is one undo", async () => {
    await fresh();
    const before = await snapshot();
    await select(beat("ra", 6), beat("rb", 5));
    await key("Enter");
    const now = await rows();
    same(now[0].text, "Alpha ", "first");
    same(now[1].text, "", "new beat");
    same(now[2].text, " two.", "last");
    await undoRestores(before);
  });

  await t("enter: Alt+Enter starts a beat in the same paragraph", async () => {
    await fresh();
    await caret("rb", 5);
    await key("Enter", "alt");
    const now = await rows();
    same(now.length, 11, "count");
    ok(!now[2].start, "no flag");
    same(now[2].text, " two.", "text");
  });

  await t("enter: Shift+Enter is a line break inside the beat", async () => {
    await fresh();
    const before = await snapshot();
    await caret("rb", 5);
    await key("Enter", "shift");
    const now = await rows();
    same(now.length, 10, "count");
    ok(now[1].html.includes("<br"), now[1].html);
    same((await sel()).head, beat("rb", 6), "caret");
    await type("X");
    ok((await textOf("rb")).startsWith("Bravo\nX"), JSON.stringify(await textOf("rb")));
    await key("z", "ctrl");
    await key("z", "ctrl");
    same(await snapshot(), before, "undo");
  });

  await t("backspace: paragraph start removes only the break", async () => {
    await fresh();
    await caret("rc", 0);
    await key("Backspace");
    const now = await rows();
    ok(!now[2].start, "flag gone");
    same(now[1].text, "Bravo two.", "before unchanged");
    same(now[2].text, "Charlie bold end.", "beat unchanged");
    same((await sel()).head, beat("rc", 0), "caret");
  });

  await t("backspace: just after a tick deletes the previous character", async () => {
    await fresh();
    await caret("rb", 0);
    await key("Backspace");
    same(await textOf("ra"), "Alpha one", "previous");
    same(await textOf("rb"), "Bravo two.", "beat");
    same(ids(await rows()), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "ids");
  });

  await t("backspace: first beat under a header moves to the header's end, changes nothing", async () => {
    await fresh();
    const before = await snapshot();
    await caret("rf", 0);
    await key("Backspace");
    same(await snapshot(), before, "nothing changed");
    same((await sel()).head, heading("s2", 6), "caret");
  });

  await t("backspace: a blank beat is removed", async () => {
    await fresh();
    await caret("ri", 0);
    await key("Backspace");
    same(ids(await rows()), "ra,rb,rc,rd,re,rf,rg,rh,rj", "ids");
    same((await sel()).head, beat("rh", 12), "caret");
  });

  await t("delete: end of a beat removes the next character", async () => {
    await fresh();
    await caret("ra", 10);
    await key("Delete");
    same(await textOf("rb"), "ravo two.", "next");
    same((await sel()).head, beat("ra", 10), "caret");
  });

  await t("delete: last beat above a header moves to the header's start, changes nothing", async () => {
    await fresh();
    const before = await snapshot();
    await caret("re", 9);
    await key("Delete");
    same(await snapshot(), before, "nothing changed");
    same((await sel()).head, heading("s2", 0), "caret");
  });

  await t("delete: paragraph end removes only the break", async () => {
    await fresh();
    await caret("rb", 10);
    await key("Delete");
    ok(!(await rows())[2].start, "flag gone");
    same(await textOf("rc"), "Charlie bold end.", "text");
  });

  await t("word delete: Ctrl+Backspace inside a beat is native", async () => {
    await fresh();
    await caret("ra", 9);
    await key("Backspace", "ctrl");
    same(await textOf("ra"), "Alpha .", "text");
    same(ids(await rows()), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "ids");
  });

  await t("word delete: Ctrl+Backspace at a paragraph start removes only the break", async () => {
    await fresh();
    await caret("rc", 0);
    await key("Backspace", "ctrl");
    ok(!(await rows())[2].start, "break gone");
    same(await textOf("rb"), "Bravo two.", "before");
    same(await textOf("rc"), "Charlie bold end.", "beat");
  });

  await t("word delete: Ctrl+Delete at a paragraph end removes only the break", async () => {
    await fresh();
    await caret("rb", 10);
    await key("Delete", "ctrl");
    ok(!(await rows())[2].start, "break gone");
    same(await textOf("rb"), "Bravo two.", "before");
    same(await textOf("rc"), "Charlie bold end.", "beat");
  });

  await t("word delete: Ctrl+Backspace at a tick stays within the words and keeps the beats", async () => {
    await fresh();
    await caret("rb", 0);
    await key("Backspace", "ctrl");
    same(ids(await rows()), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "ids");
    same(await textOf("rb"), "Bravo two.", "beat after");
    ok((await textOf("ra")).length < 10, "something before deleted: " + JSON.stringify(await textOf("ra")));
  });

  await t("word delete: Ctrl+Delete at a beat's end", async () => {
    await fresh();
    await caret("ra", 10);
    await key("Delete", "ctrl");
    same(ids(await rows()), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "ids");
    same(await textOf("ra"), "Alpha one.", "beat before");
    ok((await textOf("rb")).length < 10, "next beat's first word goes: " + JSON.stringify(await textOf("rb")));
  });

  await t("join: Alt+Backspace joins and is one undo", async () => {
    await fresh();
    await caret("rb", 0);
    const before = await snapshot();
    await ev(`__lab.flush()`);
    await key("Backspace", "alt");
    const now = await rows();
    same(now.length, 9, "count");
    same(now[0].text, "Alpha one. Bravo two.", "text");
    same(now[0].visual, "Desk shot", "visual kept");
    await undoRestores(before);
  });

  await t("clipboard: pasting several paragraphs splits at the caret", async () => {
    await fresh();
    const before = await snapshot();
    await caret("ra", 5);
    await ev(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "One\\n\\nTwo\\nThree"); document.getElementById("doc").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await settle();
    const now = await rows();
    same(now.slice(0, 4).map(r => r.text), ["AlphaOne", "Two", "Three one."].concat(now[3].text), "pieces");
    await undoRestores(before);
  });

  await t("clipboard: cut across beats", async () => {
    await fresh();
    const before = await snapshot();
    await select(beat("ra", 6), beat("rb", 5));
    const text = await ev(`(() => { const dt = new DataTransfer(); document.getElementById("doc").dispatchEvent(new ClipboardEvent("cut", { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData("text/plain"); })()`);
    await settle();
    same(text, "one. Bravo", "copied");
    same((await rows())[0].text, "Alpha ", "head");
    same((await rows())[1].text, " two.", "tail");
    await undoRestores(before);
  });

  await t("spellcheck: replacing a word by selecting it and inserting (simulated)", async () => {
    await fresh();
    await select(beat("ra", 0), beat("ra", 5));
    await send("Input.insertText", { text: "Omega" });
    await settle();
    same(await textOf("ra"), "Omega one.", "text");
    same(await textOf("rb"), "Bravo two.", "next");
    await select(beat("ra", 6), beat("rb", 5));
    await send("Input.insertText", { text: "two" });
    await settle();
    same(await textOf("ra"), "Omega two", "across beats");
    same(await textOf("rb"), " two.", "tail");
  });

  await t("heading: typing renames the scene, undo restores", async () => {
    await fresh();
    await select(heading("s2", 6));
    await type("!");
    same((await ev("__lab.doc().sections")).find(s => s.id === "s2").name, "Middle!", "name");
    same(await ev(`document.querySelector('[data-scene="s2"]').textContent`), "Middle!", "screen");
    await key("z", "ctrl");
    same((await ev("__lab.doc().sections")).find(s => s.id === "s2").name, "Middle", "undo");
  });

  await t("heading: Enter at its end moves into the first beat", async () => {
    await fresh();
    await select(heading("s2", 6));
    await key("Enter");
    same((await sel()).head, beat("rf", 0), "caret");
    same((await rows()).length, 10, "count");
  });

  await t("heading: a selection across a whole header removes it", async () => {
    await fresh();
    const before = await snapshot();
    await select(beat("re", 4), beat("rf", 7));
    await key("Backspace");
    same((await ev("__lab.doc().sections")).map(s => s.id), ["s1"], "scene gone");
    same(await textOf("re"), "Echo", "head");
    same(await textOf("rf"), " six.", "tail");
    await undoRestores(before);
  });

  await t("heading: emptying one removes it", async () => {
    await fresh();
    await select(heading("s2", 0), heading("s2", 6));
    await key("Backspace");
    same((await ev("__lab.doc().sections")).map(s => s.id), ["s1"], "scene gone");
    same(ids(await rows()), "ra,rb,rc,rd,re,rf,rg,rh,ri,rj", "ids");
    ok((await rows()).find(r => r.id === "rf").start, "first beat starts a paragraph");
  });

  await t("empty beats: typing goes in, removes the placeholder, keeps the caret", async () => {
    await fresh();
    await caret("ri", 0);
    await type("abc");
    same(await textOf("ri"), "abc", "text");
    same((await sel()).head, beat("ri", 3), "caret");
    ok(!(await ev(`document.querySelector('.wr-beat[data-id="ri"]').classList.contains("is-empty")`)), "class");
    await key("Backspace");
    await key("Backspace");
    await key("Backspace");
    same(await textOf("ri"), "", "emptied");
    ok(await ev(`document.querySelector('.wr-beat[data-id="ri"]').classList.contains("is-empty")`), "empty again");
    await type("d");
    same(await textOf("ri"), "d", "still typable");
  });

  await t("visual-only beats: typing goes in and keeps the visual", async () => {
    await fresh();
    await caret("rd", 0);
    await type("Now");
    const row = (await rows()).find(r => r.id === "rd");
    same(row.text, "Now", "text");
    same(row.visual, "Street b-roll", "visual");
  });

  await t("visual-only beats: arrows pass through without losing the caret", async () => {
    await fresh();
    await caret("rc", 17);
    await key("ArrowRight");
    const first = await sel();
    ok(first && (first.head.rowId === "rd" || first.head.rowId === "re"), JSON.stringify(first));
    await key("ArrowRight");
    const second = await sel();
    ok(second && second.head.rowId === "re", JSON.stringify(second));
  });

  await t("markdown: # then words then Enter makes a scene, and Ctrl+Z restores", async () => {
    await fresh();
    await caret("rh", 0);
    await type("# ");
    await type("Late");
    same(await textOf("rh"), "# LateHotel eight.", "pending shows the marker");
    await key("z", "ctrl");
    await fresh();
    await caret("ri", 0);
    const before = await snapshot();
    await type("# Late");
    ok(await ev(`document.querySelector('.wr-beat[data-id="ri"]').classList.contains("is-pending-heading")`), "pending look");
    await key("Enter");
    const scenes = await ev("__lab.doc().sections");
    ok(scenes.some(s => s.name === "Late"), JSON.stringify(scenes));
    await key("z", "ctrl");
    same(await ev(`__lab.doc().sections.length`), 2, "undo removes the scene");
    same(await textOf("ri"), "# Late", "and restores the characters");
    ok(before, "before");
  });

  await t("markdown: leaving the line finalizes, a run-on beat refuses and strips the marker", async () => {
    await fresh();
    await caret("ri", 0);
    await type("# Soon");
    await caret("rj", 2);
    await settle();
    ok((await ev("__lab.doc().sections")).some(s => s.name === "Soon"), "finalized on leaving");
    same((await sel()).head, beat("rj", 2), "caret stays where it was put");
    await fresh();
    await caret("rh", 0);
    await key("Enter", "alt");
    await fresh();
    await caret("rc", 0);
    await type("# ");
    await caret("ra", 2);
    await settle();
    same(await textOf("rc"), "Charlie bold end.", "marker removed because rc runs on into rd");
    same((await ev("__lab.doc().sections")).length, 2, "no new scene");
  });

  await t("markdown: **bold**, *italic*, ~~strike~~ and Ctrl+Z restores the characters", async () => {
    await fresh();
    await caret("ri", 0);
    await type("a **bb** c");
    let html = (await rows()).find(r => r.id === "ri").html;
    ok(html.includes("<strong>bb</strong>"), html);
    same(await textOf("ri"), "a bb c", "text");
    await fresh();
    await caret("ri", 0);
    await type("*it*");
    html = (await rows()).find(r => r.id === "ri").html;
    ok(html.includes("<em>it</em>"), html);
    await key("z", "ctrl");
    same(await textOf("ri"), "*it*", "undo restores the characters");
    await fresh();
    await caret("ri", 0);
    await type("~~st~~");
    ok((await rows()).find(r => r.id === "ri").html.includes("<s>st</s>"), "strike");
  });

  await t("IME: committing keeps the text, cancelling loses nothing", async () => {
    await fresh();
    await caret("ra", 5);
    await send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
    await settle();
    await send("Input.insertText", { text: "日本" });
    await settle();
    await ev("new Promise(r => setTimeout(r, 30))");
    same(await textOf("ra"), "Alpha日本 one.", "commit");
    await send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
    await settle();
    await send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    await settle();
    await ev("new Promise(r => setTimeout(r, 30))");
    same(await textOf("ra"), "Alpha日本 one.", "cancel");
  });

  await t("undo: several edits unwind and redo in order with the caret where the edit was", async () => {
    await fresh();
    const before = await snapshot();
    await caret("ra", 5);
    await type("X");
    await ev("__lab.undo.breakCoalescing()");
    await caret("rc", 0);
    await key("Backspace");
    await select(beat("re", 0), beat("rf", 3));
    await key("Backspace");
    const end = await snapshot();
    await key("z", "ctrl");
    await key("z", "ctrl");
    await key("z", "ctrl");
    same(await snapshot(), before, "all undone");
    await key("y", "ctrl");
    await key("y", "ctrl");
    await key("y", "ctrl");
    same(await snapshot(), end, "all redone");
  });

  const timing = await longScript();
  // why: taking a screenshot slows this browser's frames to one a second, so it has to follow the timing
  if (!only) {
    const control = midSentence();
    // why: a deliberate typo proves spellcheck was running, so "no underline at the gap" means something
    control.rows[5].audioText = "Last teh paragraph";
    await fresh(control);
    await caret("wf", 5);
    await type("x");
    await key("Backspace");
    await caret("wa", 3);
    await sleep(1200);
    await ev(`document.getElementById("doc").blur(); document.getElementById("doc").focus();`);
    await sleep(700);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(here, "dist", "accept-spellcheck.png"), Buffer.from(shot.data, "base64"));
    for (const scheme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await ev(`__lab.reloadDemo(); document.getElementById("switches").hidden = ${scheme === "dark"}`);
      await caret((await rows())[1].id, 6);
      await sleep(250);
      const view = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(here, "dist", `accept-demo-${scheme}.png`), Buffer.from(view.data, "base64"));
    }
  }
  return { version, timing };
}

async function longScript() {
  if (only && !"long".includes(only.toLowerCase())) return null;
  // why: each sample waits for the frame that shows the key, so a slow frame can't swallow the next press
  await ev(`(() => {
    let start = 0;
    document.getElementById("doc").addEventListener("keydown", () => { if (!start) start = performance.now(); }, true);
    window.__frame = () => new Promise(done => requestAnimationFrame(() => setTimeout(() => { const ms = start ? performance.now() - start : -1; start = 0; done(ms); }, 0)));
    // why: the time to the next frame depends on how headless paces frames, so this times the page's own work
    let workStart = 0;
    window.__works = [];
    document.getElementById("doc").addEventListener("keydown", () => {
      workStart = performance.now();
      setTimeout(() => { void document.getElementById("doc").offsetHeight; window.__works.push(performance.now() - workStart); }, 0);
    }, true);
  })()`);
  const summary = list => {
    const sorted = list.slice().sort((a, b) => a - b);
    const at = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
    return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
  };
  async function timedTyping(rowId, offset, keys) {
    await caret(rowId, offset);
    await ev("__frame()");
    await ev("window.__works.length = 0");
    const samples = [];
    for (const ch of keys) {
      await typeChar(ch);
      samples.push(await ev("__frame()"));
    }
    return { frame: summary(samples.filter(ms => ms >= 0)), work: summary(await ev("window.__works")) };
  }
  const out = {};
  await ev("__lab.quiet(true)");
  const text = "the quick brown fox jumps over the lazy dog ";
  await fresh();
  out.shortScript = await timedTyping("ra", 5, text);
  const made = await ev(`(() => { const t0 = performance.now(); __lab.load(__lab.longScript(30)); return { ms: Math.round(performance.now() - t0), beats: __lab.doc().rows.length, paragraphs: document.querySelectorAll(".wr-par").length }; })()`);
  out.long = made;
  const list = await rows();
  const first = list[1].id, middle = list[Math.floor(list.length / 2)].id, last = list[list.length - 1].id;
  out.longStart = await timedTyping(first, 2, text);
  out.longMiddle = await timedTyping(middle, 2, text);
  out.longEnd = await timedTyping(last, 2, text);
  async function timedKey(label, prepare, name, mods) {
    await prepare();
    await ev("__frame()");
    await ev("window.__works.length = 0");
    await key(name, mods);
    await ev("__frame()");
    out[label] = Math.round(await ev("window.__works[0] ?? -1"));
  }
  await timedKey("enterMiddleMs", () => caret(middle, 3), "Enter", "");
  await timedKey("undoEnterMs", async () => { await ev("__lab.flush()"); }, "z", "ctrl");
  await timedKey("deleteAcrossMs", () => select(beat(first, 2), beat(list[300].id, 2)), "Backspace", "");
  await timedKey("undoDeleteMs", async () => { await ev("__lab.flush()"); }, "z", "ctrl");
  await timedKey("selectAllDeleteMs", async () => { await caret(first, 1); await key("a", "ctrl"); }, "Delete", "");
  await timedKey("undoAllMs", async () => { await ev("__lab.flush()"); }, "z", "ctrl");
  const drift = await ev("__lab.check()");
  out.driftAfter = drift.length;
  await ev("__lab.quiet(false)");
  return out;
}

let exitCode = 1;
try {
  const { version, timing } = await run();
  const failed = results.filter(r => !r.pass);
  console.log(`browser: ${version}`);
  console.log(`passed ${results.length - failed.length} of ${results.length}`);
  for (const failure of failed) console.log(`FAIL ${failure.name}\n     ${failure.why}`);
  console.log("gap " + JSON.stringify(gapNotes));
  if (timing) console.log("timing " + JSON.stringify(timing));
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.log("run stopped: " + (error.stack || error));
} finally {
  try { ws?.close(); } catch { /* closing */ }
  browser.kill();
  if (process.platform === "win32") {
    const name = path.basename(profile);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe' OR Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${name}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", timeout: 30000 }); } catch { /* best effort */ }
  }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}
process.exit(exitCode);
