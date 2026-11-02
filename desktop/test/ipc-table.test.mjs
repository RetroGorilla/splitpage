import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, "..");

const table = require(path.join(desktop, "ipc-channels.ts"));
const { IPC_CHANNELS, APP_ORIGIN, TABSTRIP_ORIGIN, channelFor, channelsForOrigin, checkArgs } = table;

const read = (name) => {
  const text = fs.readFileSync(path.join(desktop, name), "utf8");
  return name.endsWith(".ts") ? stripTypeScriptTypes(text) : text;
};
const MAIN = read("main.ts");
const SETUP = read("ipc-setup.ts");
const IPC_MODULES = fs.readdirSync(desktop).filter((f) => /^ipc-[a-z-]+\.ts$/.test(f) && f !== "ipc-channels.ts").sort();
const SOURCES = [["main.ts", MAIN], ...IPC_MODULES.map((f) => [f, read(f)])];
const SENDERS = [...SOURCES, ["voice-composition.ts", read("voice-composition.ts")]];
const { createIpcSetup } = require(path.join(desktop, "ipc-setup.ts"));
const PRELOADS = [
  { file: "preload.js", origin: APP_ORIGIN, src: read("preload.js") },
  { file: "tabstrip-preload.js", origin: TABSTRIP_ORIGIN, src: read("tabstrip-preload.js") }
];

const key = (name, direction) => `${name} (${direction})`;

const RAW_DIRECTION = { invoke: "invoke", send: "send", sendSync: "sendSync", on: "receive" };

function callsIn(src) {
  const found = new Set();
  for (const [, method, name] of src.matchAll(/ipcRenderer\.(invoke|send|sendSync|on)\(\s*"(splitpage:[^"]+)"/g)) {
    found.add(key(name, RAW_DIRECTION[method]));
  }
  for (const [, wrapper, name] of src.matchAll(/(?<![.\w])(invoke|sendSync|send|receive)\(\s*"(splitpage:[^"]+)"/g)) {
    found.add(key(name, wrapper === "receive" ? "receive" : wrapper));
  }
  return found;
}

function literalsIn(src) {
  return new Set([...src.matchAll(/"(splitpage:[a-z0-9-]+)"/g)].map((m) => m[1]));
}

const REGISTRAR_DIRECTION = { ipcHandle: "invoke", ipcOn: "send", ipcOnSync: "sendSync" };
const registrationsIn = (file, src) => [...src.matchAll(/\b(ipcHandle|ipcOnSync|ipcOn)\(\s*"(splitpage:[^"]+)"/g)]
  .map((m) => ({ file, registrar: m[1], name: m[2], direction: REGISTRAR_DIRECTION[m[1]], at: m.index }));
const registrations = SOURCES.flatMap(([file, src]) => registrationsIn(file, src));

const [TEST_MODE_FILE, TEST_MODE_SRC] = SOURCES.find(([, src]) => src.includes("function registerTestModeIpc(")) || ["", ""];
const registerTestModeAt = TEST_MODE_SRC.indexOf("function registerTestModeIpc(");
const testModeBlock = /\n *if \((?:TEST_MODE|testMode)\) \{/g;
testModeBlock.lastIndex = Math.max(registerTestModeAt, 0);
const testModeAt = registerTestModeAt < 0 ? -1 : (testModeBlock.exec(TEST_MODE_SRC) || { index: -1 }).index;

const REGISTERED_BEFORE_SPLIT = [
  "splitpage:ipc-table-sync sendSync", "splitpage:open-file-dialog invoke", "splitpage:save-file-dialog invoke",
  "splitpage:read-file invoke", "splitpage:write-file invoke", "splitpage:stat-file invoke",
  "splitpage:recents-list invoke", "splitpage:recents-remove invoke", "splitpage:recents-clear invoke",
  "splitpage:get-session-info invoke", "splitpage:get-app-version-sync sendSync", "splitpage:tab-boot-sync sendSync",
  "splitpage:open-external send", "splitpage:set-theme send", "splitpage:video-file-grant invoke",
  "splitpage:video-file-open invoke", "splitpage:video-thumbnail invoke", "splitpage:update-status invoke",
  "splitpage:update-check invoke", "splitpage:update-download invoke", "splitpage:update-install invoke",
  "splitpage:prompter-open-in-browser invoke", "splitpage:prompter-open-in-chromium invoke",
  "splitpage:voice-status invoke", "splitpage:voice-start invoke", "splitpage:voice-stop invoke",
  "splitpage:set-document-state send", "splitpage:renderer-ready send", "splitpage:route-open invoke",
  "splitpage:draft-write invoke", "splitpage:draft-discard invoke", "splitpage:draft-take invoke",
  "splitpage:draft-restore-done send", "splitpage:draft-flushed send", "splitpage:history-put invoke",
  "splitpage:history-list invoke", "splitpage:history-get invoke", "splitpage:history-copy invoke",
  "splitpage:history-touch invoke", "splitpage:history-list-docs invoke", "splitpage:blob-put invoke",
  "splitpage:blob-get invoke", "splitpage:blob-missing invoke", "splitpage:tabstrip-window-id-sync sendSync",
  "splitpage:tabstrip-get-state invoke", "splitpage:tabstrip-new-tab send", "splitpage:tabstrip-activate send",
  "splitpage:tabstrip-close send", "splitpage:tabstrip-reorder send", "splitpage:tabstrip-move-here send",
  "splitpage:tabstrip-tear-off send", "splitpage:is-test-mode-sync sendSync", "splitpage:test-request-close send",
  "splitpage:test-request-close-tab send", "splitpage:test-request-quit send", "splitpage:test-draft-status invoke",
  "splitpage:test-crash-renderer send", "splitpage:test-dup-loser invoke", "splitpage:test-shell invoke"
];
const REGISTERED_AFTER_SPLIT = ["splitpage:print-to-pdf invoke"];

function handlerGroups() {
  const groups = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(/^( *)function (register\w+Ipc)\(\{[^}]*\}\s*\)\s*\{$/gm)) {
      const end = src.indexOf("\n" + m[1] + "}\n", m.index);
      groups.push({
        file,
        name: m[2],
        start: m.index,
        end,
        registrations: registrations.filter((r) => r.file === file && r.at > m.index && r.at < end)
      });
    }
  }
  return groups;
}

function fakeIpcMain() {
  const registered = [];
  return {
    registered,
    handle(name, listener) { registered.push({ name, method: "handle", listener }); },
    on(name, listener) { registered.push({ name, method: "on", listener }); }
  };
}

const APP_FRAME = { url: APP_ORIGIN + "/index.html" };
const STRIP_FRAME = { url: TABSTRIP_ORIGIN + "/index.html" };

function setupWith(ipcMain, windowsById = new Map()) {
  return createIpcSetup({ ipcMain, app: { getVersion: () => "9.9.9" }, testMode: false, windowsById });
}

function directionOf(entry) {
  if (entry.method === "handle") return "invoke";
  const event = { senderFrame: { url: "https://evil.example/" }, sender: {} };
  const logError = console.error;
  console.error = () => {};
  try { entry.listener(event); } finally { console.error = logError; }
  return "returnValue" in event ? "sendSync" : "send";
}

function fakeElectron(ipcMain, userData) {
  const noop = () => {};
  const loose = (base) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });
  const app = loose({
    isPackaged: false,
    getPath: () => userData,
    getVersion: () => "9.9.9",
    isReady: () => false,
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {})
  });
  return loose({
    app, ipcMain,
    BrowserWindow: loose(function BrowserWindow() {}),
    WebContentsView: loose(function WebContentsView() {}),
    Menu: loose({}), protocol: loose({}), net: loose({}), dialog: loose({}), shell: loose({}),
    session: loose({}), nativeTheme: loose({}), screen: loose({})
  });
}

const REGISTER_IPC_CALL = /\n {2}registerIpc\(\{([^}]*)\}\);/.exec(MAIN);
const GROUPS_PASSED = REGISTER_IPC_CALL ? REGISTER_IPC_CALL[1].split(",").map((s) => s.trim()).filter(Boolean) : [];

function registerThroughMain({ testMode }) {
  const ipcMain = fakeIpcMain();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-table-"));
  const electron = fakeElectron(ipcMain, userData);
  const mainPath = path.join(desktop, "main.ts");
  const lockElseEnd = MAIN.lastIndexOf("\n}");
  assert.ok(/\n\} else \{\n/.test(MAIN) && MAIN.slice(lockElseEnd).trim() === "}", "main.ts ends with its single-instance else block");
  const body = MAIN.slice(0, lockElseEnd) + `\nreturn { registerIpc, ${GROUPS_PASSED.join(", ")} };` + MAIN.slice(lockElseEnd);
  const load = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${body}\n})`,
    { filename: mainPath }
  );
  const fakeRequire = (id) => (id === "electron" ? electron : require(id.startsWith(".") ? path.join(desktop, id) : id));
  const saved = { test: process.env.SPLITPAGE_TEST, noUpdate: process.env.SPLITPAGE_NO_UPDATE_CHECK, userData: process.env.SPLITPAGE_USER_DATA };
  const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  process.env.SPLITPAGE_TEST = testMode ? "1" : "0";
  process.env.SPLITPAGE_NO_UPDATE_CHECK = "1";
  process.env.SPLITPAGE_USER_DATA = userData;
  try {
    const main = load({}, fakeRequire, { exports: {} }, mainPath, desktop);
    main.registerIpc(Object.fromEntries(GROUPS_PASSED.map((name) => [name, main[name]])));
  } finally {
    restore("SPLITPAGE_TEST", saved.test);
    restore("SPLITPAGE_NO_UPDATE_CHECK", saved.noUpdate);
    restore("SPLITPAGE_USER_DATA", saved.userData);
    fs.rmSync(userData, { recursive: true, force: true });
  }
  return ipcMain.registered.map((e) => `${e.name} ${directionOf(e)}`);
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("the table is frozen all the way down", () => {
  assert.equal(Object.isFrozen(IPC_CHANNELS), true, "the list");
  for (const c of IPC_CHANNELS) {
    assert.equal(Object.isFrozen(c), true, `row ${key(c.name, c.direction)}`);
    assert.equal(Object.isFrozen(c.argsSchema), true, `argsSchema of ${c.name}`);
    assert.equal(Object.isFrozen(c.allowedOrigins), true, `allowedOrigins of ${c.name}`);
  }
  assert.throws(() => { IPC_CHANNELS.push({}); }, "the list cannot be added to");
});

test("every row has a name, a direction, a schema and at least one origin", () => {
  const seen = new Set();
  for (const c of IPC_CHANNELS) {
    assert.match(c.name, /^splitpage:[a-z0-9-]+$/, `channel name ${c.name}`);
    assert.ok(["invoke", "send", "sendSync", "receive"].includes(c.direction), `direction of ${c.name}`);
    assert.ok(Array.isArray(c.argsSchema), `argsSchema of ${c.name}`);
    assert.ok(c.allowedOrigins.length > 0, `${c.name} is usable by nobody`);
    for (const o of c.allowedOrigins) {
      assert.ok([APP_ORIGIN, TABSTRIP_ORIGIN].includes(o), `${c.name} names origin ${o}`);
    }
    assert.equal(seen.has(key(c.name, c.direction)), false, `duplicate row ${key(c.name, c.direction)}`);
    seen.add(key(c.name, c.direction));
    if (c.direction === "sendSync") {
      assert.ok("refusal" in c, `${c.name} is sendSync and must declare a refusal value`);
    }
  }
});

test("the two origins share only the table read", () => {
  const app = new Set(channelsForOrigin(APP_ORIGIN).map((c) => key(c.name, c.direction)));
  const strip = new Set(channelsForOrigin(TABSTRIP_ORIGIN).map((c) => key(c.name, c.direction)));
  const both = [...app].filter((k) => strip.has(k));
  assert.deepEqual(both, ["splitpage:ipc-table-sync (sendSync)"]);
  for (const k of strip) {
    if (k === "splitpage:ipc-table-sync (sendSync)") continue;
    assert.match(k, /^splitpage:tabstrip-/, `${k} is reachable from the strip`);
  }
});

for (const preload of PRELOADS) {
  test(`${preload.file}: every channel it calls is in the table for its origin`, () => {
    for (const k of callsIn(preload.src)) {
      const [name, direction] = [k.slice(0, k.indexOf(" (")), k.slice(k.indexOf("(") + 1, -1)];
      const row = channelFor(name, direction);
      assert.ok(row, `${k} is called by ${preload.file} and is not in the table`);
      assert.ok(
        row.allowedOrigins.includes(preload.origin),
        `${k} is called by ${preload.file}, whose origin the table does not allow`
      );
    }
  });

  test(`${preload.file}: every channel string in it is one its origin owns`, () => {
    for (const name of literalsIn(preload.src)) {
      const rows = IPC_CHANNELS.filter((c) => c.name === name && c.allowedOrigins.includes(preload.origin));
      assert.ok(rows.length, `${preload.file} names ${name}, which is not this origin's`);
    }
  });

  test(`${preload.file}: every row for its origin is exposed by it`, () => {
    const called = callsIn(preload.src);
    for (const row of channelsForOrigin(preload.origin)) {
      assert.ok(
        called.has(key(row.name, row.direction)),
        `${key(row.name, row.direction)} is in the table for ${preload.origin} and ${preload.file} never uses it`
      );
    }
  });
}

test("neither preload can reach the other's channels", () => {
  const stripNames = new Set(channelsForOrigin(TABSTRIP_ORIGIN).map((c) => c.name));
  const appOnly = channelsForOrigin(APP_ORIGIN).filter((c) => !stripNames.has(c.name));
  const strip = PRELOADS.find((p) => p.origin === TABSTRIP_ORIGIN).src;
  for (const c of appOnly) {
    assert.equal(strip.includes(c.name), false, `the strip's preload names ${c.name}`);
  }
});

test("main.ts and the ipc-*.ts modules register nothing through ipcMain directly", () => {
  for (const [file, src] of SOURCES) {
    const direct = [...src.matchAll(/ipcMain\.(handle|on)\(\s*"/g)];
    assert.deepEqual(direct.map((m) => m[0]), [], `${file}: every registration goes through ipcHandle/ipcOn/ipcOnSync`);
    if (file !== "ipc-setup.ts") {
      assert.equal(/ipcMain\.(handle|on)\(/.test(src), false, `${file} calls ipcMain only through ipc-setup.ts`);
    }
  }
});

test("every channel main.ts and the ipc-*.ts modules register is in the table, with that direction", () => {
  for (const r of registrations) {
    const row = channelFor(r.name, r.direction);
    assert.ok(row, `${r.file} registers ${key(r.name, r.direction)}, which is not in the table`);
    assert.ok(row.allowedOrigins.length > 0, `${r.name} has no origin`);
  }
});

test("main.ts and the ipc-*.ts modules register a handler for every inbound row, exactly once", () => {
  for (const row of IPC_CHANNELS) {
    if (row.direction === "receive") continue;
    const hits = registrations.filter((r) => r.name === row.name && r.direction === row.direction);
    assert.equal(hits.length, 1, `${key(row.name, row.direction)} is registered ${hits.length} times in main.ts and the ipc-*.ts modules`);
  }
});

test("every registration outside ipc-setup.ts sits in a handler group that ipc-setup.ts calls", () => {
  const groups = handlerGroups();
  for (const r of registrations.filter((x) => x.file !== "ipc-setup.ts")) {
    assert.ok(
      groups.some((g) => g.file === r.file && r.at > g.start && r.at < g.end),
      `${r.file}: ${r.name} is registered outside a register*Ipc group`
    );
  }
  for (const g of groups) {
    assert.ok(g.registrations.length > 0, `${g.name} registers nothing`);
    assert.ok(SETUP.includes(`groups.${g.name}(wrappers);`), `ipc-setup.ts never calls ${g.name}`);
  }
});

test("main.ts passes registerIpc every handler group, and each group's module is required by main.ts", () => {
  assert.ok(REGISTER_IPC_CALL, "main.ts calls registerIpc({ ...groups })");
  const groups = handlerGroups();
  assert.deepEqual([...GROUPS_PASSED].sort(), groups.map((g) => g.name).sort());
  for (const g of groups) {
    if (g.file === "main.ts") continue;
    assert.ok(MAIN.includes(`require("./${g.file.replace(/\.js$/, "")}")`), `main.ts does not require ./${g.file}`);
  }
});

test("in test mode, main.ts's real groups register the 59 pairs in the order they had before the split, then the print channel", () => {
  assert.deepEqual(registerThroughMain({ testMode: true }), [...REGISTERED_BEFORE_SPLIT, ...REGISTERED_AFTER_SPLIT]);
});

test("outside test mode, main.ts's real groups register the same pairs in order, minus every test-only channel", () => {
  const seen = registerThroughMain({ testMode: false });
  const expected = [...REGISTERED_BEFORE_SPLIT, ...REGISTERED_AFTER_SPLIT].filter((pair) => !pair.startsWith("splitpage:test-"));
  assert.equal(expected.length, 53);
  assert.deepEqual(seen, expected);
  for (const pair of seen) {
    const [name, direction] = pair.split(" ");
    assert.equal(!!channelFor(name, direction).testOnly, false, `${pair} is test-only and registered outside test mode`);
  }
});

test("the wrappers refuse untrusted senders and bad arguments, and run trusted calls", async () => {
  const stripContents = {};
  const windowsById = new Map([["w1", { win: { isDestroyed: () => false, webContents: stripContents } }]]);
  const ipcMain = fakeIpcMain();
  setupWith(ipcMain, windowsById).registerIpc({
    registerFileIpc: ({ ipcHandle }) => ipcHandle("splitpage:read-file", (_e, id) => "read " + id),
    registerShellIpc: ({ ipcOnSync }) => ipcOnSync("splitpage:tab-boot-sync", () => { throw new Error("boom"); }),
    registerDocumentIpc: () => {},
    registerHistoryBlobIpc: () => {},
    registerTabStripIpc: ({ ipcOn }) => ipcOn("splitpage:tabstrip-new-tab", (e) => { e.ran = true; }),
    registerTestModeIpc: () => {},
    registerPrintIpc: () => {}
  });
  const entry = (name) => ipcMain.registered.find((e) => e.name === name).listener;

  assert.equal(await entry("splitpage:read-file")({ senderFrame: APP_FRAME, sender: {} }, "f1"), "read f1");
  assert.throws(() => entry("splitpage:read-file")({ senderFrame: STRIP_FRAME, sender: stripContents }, "f1"), /untrusted sender/);
  assert.throws(() => entry("splitpage:read-file")({ senderFrame: APP_FRAME, sender: {} }, "a", "b"), /splitpage:read-file: /);

  const fromStrip = { senderFrame: STRIP_FRAME, sender: stripContents };
  entry("splitpage:tabstrip-new-tab")(fromStrip);
  assert.equal(fromStrip.ran, true, "a strip sender in a live window runs");
  const strayStrip = { senderFrame: STRIP_FRAME, sender: {} };
  entry("splitpage:tabstrip-new-tab")(strayStrip);
  assert.equal(strayStrip.ran, undefined, "a strip sender in no window is refused");

  const boot = { senderFrame: APP_FRAME, sender: {} };
  entry("splitpage:tab-boot-sync")(boot);
  assert.equal(boot.returnValue, channelFor("splitpage:tab-boot-sync", "sendSync").refusal, "a throwing sync handler answers its refusal");

  const version = { senderFrame: APP_FRAME, sender: {} };
  entry("splitpage:get-app-version-sync")(version);
  assert.equal(version.returnValue, "9.9.9");
  const tableRead = { senderFrame: STRIP_FRAME, sender: stripContents };
  entry("splitpage:ipc-table-sync")(tableRead);
  assert.deepEqual(tableRead.returnValue, channelsForOrigin(TABSTRIP_ORIGIN));
});

test("the main process sends every main -> renderer row and registers none of them", () => {
  const sends = new Set(SENDERS.flatMap(([, src]) => [...src.matchAll(/\.send\(\s*"(splitpage:[^"]+)"/g)].map((m) => m[1])));
  const inbound = new Set(IPC_CHANNELS.filter((c) => c.direction !== "receive").map((c) => c.name));
  for (const row of IPC_CHANNELS) {
    if (row.direction !== "receive") continue;
    assert.ok(sends.has(row.name), `${row.name} is in the table and none of main.ts, the ipc-*.ts modules or voice-composition.ts sends it`);
    if (!inbound.has(row.name)) {
      assert.equal(
        registrations.some((r) => r.name === row.name),
        false,
        `${row.name} is only a push from main and must not be registered as a handler`
      );
    }
  }
});

test("a TEST_MODE-only row is registered inside the TEST_MODE block, and nothing else is", () => {
  assert.ok(registerTestModeAt > 0, "registerTestModeIpc() found");
  assert.ok(testModeAt > registerTestModeAt, "the TEST_MODE block inside registerTestModeIpc() found");
  for (const r of registrations) {
    const row = channelFor(r.name, r.direction);
    const inTestBlock = r.file === TEST_MODE_FILE && r.at > testModeAt;
    if (row.testOnly) {
      assert.ok(inTestBlock, `${r.name} is testOnly and is registered outside the TEST_MODE block`);
    } else {
      assert.ok(!inTestBlock, `${r.name} is not testOnly and is registered inside the TEST_MODE block`);
    }
  }
});

test("every testOnly channel is a __test hook and nothing else is", () => {
  for (const row of IPC_CHANNELS) {
    assert.equal(
      !!row.testOnly,
      row.name.startsWith("splitpage:test-"),
      `${row.name}: testOnly and the name disagree`
    );
  }
});

test("checkArgs accepts what the channels really send", () => {
  const tab = "0123456789abcdef0123456789abcdef";
  const doc = "d0123456789abcdef0123456789abcdef";
  assert.equal(checkArgs(channelFor("splitpage:tabstrip-reorder", "send").argsSchema, [tab, 3]), null);
  assert.equal(checkArgs(channelFor("splitpage:tabstrip-tear-off", "send").argsSchema, [tab, 12, 40]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-list", "invoke").argsSchema, [null]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-list", "invoke").argsSchema, [doc]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-get", "invoke").argsSchema, [{ docId: doc }, "snap-1"]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-put", "invoke").argsSchema, [doc, {}, "{}", { protect: [] }]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-put", "invoke").argsSchema, [null, {}, "{}", { protect: [], older: true }]), null);
  assert.equal(checkArgs(channelFor("splitpage:write-file", "invoke").argsSchema, ["f1", "text"]), null);
  assert.equal(checkArgs(channelFor("splitpage:write-file", "invoke").argsSchema, ["f1", new Uint8Array(2)]), null);
  assert.equal(checkArgs(channelFor("splitpage:update-check", "invoke").argsSchema, []), null);
  assert.equal(checkArgs(channelFor("splitpage:test-shell", "invoke").argsSchema, ["listTargets", null]), null);
  assert.equal(checkArgs(channelFor("splitpage:test-draft-status", "invoke").argsSchema, []), null);
  assert.equal(checkArgs(channelFor("splitpage:test-draft-status", "invoke").argsSchema, [tab]), null);
  assert.equal(checkArgs(channelFor("splitpage:draft-write", "invoke").argsSchema, [{ seq: 1 }]), null);
});

test("checkArgs refuses the shapes the handlers used to refuse for themselves", () => {
  const doc = () => "d0123456789abcdef0123456789abcdef";
  const bad = (name, direction, args) => checkArgs(channelFor(name, direction).argsSchema, args);
  assert.ok(bad("splitpage:tabstrip-activate", "send", ["not-a-tab-id"]), "a tab id that is not 32 hex");
  assert.ok(bad("splitpage:tabstrip-activate", "send", []), "no tab id at all");
  assert.ok(bad("splitpage:tabstrip-reorder", "send", ["0".repeat(32), 1.5]), "a fractional index");
  assert.ok(bad("splitpage:history-put", "invoke", ["_older", {}, "{}", {}]), "the Older bucket as a docId");
  assert.ok(bad("splitpage:history-put", "invoke", ["_older", {}, "{}", { older: true }]), "the Older bucket as a docId, flag or no flag");
  assert.ok(bad("splitpage:history-put", "invoke", [doc(), {}, "{}", []]), "a bare protect list where the options bag goes");
  assert.ok(bad("splitpage:history-put", "invoke", [doc(), {}, "{}"]), "no options bag at all");
  assert.ok(bad("splitpage:history-get", "invoke", [{}, "../escape"]), "a snapshot id that is a path");
  assert.ok(bad("splitpage:update-install", "invoke", ["C:\\anything.exe"]), "an argument to an argument-free call");
  assert.ok(bad("splitpage:write-file", "invoke", ["f1", { not: "bytes" }]), "a body that is not bytes");
  assert.ok(bad("splitpage:open-external", "send", [{ url: "https://x" }]), "a url that is not a string");
  assert.ok(bad("splitpage:set-document-state", "send", [null]), "a null document state");
  assert.ok(bad("splitpage:read-file", "invoke", ["a", "b"]), "more arguments than the channel takes");
});

test("version history is exactly six app-only invoke channels", () => {
  const names = IPC_CHANNELS.filter((c) => c.name.startsWith("splitpage:history-")).map((c) => c.name).sort();
  assert.deepEqual(names, [
    "splitpage:history-copy", "splitpage:history-get", "splitpage:history-list",
    "splitpage:history-list-docs", "splitpage:history-put", "splitpage:history-touch"
  ]);
  for (const name of names) {
    const row = channelFor(name, "invoke");
    assert.ok(row, name + " is an invoke");
    assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN], name + " is the app page's alone");
  }
  assert.equal(channelFor("splitpage:history-usage", "invoke"), null, "usage folded into history-list");
  assert.equal(channelFor("splitpage:history-import-older", "invoke"), null, "import-older folded into history-put");
});

test("the teleprompter's Open in browser takes no argument, from the app page only", () => {
  const row = channelFor("splitpage:prompter-open-in-browser", "invoke");
  assert.ok(row, "declared");
  assert.deepEqual([...row.argsSchema], []);
  assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN]);
  assert.equal(checkArgs(row.argsSchema, []), null);
  assert.ok(checkArgs(row.argsSchema, ["http://evil.example/"]), "a URL");
  assert.ok(checkArgs(row.argsSchema, ["C:\\Users\\me\\script.md"]), "a path");
  assert.ok(checkArgs(row.argsSchema, [{ doc: "abc" }]), "a document id");
  assert.ok(!channelsForOrigin(TABSTRIP_ORIGIN).some((c) => c.name === row.name), "never the tab strip's");
});

test("Use Chromium Speech Recognition takes no argument, from the app page only", () => {
  const row = channelFor("splitpage:prompter-open-in-chromium", "invoke");
  assert.ok(row, "declared");
  assert.deepEqual([...row.argsSchema], []);
  assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN]);
  assert.equal(checkArgs(row.argsSchema, []), null);
  assert.ok(checkArgs(row.argsSchema, ["C:\\Windows\\System32\\calc.exe"]), "a path");
  assert.ok(checkArgs(row.argsSchema, ["http://evil.example/"]), "a URL");
  assert.ok(!channelsForOrigin(TABSTRIP_ORIGIN).some((c) => c.name === row.name), "never the tab strip's");
});

test("Follow My Voice takes no argument, from the app page only", () => {
  for (const name of ["splitpage:voice-status", "splitpage:voice-start", "splitpage:voice-stop"]) {
    const row = channelFor(name, "invoke");
    assert.ok(row, name + " declared");
    assert.deepEqual([...row.argsSchema], [], name);
    assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN], name);
    assert.equal(checkArgs(row.argsSchema, []), null, name);
    assert.ok(checkArgs(row.argsSchema, ["powershell.exe"]), name + ": an executable");
    assert.ok(checkArgs(row.argsSchema, ["C:\\evil.ps1"]), name + ": a script path");
    assert.ok(checkArgs(row.argsSchema, [{ lang: "en-US" }]), name + ": options");
    assert.ok(!channelsForOrigin(TABSTRIP_ORIGIN).some((c) => c.name === name), name + ": never the tab strip's");
  }
  const events = channelFor("splitpage:voice-event", "receive");
  assert.ok(events, "voice-event declared");
  assert.deepEqual([...events.allowedOrigins], [APP_ORIGIN]);
});

test("packaging: every ./module main.ts requires, directly or through another module, is in electron-builder.yml's files", () => {
  const yml = read("electron-builder.yml");
  const listed = new Set([...yml.matchAll(/^\s*-\s+([A-Za-z0-9_.-]+\.(?:js|ts))\s*$/gm)].map((m) => m[1]));
  const requiredBy = (src) => [...src.matchAll(/require\("\.\/([A-Za-z0-9_-]+)(\.(?:js|ts))?"\)/g)].map((m) => m[1] + (m[2] || ".js"));
  const required = new Set();
  const pending = SOURCES.map(([, src]) => src);
  while (pending.length) {
    for (const f of requiredBy(pending.shift())) {
      if (required.has(f)) continue;
      required.add(f);
      pending.push(read(f));
    }
  }
  assert.ok(required.has("drafts.ts"), "main.ts requires ./drafts");
  assert.ok(required.has("ipc-setup.ts"), "main.ts requires ./ipc-setup");
  assert.ok(required.has("ipc-channels.ts"), "ipc-setup.ts requires ./ipc-channels");
  for (const f of ["close-keep.ts", "quit-watchdog.ts", "unsaved-dialog.ts"]) assert.ok(required.has(f), "the close and quit code requires ./" + f);
  for (const f of IPC_MODULES) assert.ok(requiredBy(MAIN).includes(f), f + " is an IPC module main.ts does not require");
  for (const f of ["close-quit.ts", "session-restore.ts"]) assert.ok(requiredBy(MAIN).includes(f), f + " is a lifecycle module main.ts does not require");
  assert.ok(requiredBy(MAIN).includes("voice-composition.ts"), "main.ts requires ./voice-composition.ts");
  assert.ok(required.has("voice-helper.ts") && required.has("prompter-share.ts"), "voice-composition.ts requires ./voice-helper and ./prompter-share.ts");
  assert.ok(requiredBy(MAIN).includes("print-pdf.ts"), "main.ts requires ./print-pdf.ts");
  for (const f of required) assert.ok(listed.has(f), f + " is required from main.ts but not in electron-builder.yml files");
});

test("the blob channels: a typed sha256, app page only", () => {
  const sha = "0123456789abcdef".repeat(4);
  const row = (name) => channelFor(name, "invoke");
  assert.deepEqual([...row("splitpage:blob-put").argsSchema], ["sha256", "bytes"]);
  assert.deepEqual([...row("splitpage:blob-get").argsSchema], ["sha256"]);
  assert.deepEqual([...row("splitpage:blob-missing").argsSchema], ["array"]);
  assert.equal(checkArgs(row("splitpage:blob-put").argsSchema, [sha, new Uint8Array(4)]), null);
  assert.equal(checkArgs(row("splitpage:blob-get").argsSchema, [sha]), null);
  assert.equal(checkArgs(row("splitpage:blob-missing").argsSchema, [[sha]]), null);
  for (const bad of [sha.toUpperCase(), sha.slice(1), sha + "0", "../" + sha.slice(3),
    "C:\\Users\\me\\blobs\\" + sha, "https://evil.example/" + sha, "", null, 42, { sha }]) {
    assert.ok(checkArgs(row("splitpage:blob-get").argsSchema, [bad]), "blob-get refuses " + JSON.stringify(bad));
    assert.ok(checkArgs(row("splitpage:blob-put").argsSchema, [bad, new Uint8Array(4)]), "blob-put refuses " + JSON.stringify(bad));
  }
  assert.ok(checkArgs(row("splitpage:blob-put").argsSchema, [sha]), "a put with no bytes");
  assert.ok(checkArgs(row("splitpage:blob-put").argsSchema, [sha, { not: "bytes" }]), "a put whose body is not bytes");
  assert.ok(checkArgs(row("splitpage:blob-put").argsSchema, [sha, new Uint8Array(4), "image/svg+xml"]), "a caller-supplied mime");
  assert.ok(checkArgs(row("splitpage:blob-missing").argsSchema, [sha]), "a missing query that is not a list");
  const blob = IPC_CHANNELS.filter((c) => c.name.startsWith("splitpage:blob-"));
  assert.equal(blob.length, 3);
  for (const c of blob) {
    assert.deepEqual([...c.allowedOrigins], [APP_ORIGIN], c.name);
    assert.equal(c.direction, "invoke", c.name);
    assert.ok(!c.testOnly, c.name);
  }
});

test("the video thumbnail channel: a typed host and video ref, app page only", () => {
  const c = channelFor("splitpage:video-thumbnail", "invoke");
  assert.ok(c, "the channel exists");
  assert.deepEqual([...c.argsSchema], ["videoHost", "videoRef"]);
  assert.deepEqual([...c.allowedOrigins], [APP_ORIGIN]);
  assert.ok(!c.testOnly);
  for (const ok of [["youtube", "dQw4w9WgXcQ"], ["vimeo", "76979871"], ["vimeo", "76979871:abcdef1234"], ["youtube", "a-b_c-d_e-f"]]) {
    assert.equal(checkArgs(c.argsSchema, ok), null, JSON.stringify(ok));
  }
  for (const bad of [
    ["loom", "dQw4w9WgXcQ"], ["YouTube", "dQw4w9WgXcQ"], ["https://i.ytimg.com", "dQw4w9WgXcQ"],
    ["youtube", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"], ["youtube", "../../etc/passwd"],
    ["youtube", "dQw4w9WgXc"], ["vimeo", "76979871:ABCDEF"], ["vimeo", "76979871:abcdef/../x"], ["youtube", ""],
    ["youtube"], ["youtube", 42], ["youtube", "dQw4w9WgXcQ", "https://evil.example/"]
  ]) {
    assert.ok(checkArgs(c.argsSchema, bad), "refuses " + JSON.stringify(bad));
  }
});

test("the PDF print channel takes one HTML string, from the app page only", () => {
  const row = channelFor("splitpage:print-to-pdf", "invoke");
  assert.ok(row, "declared");
  assert.deepEqual([...row.argsSchema], ["string"]);
  assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN]);
  assert.ok(!row.testOnly);
  assert.equal(checkArgs(row.argsSchema, ["<!doctype html><title>t</title>"]), null);
  for (const bad of [[], [null], [{ html: "<p>" }], [new Uint8Array(2)], ["<p>", { path: "C:\\out.pdf" }], ["<p>", "C:\\out.pdf"]]) {
    assert.ok(checkArgs(row.argsSchema, bad), "refuses " + JSON.stringify(bad));
  }
  assert.ok(!channelsForOrigin(TABSTRIP_ORIGIN).some((c) => c.name === row.name), "never the tab strip's");
});

test("the draft channels let a bad payload through to their own answer", () => {
  for (const name of ["splitpage:draft-write", "splitpage:draft-discard"]) {
    assert.equal(checkArgs(channelFor(name, "invoke").argsSchema, ["nonsense"]), null, name);
    assert.equal(checkArgs(channelFor(name, "invoke").argsSchema, [null]), null, name);
  }
});

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failures.push(c.name);
    console.log(`FAIL - ${c.name}\n       ${String((err && err.stack) || err).split("\n").slice(0, 6).join("\n       ")}`);
  }
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases, ${IPC_CHANNELS.length} channels)`);
