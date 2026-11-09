import type { MalformedDesktopReply } from "../../../src/adapters/desktop/desktop-port.ts";
import type { RecentFiles, RecentFileData } from "../../../src/application/files/recent-files.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startFileMenu } from "../../../src/features/file-menu/file-menu.ts";
import { fileMenuActions } from "../../../src/features/file-menu/actions.ts";
import type { FileMenuControls, FileMenuDropdownMount, FileMenuDropdownPorts } from "../../../src/features/file-menu/ports.ts";
import { NO_DESTINATION } from "../../../src/application/transitions/ports.ts";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import type { DocumentView } from "../../../src/application/session/document-session.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeNotices, fakeScreen } from "../fakes.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function page() {
  win.document.body.innerHTML = '<div class="menu-wrap"><button id="btn-file" aria-expanded="false">File</button>' +
    '<div id="file-menu" hidden tabindex="-1"><div class="menu-body"><div id="fm-card-name"></div><div id="fm-card-meta"></div>' +
    '<div class="menu-group"><button class="mi" data-file-action="paste"><span class="mi-why" hidden></span></button></div>' +
    '<div class="menu-group"><button class="mi mi-parent" id="menu-recent" data-submenu="recent" aria-controls="menu-sub-recent" aria-expanded="false">Recent</button>' +
    '<div class="menu-sub" id="menu-sub-recent" hidden></div></div></div></div></div>' +
    '<div id="file-menu-backdrop" hidden></div><div id="rows"></div>';
}

async function settled() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function documentOf(raw: unknown): DocumentView {
  return migrateRows(raw, fakeMigration().ports);
}

const LONG_DEMO ={ state: { title: "Long demo", rows: [{ id: "d1", audioText: "One" }, { id: "d2", audioText: "Two" }] } };

function harness() {
  const calls: unknown[][] = [];
  const state = {
    document: documentOf({ title: "Before", docId: "d-old", rows: [{ id: "a" }] }) as DocumentView | null,
    home: { kind: "none" } as ReturnType<FileMenuDropdownPorts["place"]["home"]>,
    desktop: false,
    busy: false, unsaved: false, kept: { label: "kept" } as unknown, recent: [] as unknown[]
  };
  const notices = fakeNotices();
  const ports: FileMenuDropdownPorts = {
    document: { current: () => state.document },
    place: { home: () => state.home },
    desktop: () => state.desktop,
    recents: {
      available: () => true,
      list: async () => { calls.push(["listRecents"]); return state.recent as MalformedDesktopReply<Awaited<ReturnType<RecentFiles["list"]>>>; },
      routeOpen: async (request) => { calls.push(["routeOpen", request]); return { where: "this-tab" }; },
      read: async (id) => { calls.push(["readFile", id]); return { id, name: "Recent.splitpage" } as MalformedDesktopReply<RecentFileData>; }
    },
    recentHandle: (entry) => { calls.push(["makeDesktopHandle", entry]); return { getFile: async () => new win.File(["file"], (entry as NonNullable<typeof entry>).name) }; },
    opening: { open: async (opening) => { calls.push(["openDocument", opening]); return true; } },
    transitions: { startNew: (arrival) => { calls.push(["startNew", arrival]); assert.ok("document" in arrival.from); return { document: arrival.from.document, forkedFrom: null, kept: false }; } },
    history: { keep: (...args) => { calls.push(["keepSnapshot", ...args]); return state.kept; } },
    notices: notices.notices,
    saves: { busy: () => state.busy, unsaved: () => state.unsaved },
    saving: { confirmSavedNow: () => { calls.push(["confirmSavedNow"]); } },
    preferences: { defaultWpm: () => 180, clock: () => "24" },
    panels: { close: (id) => { calls.push(["sidePanels.close", id]); } },
    resetProductionPanel: () => { calls.push(["resetProductionPanelState"]); },
    ids: { id: (prefix) => { calls.push(["makeId", prefix]); return "r-new"; } },
    prepareDocument: (raw) => { const snapshot: unknown = JSON.parse(JSON.stringify(raw)); calls.push(["migrateRows", snapshot]); return migrateRows(raw, fakeMigration().ports); },
    syncIdentity: () => { calls.push(["syncDocIdentity"]); },
    longDemo: LONG_DEMO
  };
  return { ports, state, calls, notices };
}

interface Arrival {
  readonly from: { readonly document?: unknown };
  readonly reason: string;
  readonly destination: unknown;
}

function names(calls: unknown[][]): unknown[] {
  return calls.map((call) => call[0]);
}

function shown(notices: ReturnType<typeof fakeNotices>): unknown[] {
  return notices.shown.map((notice) => ({ message: notice.message, kind: notice.kind }));
}

test("a new script keeps the owners, arguments and order of the document-creating calls", () => {
  page();
  const h = harness();
  const mounted = startFileMenu(h.ports);
  try {
    assert.equal(mounted.startNewScript(), true);
    assert.deepEqual(names(h.calls), ["makeId", "migrateRows", "keepSnapshot", "keepSnapshot", "resetProductionPanelState", "startNew", "confirmSavedNow", "syncDocIdentity", "sidePanels.close"]);
    assert.deepEqual(h.calls[0], ["makeId", "r"]);
    assert.deepEqual(h.calls[1], ["migrateRows", { title: "Untitled Script", rows: [{ id: "r-new", visualText: "", imageRef: null, audioText: "" }], wordsPerMinute: 180 }]);
    assert.deepEqual(h.calls[2], ["keepSnapshot", "Before starting a new script"]);
    const arrival = h.calls[5]?.[1] as Arrival;
    assert.ok("document" in arrival.from);
    const next = arrival.from.document as { docId: string };
    assert.deepEqual(h.calls[3], ["keepSnapshot", "Before starting a new script", { ...h.state.document, docId: next.docId }]);
    assert.notEqual(next.docId, "d-old");
    assert.equal(arrival.reason, "startNewScript: a new blank document");
    assert.equal(arrival.destination, NO_DESTINATION);
    assert.deepEqual(h.calls[8], ["sidePanels.close", "newtab-page"]);
    assert.deepEqual(shown(h.notices), [{ message: "New script — the one before is in Version history.", kind: "ok" }]);
  } finally { mounted.dispose(); }
});

test("a new script over an empty document keeps no snapshot", () => {
  page();
  const h = harness();
  h.state.document = documentOf({ title: "Empty", rows: [] });
  const mounted = startFileMenu(h.ports);
  try {
    assert.equal(mounted.startNewScript(), true);
    assert.deepEqual(names(h.calls), ["makeId", "migrateRows", "resetProductionPanelState", "startNew", "confirmSavedNow", "syncDocIdentity", "sidePanels.close"]);
    assert.deepEqual(shown(h.notices), [{ message: "New script.", kind: "ok" }]);
  } finally { mounted.dispose(); }
});

test("the long demo copies its starter state and creates the document through the same calls", () => {
  page();
  const h = harness();
  const mounted = startFileMenu(h.ports);
  try {
    assert.equal(mounted.openLongDemo(), true);
    assert.deepEqual(names(h.calls), ["migrateRows", "keepSnapshot", "keepSnapshot", "resetProductionPanelState", "startNew", "confirmSavedNow", "syncDocIdentity", "sidePanels.close"]);
    assert.deepEqual(h.calls[0], ["migrateRows", LONG_DEMO.state]);
    assert.deepEqual(h.calls[1], ["keepSnapshot", "Before opening the long demo"]);
    const arrival = h.calls[4]?.[1] as Arrival;
    assert.equal(arrival.reason, "openLongDemo: a new copy of the long demo");
    assert.equal(arrival.destination, NO_DESTINATION);
    assert.deepEqual(LONG_DEMO.state.rows, [{ id: "d1", audioText: "One" }, { id: "d2", audioText: "Two" }]);
    assert.deepEqual(shown(h.notices), [{ message: "The long demo — 2 beats, not saved anywhere yet. The script before is in Version history.", kind: "ok" }]);
  } finally { mounted.dispose(); }
});

test("while loading, neither a new script nor the demo touches the document owners", () => {
  page();
  const h = harness();
  h.state.document = null;
  const mounted = startFileMenu(h.ports);
  try {
    assert.equal(mounted.startNewScript(), false);
    assert.equal(mounted.openLongDemo(), false);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(shown(h.notices), [{ message: "Still loading…", kind: "warn" }, { message: "Still loading…", kind: "warn" }]);
  } finally { mounted.dispose(); }
});

test("refreshing reads desktop and save facts through the ports", () => {
  page();
  const h = harness();
  h.state.unsaved = true;
  h.state.home = { kind: "file", name: "Script.md", format: "md", lastModified: 1 } as ReturnType<FileMenuDropdownPorts["place"]["home"]>;
  const mounted = startFileMenu(h.ports);
  try {
    mounted.toggleFileMenu(true);
    assert.equal(mounted.fileMenuOpen(), true);
    assert.equal(win.document.getElementById("menu-recent")?.hidden, true);
    assert.equal(win.document.getElementById("fm-card-name")?.textContent, "Script.md");
    assert.equal(win.document.getElementById("fm-card-meta")?.textContent, "Unsaved changes · Markdown");
    mounted.toggleFileMenu(false);
    assert.equal(mounted.fileMenuOpen(), false);
  } finally { mounted.dispose(); }
});

test("a recent file opens through the recent-files, handle and opening ports", async () => {
  page();
  const h = harness();
  h.state.desktop = true;
  h.state.recent = [{ fileId: "f1", name: "Recent.splitpage", title: "Recent" }];
  const mounted = startFileMenu(h.ports);
  try {
    mounted.toggleFileMenu(true);
    h.calls.length = 0;
    mounted.toggleSubmenu("recent", true);
    await settled();
    const item = win.document.querySelector('[data-recent-id="f1"]');
    assert.ok(item);
    item.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await settled();
    assert.deepEqual(names(h.calls), ["listRecents", "routeOpen", "readFile", "makeDesktopHandle", "openDocument"]);
    assert.deepEqual(h.calls[1], ["routeOpen", { kind: "file", fileId: "f1" }]);
    const opened = h.calls[4]?.[1] as { kind: string; file: File; handle: unknown };
    assert.equal(opened.kind, "file");
    assert.equal(opened.file.name, "Recent.splitpage");
    assert.ok(opened.handle);
    assert.equal(mounted.fileMenuOpen(), false);
  } finally { mounted.dispose(); }
});

test("a recent file whose read finishes after disposal is not opened", async () => {
  page();
  const h = harness();
  h.state.desktop = true;
  h.state.recent = [{ fileId: "f1", name: "Recent.splitpage", title: "Recent" }];
  let release: () => void = () => {};
  const read = new Promise<void>((done) => { release = done; });
  const mounted = startFileMenu({ ...h.ports, recentHandle: (entry: { readonly name: string } | undefined) => ({ getFile: async () => { await read; return new win.File(["file"], (entry as NonNullable<typeof entry>).name); } }) });
  mounted.toggleFileMenu(true);
  mounted.toggleSubmenu("recent", true);
  await settled();
  win.document.querySelector('[data-recent-id="f1"]')?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  await settled();
  mounted.dispose();
  release();
  await settled();
  assert.equal(h.calls.some((call) => call[0] === "openDocument"), false);
});

test("a recent file deleted since it was listed says so and opens nothing", async () => {
  page();
  const h = harness();
  h.state.desktop = true;
  h.state.recent = [{ fileId: "f1", name: "Recent.splitpage", title: "Recent" }];
  const mounted = startFileMenu({ ...h.ports, recentHandle: () => ({ getFile: () => Promise.reject(new Error("ENOENT")) }) });
  const failures: unknown[] = [];
  const onFailure = (reason: unknown): void => { failures.push(reason); };
  process.on("unhandledRejection", onFailure);
  try {
    mounted.toggleFileMenu(true);
    mounted.toggleSubmenu("recent", true);
    await settled();
    win.document.querySelector('[data-recent-id="f1"]')?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await settled();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onFailure);
    mounted.dispose();
  }
  assert.deepEqual(failures, []);
  assert.equal(h.calls.some((call) => call[0] === "openDocument"), false);
  assert.deepEqual(h.notices.shown.map((n) => [n.message, n.kind]), [["That file isn't there any more — it may have been moved or deleted.", "warn"]]);
});

test("disposal removes the menu's listeners and test probe and stops the controls", () => {
  page();
  const h = harness();
  const mounted = startFileMenu(h.ports);
  mounted.dispose();
  mounted.dispose();
  assert.equal((win as unknown as { __fileMenuTest?: unknown }).__fileMenuTest, undefined);
  win.document.getElementById("btn-file")?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(win.document.getElementById("file-menu")?.hidden, true);
  assert.equal(mounted.startNewScript(), false);
  assert.equal(mounted.openLongDemo(), false);
  mounted.toggleFileMenu(true);
  assert.equal(mounted.fileMenuOpen(), false);
  assert.deepEqual(h.calls, []);
  const next = startFileMenu(h.ports);
  try {
    win.document.getElementById("btn-file")?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.equal(next.fileMenuOpen(), true);
  } finally { next.dispose(); }
});

test("the file menu's actions refuse while it is unmounted and reach the mounted menu", async () => {
  page();
  const h = harness();
  let owner: FileMenuDropdownMount | null = null;
  const ran: string[] = [];
  const screen = fakeScreen();
  const registry = createActionRegistry();
  const stop = registerAll(registry, fileMenuActions(() => owner as FileMenuControls | null, {
    createBundle: async () => { ran.push("create-bundle"); },
    canCreateBundle: () => false,
    screen: screen.screen,
    desktop: () => false,
    saves: { busy: () => false },
    save: async (options) => { ran.push(options?.saveAs ? "save-as" : "save"); },
    openFile: async () => { ran.push("open"); },
    openImport: () => { ran.push("paste"); }
  }));
  try {
    assert.deepEqual(registry.list().map((definition) => definition.id), ["save", "save-as", "open", "close-file-menu", "new", "paste", "long-demo", "create-bundle"]);
    for (const id of ["save", "save-as", "open", "new", "paste", "long-demo"]) assert.equal(registry.view(id, "menu")?.enabled, false, id);
    owner = startFileMenu(h.ports);
    owner.toggleFileMenu(true);
    await registry.invoke("save", "menu");
    assert.equal(owner.fileMenuOpen(), false);
    await registry.invoke("save-as", "menu");
    await registry.invoke("open", "menu");
    await registry.invoke("paste", "menu");
    assert.deepEqual(ran, ["save", "save-as", "open", "paste"]);
    await registry.invoke("new", "menu");
    assert.equal(h.calls.filter((call) => call[0] === "startNew").length, 1);
  } finally {
    stop();
    owner?.dispose();
  }
});
