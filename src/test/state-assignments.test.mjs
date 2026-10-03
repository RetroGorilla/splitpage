import "./_dom.mjs";
import "fake-indexeddb/auto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { S } from "../js/_state.js";

const seen = [];
let held = S.state;

function siteOf(stack) {
  for (const line of String(stack).split("\n").slice(1)) {
    const named = /^\s*at (?:async )?([\w$.<>]+) \(.*\/src\/js\/([\w.-]+\.js):\d+:\d+\)$/.exec(line);
    if (named) return named[2] + "#" + named[1].replace(/^Object\./, "");
    const bare = /^\s*at (?:async )?.*\/src\/js\/([\w.-]+\.js):\d+:\d+$/.exec(line);
    if (bare) return bare[1] + "#(anonymous)";
  }
  return "(not from src/js)";
}

Object.defineProperty(S, "state", {
  configurable: true,
  enumerable: true,
  get() { return held; },
  set(v) {
    held = v;
    seen.push({ site: siteOf(new Error().stack), value: v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)) });
  }
});

const timers = new Set();
for (const [set, clear] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"]]) {
  const realSet = globalThis[set];
  const realClear = globalThis[clear];
  globalThis[set] = function (...args) { const id = realSet(...args); timers.add([realClear, id]); return id; };
  window[set] = globalThis[set];
  window[clear] = realClear;
}
const channels = new Set();
const NodeChannel = globalThis.BroadcastChannel;
class TrackedChannel extends NodeChannel {
  constructor(name) {
    super(name);
    channels.add(this);
  }
}
globalThis.BroadcastChannel = TrackedChannel;
window.BroadcastChannel = TrackedChannel;
for (const name of Object.getOwnPropertyNames(window)) {
  if (!(name in globalThis)) globalThis[name] = window[name];
}
for (const name of ["indexedDB", "IDBKeyRange"]) window[name] = globalThis[name];
const noMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.matchMedia = noMedia;
globalThis.matchMedia = noMedia;
const noRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
window.Range.prototype.getBoundingClientRect = noRect;
window.Range.prototype.getClientRects = () => [];
window.__splitpageNoNewTab = true;
const consoleError = window.console.error;
window.console.error = () => {};

const PAGE = readFileSync(new URL("../page.html", import.meta.url), "utf8");
document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(PAGE)[1];

await import("../js/_entry.js");
await S.initialStateReady;
const atBoot = seen.splice(0);

const { migrateRows } = await import("../js/02-state.js");
const { adoptRestoredState, migrateDocument } = await import("../js/02b-doc-id.js");
const { applyMerge, cloneState } = await import("../js/03-sync.js");
const { openServerDoc } = await import("../js/13-hosted.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { openLongDemo, startNewScript } = await import("../js/18b-file-menu.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { applyTakenDraft } = await import("../js/20g-drafts.js");

after(() => {
  for (const [clear, id] of timers) clear(id);
  window.console.error = consoleError;
  for (const channel of channels) channel.close();
});

const SRC = fileURLToPath(new URL("..", import.meta.url));

const SITES = [
  "00-prelude.js#(anonymous)",
  "02b-doc-id.js#adoptRestoredState",
  "03-sync.js#adopt",
  "13-hosted.js#resumeServerDoc",
  "13-hosted.js#openServerDoc",
  "18-local-files.js#adoptProjectState",
  "18-local-files.js#loadFileIntoEditor",
  "18b-file-menu.js#replaceWithNewDocument",
  "20g-drafts.js#recoverDraftAsUnsavedCopy",
  "20g-drafts.js#restoreFileDraft",
  "20g-drafts.js#adoptUntitledDraft",
  "20j-newtab.js#adoptNewDocument",
  "21-events.js#init",
  "21-events.js#(anonymous)"
];

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== join(SRC, "test")) out.push(...sourceFiles(path));
    } else if (/\.(?:js|mjs|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function enclosingName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) return n.name.text;
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return "(anonymous)";
  }
  return "(anonymous)";
}

function assignmentSites() {
  const sites = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (text.indexOf("S.state") === -1) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) && node.left.name.text === "state" &&
          ts.isIdentifier(node.left.expression) && node.left.expression.text === "S") {
        sites.push(relative(join(SRC, "js"), file).replace(/\\/g, "/") + "#" + enclosingName(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort();
}

function fixedPoint(value) {
  if (value === null || value === undefined) return value;
  return JSON.stringify(migrateRows(cloneState(value))) === JSON.stringify(value);
}

async function drive(fn) {
  seen.length = 0;
  let thrown = null;
  try { await fn(); } catch (e) { thrown = e; }
  await new Promise((r) => setTimeout(r, 20));
  return { records: seen.splice(0), thrown };
}

function only(got, site) {
  const at = got.records.filter((r) => r.site === site);
  assert.equal(at.length, 1, site + " assigned once: [" + got.records.map((r) => r.site).join(", ") + "] " + (got.thrown || ""));
  return at[0].value;
}

function rawDoc(title) {
  return {
    schema: 2,
    title: title,
    rows: [
      { id: "r1", visualText: "Wide on the <b>harbour</b>", audioText: "Every morning.", status: "ready" },
      { id: "r2", visualText: "Close", audioText: "Mara mends nets.", status: "bogus", lengthSeconds: 90 }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", text: "Tighter", replies: [] }]
  };
}

function migrated(title) {
  return migrateRows(rawDoc(title));
}

test("there are fourteen S.state assignments, in these functions", () => {
  assert.deepEqual(assignmentSites(), SITES.slice().sort());
});

test("boot: 00-prelude and init assign null, then the loaded document, a migrateRows fixed point", () => {
  assert.deepEqual(atBoot.map((r) => r.site), ["00-prelude.js#(anonymous)", "21-events.js#init", "21-events.js#(anonymous)"]);
  assert.equal(atBoot[0].value, null);
  assert.equal(atBoot[1].value, null);
  assert.equal(fixedPoint(atBoot[2].value), true);
});

test("02b adoptRestoredState: a migrateRows fixed point, its docId kept", async () => {
  const before = S.state.docId;
  const value = only(await drive(() => adoptRestoredState(rawDoc("Restored"))), "02b-doc-id.js#adoptRestoredState");
  assert.equal(fixedPoint(value), true);
  assert.equal(S.state.docId, before, "the docId is put back after the assignment");
  assert.equal(fixedPoint(S.state), true);
});

test("03-sync applyMerge's adopt, after a merge: a migrateRows fixed point", async () => {
  const base = migrated("Merge");
  const mine = cloneState(base);
  const theirs = cloneState(base);
  mine.rows[0].audioText = "Mine.";
  theirs.rows[1].audioText = "Theirs.";
  const got = await drive(() => applyMerge({ base, mine, theirs, source: "stash", report: false }));
  assert.equal(fixedPoint(only(got, "03-sync.js#adopt")), true);
});

test("03-sync applyMerge's adopt, nothing to merge: theirs as handed over, unmigrated if it came that way", async () => {
  const fromMigrated = await drive(() => applyMerge({ theirs: migrated("Same"), source: "stash", unchanged: true, report: false }));
  assert.equal(fixedPoint(only(fromMigrated, "03-sync.js#adopt")), true);
  const raw = rawDoc("Raw");
  const fromRaw = await drive(() => applyMerge({ theirs: raw, source: "stash", unchanged: true, report: false }));
  assert.equal(fixedPoint(only(fromRaw, "03-sync.js#adopt")), false, "applyMerge does not migrate an unchanged theirs");
});

test("13-hosted openServerDoc: migrateDocument's answer, a migrateRows fixed point", async () => {
  const realFetch = globalThis.fetch;
  const desktop = S.DESKTOP;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "doc1", rev: 3, state: rawDoc("From the server") }),
    { status: 200, headers: { "content-type": "application/json" } });
  S.DESKTOP = {};
  try {
    const got = await drive(() => openServerDoc("doc1"));
    assert.equal(fixedPoint(only(got, "13-hosted.js#openServerDoc")), true);
  } finally {
    globalThis.fetch = realFetch;
    S.DESKTOP = desktop;
  }
});

test("13-hosted resumeServerDoc, by its producer: migrateDocument for a server origin is a migrateRows fixed point", () => {
  const theirs = migrateDocument(cloneState(rawDoc("Resumed")), { kind: "server", serverId: "doc1", fallbackId: null });
  assert.equal(fixedPoint(theirs), true);
});

test("18-local-files adoptProjectState, from a .splitpage file: a migrateRows fixed point", async () => {
  const file = new File([buildSplitpageFile(migrated("On disk"))], "disk.splitpage", { lastModified: 1 });
  const got = await drive(() => openProjectFile(file, null, { skipSnapshot: true }));
  assert.equal(fixedPoint(only(got, "18-local-files.js#adoptProjectState")), true);
});

test("18-local-files loadFileIntoEditor, from a .txt import: a migrateRows fixed point", async () => {
  const file = new File(["Wide on the harbour\tEvery morning.\nClose\tMara mends nets."], "import.txt", { lastModified: 1 });
  const got = await drive(() => openProjectFile(file, null, { skipSnapshot: true }));
  assert.equal(fixedPoint(only(got, "18-local-files.js#loadFileIntoEditor")), true);
});

test("18b replaceWithNewDocument, a new script and the long demo: migrateRows fixed points", async () => {
  assert.equal(fixedPoint(only(await drive(() => startNewScript()), "18b-file-menu.js#replaceWithNewDocument")), true);
  assert.equal(fixedPoint(only(await drive(() => openLongDemo()), "18b-file-menu.js#replaceWithNewDocument")), true);
});

test("20g recoverDraftAsUnsavedCopy, an imported file's draft: a migrateRows fixed point with a minted docId", async () => {
  const draftId = "d" + "1".repeat(32);
  const t = { header: { origin: { kind: "import", importName: "a.docx" } }, stateJson: JSON.stringify(Object.assign(rawDoc("Import draft"), { docId: draftId })) };
  const value = only(await drive(() => applyTakenDraft(t)), "20g-drafts.js#recoverDraftAsUnsavedCopy");
  assert.equal(fixedPoint(value), true);
  assert.match(value.docId, /^d[0-9a-f]{32}$/);
  assert.notEqual(value.docId, draftId, "the copy is given a docId of its own before it is assigned");
});

test("20g restoreFileDraft, by its producer: a draft read through migrateRows is a fixed point", () => {
  assert.equal(fixedPoint(migrateRows(JSON.parse(JSON.stringify(rawDoc("File draft"))))), true);
});

test("20g adoptUntitledDraft: a migrateRows fixed point", async () => {
  const t = { header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify(rawDoc("Untitled draft")) };
  assert.equal(fixedPoint(only(await drive(() => applyTakenDraft(t)), "20g-drafts.js#adoptUntitledDraft")), true);
});

test("20j adoptNewDocument, from the new-tab page's New script: a migrateRows fixed point", async () => {
  const button = document.querySelector('#newtab-page [data-newtab-action="new"]');
  assert.ok(button, "the page has the button");
  const got = await drive(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  assert.equal(fixedPoint(only(got, "20j-newtab.js#adoptNewDocument")), true);
});
