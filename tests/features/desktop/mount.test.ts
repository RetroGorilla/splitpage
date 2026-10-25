import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { __init } from "../../../src/features/desktop/desktop.js";
import { desktopActions } from "../../../src/features/desktop/actions.ts";
import type { DesktopMount, DesktopPorts, DocumentOpening } from "../../../src/features/desktop/ports.ts";
import type { DesktopOpenedFile, DesktopReassign, DesktopRestoreNotice, DesktopServerDoc, DesktopServerRoute } from "../../../src/application/desktop/shell.ts";
import { fakeActions, fakeNotices, fakeScreen } from "../fakes.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const pilot = migrateRows({ title: "Pilot", rows: [] }, fakeMigration().ports);

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function mount(ports: DesktopPorts): DesktopMount {
  return __init(ports) as DesktopMount;
}

async function settled() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function harness(start: { running?: boolean; intent?: string; doc?: boolean; hosting?: boolean } = {}) {
  const handlers: {
    openFile?: (entry: DesktopOpenedFile) => void;
    serverDoc?: (payload: DesktopServerDoc) => void;
    restore?: (notice: DesktopRestoreNotice) => void;
    reassign?: (msg: DesktopReassign | null) => void;
    menu?: (command: string) => void;
    flush?: (request: { readonly keep: boolean }) => unknown;
  } = {};
  const log: string[] = [];
  const routed: DesktopServerRoute[] = [];
  const opened: DocumentOpening[] = [];
  const state = { running: start.running ?? true, doc: start.doc ?? true, unsaved: false, menuTaken: false, reassigned: true };
  const shell = {
    launchIntent: { type: start.intent ?? "blank" },
    onOpenFile: (cb: (entry: DesktopOpenedFile) => void) => { handlers.openFile = cb; },
    onOpenServerDoc: (cb: (payload: DesktopServerDoc) => void) => { handlers.serverDoc = cb; },
    onRestoreNotice: (cb: (notice: DesktopRestoreNotice) => void) => { handlers.restore = cb; },
    onReassignDocId: (cb: (msg: DesktopReassign | null) => void) => { handlers.reassign = cb; },
    onMenuCommand: (cb: (command: string) => void) => { handlers.menu = cb; },
    onDraftFlush: (cb: (request: { readonly keep: boolean }) => unknown) => { handlers.flush = cb; },
    getSessionInfo: () => Promise.resolve({ hosting: start.hosting ?? false, lanUrls: ["http://10.0.0.2:8080/"], pin: "1234" }),
    openPrompterInBrowser: () => { log.push("browser"); return Promise.resolve({ ok: true, voice: "relay" }); },
    openPrompterInChromium: () => Promise.resolve({ ok: true, browser: "Edge" }),
    routeOpen: (request: DesktopServerRoute) => { routed.push(request); return Promise.resolve({ where: "this-tab" }); }
  };
  const notices = fakeNotices();
  const actions = fakeActions();
  const flushDraft = (request: { readonly keep: boolean }) => { log.push("flush:" + request.keep); return "flushed"; };
  const ports: DesktopPorts = {
    running: () => state.running,
    shell: () => (state.running ? shell : null),
    canOpenPrompter: { browser: () => state.running, chromium: () => state.running },
    driveOpenShown: () => false,
    makeHandle: (entry) => ({ getFile: () => Promise.resolve("file:" + entry.name) }),
    wireBlobs: () => { log.push("blobs"); },
    document: { current: () => (state.doc ? pilot : null) },
    place: {
      home: () => ({ kind: "none" }),
      connection: () => ({ serverUrl: "http://team.test/", token: "tok", tunnel: null, role: "", scope: "" }),
      fileHome: () => ({ kind: "file", handle: { _desktopId: "file-1" }, format: "md" }),
      homeConn: () => null,
      serverHomeId: () => null,
      serverMode: () => ({ available: true, readOnly: false, checked: true, authRequired: false, reviewAvailable: false, version: null, links: false, linksPersist: false })
    },
    server: {
      setHome: () => { log.push("setHome"); },
      forgetMode: () => { log.push("forgetMode"); },
      check: () => { log.push("check"); },
      pointTabAt: (url) => { log.push("point:" + url); }
    },
    notices: notices.notices,
    documents: { open: (opening) => { opened.push(opening); return Promise.resolve(true); } },
    saves: { unsaved: () => state.unsaved, save: () => { log.push("save"); state.unsaved = false; return Promise.resolve(); } },
    startup: { ready: () => null },
    actions: actions.actions,
    flushDraft: flushDraft,
    reassignDocId: (toId) => { log.push("reassign:" + toId); return state.reassigned; },
    documentState: {
      notify: () => { log.push("notify"); },
      settled: () => { log.push("settled"); },
      awaitHanded: (intent) => { log.push("await:" + intent); }
    },
    menuCommands: { run: (command) => { log.push("runner:" + command); return state.menuTaken; } }
  };
  return { ports, handlers, log, routed, opened, notices, actions, state, flushDraft };
}

function page() {
  win.document.body.innerHTML = '<div id="file-menu"><button data-file-action="save-as">Save as</button></div>' +
    '<button id="menu-drive-open"></button><button id="menu-export-app-data" hidden></button>' +
    '<button id="menu-import-app-data" hidden></button><div id="desktop-share-info" hidden></div>';
}

test("starting the desktop wires pictures, menus and every shell event in the old order, then reports the document", async () => {
  page();
  const h = harness({ intent: "open-file", hosting: true });
  const mounted = mount(h.ports);
  try {
    mounted.initDesktop();
    assert.deepEqual(h.log, ["blobs", "await:open-file", "notify"]);
    assert.equal(win.document.getElementById("menu-drive-open")?.hidden, true);
    assert.equal(win.document.getElementById("menu-export-app-data")?.hidden, false);
    assert.equal(win.document.getElementById("menu-import-app-data")?.hidden, false);
    assert.equal(h.handlers.flush, h.flushDraft);
    await settled();
    assert.deepEqual(h.actions.calls, [{ id: "show-servers-dialog", source: "button" }]);
  } finally {
    mounted.dispose();
  }
});

test("an opened file goes through the document sources and settles the handed document", async () => {
  page();
  const h = harness();
  const mounted = mount(h.ports);
  try {
    mounted.initDesktop();
    h.log.length = 0;
    h.handlers.openFile?.({ id: "f1", name: "Pilot.md" });
    await settled();
    assert.deepEqual(h.opened, [{ kind: "file", file: "file:Pilot.md", handle: h.opened[0] && (h.opened[0] as { handle: unknown }).handle }]);
    assert.deepEqual(h.log, ["settled"]);
  } finally {
    mounted.dispose();
  }
});

test("a reassigned id reports the document only when the reassignment took", () => {
  page();
  const h = harness();
  const mounted = mount(h.ports);
  try {
    mounted.initDesktop();
    h.log.length = 0;
    h.handlers.reassign?.({ toId: "doc-2" });
    h.state.reassigned = false;
    h.handlers.reassign?.({ toId: "doc-3" });
    h.handlers.reassign?.(null);
    assert.deepEqual(h.log, ["reassign:doc-2", "notify", "reassign:doc-3"]);
  } finally {
    mounted.dispose();
  }
});

test("a native menu command goes to the runner first, and clicks the file menu item only when the runner declines", () => {
  page();
  const h = harness();
  const mounted = mount(h.ports);
  let clicks = 0;
  win.document.querySelector('[data-file-action="save-as"]')?.addEventListener("click", () => { clicks++; });
  try {
    mounted.initDesktop();
    h.handlers.menu?.("save-as");
    h.state.menuTaken = true;
    h.handlers.menu?.("save-as");
    assert.equal(clicks, 1);
    assert.deepEqual(h.log.filter((entry) => entry.startsWith("runner:")), ["runner:save-as", "runner:save-as"]);
  } finally {
    mounted.dispose();
  }
});

test("a restore notice lists what was skipped, sticky", () => {
  page();
  const h = harness();
  const mounted = mount(h.ports);
  try {
    mounted.initDesktop();
    h.handlers.restore?.({ skipped: [{ name: "Pilot", reason: "server-unreachable" }, { reason: "odd" }] });
    h.handlers.restore?.({ skipped: [] });
    assert.deepEqual(h.notices.shown.map((n) => [n.message, n.kind, n.sticky]), [["Could not restore: Pilot (server unreachable), a document (odd).", "warn", true]]);
  } finally {
    mounted.dispose();
  }
});

test("presenting in the browser saves unsaved work first and reports the shell's answer", async () => {
  page();
  const h = harness();
  h.state.unsaved = true;
  const mounted = mount(h.ports);
  try {
    const result = await mounted.openPrompterInBrowser();
    assert.deepEqual(h.log, ["save", "browser"]);
    assert.equal(result.ok, true);
    assert.match(result.message, /listens through this app/);
  } finally {
    mounted.dispose();
  }
});

test("the share info is drawn only while this computer is hosting", async () => {
  page();
  const quiet = harness();
  const first = mount(quiet.ports);
  await first.renderShareInfo();
  assert.equal(win.document.getElementById("desktop-share-info")?.hidden, true);
  first.dispose();
  const hosting = harness({ hosting: true });
  const second = mount(hosting.ports);
  try {
    await second.renderShareInfo();
    const el = win.document.getElementById("desktop-share-info");
    assert.equal(el?.hidden, false);
    assert.match(el?.textContent ?? "", /10\.0\.0\.2/);
    assert.match(el?.textContent ?? "", /1234/);
  } finally {
    second.dispose();
  }
});

test("a server open is routed with the current connection, and refused off the desktop", async () => {
  const h = harness();
  const mounted = mount(h.ports);
  try {
    assert.equal(await mounted.routeServerOpen("srv-1"), true);
    assert.deepEqual(h.routed, [{ kind: "server", serverDocId: "srv-1", serverUrl: "http://team.test/", token: "tok", tunnel: null }]);
    h.state.running = false;
    assert.equal(mounted.routeServerOpen("srv-2"), null);
  } finally {
    mounted.dispose();
  }
});

test("off the desktop, starting does nothing", () => {
  page();
  const h = harness({ running: false });
  const mounted = mount(h.ports);
  try {
    mounted.initDesktop();
    assert.deepEqual(h.log, []);
  } finally {
    mounted.dispose();
  }
});

test("the prompter actions are refused until mounted, then follow the screen and what the shell offers", async () => {
  const screen = fakeScreen();
  let current: DesktopMount | null = null;
  let running = true;
  const definitions = desktopActions(() => current, {
    screen: screen.screen,
    running: () => running,
    canOpenPrompter: { browser: () => running, chromium: () => false }
  });
  assert.deepEqual(definitions.map((d) => d.id), ["prompter-open-in-browser", "prompter-open-in-chromium"]);
  const [browser, chromium] = definitions;
  assert.deepEqual(browser?.availability?.("menu"), { enabled: false });
  const h = harness();
  current = mount(h.ports);
  try {
    assert.deepEqual(browser?.availability?.("menu"), { enabled: true });
    assert.deepEqual(chromium?.availability?.("menu"), { enabled: true, visible: false });
    const keys = browser?.keys;
    assert.deepEqual(typeof keys === "function" ? keys() : keys, ["mod+shift+p"]);
    running = false;
    assert.deepEqual(typeof keys === "function" ? keys() : keys, []);
    running = true;
    await browser?.run?.("menu", undefined);
    assert.deepEqual(h.log, ["browser"]);
  } finally {
    current.dispose();
  }
});
