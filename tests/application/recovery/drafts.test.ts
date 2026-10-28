import { test } from "node:test";
import assert from "node:assert/strict";
import { startDrafts } from "../../../src/application/recovery/drafts.js";
import type { BrowserDrafts, DraftsMount, DraftsPorts } from "../../../src/application/recovery/drafts-ports.ts";
import { createDraftResume } from "../../../src/application/recovery/draft-resume.ts";
import type { DraftCapture, DraftWriteOutcome } from "../../../src/application/recovery/draft-writer.ts";
import type { DesktopDraftResult, StoredDraft } from "../../../src/application/recovery/ports.ts";
import { NO_DESTINATION } from "../../../src/application/transitions/ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration, pngDataUrl } from "../../core/migrate-ports.ts";

interface Timer { run: () => void; ms: number; live: boolean }

interface BrowserStart { records: StoredDraft[]; live?: string[]; write?: DraftWriteOutcome }

function fakeBrowserDrafts(browser: BrowserStart, log: string[]): BrowserDrafts {
  let tracked: string | null = null;
  const capture = (key: string): DraftCapture => ({ key, generation: 0, before: null, operation: { epoch: 0, docId: null, destination: null, destinationGeneration: 0, generation: 0 } });
  return {
    store: {
      available: () => Promise.resolve(true),
      put: () => Promise.resolve({ ok: true, evicted: 0 }),
      get: (key) => Promise.resolve(browser.records.find((r) => r.key === key) ?? null),
      list: () => Promise.resolve(browser.records.map((r) => ({ ...r }))),
      remove: () => Promise.resolve(true),
      claim: () => Promise.resolve(true)
    },
    writer: {
      writerId: () => "w".repeat(32),
      tracked: () => tracked,
      capture,
      write: (c) => { log.push("browserWrite:" + c.key); return Promise.resolve(browser.write ?? { ok: true, evicted: 0, obsolete: false }); },
      discard: () => Promise.resolve(true),
      take: (key) => { tracked = key; log.push("take:" + key); return Promise.resolve(true); }
    }
  };
}

function harness(start: { running?: boolean; unsaved?: boolean; hasDraft?: boolean; writes?: DesktopDraftResult[]; browser?: BrowserStart } = {}) {
  const timers: Timer[] = [];
  const log: string[] = [];
  const written: Record<string, unknown>[] = [];
  const discarded: number[] = [];
  const toasts: { message: string; kind: string | undefined; sticky: boolean | undefined; dismissed: boolean }[] = [];
  const recovered: unknown[] = [];
  const restoreDone: string[] = [];
  const answers = [...(start.writes ?? [])];
  const resume = createDraftResume();
  const doc = migrateRows({ title: "Pilot", docId: "d0123456789abcdef0123456789abcdef", rows: [] }, fakeMigration().ports);
  const state = { unsaved: start.unsaved ?? true, editSeq: 1, now: 1000, base: null as unknown, current: doc };
  const browser = start.browser ? fakeBrowserDrafts(start.browser, log) : null;
  const desktop = {
    writable: () => true,
    canDiscard: () => true,
    write: (payload: unknown) => {
      written.push(payload as Record<string, unknown>);
      return Promise.resolve(answers.shift() ?? { ok: true });
    },
    discard: (seq: number) => { discarded.push(seq); return Promise.resolve({ ok: true }); },
    taker: (): (() => Promise<unknown>) | null => () => Promise.resolve(null),
    restoreDone: (outcome: string) => { restoreDone.push(outcome); },
    hasDraftToRestore: () => start.hasDraft ?? false
  };
  const ports: DraftsPorts = {
    running: () => start.running ?? true,
    clock: { now: () => state.now },
    timers: {
      set: (run, ms) => { const t = { run, ms, live: true }; timers.push(t); return t; },
      clear: (handle) => { (handle as Timer).live = false; }
    },
    report: (error) => { log.push("report:" + String(error)); },
    document: { current: () => state.current },
    session: { mergeBase: () => state.base, noteAbsorbedDirty: (reason) => { log.push("absorbed:" + reason); } },
    place: {
      home: () => ({ kind: "none" }),
      fileHome: () => null,
      importHome: () => null,
      writtenOut: () => false
    },
    markWrittenOut: (on) => { log.push("writtenOut:" + on); },
    saves: { unsaved: () => state.unsaved, editSeq: () => state.editSeq },
    notices: {
      show: (message, kind, sticky) => {
        const toast = { message, kind, sticky, dismissed: false };
        toasts.push(toast);
        return { isConnected: true, dismiss: () => { toast.dismissed = true; }, addEventListener: () => {}, removeEventListener: () => {} };
      }
    },
    entry: { migrate: (raw) => migrateRows(raw, fakeMigration().ports) },
    identity: { copyHistory: (fromId, toId) => { log.push("copy:" + fromId + ">" + toId); }, sync: () => { log.push("sync"); } },
    transitions: {
      recover: (recovery) => {
        recovered.push(recovery);
        log.push("recover");
        assert.ok("document" in recovery.from);
        state.current = recovery.from.document;
        return { document: state.current, forkedFrom: null, kept: false };
      },
      restore: () => ({ document: doc, forkedFrom: null, kept: false })
    },
    documents: { open: () => Promise.resolve(true) },
    resetProductionPanel: () => { log.push("resetPanel"); },
    pictures: { persist: () => Promise.resolve([]), inline: (json) => json },
    files: { handle: () => ({ getFile: () => Promise.resolve(null) }), parse: () => Promise.resolve(null) },
    recovery: {
      started: () => true,
      draftResume: () => resume,
      browserDrafts: () => { if (!browser) throw new Error("no browser drafts on the desktop"); return browser; },
      desktopDrafts: () => desktop,
      captureRestore: () => ({ epoch: 0, docId: null, destination: null, destinationGeneration: 0, generation: 0 }),
      stillRestoring: () => true,
      applyStashedWork: () => { throw new Error("no stash"); },
      useBrowserDraftFactory: () => { throw new Error("no browser drafts on the desktop"); }
    },
    browserDraft: { key: (base, docId) => base + "#" + docId, base: (serverUrl) => String(serverUrl ?? "") },
    lock: {
      writerId: () => "w".repeat(32),
      hold: () => { log.push("hold"); },
      release: () => { log.push("release"); },
      isLive: (writerId) => Promise.resolve((start.browser?.live ?? []).includes(writerId))
    },
    documentState: { notify: () => { log.push("notify"); } }
  };
  return { ports, timers, log, written, discarded, toasts, recovered, restoreDone, resume, state, desktop };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function fireDue(timers: Timer[]) {
  const due = timers.filter((t) => t.live);
  for (const t of due) { t.live = false; t.run(); }
}

function mount(ports: DraftsPorts): DraftsMount {
  return startDrafts(ports) as DraftsMount;
}

test("mounting reads the desktop's pending draft into the resume flag and the on-disk flag", () => {
  const h = harness({ hasDraft: true });
  const drafts = mount(h.ports);
  try {
    assert.equal(h.resume.restorePending(), true);
    const status = (drafts.testing["status"] as () => { onDisk: boolean })();
    assert.equal(status.onDisk, true);
  } finally {
    drafts.dispose();
  }
});

test("a change is captured after the idle wait and written as the same desktop draft payload", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    drafts.noteChange();
    assert.deepEqual(h.timers.filter((t) => t.live).map((t) => t.ms).sort((a, b) => a - b), [1500, 5000]);
    const idle = h.timers.find((t) => t.live && t.ms === 1500);
    assert.ok(idle);
    idle.live = false;
    idle.run();
    await settle();
    assert.equal(h.timers.some((t) => t.live), false, "the idle capture cancels the maximum wait");
    assert.equal(h.written.length, 1);
    const sent = h.written[0] ?? {};
    assert.equal(sent["editSeq"], 1);
    assert.equal(sent["title"], "Pilot");
    assert.equal(sent["docId"], "d0123456789abcdef0123456789abcdef");
    assert.equal(sent["originKind"], "untitled");
    assert.equal(sent["baseJson"], "null", "the first write carries its base");
    assert.equal(typeof sent["stateJson"], "string");
    assert.equal(typeof sent["seq"], "number");
  } finally {
    drafts.dispose();
  }
});

test("NEED_BASE is retried once with the base and a new sequence number", async () => {
  const h = harness({ writes: [{ ok: false, code: "NEED_BASE" }, { ok: true }] });
  const drafts = mount(h.ports);
  try {
    h.state.editSeq = 7;
    await drafts.flush();
    assert.equal(h.written.length, 2);
    const [first, retry] = h.written;
    assert.equal(Number(retry?.["seq"]), Number(first?.["seq"]) + 1);
    assert.equal(retry?.["baseJson"], "null");
    assert.equal(retry?.["editSeq"], 7);
  } finally {
    drafts.dispose();
  }
});

test("a refused write pauses crash recovery with one sticky notice, and the next landed write says it works again", async () => {
  const h = harness({ writes: [{ ok: false, code: "ENOSPC" }, { ok: true }] });
  const drafts = mount(h.ports);
  try {
    h.state.editSeq = 11;
    await drafts.flush();
    assert.deepEqual(h.toasts.map((t) => [t.message, t.kind, t.sticky]), [["Crash recovery is paused — this disk is full", "warn", true]]);
    const retry = h.timers.filter((t) => t.live);
    assert.equal(retry.length, 1, "a backoff retry is armed");
    fireDue(h.timers);
    await settle();
    assert.equal(h.toasts[0]?.dismissed, true);
    assert.equal(h.toasts[1]?.message, "Crash recovery is working again");
  } finally {
    drafts.dispose();
  }
});

test("with nothing unsaved, a draft on disk is discarded instead of written", async () => {
  const h = harness({ hasDraft: true, unsaved: false });
  const drafts = mount(h.ports);
  try {
    await drafts.flush();
    assert.equal(h.discarded.length, 0, "nothing is discarded while the last session's draft waits to be restored");
    h.resume.setRestorePending(false);
    await drafts.flush();
    assert.equal(h.written.length, 0);
    assert.equal(h.discarded.length, 1);
  } finally {
    drafts.dispose();
  }
});

test("an untitled draft is adopted through recover, reported to the desktop, and the document state is sent", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    h.resume.setRestorePending(true);
    const outcome = await drafts.applyTaken({
      header: { origin: { kind: "untitled" }, docIdWrittenOut: true },
      stateJson: JSON.stringify({ title: "Recovered", rows: [] }),
      baseJson: null
    });
    assert.equal(outcome, "applied");
    assert.equal(h.recovered.length, 1);
    const recovery = h.recovered[0] as { detached: boolean; writtenOut: boolean; baseline: unknown };
    assert.deepEqual([recovery.detached, recovery.writtenOut, recovery.baseline], [false, true, null]);
    assert.equal(h.resume.restorePending(), false);
    assert.deepEqual(h.restoreDone, ["applied"]);
    assert.deepEqual(h.log.filter((entry) => ["resetPanel", "recover", "sync", "absorbed:recovery", "notify"].includes(entry)), ["resetPanel", "recover", "sync", "absorbed:recovery", "notify"]);
  } finally {
    drafts.dispose();
  }
});

test("an unreadable draft fails, keeps the draft, and still clears the resume flag", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    h.resume.setRestorePending(true);
    assert.equal(await drafts.applyTaken({ corrupt: true }), "failed");
    assert.match(h.toasts[0]?.message ?? "", /couldn't be read/);
    assert.equal(h.resume.restorePending(), false);
    assert.deepEqual(h.restoreDone, ["failed"]);
  } finally {
    drafts.dispose();
  }
});

test("on the desktop the taker is the desktop store's own, offered only while a restore is pending", () => {
  const h = harness();
  const take = () => Promise.resolve(null);
  h.desktop.taker = () => take;
  const drafts = mount(h.ports);
  try {
    assert.equal(drafts.taker(), null);
    h.resume.setRestorePending(true);
    assert.equal(drafts.taker(), take);
    h.desktop.taker = () => null;
    assert.equal(drafts.taker(), null, "no desktop taker means nothing is offered");
  } finally {
    drafts.dispose();
  }
});

const SERVER_BASE = "https://splitpage.example";
const SERVER_DOC_ID = "d" + "5".repeat(32);
const IMAGE_SHA = "d7fe3e6dffdff124cd40c7e45c12adaae82415b7e2dcdaf60905212044782e9f";

function serverDocumentJson(title: string): string {
  return JSON.stringify(migrateRows({
    title: title,
    docId: SERVER_DOC_ID,
    rows: [
      { id: "r1", visualText: "Wide shot", imageRef: { sha256: IMAGE_SHA, width: 4, height: 3, mime: "image/png" }, audioText: "Hello there" },
      { id: "r2", visualText: "Close up", audioText: "And goodbye" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", body: 'Note <img src="' + pngDataUrl(4, 3, 7) + '">', createdAt: "2026-01-01T00:00:00.000Z" }],
    productionTags: [{ cat: "location", name: "Studio" }]
  }, fakeMigration().ports));
}

function storedServerDraft(key: string, writerId: string, writtenAt: number, stateJson: string): StoredDraft {
  return {
    key, base: SERVER_BASE, docId: SERVER_DOC_ID, rev: 4, title: "Pilot", writtenAt, writerId, generation: 1,
    editSeq: 3, schema: 2, docIdWrittenOut: false, bytes: stateJson.length, stateJson, baseJson: null
  };
}

function assertSameContent(recovered: unknown, stateJson: string) {
  const saved = JSON.parse(stateJson) as Record<string, unknown>;
  const doc = recovered as Record<string, unknown>;
  assert.deepEqual(doc["rows"], saved["rows"]);
  assert.deepEqual(doc["comments"], saved["comments"]);
  assert.deepEqual(doc["productionTags"], saved["productionTags"]);
  assert.equal(JSON.stringify(recovered), stateJson, "nothing in the draft is dropped or changed");
  assert.deepEqual((doc["rows"] as { imageRef: unknown }[])[0]?.imageRef, { sha256: IMAGE_SHA, width: 4, height: 3, mime: "image/png" });
  assert.match(String((doc["comments"] as { body: unknown }[])[0]?.body), new RegExp('data-blob="' + IMAGE_SHA + '"'));
}

test("a desktop draft of a former server document restores as an unsaved local copy with all its content", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    const stateJson = serverDocumentJson("Pilot");
    h.resume.setRestorePending(true);
    const outcome = await drafts.applyTaken({
      header: { origin: { kind: "server", server: { base: SERVER_BASE, docId: SERVER_DOC_ID, rev: 4 } }, writtenAt: 900, title: "Pilot" },
      stateJson,
      baseJson: stateJson
    });
    assert.equal(outcome, "untitled-copy");
    assert.equal(h.recovered.length, 1);
    const recovery = h.recovered[0] as { from: { document: unknown }; destination: unknown; detached: boolean; baseline: unknown; writtenOut: boolean };
    assert.equal(recovery.destination, NO_DESTINATION);
    assert.deepEqual([recovery.detached, recovery.baseline, recovery.writtenOut], [true, null, false]);
    assertSameContent(recovery.from.document, stateJson);
    assert.deepEqual(h.restoreDone, ["untitled-copy"]);
    assert.deepEqual(h.discarded, [], "the desktop draft is not discarded");
    assert.equal(h.resume.restorePending(), false);
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0]?.message ?? "", /unsaved copy/);
    assert.deepEqual([h.toasts[0]?.kind, h.toasts[0]?.sticky], ["warn", true]);
  } finally {
    drafts.dispose();
  }
});

test("a leftover browser draft of a former server document is offered newest non-live first and restored as an unsaved copy it keeps protecting", async () => {
  const stateJson = serverDocumentJson("Pilot");
  const key = SERVER_BASE + "#" + SERVER_DOC_ID;
  const h = harness({
    running: false,
    unsaved: false,
    browser: {
      records: [
        storedServerDraft("old", "a".repeat(32), 500, serverDocumentJson("Older")),
        storedServerDraft("busy", "b".repeat(32), 900, serverDocumentJson("Open elsewhere")),
        storedServerDraft(key, "c".repeat(32), 800, stateJson)
      ],
      live: ["b".repeat(32)]
    }
  });
  const drafts = mount(h.ports);
  try {
    const take = drafts.taker();
    assert.equal(typeof take, "function");
    const taken = await take?.() as { browserKey: string; header: { origin: unknown } };
    assert.equal(taken.browserKey, key);
    assert.deepEqual(taken.header.origin, { kind: "server", server: { base: SERVER_BASE, docId: SERVER_DOC_ID, rev: 4 } });
    const outcome = await drafts.applyTaken(taken);
    assert.equal(outcome, "untitled-copy");
    assert.equal(h.recovered.length, 1);
    const recovery = h.recovered[0] as { from: { document: unknown }; destination: unknown };
    assert.equal(recovery.destination, NO_DESTINATION);
    assertSameContent(recovery.from.document, stateJson);
    assert.ok(h.log.includes("take:" + key), "the draft is taken over by this tab");
    const status = (drafts.testing["browser"] as { status: () => unknown }).status();
    assert.deepEqual(status, { off: false, keyOnDisk: key, copy: true, target: { docId: SERVER_DOC_ID, copy: true } });
    h.state.unsaved = true;
    h.state.editSeq = 2;
    await drafts.flush();
    assert.ok(h.log.includes("browserWrite:" + key), "later changes keep landing in the same draft until saved");
  } finally {
    drafts.dispose();
  }
});

test("a leftover browser draft is kept, not restored, when the page already has unsaved changes", async () => {
  const stateJson = serverDocumentJson("Pilot");
  const key = SERVER_BASE + "#" + SERVER_DOC_ID;
  const h = harness({ running: false, unsaved: true, browser: { records: [storedServerDraft(key, "c".repeat(32), 800, stateJson)] } });
  const drafts = mount(h.ports);
  try {
    const before = h.state.current;
    const taken = await drafts.taker()?.();
    assert.equal(await drafts.applyTaken(taken), "kept");
    assert.equal(h.recovered.length, 0);
    assert.equal(h.state.current, before, "the open document is not replaced");
    assert.equal(h.log.some((entry) => entry.startsWith("take:")), false, "the draft is left for later");
    assert.equal(h.toasts.length, 0);
  } finally {
    drafts.dispose();
  }
});

test("in the browser no taker is offered once browser drafts are off", async () => {
  const stateJson = serverDocumentJson("Pilot");
  const key = SERVER_BASE + "#" + SERVER_DOC_ID;
  const h = harness({
    running: false,
    unsaved: false,
    browser: { records: [storedServerDraft(key, "c".repeat(32), 800, stateJson)], write: { ok: false, code: "UNAVAILABLE" } }
  });
  const drafts = mount(h.ports);
  try {
    assert.equal(await drafts.applyTaken(await drafts.taker()?.()), "untitled-copy");
    assert.equal(typeof drafts.taker(), "function");
    h.state.unsaved = true;
    h.state.editSeq = 9;
    await drafts.flush();
    assert.ok(h.log.includes("browserWrite:" + key));
    assert.equal(drafts.taker(), null);
  } finally {
    drafts.dispose();
  }
});

test("dispose cancels the pending capture timers", () => {
  const h = harness();
  const drafts = mount(h.ports);
  drafts.noteChange();
  assert.ok(h.timers.some((t) => t.live));
  drafts.dispose();
  assert.equal(h.timers.some((t) => t.live), false);
});
