import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { collaborationPreload } from "../../tools/build-preload.mjs";

const require = createRequire(import.meta.url);
const { createIpcSetup } = require("../ipc-setup.ts");
const { APP_ORIGIN, TABSTRIP_ORIGIN, RELAY_SETUP_ORIGIN, IPC_CHANNELS } = require("../ipc-channels.ts");
const { createRelaySetupWindow } = require("../relay-setup-window.ts");
const root = fileURLToPath(new URL("../relay-setup", import.meta.url));
const page = RELAY_SETUP_ORIGIN + "/index.html";

function openFixture() {
  let win;
  class Window extends EventEmitter {
    webContents = new EventEmitter();
    closed = false;
    constructor(options) {
      super();
      this.options = options;
      this.webContents.setWindowOpenHandler = handler => { this.popup = handler; };
      win = this;
    }
    isDestroyed() { return this.closed; }
    removeMenu() {}
    loadURL(url) {
      this.webContents.mainFrame = { url };
      return Promise.resolve();
    }
    close() { this.closed = true; this.emit("closed"); }
  }
  const setup = createRelaySetupWindow(Window, root, RELAY_SETUP_ORIGIN);
  const closed = setup.open({});
  return { setup, win, closed };
}

test("the setup window is sandboxed, serves its own script-free page and blocks navigation", async () => {
  const { setup, win, closed } = openFixture();
  assert.equal(win.webContents.mainFrame.url, page);
  assert.deepEqual(win.popup(), { action: "deny" });
  for (const kind of ["will-navigate", "will-frame-navigate", "will-attach-webview"]) {
    let prevented = 0;
    win.webContents.emit(kind, { preventDefault: () => { prevented++; } });
    assert.equal(prevented, 1);
  }
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.devTools, false);
  const response = await setup.serve(new URL(page), "GET");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy"), /form-action 'none'/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const html = await response.text();
  assert.doesNotMatch(html, /<script/i);
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector("input[type=password]").value, "");
  assert.equal((await setup.serve(new URL("/preload.js", page), "GET")).status, 404);
  assert.equal((await setup.serve(new URL(page + "?secret=x"), "GET")).status, 404);
  assert.equal((await setup.serve(new URL(page), "POST")).status, 404);
  assert.equal(await setup.serve(new URL(APP_ORIGIN), "GET"), null);
  win.close();
  assert.equal(await closed, true);
});

test("the setup window may submit credentials solely from its live top frame", async () => {
  const { setup, win, closed } = openFixture();
  const invoke = new Map();
  const push = new Map();
  const secret = crypto.randomUUID();
  let saved = false;
  const registerGroup = ({ ipcHandle, ipcOn, ipcOnSync }) => {
    ipcHandle("splitpage:read-file", () => { throw Error("unreachable"); });
    ipcOn("splitpage:tabstrip-new-tab", () => { throw Error("unreachable"); });
    ipcOnSync("splitpage:tab-boot-sync", () => { throw Error("unreachable"); });
  };
  const noOp = () => {};
  const { registerIpc } = createIpcSetup({
    ipcMain: { handle: (name, fn) => invoke.set(name, fn), on: (name, fn) => push.set(name, fn) },
    app: { getVersion: () => "1.0" }, windowsById: new Map(), testMode: false,
    relaySetup: {
      trusts: setup.trusts,
      save: (address, value) => { saved = address === "https://relay.example" && value === secret; return "saved"; },
      status: () => ({ address: "https://relay.example" }), open: async () => true,
      test: async () => "connected", clear: () => true,
      sharedReference: () => null, manageSharing: () => ({ kind: "failed", reason: "closed" }),
      createShare: () => ({ kind: "failed" }), abandonShare: () => false, completeShare: () => false
    }
  });
  registerIpc({
    registerFileIpc: registerGroup, registerShellIpc: noOp, registerDocumentIpc: noOp,
    registerHistoryBlobIpc: noOp, registerTabStripIpc: noOp, registerTestModeIpc: noOp, registerPrintIpc: noOp
  });
  const setupEvent = { senderFrame: win.webContents.mainFrame, sender: win.webContents };
  const appEvent = { senderFrame: { url: APP_ORIGIN + "/index.html" }, sender: {} };
  const stripEvent = { senderFrame: { url: TABSTRIP_ORIGIN + "/index.html" }, sender: {} };
  const save = invoke.get("splitpage:relay-setup-save");
  for (const event of [appEvent, stripEvent, { ...setupEvent, sender: {} }, { ...setupEvent, senderFrame: { url: page } }]) {
    assert.throws(() => save(event, "https://relay.example", secret), /^Error: untrusted sender$/);
  }
  assert.throws(() => save(setupEvent, "https://relay.example", { secret }), /argument 2 is not string/);
  assert.equal(saved, false);
  assert.equal(save(setupEvent, "https://relay.example", secret), "saved");
  assert.equal(saved, true);
  for (const [name, handler] of invoke) {
    if (name !== "splitpage:relay-setup-save") assert.throws(() => handler(setupEvent), /untrusted sender/);
  }
  for (const row of IPC_CHANNELS.filter(row => row.direction === "sendSync" && push.has(row.name))) {
    push.get(row.name)(setupEvent);
    assert.equal(setupEvent.returnValue, row.refusal);
  }
  push.get("splitpage:tabstrip-new-tab")(setupEvent);
  assert.deepEqual(invoke.get("splitpage:relay-owner-status")(appEvent), { address: "https://relay.example" });
  win.close();
  await closed;
  assert.throws(() => save(setupEvent, "https://relay.example", secret), /untrusted sender/);
});

test("the sandbox preload submits once, never exposes a bridge, and Cancel drops the input", async () => {
  const { setup, win } = openFixture();
  const html = await (await setup.serve(new URL(page), "GET")).text();
  win.close();
  const flow = async (submit) => {
    const dom = new JSDOM(html, { url: page, runScripts: "outside-only" });
    const { window } = dom;
    const secret = crypto.randomUUID();
    const actions = [];
    let closeCount = 0;
    const dispose = window.close.bind(window);
    window.close = () => { closeCount++; };
    window.require = name => {
      assert.equal(name, "electron");
      return { ipcRenderer: { invoke: async (...args) => { actions.push(args); return "saved"; } } };
    };
    const load = new Promise(resolve => window.addEventListener("DOMContentLoaded", resolve));
    window.eval(collaborationPreload("relay-setup-preload", true).replace("location.origin", JSON.stringify(RELAY_SETUP_ORIGIN)));
    await load;
    const { document } = window;
    document.querySelector("#relay-address").value = "https://relay.example";
    document.querySelector("#relay-secret").value = secret;
    if (submit) {
      const form = document.querySelector("form");
      form.requestSubmit();
      form.requestSubmit();
      await setImmediate();
      assert.equal(actions.length, 1);
      assert.ok(actions[0][0] === "splitpage:relay-setup-save" && actions[0][2] === secret);
    } else {
      document.querySelector("#cancel").click();
      assert.deepEqual(actions, []);
    }
    assert.ok(document.querySelector("#relay-secret").value === "");
    assert.equal(closeCount, 1);
    assert.equal(window.splitpageDesktop, undefined);
    dispose();
  };
  await flow(true);
  await flow(false);
});
