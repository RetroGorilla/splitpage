import type { MalformedDesktopReply } from "../../../src/adapters/desktop/desktop-port.ts";
import type { RecentFileData } from "../../../src/application/files/recent-files.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startNewTab } from "../../../src/features/newtab/newtab.ts";
import type { NewTabPorts } from "../../../src/features/newtab/ports.ts";
import { NO_DESTINATION } from "../../../src/application/transitions/ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeActions, fakeNotices } from "../fakes.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function page() {
  win.document.body.innerHTML = '<div id="newtab-page" hidden><div id="newtab-cards">' +
    ['new', 'paste', 'open', 'gdoc', 'dismiss'].map((action) => '<button data-newtab-action="' + action + '">' + action + '</button>').join('') +
    '</div><div id="newtab-drop"></div><div class="newtab-main"></div><div id="newtab-recents"><div id="newtab-recents-list"></div>' +
    '<button id="newtab-recents-clear" data-newtab-action="clear-recents"></button></div><div id="newtab-continue">' +
    '<button id="newtab-continue-btn"><span id="newtab-continue-title"></span><span id="newtab-continue-when"></span></button></div></div>';
}

function click(action: string) {
  const button = win.document.querySelector('[data-newtab-action="' + action + '"]');
  assert.ok(button);
  button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function settled() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function harness() {
  const calls: unknown[][] = [];
  const arrivals: Parameters<NewTabPorts["transitions"]["startNew"]>[0][] = [];
  const state = { home: { kind: "none" } as ReturnType<NewTabPorts["place"]["home"]>, desktop: false, seed: true, pending: false, draft: false, intent: { type: "blank" }, last: null as unknown };
  const actions = fakeActions();
  const notices = fakeNotices();
  let pasted: Parameters<NewTabPorts["importText"]>[0] | null = null;
  const starter = { id: "sample", name: "Sample", desc: "A starter", state: { title: "Starter", rows: [{ id: "s", audioText: "Hello" }] } };
  const ports: NewTabPorts = {
    document: { current: () => null },
    place: { home: () => state.home },
    desktop: () => state.desktop,
    recents: { available: () => true, canRemove: () => true, canClear: () => true, list: async () => [], remove: async () => [], clear: async () => [], read: async (id) => ({ id, name: "Recent.splitpage" } as MalformedDesktopReply<RecentFileData>), routeOpen: async () => ({ where: "this-tab" }) },
    launch: { launchIntent: () => state.intent, hasDraftToRestore: () => state.draft },
    lastFile: { load: async () => state.last },
    seedCheck: { passes: () => state.seed },
    draftResume: { restorePending: () => state.pending },
    startup: { ready: () => null },
    transitions: { startNew: (arrival) => { arrivals.push(arrival); calls.push(["startNew", arrival]); assert.ok("document" in arrival.from); return { document: arrival.from.document, forkedFrom: null, kept: false }; } },
    opening: { open: async (opening) => { calls.push(["openDocument", opening]); return true; } },
    text: { productionReaders: { wordCount: () => 1 } },
    notices: notices.notices,
    actions: actions.actions,
    preferences: { defaultWpm: () => 180 },
    saving: { confirmSavedNow: () => { calls.push(["confirmSavedNow"]); } },
    resetProductionPanel: () => { calls.push(["resetProductionPanelState"]); },
    ids: { id: (prefix) => { calls.push(["makeId", prefix]); return "r-new"; } },
    prepareDocument: (raw) => { const snapshot: unknown = JSON.parse(JSON.stringify(raw)); calls.push(["migrateRows", snapshot]); return migrateRows(raw, fakeMigration().ports); },
    syncIdentity: () => { calls.push(["syncDocIdentity"]); },
    importText: (options) => { pasted = options; },
    openFile: async () => { calls.push(["openLocalFile"]); },
    desktopDownload: { offered: () => false, url: () => "https://example.test" },
    starters: [starter], findStarter: (id) => id === "sample" ? starter : null,
    recentHandle: (entry) => { calls.push(["makeDesktopHandle", entry]); return { getFile: async () => new win.File(["file"], entry.name) }; }
  };
  return { ports, state, calls, arrivals, actions, notices, starter, pasted: () => pasted };
}

test("blank and starter creation keep preparation, reset, transition, confirmation and identity call order", async () => {
  for (const kind of ["none", "file", "import"] as const) {
    page();
    const h = harness();
    h.state.home = { kind };
    const mounted = startNewTab(h.ports);
    try {
      await settled();
      click("new");
      assert.deepEqual(h.calls.map((call) => call[0]), ["makeId", "migrateRows", "resetProductionPanelState", "startNew", "confirmSavedNow", "syncDocIdentity"]);
      assert.deepEqual(h.calls[0], ["makeId", "r"]);
      assert.deepEqual(h.calls[1], ["migrateRows", { title: "Untitled Script", rows: [{ id: "r-new", visualText: "", imageRef: null, audioText: "" }], wordsPerMinute: 180 }]);
      const transition = h.arrivals[0];
      assert.ok(transition);
      assert.equal(transition.reason, "startBlankScript: a new blank document");
      assert.equal(transition.destination, kind === "none" ? undefined : NO_DESTINATION);
      h.calls.length = 0;
      click("starter");
      assert.deepEqual(h.calls.map((call) => call[0]), ["migrateRows", "resetProductionPanelState", "startNew", "confirmSavedNow", "syncDocIdentity"]);
      assert.deepEqual(h.calls[0]?.[1], h.starter.state);
      assert.notEqual(h.calls[0]?.[1], h.starter.state);
      assert.equal(h.arrivals[1]?.reason, "startStarterScript: a new document from the sample starter");
    } finally { mounted.dispose(); }
  }
});

test("paste scans its migrated document before adoption and dropped files keep their source arguments", async () => {
  page();
  const h = harness();
  const mounted = startNewTab(h.ports);
  try {
    await settled();
    click("paste");
    const paste = h.pasted();
    assert.ok(paste);
    const rows = [{ id: "p", audioText: "Pasted" }];
    paste.intoNewDocument(rows, (doc) => { h.calls.push(["scan", doc]); });
    assert.deepEqual(h.calls.map((call) => call[0]), ["migrateRows", "scan", "resetProductionPanelState", "startNew", "confirmSavedNow", "syncDocIdentity"]);
    assert.deepEqual(h.calls[0], ["migrateRows", { schema: 2, title: "Untitled Script", rows: [{ id: "p", audioText: "Pasted" }] }]);
    const file = new win.File(["Document"], "Doc.txt");
    const drop = new win.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    win.document.getElementById("newtab-page")?.dispatchEvent(drop);
    assert.deepEqual(h.calls.at(-1), ["openDocument", { kind: "file", file, handle: null }]);
  } finally { mounted.dispose(); }
});

test("auto-show observes location, seed, last file, desktop launch and draft facts", async () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void, boolean][] = [
    ["blank", () => {}, false], ["seed", (h) => { h.state.seed = false; }, true],
    ["file", (h) => { h.state.home = { kind: "file" }; }, true],
    ["last file", (h) => { h.state.last = {}; }, true], ["desktop", (h) => { h.state.desktop = true; }, false],
    ["pending restore", (h) => { h.state.desktop = true; h.state.pending = true; }, true],
    ["draft", (h) => { h.state.desktop = true; h.state.draft = true; }, true],
    ["file launch", (h) => { h.state.desktop = true; h.state.intent.type = "file"; }, true]
  ];
  for (const [name, configure, hidden] of cases) {
    page();
    const h = harness();
    configure(h);
    const mounted = startNewTab(h.ports);
    try { await settled(); assert.equal(win.document.getElementById("newtab-page")?.hidden, hidden, name); }
    finally { mounted.dispose(); }
  }
});

test("disposal removes handlers, closes the page and permits remounting without duplicate actions", async () => {
  page();
  const h = harness();
  const first = startNewTab(h.ports);
  await settled();
  first.dispose();
  first.dispose();
  click("new");
  assert.deepEqual(h.calls, []);
  assert.equal(win.document.getElementById("newtab-page")?.hidden, true);
  const next = startNewTab(h.ports);
  try {
    await settled();
    first.dispose();
    click("gdoc");
    assert.deepEqual(h.actions.calls, [{ id: "show-gdoc-import", source: "button" }]);
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(win.document.getElementById("newtab-page")?.hidden, true);
  } finally { next.dispose(); }
});

test("disposed startup and last-file reads cannot create or reopen a replacement mount", async () => {
  page();
  const h = harness();
  let resolveReady: (value?: unknown) => void = () => {};
  let resolveLast: (value: unknown) => void = () => {};
  const ready = new Promise<unknown>((done) => { resolveReady = done; });
  const last = new Promise<unknown>((done) => { resolveLast = done; });
  const first = startNewTab({ ...h.ports, startup: { ready: () => ready }, lastFile: { load: () => last } });
  click("paste");
  const paste = h.pasted();
  assert.ok(paste);
  const probe = (win as unknown as { __newTab: { open: () => void; blankState: () => unknown; starterState: (id: string) => unknown; refreshRecents: () => Promise<void> } }).__newTab;
  click("new");
  first.dispose();
  const replacement = harness();
  replacement.state.seed = false;
  const next = startNewTab(replacement.ports);
  try {
    resolveReady();
    resolveLast(null);
    paste.intoNewDocument([], () => { throw new Error("a stale import must not scan"); });
    probe.open();
    assert.equal(probe.blankState(), null);
    assert.equal(probe.starterState("sample"), null);
    await probe.refreshRecents();
    await settled();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(replacement.calls, []);
    assert.equal(win.document.getElementById("newtab-page")?.hidden, true);
  } finally { next.dispose(); }
});
