import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { prng, genPaste } from "./_paste-gen.mjs";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
window.__splitpageNoRemote = true;
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { cellFromClipboard } = await import("../js/05c-clipboard.js");
const { fromHtml, toHtml, projection, commentIds } = await import("../js/04c-doc-model.js");
const { undo, redo, undoSizes, flushEdits } = await import("../js/12a-undo.js");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const COUNT = Number(process.env.SPLITPAGE_PASTE_FUZZ) || 400;
const APP_COUNT = Number(process.env.SPLITPAGE_PASTE_APP_FUZZ) || 15;
const FIRST = 413000;
const BLANKS = new RegExp("[\\s" + String.fromCharCode(0x200b, 0xfffc) + "]+", "g");

function violation(html) {
  if (/<(script|style|template|noscript|iframe|object|embed|meta|link|picture|video|img)\b/i.test(html)) return "element";
  if (/\son[a-z]+\s*=/i.test(html)) return "handler";
  if (/javascript:/i.test(html)) return "scheme";
  if (/video-embed-card/.test(html)) return "card";
  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    if (!/^<a href="https?:\/\/[^"]*" target="_blank" rel="noopener">$/.test(m[0])) return "link " + m[0];
  }
  return null;
}

function plainOf(html) {
  const doc = new window.DOMParser().parseFromString("<!doctype html><body>" + html, "text/html");
  doc.body.querySelectorAll("style, script, template, noscript, title, meta, link, img, picture, video, a.video-embed-card").forEach((el) => el.remove());
  return doc.body.textContent.replace(BLANKS, "");
}

function subsequence(small, big) {
  let at = 0;
  for (const ch of small) {
    at = big.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

test("seeded: whatever HTML is pasted, the cell is clean, canonical, within the bound, invents no words and keeps no comment it was not given", () => {
  const failures = [];
  for (let seed = FIRST; seed < FIRST + COUNT; seed++) {
    const paste = genPaste(prng(seed));
    let got;
    try {
      got = cellFromClipboard(paste.html, paste.text, { nonce: null, hasComment: () => true });
    } catch (error) {
      failures.push(seed + ": threw " + (error && error.message));
      continue;
    }
    const stored = toHtml(got.cell);
    let why = null;
    if (violation(stored)) why = "not clean: " + violation(stored);
    else if (toHtml(fromHtml(stored)) !== stored) why = "not canonical";
    else if (commentIds(got.cell).length) why = "a comment without a cut";
    else if (got.fromCut) why = "fromCut without a nonce";
    else if (stored.length > 14 * (paste.html.length + paste.text.length) + 4096) why = "output of " + stored.length;
    else if (got.text === null && !subsequence(projection(got.cell).replace(BLANKS, ""), plainOf(paste.html))) why = "invented words";
    else if (got.attach.some((a) => (a.kind === "image" && !/^[0-9a-f]{64}$/.test(a.ref.sha256)) || (a.kind === "video" && !/^https?:\/\//.test(a.href)))) why = "attachment";
    if (why) failures.push(seed + ": " + why);
  }
  assert.deepEqual(failures, []);
});

test("seeded: a cut's marker brings its comments only for this tab's nonce and only for comments that exist", () => {
  const failures = [];
  for (let seed = FIRST; seed < FIRST + COUNT; seed++) {
    const rnd = prng(seed);
    const paste = genPaste(rnd);
    const html = '<span data-splitpage-cut="n1">' + paste.html + "</span>";
    const mine = cellFromClipboard(html, paste.text, { nonce: "n1", hasComment: (id) => id === "c1" });
    const other = cellFromClipboard(html, paste.text, { nonce: "n2", hasComment: () => true });
    if (commentIds(mine.cell).some((id) => id !== "c1")) failures.push(seed + ": a comment that does not exist");
    if (commentIds(other.cell).length) failures.push(seed + ": another tab's comment");
    if (projection(mine.cell) !== projection(other.cell)) failures.push(seed + ": the words differ with the nonce");
  }
  assert.deepEqual(failures, []);
});

const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const KEY = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const comment = (id, rowId, field) => ({ id, rowId, field, anchorId: id, quotedText: "", kind: "anchor", text: "note", replies: [], body: "n" });

function fixture() {
  return {
    schema: 2,
    title: "Paste fuzz",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Hello there", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Alpha " + cmt("c1", "bravo charlie") + " delta", status: "ready" },
      { id: "r3", visualText: KEY("bsA") + " gulls", audioText: "Three.", status: "todo" },
      { id: "r4", visualText: KEY("bsB") + " harbour<br>" + KEY("bsC") + " boats", audioText: "Four " + cmt("c2", "words") + ".", status: "shot" }
    ],
    comments: [comment("c1", "r2", "audioText"), comment("c2", "r4", "audioText")]
  };
}

let opened = 0;
async function open() {
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(fixture())))], "fuzz-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
}

const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');

function clip(type, el, data) {
  const store = Object.assign({}, data || {});
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { getData: (t) => store[t] || "", setData: (t, v) => { store[t] = v; }, files: [], types: Object.keys(store) }
  });
  el.dispatchEvent(ev);
  return store;
}

function selectBetween(el, a, b) {
  const walker = document.createTreeWalker(el, 4);
  let at = 0, start = null, end = null;
  const from = Math.min(a, b), to = Math.max(a, b);
  while (walker.nextNode()) {
    const n = walker.currentNode, len = n.data.length;
    if (!start && from <= at + len) start = [n, from - at];
    if (!end && to <= at + len) { end = [n, to - at]; break; }
    at += len;
  }
  const r = document.createRange();
  if (!start || !end) {
    r.selectNodeContents(el);
    r.collapse(false);
  } else {
    r.setStart(start[0], start[1]);
    r.setEnd(end[0], end[1]);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function textLength(el) {
  const walker = document.createTreeWalker(el, 4);
  let n = 0;
  while (walker.nextNode()) n += walker.currentNode.data.length;
  return n;
}

function state() {
  return JSON.stringify({
    rows: currentDocument().rows.map((r) => {
      const copy = JSON.parse(JSON.stringify(r));
      delete copy.updatedAt;
      delete copy.updatedBy;
      return copy;
    }),
    comments: currentDocument().comments.map((c) => [c.id, c.rowId, c.field])
  });
}

const shots = () => currentDocument().brollShots.map((s) => s.id);

test("seeded: pasting into the booted app keeps every cell clean and canonical, keeps broll ids unique, and is one undo step that undoes and redoes exactly", async () => {
  const realNow = Date.now;
  let clock = 9_000_000;
  Date.now = () => clock;
  const errors = [];
  window.addEventListener("error", (e) => { errors.push(String(e.message)); });
  const failures = [];
  try {
    for (let seed = FIRST; seed < FIRST + APP_COUNT && !failures.length; seed++) {
      const rnd = prng(seed);
      await open();
      for (let step = 0; step < 6 && !failures.length; step++) {
        clock += 10_000;
        flushEdits();
        const id = "r" + (1 + Math.floor(rnd() * 4));
        const field = rnd() < 0.5 ? "visualText" : "audioText";
        const el = cellOf(id, field);
        const len = textLength(el);
        el.focus();
        selectBetween(el, Math.floor(rnd() * (len + 1)), Math.floor(rnd() * (len + 1)));
        const paste = genPaste(rnd);
        const label = seed + "/" + step;
        flushEdits();
        const before = state();
        const shotsBefore = shots();
        const entries = undoSizes().undo;
        errors.length = 0;
        clip("paste", el, paste.html === "" && paste.text === "" ? {} : { "text/html": paste.html, "text/plain": paste.text });
        flushEdits();
        const after = state();
        const shotsAfter = shots();
        const grew = undoSizes().undo - entries;
        if (errors.length) failures.push(label + " error " + errors[0]);
        currentDocument().rows.forEach((r) => {
          ["visualText", "audioText"].forEach((f) => {
            if (typeof r[f] === "string" && violation(r[f].replace(/<a class="video-embed-card"[^>]*>.*?<\/a>/g, ""))) failures.push(label + " " + r.id + "." + f + " not clean");
          });
        });
        const keys = currentDocument().rows.flatMap((r) => Array.from(String(r.visualText + r.audioText).matchAll(/data-broll-id="([^"]*)"/g), (m) => m[1]));
        if (keys.some((k) => !k) || new Set(keys).size !== keys.length) failures.push(label + " keys " + keys.join());
        const migrated = migrateRows(JSON.parse(JSON.stringify(currentDocument())));
        migrated.rows.forEach((r, i) => {
          if (r.visualText !== currentDocument().rows[i].visualText || r.audioText !== currentDocument().rows[i].audioText) failures.push(label + " not a migrate fixed point " + r.id);
        });
        if (grew > 1) failures.push(label + " entries " + grew);
        else if (grew === 1) {
          undo();
          if (state() !== before) failures.push(label + " undo");
          if (shotsBefore.some((id) => shots().indexOf(id) === -1)) failures.push(label + " undo lost a shot");
          redo();
          if (state() !== after) failures.push(label + " redo");
          if (shotsAfter.some((id) => shots().indexOf(id) === -1)) failures.push(label + " redo lost a shot");
        } else if (after !== before) {
          failures.push(label + " changed with no undo step");
        }
      }
    }
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(failures, []);
});
