import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startDesktopView } from "../../../src/features/desktop/desktop.ts";
import { desktopActions } from "../../../src/features/desktop/actions.ts";
import type { DesktopMount, DesktopPorts, DesktopOpening } from "../../../src/features/desktop/ports.ts";
import type { DesktopOpenedFile, DesktopReassign, DesktopRestoreNotice } from "../../../src/application/desktop/shell.ts";
import { fakeNotices, fakeScreen } from "../fakes.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const pilot = migrateRows({ title: "Pilot", rows: [] }, fakeMigration().ports);

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function mount(ports: DesktopPorts): DesktopMount {
  return startDesktopView(ports) as DesktopMount;
}

async function settled() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function harness(start: { running?: boolean; intent?: string; doc?: boolean } = {}) {
  const handlers: {
    openFile?: (entry: DesktopOpenedFile) => void;
    restore?: (notice: DesktopRestoreNotice) => void;
    reassign?: (msg: DesktopReassign | null) => void;
    menu?: (command: string) => void;
    flush?: (request: { readonly keep: boolean }) => unknown;
  } = {};
  const log: string[] = [];
  const opened: DesktopOpening[] = [];
  const state = { running: start.running ?? true, doc: start.doc ?? true, unsaved: false, menuTaken: false, reassigned: true, onDisk: true };
  const shell = {
    launchIntent: { type: start.intent ?? "blank" },
    onOpenFile: (cb: (entry: DesktopOpenedFile) => void) => { handlers.openFile = cb; },
    onRestoreNotice: (cb: (notice: DesktopRestoreNotice) => void) => { handlers.restore = cb; },
    onReassignDocId: (cb: (msg: DesktopReassign | null) => void) => { handlers.reassign = cb; },
    onMenuCommand: (cb: (command: string) => void) => { handlers.menu = cb; },
    onDraftFlush: (cb: (request: { readonly keep: boolean }) => unknown) => { handlers.flush = cb; },
    openPrompterInBrowser: () => { log.push("browser"); return Promise.resolve({ ok: true, voice: "relay" }); },
    openPrompterInChromium: () => Promise.resolve({ ok: true, browser: "Edge" })
  };
  const notices = fakeNotices();
  const flushDraft = (request: { readonly keep: boolean }) => { log.push("flush:" + request.keep); return "flushed"; };
  const ports: DesktopPorts = {
    running: () => state.running,
    shell: () => (state.running ? shell : null),
    canOpenPrompter: { browser: () => state.running, chromium: () => state.running },
    makeHandle: (entry) => ({ getFile: () => Promise.resolve("file:" + entry.name) }),
    wireBlobs: () => { log.push("blobs"); },
    document: { current: () => (state.doc ? pilot : null) },
    place: {
      fileHome: () => (state.onDisk ? { kind: "file", handle: { _desktopId: "file-1" }, format: "md" } : null)
    },
    notices: notices.notices,
    documents: { open: (opening) => { opened.push(opening); return Promise.resolve(true); } },
    saves: { unsaved: () => state.unsaved, save: () => { log.push("save"); state.unsaved = false; return Promise.resolve(); } },
    startup: { ready: () => null },
    flushDraft: flushDraft,
    reassignDocId: (toId) => { log.push("reassign:" + toId); return state.reassigned; },
    documentState: {
      notify: () => { log.push("notify"); },
      settled: () => { log.push("settled"); },
      awaitHanded: (intent) => { log.push("await:" + intent); }
    },
    menuCommands: { run: (command) => { log.push("runner:" + command); return state.menuTaken; } }
  };
  return { ports, handlers, log, opened, notices, state, flushDraft };
}

function page() {
  win.document.body.innerHTML = '<div id="file-menu"><button data-file-action="save-as">Save as</button></div>' +
    '<button id="menu-export-app-data" hidden></button><button id="menu-import-app-data" hidden></button>';
}

test("starting the desktop wires pictures, menus and every shell event in the old order, then reports the document", async () => {
  page();
  const h = harness({ intent: "open-file" });
  const mounted = mount(h.ports);
  try {
    mounted.initDesktop();
    assert.deepEqual(h.log, ["blobs", "await:open-file", "notify"]);
    assert.equal(win.document.getElementById("menu-export-app-data")?.hidden, false);
    assert.equal(win.document.getElementById("menu-import-app-data")?.hidden, false);
    assert.equal(h.handlers.flush, h.flushDraft);
    await settled();
    assert.deepEqual(h.log, ["blobs", "await:open-file", "notify"], "nothing more runs once the shell answers");
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
    h.handlers.restore?.({ skipped: [{ name: "Pilot", reason: "missing" }, { name: "Cut", reason: "unreadable" }, { reason: "odd" }] });
    h.handlers.restore?.({ skipped: [] });
    assert.deepEqual(h.notices.shown.map((n) => [n.message, n.kind, n.sticky]), [["Could not restore: Pilot (missing), Cut (unreadable), a document (odd).", "warn", true]]);
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

test("presenting in the browser refuses a script that is not saved to a file", async () => {
  page();
  const h = harness();
  h.state.onDisk = false;
  const mounted = mount(h.ports);
  try {
    const result = await mounted.openPrompterInBrowser();
    assert.equal(result.ok, false);
    assert.match(result.message, /Save this script first/);
    assert.deepEqual(h.log, []);
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
