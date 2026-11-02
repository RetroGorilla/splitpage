import type { MalformedDesktopReply } from "../../../src/adapters/desktop/desktop-port.ts";
import type { DesktopDraftStore } from "../../../src/application/recovery/ports.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { createDraftStore as draftStoreFactory } from "../../../desktop/drafts.ts";
import type {
  checkFileGone as checkGone, copyKept as keptCopy, holdKeep as keepHold, runCloseCheck as closeCheck, CloseCheckIo
} from "../../../desktop/close-keep.ts";
import type { DesktopMainTab } from "../../../desktop/main-types.d.ts";
import { startDrafts } from "../../../src/application/recovery/drafts.ts";
import type { DraftsMount, DraftsPorts } from "../../../src/application/recovery/drafts-ports.ts";
import { createDraftResume } from "../../../src/application/recovery/draft-resume.ts";
type IncompleteDraftWriteFixture = { ok: boolean; code?: string };
import { NO_DESTINATION } from "../../../src/application/transitions/ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration, pngDataUrl } from "../../core/migrate-ports.ts";

interface Timer { run: () => void; ms: number; live: boolean }

function harness(start: { running?: boolean; unsaved?: boolean; hasDraft?: boolean; writes?: IncompleteDraftWriteFixture[] } = {}) {
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
  const desktop = {
    writable: () => true,
    canDiscard: () => true,
    write: (payload: unknown) => {
      written.push(payload as Record<string, unknown>);
      return Promise.resolve((answers.shift() ?? { ok: true }) as MalformedDesktopReply<Awaited<ReturnType<DesktopDraftStore["write"]>>>);
    },
    discard: (seq: number) => { discarded.push(seq); return Promise.resolve({ ok: true } as const); },
    taker: (): ReturnType<DesktopDraftStore["taker"]> => () => Promise.resolve(null),
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
    entry: { migrate: (raw) => migrateRows(raw, fakeMigration().ports), cell: () => [] },
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
    files: { handle: () => ({ getFile: () => Promise.reject(new Error("no file")) }), parse: () => Promise.resolve(null) },
    recovery: {
      draftResume: () => resume,
      desktopDrafts: () => desktop,
      captureRestore: () => ({ epoch: 0, docId: null, destination: null, destinationGeneration: 0, generation: 0 }),
      stillRestoring: () => true,
      applyStashedWork: () => { throw new Error("no stash"); }
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const stage of ["capture", "write"] as const) {
  test("dispose before the queued " + stage + " leaves no work running (#814)", async () => {
    const h = harness();
    const drafts = mount(h.ports);
    h.resume.setRestorePending(false);
    const flush = drafts.flush();
    if (stage !== "capture") await Promise.resolve();
    drafts.dispose();
    assert.deepEqual(await flush, { ok: false, code: "CANCELLED" });
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.discarded, []);
    assert.deepEqual(h.log, []);
  });
}

for (const outcome of ["persisted", "inline", "rejected"] as const) {
  test("dispose abandons a pending picture persist: " + outcome + " (#814)", async () => {
    const h = harness();
    const sha = "a".repeat(64);
    h.state.base = { rows: [{ id: "r", imageRef: { sha256: sha } }] };
    const pending = deferred<string[]>();
    const calls: string[] = [];
    const drafts = mount({ ...h.ports, pictures: {
      persist: (refs) => { assert.deepEqual(refs, [sha]); calls.push("persist"); return pending.promise; },
      inline: (json) => { calls.push("inline"); return json; }
    } });
    const flush = drafts.flush();
    await settle();
    assert.deepEqual(calls, ["persist"]);
    drafts.dispose();
    if (outcome === "rejected") pending.reject(new Error("persist failed"));
    else pending.resolve(outcome === "inline" ? [sha] : []);
    assert.deepEqual(await flush, { ok: false, code: "CANCELLED" });
    assert.deepEqual(calls, ["persist"]);
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.discarded, []);
    assert.deepEqual(h.log, []);
    assert.deepEqual(h.toasts, []);
    assert.equal(h.timers.some((t) => t.live), false);
  });
}

for (const outcome of ["landed", "obsolete", "need-base", "refused", "rejected"] as const) {
  test("dispose abandons a pending draft write and queued flush: " + outcome + " (#814)", async () => {
    const h = harness();
    const pending = deferred<Awaited<ReturnType<typeof h.desktop.write>>>();
    h.desktop.write = (payload) => { h.written.push(payload as Record<string, unknown>); return pending.promise; };
    const drafts = mount(h.ports);
    const flush = drafts.flush();
    await settle();
    assert.equal(h.written.length, 1);
    drafts.noteChange();
    const queued = drafts.flush();
    drafts.dispose();
    if (outcome === "rejected") pending.reject(new Error("write failed"));
    else {
      const reply = outcome === "need-base" ? { ok: false, code: "NEED_BASE" }
        : outcome === "refused" ? { ok: false, code: "ENOSPC" }
        : { ok: true, seq: 1, bytes: 1, obsolete: outcome === "obsolete" };
      pending.resolve(reply as Awaited<ReturnType<typeof h.desktop.write>>);
    }
    assert.deepEqual(await Promise.all([flush, queued]), [
      { ok: false, code: "CANCELLED" }, { ok: false, code: "CANCELLED" }
    ]);
    assert.equal(h.written.length, 1);
    assert.deepEqual(h.discarded, []);
    assert.deepEqual(h.log, []);
    assert.deepEqual(h.toasts, []);
    assert.equal(h.timers.some((t) => t.live), false);
  });
}

test("dispose during a keep flush cancels quit and retains the older on-disk draft (#814)", async () => {
  const { createDraftStore } = createRequire(import.meta.url)("../../../desktop/drafts.ts") as {
    createDraftStore: typeof draftStoreFactory
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-dispose-draft-"));
  const { checkFileGone, copyKept, holdKeep, runCloseCheck } = createRequire(import.meta.url)("../../../desktop/close-keep.ts") as {
    checkFileGone: typeof checkGone;
    copyKept: typeof keptCopy;
    holdKeep: typeof keepHold;
    runCloseCheck: typeof closeCheck;
  };
  const file = path.join(dir, "script.splitpage");
  const tabId = "0123456789abcdef0123456789abcdef";
  const makeStore = () => createDraftStore({ dir, fs, fsp, path, crypto, appVersion: "test" });
  const store = makeStore();
  const h = harness({ unsaved: false });
  const pending = deferred<string[]>();
  const entered = deferred<undefined>();
  let drafts: DraftsMount | null = null;
  try {
    store.init();
    const stateJson = JSON.stringify(h.state.current);
    fs.writeFileSync(file, stateJson);
    assert.equal((await store.write(tabId, {
      title: "Pilot", docId: h.state.current.docId, docIdWrittenOut: false, schema: h.state.current.schema, editSeq: 1,
      origin: { kind: "untitled", filePath: null, fileName: null, fileKind: null, importName: null,
        baseLastModified: null, baseSize: null },
      placement: { windowKey: "test", index: 0, active: true }
    }, stateJson, "null", 1)).ok, true);
    h.desktop.hasDraftToRestore = () => store.hasDraft(tabId);
    h.desktop.discard = async (seq) => {
      h.discarded.push(seq);
      await store.discardClean(tabId, seq);
      return { ok: true } as const;
    };
    drafts = mount({ ...h.ports,
      place: { ...h.ports.place, fileHome: () => ({ kind: "file", handle: { _desktopId: "f1" }, format: "splitpage" }) },
      pictures: { ...h.ports.pictures, persist: () => { entered.resolve(undefined); return pending.promise; } }
    });
    const mounted = drafts;
    assert.equal((drafts.testing["status"] as () => { onDisk: boolean })().onDisk, true);
    h.resume.setRestorePending(false);
    h.state.current = migrateRows({ ...h.state.current, title: "Newer in-memory copy" }, fakeMigration().ports);
    h.state.base = { rows: [{ id: "r", imageRef: { sha256: "a".repeat(64) } }] };
    fs.unlinkSync(file);
    const tab = { id: tabId } as DesktopMainTab;
    const tabs: CloseCheckIo["tabs"] = new Map();
    tabs.set(tabId, tab);
    const questions: string[][] = [];
    const flushResults: unknown[] = [];
    const result = await runCloseCheck({
      tabs,
      goneFileTabsOf: async () => await checkFileGone(() => fsp.stat(file), file, 1000) ? [tab] : [],
      unsavedTabsOf: (ids, gone) => ids.includes(tabId) && gone.includes(tab) ? [tab] : [],
      askAboutUnsaved: (list) => {
        if (!list.length) return "discard";
        questions.push(list.map((t) => t.id));
        return questions.length === 1 ? "discard" : "cancel";
      },
      keepDraftsOfGoneFiles: async (gone, holder) => {
        holdKeep(tab, holder);
        const flush = mounted.flush({ keep: true });
        await entered.promise;
        mounted.dispose();
        pending.resolve([]);
        const flushed = await flush;
        flushResults.push(flushed);
        return copyKept(flushed, store.hasDraft(tabId)) ? [] : gone;
      },
      report: (_verb, error) => { throw error; }
    }, () => [tabId], "Quit", () => undefined, () => true);
    assert.equal(result.answer, "cancel", "an older draft must not authorize quitting with uncaptured new content");
    assert.deepEqual(questions, [[tabId], [tabId]], "the failed-copy question still appears");
    assert.deepEqual(flushResults, [{ ok: false, code: "CANCELLED" }]);
    assert.deepEqual(h.written, []);
    assert.equal(tab.keepDraftOnClose, false);
    const nextStore = makeStore();
    assert.equal(nextStore.init().drafts.length, 1);
    const taken = await nextStore.take(tabId);
    assert.equal(taken?.stateJson, stateJson);
    assert.equal(taken?.baseJson, "null");
    const next = mount(h.ports);
    try { assert.ok(next.taker(), "the next owner still offers the retained draft"); }
    finally { next.dispose(); }
    assert.deepEqual(h.discarded, []);
    assert.deepEqual(h.restoreDone, []);
  } finally {
    drafts?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test("a leftover desktop draft with a server origin restores as an untitled script with all its content", async () => {
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
    assert.equal(outcome, "applied");
    assert.equal(h.recovered.length, 1);
    const recovery = h.recovered[0] as { from: { document: unknown }; destination: unknown; detached: boolean; baseline: unknown; writtenOut: boolean };
    assert.equal(recovery.destination, NO_DESTINATION);
    assert.deepEqual([recovery.detached, recovery.writtenOut], [false, false]);
    assert.equal(JSON.stringify(recovery.baseline), stateJson, "the draft's own base is the baseline");
    assertSameContent(recovery.from.document, stateJson);
    assert.deepEqual(h.restoreDone, ["applied"]);
    assert.deepEqual(h.discarded, [], "the desktop draft is not discarded");
    assert.equal(h.resume.restorePending(), false);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0]?.message, "Restored your unsaved script — it has never been saved, so save it somewhere.");
    assert.deepEqual([h.toasts[0]?.kind, h.toasts[0]?.sticky], ["warn", true]);
  } finally {
    drafts.dispose();
  }
});

test("in the browser no draft is offered, captured or written", async () => {
  const h = harness({ running: false });
  const drafts = mount(h.ports);
  try {
    assert.equal(drafts.taker(), null);
    drafts.noteChange();
    assert.equal(h.timers.length, 0, "a change schedules no capture");
    h.state.editSeq = 2;
    assert.deepEqual(await drafts.flush(), { ok: true });
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.discarded, []);
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

test("a document that can't be copied stops the writer until the next change, which resumes it", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  const status = drafts.testing["status"] as () => { stopped: boolean; paused: boolean };
  const real = JSON.stringify;
  try {
    JSON.stringify = function (value: unknown, ...rest: unknown[]) {
      if (value === h.state.current) throw new RangeError("test: too large");
      return (real as (...args: unknown[]) => string).call(JSON, value, ...rest);
    } as typeof JSON.stringify;
    h.state.editSeq = 21;
    assert.deepEqual(await drafts.flush(), { ok: false, code: "TOO_LARGE" });
    JSON.stringify = real;
    assert.deepEqual(h.toasts.map((t) => [t.message, t.kind, t.sticky]), [["Crash recovery is paused — this document is too large to copy", "warn", true]]);
    assert.equal(status().stopped, true);
    assert.deepEqual(await drafts.flush(), { ok: true }, "a stopped writer answers ok without writing");
    assert.equal(h.written.length, 0);

    h.state.editSeq = 22;
    drafts.noteChange();
    assert.equal(status().stopped, false);
    assert.deepEqual(h.timers.filter((t) => t.live).map((t) => t.ms), [15000, 15000], "the retry waits the slow interval");
    fireDue(h.timers);
    await settle();
    assert.equal(h.written.length, 1);
    assert.equal(h.written[0]?.["editSeq"], 22);
    assert.equal(h.toasts[0]?.dismissed, true);
    assert.equal(h.toasts[1]?.message, "Crash recovery is working again");
    assert.equal(status().paused, false);
  } finally {
    JSON.stringify = real;
    drafts.dispose();
  }
});

test("a change that still can't be copied stops the writer again without a second notice", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  const status = drafts.testing["status"] as () => { stopped: boolean };
  const real = JSON.stringify;
  try {
    JSON.stringify = function (value: unknown, ...rest: unknown[]) {
      if (value === h.state.current) throw new RangeError("test: too large");
      return (real as (...args: unknown[]) => string).call(JSON, value, ...rest);
    } as typeof JSON.stringify;
    h.state.editSeq = 31;
    await drafts.flush();
    drafts.noteChange();
    fireDue(h.timers);
    await settle();
    assert.equal(status().stopped, true);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.written.length, 0);
    JSON.stringify = real;
    drafts.noteChange();
    fireDue(h.timers);
    await settle();
    assert.equal(h.written.length, 1);
    assert.equal(h.toasts[1]?.message, "Crash recovery is working again");
  } finally {
    JSON.stringify = real;
    drafts.dispose();
  }
});

test("each start owns its own writer state, timing and counts, and an old mount's dispose leaves a newer one running", async () => {
  const first = harness();
  const old = mount(first.ports);
  (old.testing["setTiming"] as (t: Record<string, number>) => void)({ idle: 10 });
  await (old.testing["flushNow"] as () => Promise<unknown>)();
  const oldStatus = (old.testing["status"] as () => { seq: number; writes: number })();
  assert.equal(oldStatus.writes, 1);
  assert.ok(oldStatus.seq > 0);

  const second = harness();
  const drafts = mount(second.ports);
  try {
    const fresh = (drafts.testing["status"] as () => { seq: number; writes: number; failures: number; onDisk: boolean })();
    assert.deepEqual({ seq: fresh.seq, writes: fresh.writes, failures: fresh.failures, onDisk: fresh.onDisk }, { seq: 0, writes: 0, failures: 0, onDisk: false });
    old.dispose();
    assert.throws(() => old.noteChange(), /Drafts are not started/);
    drafts.noteChange();
    assert.deepEqual(second.timers.filter((t) => t.live).map((t) => t.ms).sort((a, b) => a - b), [1500, 5000]);
    fireDue(second.timers);
    await settle();
    assert.equal(second.written.length, 1);
    assert.equal(first.written.length, 1);
  } finally {
    drafts.dispose();
  }
});
