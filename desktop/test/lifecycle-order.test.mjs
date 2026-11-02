import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, "..");
const MAIN = stripTypeScriptTypes(fs.readFileSync(path.join(desktop, "main.ts"), "utf8"));
const EXPOSED = ["createTabWindow", "createTab", "tabs", "windowsById", "pendingDraftFlushes", "initDraftStore", "persistShellState", "requestCloseTab", "registerActivate"];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEvent() {
  const event = { prevented: false, preventDefault() { event.prevented = true; } };
  return event;
}

function emitterOf(target) {
  const handlers = new Map();
  target.on = (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return target; };
  target.once = target.on;
  target.emit = (name, ...args) => { for (const fn of handlers.get(name) || []) fn(...args); };
  return target;
}

function loadMain(world) {
  const { log, userData } = world;
  const noop = () => {};
  const loose = (base) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });
  const windows = [];
  let viewCount = 0;
  let quitting = false;

  const tagOfContents = (wc) => world.contentsTags.get(wc) || "?";

  function makeContents() {
    const wc = emitterOf({ id: ++viewCount, destroyed: false });
    wc.isDestroyed = () => wc.destroyed;
    wc.setWindowOpenHandler = noop;
    wc.loadURL = noop;
    wc.focus = noop;
    wc.reload = noop;
    wc.close = () => { log(`view closed ${tagOfContents(wc)}`); wc.destroyed = true; };
    wc.send = (channel, reqId, keep) => {
      if (channel !== "splitpage:draft-flush") return;
      const tag = tagOfContents(wc);
      log(`flush ${tag} keep=${keep}`);
      if (world.flushAnswer(tag) !== "ok") return;
      setTimeout(() => {
        const answer = world.main.pendingDraftFlushes.get(reqId);
        if (!answer) return;
        world.main.pendingDraftFlushes.delete(reqId);
        world.kept.add(world.idOf(tag));
        log(`flush answered ${tag}`);
        answer({ ok: true });
      }, 5);
    };
    return wc;
  }

  function probe(label) {
    log(`probe ${label}`);
    world.main.persistShellState();
  }

  function BrowserWindow() {
    const win = emitterOf(loose({}));
    win.tag = "W" + (windows.length + 1);
    win.destroyed = false;
    win.webContents = makeContents();
    win.contentView = { addChildView: noop, removeChildView: noop };
    win.isDestroyed = () => win.destroyed;
    win.isMinimized = () => false;
    win.isMaximized = () => false;
    win.getBounds = () => ({ x: 0, y: 0, width: 1400, height: 900 });
    win.getContentBounds = () => ({ x: 0, y: 0, width: 1400, height: 900 });
    win.close = () => {
      if (win.destroyed) return true;
      log(`close ${win.tag}`);
      const event = makeEvent();
      win.emit("close", event);
      if (event.prevented) { log(`close prevented ${win.tag}`); return false; }
      probe(`${win.tag} closing`);
      win.destroyed = true;
      win.emit("closed");
      log(`closed ${win.tag}`);
      if (!quitting && !windows.some((w) => !w.destroyed)) app.emit("window-all-closed");
      return true;
    };
    windows.push(win);
    return win;
  }
  BrowserWindow.getAllWindows = () => windows.filter((w) => !w.destroyed);

  function WebContentsView() {
    return { webContents: makeContents(), setBackgroundColor: noop, setBounds: noop, setVisible: noop };
  }

  const app = emitterOf({
    isPackaged: false,
    getPath: () => userData,
    setPath: noop,
    getVersion: () => "9.9.9",
    isReady: () => false,
    requestSingleInstanceLock: () => true,
    setAppUserModelId: noop,
    whenReady: () => new Promise(() => {}),
    quit() {
      log("app.quit");
      const event = makeEvent();
      app.emit("before-quit", event);
      if (event.prevented) { log("quit prevented"); return; }
      quitting = true;
      probe("quitting");
      for (const w of windows) {
        if (w.destroyed) continue;
        if (!w.close()) { quitting = false; log("quit aborted"); return; }
      }
      app.emit("will-quit", makeEvent());
      log("quit done");
    }
  });

  const dialog = {
    showMessageBoxSync(_parent, options) {
      const detail = String(options.detail || "").split("\n").filter(Boolean).join(" / ");
      log(`ask ${options.message} [${options.buttons.join("|")}] ${detail}`);
      const answer = world.answers.shift();
      if (typeof world.onAsk === "function") world.onAsk();
      if (answer === "throw") throw new Error("dialog failed");
      if (answer === "review") return options.buttons.indexOf("Review");
      if (answer === "discard") return options.buttons.findIndex((b) => /without saving/.test(b));
      return options.cancelId;
    }
  };

  const electron = loose({
    app, BrowserWindow, WebContentsView, dialog,
    ipcMain: loose({}), Menu: loose({}), protocol: loose({}), net: loose({}), shell: loose({}),
    session: loose({}), nativeTheme: loose({ shouldUseDarkColors: false }),
    screen: loose({ getAllDisplays: () => [] })
  });

  const realDrafts = require(path.join(desktop, "drafts.ts"));
  const draftStore = {
    init: () => ({ previousSession: "none", drafts: [] }),
    hasDraft: (id) => world.kept.has(id),
    isHeld: () => false,
    list: () => [],
    resetSeq: noop,
    hold: (id) => log(`draft hold ${world.tagOf(id)}`),
    discardForUserDecision: (ids, reason) => log(`draft discard [${ids.map(world.tagOf).join(",")}] ${reason}`),
    discardClean: (id) => { log(`draft discardClean ${world.tagOf(id)}`); return Promise.resolve(); },
    markSessionEnd: () => log("draft markSessionEnd"),
    markCleanExit: () => log("draft markCleanExit")
  };
  const realState = require(path.join(desktop, "desktop-state.ts"));
  const stubs = {
    electron,
    "./drafts.ts": { ...realDrafts, createDraftStore: () => draftStore },
    "./desktop-state.ts": {
      ...realState,
      createDesktopStateStore: (opts) => {
        const store = realState.createDesktopStateStore(opts);
        return { ...store, read: store.read, write: (fn) => { log("state-write"); return store.write(fn); } };
      }
    }
  };
  const fakeRequire = (id) => {
    if (id in stubs) return stubs[id];
    return require(id.startsWith(".") ? path.join(desktop, id) : id);
  };

  const mainPath = path.join(desktop, "main.ts");
  const lockElseEnd = MAIN.lastIndexOf("\n}");
  const body = MAIN.slice(0, lockElseEnd) + `\nreturn { ${EXPOSED.join(", ")} };` + MAIN.slice(lockElseEnd);
  const load = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${body}\n})`, { filename: mainPath });
  process.env.SPLITPAGE_TEST = "0";
  process.env.SPLITPAGE_NO_UPDATE_CHECK = "1";
  process.env.SPLITPAGE_USER_DATA = userData;
  world.main = load({}, fakeRequire, { exports: {} }, mainPath, desktop);
  world.app = app;
  world.windows = windows;
  world.main.initDraftStore();
}

function makeWorld() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-order-"));
  const world = {
    userData,
    entries: [],
    answers: [],
    onAsk: null,
    kept: new Set(),
    flushes: new Map(),
    tags: new Map(),
    contentsTags: new Map(),
    log: (line) => world.entries.push(line),
    tagOf: (id) => world.tags.get(id) || id,
    idOf: (tag) => [...world.tags].find(([, t]) => t === tag)[0],
    flushAnswer: (tag) => world.flushes.get(tag) || "late",
    existing: path.join(userData, "present.md"),
    gone: path.join(userData, "gone.md")
  };
  fs.writeFileSync(world.existing, "# present\n");
  loadMain(world);
  world.window = () => {
    const rec = world.main.createTabWindow({});
    return rec;
  };
  world.tab = (rec, tag, { file, dirty } = {}) => {
    const source = file ? { kind: "file", absPath: file } : { kind: "blank" };
    const tab = world.main.createTab(rec.id, { source, launchIntent: { type: file ? "open-file" : "blank" } });
    tab.title = tag;
    tab.dirty = !!dirty;
    world.tags.set(tab.id, tag);
    world.contentsTags.set(tab.view.webContents, tag);
    return tab;
  };
  world.start = () => { world.entries.length = 0; };
  world.until = async (line, ms = 4000) => {
    const end = Date.now() + ms;
    while (!world.entries.includes(line)) {
      if (Date.now() > end) assert.fail(`timed out waiting for "${line}"; log so far:\n  ${world.entries.join("\n  ")}`);
      await wait(10);
    }
    await wait(50);
  };
  world.dispose = () => fs.rmSync(userData, { recursive: true, force: true });
  return world;
}

const ASK_ONE_LEAVE = "ask You have unsaved changes [Leave without saving|Stay] If you leave now, your changes will be lost.";
const ASK_ONE_TAB = "ask You have unsaved changes [Leave without saving|Stay] If you close this tab now, your changes will be lost.";
const askMany = (count, leave, titles) =>
  `ask You have unsaved changes in ${count} documents [Review|${leave}|Cancel] ${titles.map((t) => "• " + t).join(" / ")} / If you continue, these changes will be lost.`;
const QUITS_AFTER_LAST_WINDOW = process.platform !== "darwin"
  ? ["app.quit", "probe quitting", "draft markCleanExit", "quit done"]
  : [];

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("window close without files: question, settle, freeze, close", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { dirty: true });
  w.tab(rec, "T2");
  w.answers.push("discard");
  w.start();
  rec.win.close();
  await w.until("closed W1");
  assert.deepEqual(w.entries, [
    "close W1",
    ASK_ONE_LEAVE,
    "draft discard [T1] close-without-saving",
    "draft discardClean T2",
    "probe W1 closing",
    "closed W1",
    ...QUITS_AFTER_LAST_WINDOW
  ]);
});

test("window close cancelled: nothing settled, session writes continue", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { dirty: true });
  w.answers.push("cancel");
  w.start();
  rec.win.close();
  await wait(100);
  w.main.persistShellState();
  assert.deepEqual(w.entries, ["close W1", ASK_ONE_LEAVE, "close prevented W1", "state-write"]);
});

test("closing one of two windows leaves session writes on", async (w) => {
  const first = w.window();
  w.tab(first, "T1", { dirty: true });
  const second = w.window();
  w.tab(second, "T2");
  w.answers.push("discard");
  w.start();
  first.win.close();
  await w.until("closed W1");
  assert.deepEqual(w.entries, [
    "close W1",
    ASK_ONE_LEAVE,
    "draft discard [T1] close-without-saving",
    "probe W1 closing",
    "state-write",
    "state-write",
    "closed W1"
  ]);
});

test("window close with a gone file whose kept copy is late: question, wait, recheck, settle, freeze", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.existing, dirty: true });
  w.tab(rec, "T2", { file: w.gone, dirty: true });
  w.answers.push("discard", "discard");
  w.start();
  rec.win.close();
  await w.until("closed W1", 6000);
  assert.deepEqual(w.entries, [
    "close W1",
    "close prevented W1",
    askMany(2, "Close without saving", ["T1", "T2"]),
    "flush T2 keep=true",
    ASK_ONE_LEAVE,
    "draft discard [T1] close-without-saving",
    "close W1",
    "probe W1 closing",
    "closed W1",
    ...QUITS_AFTER_LAST_WINDOW
  ]);
});

test("window close with a gone file whose copy is kept in time asks once", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.gone, dirty: true });
  w.flushes.set("T1", "ok");
  w.answers.push("discard");
  w.start();
  rec.win.close();
  await w.until("closed W1");
  assert.deepEqual(w.entries, [
    "close W1",
    "close prevented W1",
    ASK_ONE_LEAVE,
    "flush T1 keep=true",
    "flush answered T1",
    "close W1",
    "probe W1 closing",
    "closed W1",
    ...QUITS_AFTER_LAST_WINDOW
  ]);
});

test("a gone file's late copy and a cancelled recheck keep the window open", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.gone, dirty: true });
  w.answers.push("discard", "cancel");
  w.start();
  rec.win.close();
  await wait(1800);
  w.main.persistShellState();
  assert.deepEqual(w.entries, [
    "close W1",
    "close prevented W1",
    ASK_ONE_LEAVE,
    "flush T1 keep=true",
    ASK_ONE_LEAVE,
    "state-write"
  ]);
  assert.equal(w.main.tabs.get(w.idOf("T1")).keepDraftOnClose, false, "the keep hold is released");
});

test("a new edit while the close waits is asked about before closing", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.existing, dirty: true });
  const t2 = w.tab(rec, "T2");
  w.answers.push("discard", "discard");
  w.onAsk = () => { w.onAsk = null; t2.dirty = true; };
  w.start();
  rec.win.close();
  await w.until("closed W1");
  assert.deepEqual(w.entries, [
    "close W1",
    "close prevented W1",
    ASK_ONE_LEAVE,
    ASK_ONE_LEAVE,
    "draft discard [T1,T2] close-without-saving",
    "close W1",
    "probe W1 closing",
    "closed W1",
    ...QUITS_AFTER_LAST_WINDOW
  ]);
});

test("a failing question reports and cancels the close", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.existing, dirty: true });
  w.answers.push("throw");
  const logError = console.error;
  console.error = (line) => w.log(String(line).split(":")[0]);
  try {
    w.start();
    rec.win.close();
    await wait(150);
  } finally { console.error = logError; }
  assert.deepEqual(w.entries, [
    "close W1",
    "close prevented W1",
    ASK_ONE_LEAVE,
    "[splitpage] close check failed (Close window)"
  ]);
});

test("review shows the first unsaved tab and keeps the window", async (w) => {
  const rec = w.window();
  const t1 = w.tab(rec, "T1", { dirty: true });
  w.tab(rec, "T2", { dirty: true });
  w.answers.push("review");
  w.start();
  rec.win.close();
  await wait(50);
  assert.deepEqual(w.entries, ["close W1", askMany(2, "Close without saving", ["T1", "T2"]), "close prevented W1"]);
  assert.equal(rec.activeTabId, t1.id);
});

test("closing a tab: question, settle, view closed", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.existing, dirty: true });
  w.tab(rec, "T2");
  w.answers.push("discard");
  w.start();
  w.main.requestCloseTab(w.idOf("T1"));
  await w.until("view closed T1");
  assert.deepEqual(w.entries, [
    ASK_ONE_TAB,
    "draft discard [T1] leave-without-saving",
    "view closed T1",
    "state-write"
  ]);
  assert.equal(w.main.tabs.has(w.idOf("T1")), false);
});

test("closing an untitled tab and cancelling keeps it", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { dirty: true });
  w.tab(rec, "T2");
  w.answers.push("cancel");
  w.start();
  w.main.requestCloseTab(w.idOf("T1"));
  await wait(50);
  assert.deepEqual(w.entries, [ASK_ONE_TAB]);
  assert.equal(w.main.tabs.has(w.idOf("T1")), true);
});

test("closing the last tab closes its window", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1");
  w.start();
  w.main.requestCloseTab(w.idOf("T1"));
  await w.until("closed W1");
  assert.deepEqual(w.entries, [
    "close W1",
    "draft discardClean T1",
    "probe W1 closing",
    "closed W1",
    ...QUITS_AFTER_LAST_WINDOW
  ]);
});

test("quit with file tabs: question, settle, freeze, quit", async (w) => {
  const first = w.window();
  w.tab(first, "T1", { file: w.existing, dirty: true });
  const second = w.window();
  w.tab(second, "T2");
  w.answers.push("discard");
  w.start();
  w.app.quit();
  await w.until("quit done");
  assert.deepEqual(w.entries, [
    "app.quit",
    "quit prevented",
    ASK_ONE_LEAVE,
    "draft discard [T1] quit-without-saving",
    "draft discardClean T2",
    "app.quit",
    "probe quitting",
    "close W1",
    "probe W1 closing",
    "closed W1",
    "close W2",
    "probe W2 closing",
    "closed W2",
    "draft markCleanExit",
    "quit done"
  ]);
});

test("quit without file tabs answers at once", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { dirty: true });
  w.answers.push("discard");
  w.start();
  w.app.quit();
  assert.deepEqual(w.entries, [
    "app.quit",
    ASK_ONE_LEAVE,
    "draft discard [T1] quit-without-saving",
    "probe quitting",
    "close W1",
    "probe W1 closing",
    "closed W1",
    "draft markCleanExit",
    "quit done"
  ]);
});

test("quit cancelled: nothing settled, session writes resume", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.existing, dirty: true });
  w.answers.push("cancel");
  w.start();
  w.app.quit();
  await wait(100);
  w.main.persistShellState();
  assert.deepEqual(w.entries, ["app.quit", "quit prevented", ASK_ONE_LEAVE, "state-write"]);
});

test("a second quit while the question waits is held back", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.gone, dirty: true });
  w.answers.push("discard", "cancel");
  w.start();
  w.app.quit();
  await w.until("flush T1 keep=true");
  w.app.quit();
  rec.win.close();
  await wait(1700);
  assert.deepEqual(w.entries, [
    "app.quit",
    "quit prevented",
    ASK_ONE_LEAVE,
    "flush T1 keep=true",
    "app.quit",
    "quit prevented",
    "close W1",
    "close prevented W1",
    ASK_ONE_LEAVE
  ]);
});

test("session end: freeze, mark, flush every unsaved tab, closes go through", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { dirty: true });
  w.tab(rec, "T2", { file: w.gone });
  w.tab(rec, "T3", { file: w.existing });
  w.start();
  rec.win.emit("session-end");
  await w.until("flush T2 keep=true");
  await w.until("flush T3 keep=false");
  w.log("probe after session end");
  w.main.persistShellState();
  rec.win.close();
  const entries = w.entries.slice();
  entries.splice(2, 2, ...entries.slice(2, 4).sort());
  assert.deepEqual(entries, [
    "draft markSessionEnd",
    "flush T1 keep=false",
    "flush T2 keep=true",
    "flush T3 keep=false",
    "probe after session end",
    "close W1",
    "probe W1 closing",
    "closed W1",
    ...QUITS_AFTER_LAST_WINDOW
  ]);
  assert.equal(w.main.tabs.size, 0);
});

test("session end while the quit question waits cancels the quit", async (w) => {
  const rec = w.window();
  w.tab(rec, "T1", { file: w.gone, dirty: true });
  w.answers.push("discard");
  w.start();
  w.app.quit();
  await w.until("flush T1 keep=true");
  rec.win.emit("session-end");
  await wait(1700);
  assert.deepEqual(w.entries, [
    "app.quit",
    "quit prevented",
    ASK_ONE_LEAVE,
    "flush T1 keep=true",
    "draft markSessionEnd",
    "flush T1 keep=false"
  ]);
});

test("macOS dock activation after the last window closes resumes persisted layout writes", async (w) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    w.main.registerActivate();
    let rec = w.window();
    w.tab(rec, "T1");
    await w.main.persistShellState();
    const statePath = path.join(w.userData, "desktop-state.json");
    for (let round = 0; round < 2; round++) {
      const beforeClose = fs.readFileSync(statePath, "utf8");
      w.start();
      rec.win.close();
      assert.equal(w.main.windowsById.size, 0);
      assert.equal(w.entries.includes("app.quit"), false);
      assert.equal(await w.main.persistShellState(), false);
      assert.equal(fs.readFileSync(statePath, "utf8"), beforeClose);
      w.app.emit("activate");
      assert.equal(w.main.windowsById.size, 1);
      rec = [...w.main.windowsById.values()][0];
      rec.bounds = { x: 50 + round, y: 60, width: 1100, height: 800 };
      await w.main.persistShellState();
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(state.windows[0].windowId, rec.id);
      assert.deepEqual(state.windows[0].bounds, rec.bounds);
      assert.equal(state.windows[0].tabs[0].tabId, rec.activeTabId);
    }
  } finally { Object.defineProperty(process, "platform", platform); }
});

for (const platformName of ["darwin", "win32", "linux"]) {
  test(`a window attached during final-close teardown on ${platformName} keeps the saved layout frozen`, async (w) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platformName });
    try {
      const rec = w.window();
      w.tab(rec, "T1");
      await w.main.persistShellState();
      const statePath = path.join(w.userData, "desktop-state.json");
      const savedState = fs.readFileSync(statePath, "utf8");
      let duringClose;
      rec.win.on("close", () => {
        w.tab(w.window(), "T2");
        duringClose = w.main.persistShellState();
      });
      rec.win.close();
      assert.equal(await duringClose, false);
      assert.equal(await w.main.persistShellState(), false);
      assert.equal(fs.readFileSync(statePath, "utf8"), savedState);
    } finally { Object.defineProperty(process, "platform", platform); }
  });
}

test("a macOS reopen during an asynchronous quit keeps the completed-close snapshot frozen", async (w) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const rec = w.window();
    w.tab(rec, "T1", { file: w.existing });
    await w.main.persistShellState();
    const statePath = path.join(w.userData, "desktop-state.json");
    const savedState = fs.readFileSync(statePath, "utf8");
    let beforeReopen;
    let duringQuit;
    rec.win.on("close", (event) => { if (!event.prevented) w.app.quit(); });
    rec.win.on("closed", () => {
      beforeReopen = w.main.persistShellState();
      w.tab(w.window(), "T2");
      duringQuit = w.main.persistShellState();
    });
    w.start();
    rec.win.close();
    await w.until("quit done");
    assert.equal(await beforeReopen, false);
    assert.equal(await duringQuit, false);
    assert.equal(fs.readFileSync(statePath, "utf8"), savedState);
  } finally { Object.defineProperty(process, "platform", platform); }
});

for (const ending of ["quit", "session-end"]) {
  test(`creating a window during ${ending} keeps session writes frozen`, async (w) => {
    const rec = w.window();
    w.tab(rec, "T1");
    await w.main.persistShellState();
    if (ending === "quit") w.app.quit();
    else rec.win.emit("session-end");
    w.start();
    w.tab(w.window(), "T2");
    assert.equal(await w.main.persistShellState(), false);
    assert.equal(w.entries.includes("state-write"), false);
  });
}

const saved = { test: process.env.SPLITPAGE_TEST, noUpdate: process.env.SPLITPAGE_NO_UPDATE_CHECK, userData: process.env.SPLITPAGE_USER_DATA };
const restoreEnv = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
const failures = [];
for (const c of cases) {
  const world = makeWorld();
  try {
    await c.fn(world);
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failures.push(c.name);
    console.log(`FAIL - ${c.name}\n       ${String((err && err.stack) || err).split("\n").slice(0, 30).join("\n       ")}`);
  } finally {
    await wait(20);
    world.dispose();
  }
}
restoreEnv("SPLITPAGE_TEST", saved.test);
restoreEnv("SPLITPAGE_NO_UPDATE_CHECK", saved.noUpdate);
restoreEnv("SPLITPAGE_USER_DATA", saved.userData);

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases)`);
