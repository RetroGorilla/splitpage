import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  DESKTOP_STATE_VERSION, LAST_KNOWN_TITLE_MAX, RECENTS_MAX, TAB_OR_WINDOW_ID_RE,
  normalizeDesktopStateV2, createDesktopStateStore
} = require(path.join(here, "..", "desktop-state.ts"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-desktop-state-"));
let dirCount = 0;
const pathKey = (p) => path.resolve(p).toLowerCase();
const abs = (name) => path.join(root, name);
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);

function store(opts) {
  const dir = path.join(root, "case-" + ++dirCount);
  const file = path.join(dir, "desktop-state.json");
  const errors = [];
  const s = createDesktopStateStore({ filePath: () => file, pathKey, onWriteError: (e) => errors.push(e), ...(opts || {}) });
  return { s, dir, file, errors };
}

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function assertFresh(state) {
  assert.equal(state.version, DESKTOP_STATE_VERSION);
  assert.equal(state.windows.length, 1);
  const w = state.windows[0];
  assert.match(w.windowId, TAB_OR_WINDOW_ID_RE);
  assert.equal(w.bounds, null);
  assert.equal(w.maximized, false);
  assert.equal(w.tabs.length, 1);
  assert.match(w.tabs[0].tabId, TAB_OR_WINDOW_ID_RE);
  assert.deepEqual(w.tabs[0].source, { kind: "blank" });
  assert.equal(w.tabs[0].lastKnownTitle, "");
  assert.equal(w.activeTabId, w.tabs[0].tabId);
  assert.deepEqual(state.recents, []);
}

test("no file reads as a fresh state with one blank tab", () => {
  assertFresh(store().s.read());
});

test("the last saved script folder survives store writes and a new store instance", async () => {
  const { s, file } = store();
  const folder = abs("saved scripts");
  await s.write((current) => { current.lastSavedFolder = folder; return current; });
  await s.write((current) => { current.recents = [{ absPath: abs("opened.splitpage"), title: "Opened", at: 1 }]; return current; });
  const restarted = createDesktopStateStore({ filePath: () => file, pathKey });
  assert.equal(restarted.read().lastSavedFolder, folder);
});

test("invalid saved folders are dropped when desktop state is loaded", () => {
  for (const lastSavedFolder of [null, 42, "", "relative/folder"]) {
    const { s, file } = store();
    put(file, { version: 2, windows: [], recents: [], lastSavedFolder });
    assert.equal(s.read().lastSavedFolder, undefined);
  }
});

test("unreadable JSON, an array and an unknown version each read as a fresh state", () => {
  for (const text of ["{ this is not valid JSON", "[]", JSON.stringify({ version: 3, windows: [] }), "null"]) {
    const { s, file } = store();
    put(file, text);
    assertFresh(s.read());
  }
});

test("a v1 file migrates its last file, bounds and maximized flag into one window", () => {
  const { s, file } = store();
  put(file, { lastFilePath: abs("old.splitpage"), windowBounds: { x: 1, y: 2, width: 300, height: 400 }, windowMaximized: true });
  const state = s.read();
  assert.equal(state.version, DESKTOP_STATE_VERSION);
  assert.equal(state.windows.length, 1);
  const w = state.windows[0];
  assert.deepEqual(w.bounds, { x: 1, y: 2, width: 300, height: 400 });
  assert.equal(w.maximized, true);
  assert.deepEqual(w.tabs.map((t) => t.source), [{ kind: "file", absPath: abs("old.splitpage") }]);
  assert.equal(w.activeTabId, w.tabs[0].tabId);
  assert.deepEqual(state.recents, []);
});

test("a v1 file without a last file migrates to a blank tab and drops bad bounds", () => {
  const { s, file } = store();
  put(file, { windowBounds: { x: 1, y: "2", width: 3, height: 4 } });
  const w = s.read().windows[0];
  assert.deepEqual(w.tabs[0].source, { kind: "blank" });
  assert.equal(w.bounds, null);
  assert.equal(w.maximized, false);
});

test("v2 normalization keeps good ids, remints bad and repeated ones, and repairs each field", () => {
  const long = "t".repeat(LAST_KNOWN_TITLE_MAX + 50);
  const state = normalizeDesktopStateV2({
    version: 2,
    windows: [
      {
        windowId: ID_A,
        bounds: { x: 0, y: 0, width: 10, height: Infinity },
        maximized: "yes",
        activeTabId: "missing",
        tabs: [
          { tabId: ID_B, source: { kind: "file", absPath: abs("a.splitpage") }, lastKnownTitle: long },
          { tabId: ID_B, source: { kind: "file", absPath: "relative.splitpage" }, lastKnownTitle: 7 },
          null,
          { tabId: "short", source: { kind: "server", url: "https://example.test" } }
        ]
      },
      { windowId: ID_A, tabs: [{ tabId: ID_C }], activeTabId: ID_C, bounds: { x: 5, y: 6, width: 7, height: 8 }, maximized: true },
      { windowId: ID_C, tabs: [] },
      "not a window"
    ]
  }, pathKey);
  assert.equal(state.windows.length, 2);
  const [first, second] = state.windows;
  assert.equal(first.windowId, ID_A);
  assert.equal(first.bounds, null);
  assert.equal(first.maximized, false);
  assert.equal(first.tabs.length, 3);
  assert.equal(first.tabs[0].tabId, ID_B);
  assert.equal(first.tabs[0].lastKnownTitle.length, LAST_KNOWN_TITLE_MAX);
  assert.deepEqual(first.tabs[0].source, { kind: "file", absPath: abs("a.splitpage") });
  assert.notEqual(first.tabs[1].tabId, ID_B);
  assert.match(first.tabs[1].tabId, TAB_OR_WINDOW_ID_RE);
  assert.deepEqual(first.tabs[1].source, { kind: "blank" });
  assert.equal(first.tabs[1].lastKnownTitle, "");
  assert.match(first.tabs[2].tabId, TAB_OR_WINDOW_ID_RE);
  assert.deepEqual(first.tabs[2].source, { kind: "blank" });
  assert.equal(first.activeTabId, ID_B);
  assert.notEqual(second.windowId, ID_A);
  assert.match(second.windowId, TAB_OR_WINDOW_ID_RE);
  assert.equal(second.tabs[0].tabId, ID_C);
  assert.equal(second.activeTabId, ID_C);
  assert.deepEqual(second.bounds, { x: 5, y: 6, width: 7, height: 8 });
  assert.equal(second.maximized, true);
});

test("v2 with no usable window reads as a fresh state that keeps its recents", () => {
  const state = normalizeDesktopStateV2({ version: 2, windows: [{ tabs: [] }], recents: [{ absPath: abs("r.splitpage"), title: "R", at: 5 }] }, pathKey);
  assert.equal(state.windows.length, 1);
  assert.deepEqual(state.windows[0].tabs.map((t) => t.source), [{ kind: "blank" }]);
  assert.deepEqual(state.recents, [{ absPath: abs("r.splitpage"), title: "R", at: 5 }]);
});

test("recents drop bad rows and repeats by path key, cap titles, and stop at the limit", () => {
  const rows = [
    { absPath: abs("One.splitpage"), title: "x".repeat(LAST_KNOWN_TITLE_MAX + 1), at: 1 },
    { absPath: abs("one.splitpage"), title: "repeat", at: 2 },
    { absPath: "relative.splitpage", title: "rel", at: 3 },
    { absPath: abs("two.splitpage"), title: 4, at: Number.NaN },
    null
  ];
  for (let i = 0; i < RECENTS_MAX + 5; i++) rows.push({ absPath: abs("n" + i + ".splitpage"), title: "n" + i, at: i });
  const recents = normalizeDesktopStateV2({ version: 2, windows: [], recents: rows }, pathKey).recents;
  assert.equal(recents.length, RECENTS_MAX);
  assert.equal(recents[0].absPath, abs("One.splitpage"));
  assert.equal(recents[0].title.length, LAST_KNOWN_TITLE_MAX);
  assert.deepEqual(recents[1], { absPath: abs("two.splitpage"), title: "", at: 0 });
  assert.equal(recents[2].absPath, abs("n0.splitpage"));
  assert.equal(recents.at(-1).absPath, abs("n" + (RECENTS_MAX - 3) + ".splitpage"));
});

test("reading the same file twice gives the same ids, and each read is its own copy", () => {
  const { s } = store();
  const a = s.read();
  const b = s.read();
  assert.deepEqual(a, b);
  a.windows[0].tabs[0].lastKnownTitle = "changed";
  assert.equal(s.read().windows[0].tabs[0].lastKnownTitle, "");
});

test("a changed file is read again", () => {
  const { s, file } = store();
  const before = s.read();
  put(file, { version: 2, windows: [{ windowId: ID_A, activeTabId: ID_B, tabs: [{ tabId: ID_B, source: { kind: "blank" } }] }] });
  const after = s.read();
  assert.notDeepEqual(after, before);
  assert.equal(after.windows[0].windowId, ID_A);
});

test("a write normalizes what the mutator returns and stores it as v2 JSON", async () => {
  const { s, file } = store();
  const written = await s.write((current) => {
    current.recents = [{ absPath: abs("w.splitpage"), title: "W", at: 9 }, { absPath: "bad" }];
    current.windows[0].tabs[0].lastKnownTitle = "Title";
    return current;
  });
  assert.equal(written, true);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.version, DESKTOP_STATE_VERSION);
  assert.deepEqual(onDisk.recents, [{ absPath: abs("w.splitpage"), title: "W", at: 9 }]);
  assert.equal(onDisk.windows[0].tabs[0].lastKnownTitle, "Title");
  assert.deepEqual(s.read(), onDisk);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["desktop-state.json"]);
});

test("a mutator that returns nothing writes the state it was given, and one that returns false writes nothing", async () => {
  const { s, file } = store();
  assert.equal(await s.write((current) => { current.windows[0].maximized = true; }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).windows[0].maximized, true);
  const before = fs.readFileSync(file, "utf8");
  assert.equal(await s.write(() => false), false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("writes run in order, and a write queued during another sees its result", async () => {
  const { s, file } = store();
  const seen = [];
  let inner;
  const outer = s.write((current) => {
    inner = s.write((again) => { seen.push(again.recents.length); again.recents.push({ absPath: abs("second.splitpage") }); return again; });
    current.recents = [{ absPath: abs("first.splitpage") }];
    return current;
  });
  assert.deepEqual(await Promise.all([outer, inner]), [true, true]);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).recents.map((r) => r.absPath), [abs("first.splitpage"), abs("second.splitpage")]);
});

test("a failed write resolves false, reports the error, and the next write still runs", async () => {
  const { s, file, errors } = store();
  assert.equal(await s.write(() => { throw new Error("boom"); }), false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "boom");
  assert.equal(fs.existsSync(file), false);
  assert.equal(await s.write((c) => c), true);
  assert.equal(fs.existsSync(file), true);
});

test("a write error with no error handler still resolves false", async () => {
  const s = createDesktopStateStore({ filePath: () => path.join(root, "no-handler", "desktop-state.json"), pathKey });
  assert.equal(await s.write(() => { throw new Error("quiet"); }), false);
});

test("the temp-file sweep removes only the store's own leftover temp files", () => {
  const { s, dir } = store();
  fs.mkdirSync(dir, { recursive: true });
  const names = [".tmp-0123456789ab-desktop-state.json", ".tmp-ffffffffffff-desktop-state.json", ".tmp-xyz-desktop-state.json", "desktop-state.json", ".tmp-0123456789ab-theme.json"];
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
  assert.equal(s.sweepTempFiles(), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [".tmp-0123456789ab-theme.json", ".tmp-xyz-desktop-state.json", "desktop-state.json"]);
});

test("the temp-file sweep of a missing folder removes nothing", () => {
  assert.equal(store().s.sweepTempFiles(), 0);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
fs.rmSync(root, { recursive: true, force: true });
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
