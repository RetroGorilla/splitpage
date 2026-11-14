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
import { inspect } from "node:util";
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
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration, pngDataUrl } from "../../core/migrate-ports.ts";

interface Timer { run: () => void; ms: number; live: boolean }

const COMMON = { edit: () => ({ allowed: true }) as const, comment: () => ({ allowed: true }) as const };
const MODES = { standalone: createSessionCapabilities("standalone", COMMON), shared: createSessionCapabilities("shared", COMMON) };

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
  const state = { unsaved: start.unsaved ?? true, editSeq: 1, now: 1000, base: null as unknown, current: doc, mode: "standalone" as keyof typeof MODES };
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
    capability: { drafts: () => MODES[state.mode].drafts() },
    running: () => start.running ?? true,
    clock: { now: () => state.now },
    timers: {
      set: (run, ms) => { const t = { run, ms, live: true }; timers.push(t); return t; },
      clear: (handle) => { (handle as Timer).live = false; }
    },
    report: (error) => { log.push("report:" + String(error)); },
    document: { current: () => state.current },
    session: { mergeBase: () => state.base, noteAbsorbedDirty: (reason) => { log.push("absorbed:" + reason); state.editSeq++; } },
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

test("on the desktop the taker takes through the desktop store's own, offered only while a restore is pending", async () => {
  const h = harness();
  let taken = 0;
  const take = () => { taken++; return Promise.resolve(null); };
  h.desktop.taker = () => take;
  const drafts = mount(h.ports);
  try {
    assert.equal(drafts.taker(), null);
    h.resume.setRestorePending(true);
    const offered = drafts.taker();
    assert.ok(offered);
    assert.equal(await offered(), null);
    assert.equal(taken, 1);
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
    assert.deepEqual(await drafts.flush(), { ok: false, code: "TOO_LARGE" }, "a stopped writer writes nothing and answers that nothing was kept");
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

for (const answer of ["merged", "refused"] as const) {
  test("a file draft whose merge is " + answer + (answer === "refused" ? " for a reason stays kept for the next launch" : " reports merged and marks the written-out state"), async () => {
    const h = harness();
    const docId = "d0123456789abcdef0123456789abcdef";
    const version = (title: string) => migrateRows({ title, docId, rows: [] }, fakeMigration().ports);
    const disk = version("Disk");
    const asked: unknown[] = [];
    const ports: DraftsPorts = {
      ...h.ports,
      files: {
        handle: () => ({ getFile: () => Promise.resolve({ name: "pilot.splitpage", lastModified: 4 }) }),
        parse: () => Promise.resolve({ state: disk, kind: "splitpage", docIdEmbedded: true })
      },
      recovery: {
        ...h.ports.recovery,
        applyStashedWork: (state, _override, options) => {
          asked.push(options?.recovery);
          return Promise.resolve(answer === "refused"
            ? { state, report: null, snapshot: null, reason: "Local merge is not available in a shared session." }
            : { state, report: null, snapshot: null });
        }
      }
    };
    const drafts = mount(ports);
    try {
      const outcome = await drafts.applyTaken({
        header: { origin: { kind: "file" }, docIdWrittenOut: true },
        file: { id: "f1", name: "pilot.splitpage" },
        stateJson: JSON.stringify(version("Mine")),
        baseJson: JSON.stringify(version("Base"))
      });
      assert.deepEqual(asked, [true]);
      assert.equal(outcome, answer === "refused" ? "kept" : "merged");
      assert.deepEqual(h.log.filter(entry => entry.startsWith("writtenOut:")), answer === "refused" ? [] : ["writtenOut:true"]);
      assert.deepEqual(h.toasts.map(toast => /kept for the next launch/.test(toast.message)), answer === "refused" ? [true] : []);
      assert.deepEqual(h.restoreDone, [outcome]);
    } finally {
      drafts.dispose();
    }
  });
}

test("a shared session schedules, writes and discards no draft, leaves the last session's draft on disk, and answers every flush that nothing was kept", async () => {
  const h = harness({ hasDraft: true });
  const drafts = mount(h.ports);
  try {
    h.resume.setRestorePending(false);
    h.state.mode = "shared";
    drafts.noteChange();
    assert.equal(h.timers.length, 0);
    h.state.editSeq = 2;
    assert.deepEqual(await drafts.flush(), { ok: false, code: "DETACHED" });
    h.state.unsaved = false;
    assert.deepEqual(await drafts.flush({ keep: true }), { ok: false, code: "DETACHED" });
    assert.deepEqual(await drafts.flush(), { ok: false, code: "DETACHED" });
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.discarded, []);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(h.log, []);
  } finally {
    drafts.dispose();
  }
});

test("a shared session takes no draft, and a draft already taken is kept for the next launch without being read", async () => {
  const h = harness({ hasDraft: true });
  h.desktop.taker = () => () => Promise.resolve(null);
  const handled: unknown[] = [];
  const drafts = mount({
    ...h.ports,
    files: { handle: (entry) => { handled.push(entry); return { getFile: () => Promise.reject(new Error("read")) }; }, parse: () => Promise.reject(new Error("parse")) }
  });
  try {
    assert.equal(typeof drafts.taker(), "function");
    h.state.mode = "shared";
    assert.equal(drafts.taker(), null);
    const outcome = await drafts.applyTaken({
      header: { origin: { kind: "file" }, docIdWrittenOut: true },
      file: { id: "f1", name: "pilot.splitpage" },
      stateJson: JSON.stringify({ title: "Recovered", rows: [] }),
      baseJson: null
    });
    assert.equal(outcome, "kept");
    assert.deepEqual(handled, []);
    assert.deepEqual(h.recovered, []);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(h.restoreDone, ["kept"]);
    assert.equal(h.resume.restorePending(), false);
    assert.deepEqual(h.log, ["notify"]);
    assert.equal(h.state.current.title, "Pilot");
  } finally {
    drafts.dispose();
  }
});

test("a file draft whose session becomes shared while the file is read opens nothing, merges nothing and says nothing", async () => {
  const h = harness();
  const docId = "d0123456789abcdef0123456789abcdef";
  const version = (title: string) => migrateRows({ title, docId, rows: [] }, fakeMigration().ports);
  const calls: string[] = [];
  const ports: DraftsPorts = {
    ...h.ports,
    files: {
      handle: () => ({ getFile: () => { h.state.mode = "shared"; return Promise.resolve({ name: "pilot.splitpage" }); } }),
      parse: () => { calls.push("parse"); return Promise.resolve({ state: version("Disk"), kind: "splitpage", docIdEmbedded: true }); }
    },
    documents: { open: () => { calls.push("open"); return Promise.resolve(true); } },
    recovery: { ...h.ports.recovery, applyStashedWork: () => { calls.push("merge"); return Promise.reject(new Error("merge")); } }
  };
  const drafts = mount(ports);
  try {
    const outcome = await drafts.applyTaken({
      header: { origin: { kind: "file" }, docIdWrittenOut: true },
      file: { id: "f1", name: "pilot.splitpage" },
      stateJson: JSON.stringify(version("Mine")),
      baseJson: JSON.stringify(version("Base"))
    });
    assert.equal(outcome, "kept");
    assert.deepEqual(calls, ["parse"]);
    assert.deepEqual(h.recovered, []);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(h.restoreDone, ["kept"]);
    assert.deepEqual(h.log, ["notify"]);
  } finally {
    drafts.dispose();
  }
});

type DetachStatus = { seq: number; writes: number; failures: number; onDisk: boolean; pending: boolean; lastCode: string | null };

function statusOf(drafts: DraftsMount): () => DetachStatus {
  return drafts.testing["status"] as () => DetachStatus;
}

function fireIdle(timers: Timer[]) {
  const idle = timers.find((t) => t.live && t.ms === 1500);
  assert.ok(idle);
  idle.live = false;
  idle.run();
}

async function refusedWhile(drafts: DraftsMount, h: ReturnType<typeof harness>, reason: string) {
  const before = { status: statusOf(drafts)(), live: h.timers.filter((t) => t.live).length, written: h.written.length };
  assert.equal(drafts.detachRefusal(), reason);
  assert.deepEqual(drafts.detachSource(), { ok: false, reason });
  assert.deepEqual({ status: statusOf(drafts)(), live: h.timers.filter((t) => t.live).length, written: h.written.length }, before);
}

test("detach refuses with its reason and changes nothing while a change is pending, then the standalone capture still runs", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    drafts.noteChange();
    await refusedWhile(drafts, h, "pending");
    fireIdle(h.timers);
    await settle();
    assert.equal(h.written.length, 1);
    assert.deepEqual(drafts.detachSource(), { ok: true });
  } finally {
    drafts.dispose();
  }
});

test("detach refuses while a write is in flight and succeeds once its answer has landed", async () => {
  const h = harness();
  const pending = deferred<Awaited<ReturnType<typeof h.desktop.write>>>();
  h.desktop.write = (payload) => { h.written.push(payload as Record<string, unknown>); return pending.promise; };
  const drafts = mount(h.ports);
  try {
    const flush = drafts.flush();
    await settle();
    assert.equal(h.written.length, 1);
    await refusedWhile(drafts, h, "writing");
    pending.resolve({ ok: true, seq: 1, bytes: 1 } as Awaited<ReturnType<typeof h.desktop.write>>);
    assert.deepEqual(await flush, { ok: true, seq: 1, bytes: 1 });
    assert.deepEqual(drafts.detachSource(), { ok: true });
  } finally {
    drafts.dispose();
  }
});

test("detach refuses while a discard is in flight and succeeds once it has answered", async () => {
  const h = harness();
  const pending = deferred<{ ok: true }>();
  h.desktop.discard = (seq) => { h.discarded.push(seq); return pending.promise; };
  const drafts = mount(h.ports);
  try {
    await drafts.flush();
    h.state.unsaved = false;
    const flush = drafts.flush();
    await settle();
    assert.equal(h.discarded.length, 1);
    await refusedWhile(drafts, h, "discarding");
    pending.resolve({ ok: true });
    await flush;
    assert.deepEqual(drafts.detachSource(), { ok: true });
  } finally {
    drafts.dispose();
  }
});

test("detach refuses while a retry is scheduled and while the writer is stopped", async () => {
  for (const [code, reason] of [["ENOSPC", "retrying"], ["DISCARDED", "stopped"]] as const) {
    const h = harness({ writes: [{ ok: false, code }] });
    const drafts = mount(h.ports);
    try {
      await drafts.flush();
      await refusedWhile(drafts, h, reason);
    } finally {
      drafts.dispose();
    }
  }
});

test("a settled owner detaches; while detached nothing is scheduled, written or discarded, and every flush answers that nothing was kept", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    await drafts.flush();
    assert.equal(drafts.detachRefusal(), null);
    assert.deepEqual(drafts.detachSource(), { ok: true });
    const armed = h.timers.length;
    h.state.editSeq = 2;
    drafts.noteChange();
    assert.deepEqual(await drafts.flush(), { ok: false, code: "DETACHED" });
    assert.deepEqual(await drafts.flush({ keep: true }), { ok: false, code: "DETACHED" });
    h.state.unsaved = false;
    drafts.noteChange();
    assert.deepEqual(await drafts.flush(), { ok: false, code: "DETACHED" });
    assert.equal(h.timers.length, armed, "nothing is scheduled while detached");
    assert.equal(h.written.length, 1);
    assert.deepEqual(h.discarded, []);
  } finally {
    drafts.dispose();
  }
});

test("after resuming, the next write carries the next sequence number, not a new first one", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    await drafts.flush();
    assert.deepEqual(drafts.detachSource(), { ok: true });
    h.state.editSeq = 2;
    await drafts.flush();
    assert.equal(drafts.resumeWriting(), true);
    h.state.editSeq = 3;
    await drafts.flush();
    assert.equal(h.written.length, 2);
    const [before, after] = h.written;
    assert.equal(Number(after?.["seq"]), Number(before?.["seq"]) + 1);
    assert.equal(after?.["editSeq"], 3);
    assert.equal(statusOf(drafts)().seq, Number(after?.["seq"]));
  } finally {
    drafts.dispose();
  }
});

test("while detached the source draft is neither discarded nor rewritten under another origin", async () => {
  const h = harness();
  let home: ReturnType<DraftsPorts["place"]["fileHome"]> = { kind: "file", format: "splitpage", handle: { _desktopId: "f1" } } as ReturnType<DraftsPorts["place"]["fileHome"]>;
  const drafts = mount({ ...h.ports, place: { ...h.ports.place, fileHome: () => home } });
  try {
    await drafts.flush();
    assert.equal(h.written[0]?.["originKind"], "file");
    assert.deepEqual(drafts.detachSource(), { ok: true });
    home = null;
    h.state.editSeq = 2;
    drafts.noteChange();
    await drafts.flush();
    await drafts.flush({ keep: true });
    h.state.unsaved = false;
    drafts.noteChange();
    await drafts.flush();
    assert.equal(h.written.length, 1);
    assert.deepEqual(h.discarded, []);
    assert.equal(statusOf(drafts)().onDisk, true);
  } finally {
    drafts.dispose();
  }
});

test("detach and resume are idempotent, a resume without a detach changes nothing, resuming arms nothing, and disposal while detached ends the owner", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  assert.equal(drafts.resumeWriting(), false);
  drafts.noteChange();
  assert.equal(drafts.resumeWriting(), false);
  assert.deepEqual(h.timers.filter((t) => t.live).map((t) => t.ms).sort((a, b) => a - b), [1500, 5000], "a stray resume keeps the armed capture");
  fireIdle(h.timers);
  await settle();
  assert.equal(h.written.length, 1);
  assert.deepEqual(drafts.detachSource(), { ok: true });
  assert.deepEqual(drafts.detachSource(), { ok: false, reason: "detached" });
  assert.equal(drafts.resumeWriting(), true);
  assert.equal(drafts.resumeWriting(), false);
  assert.equal(h.timers.some((t) => t.live), false, "resuming arms nothing");
  drafts.noteChange();
  assert.equal(h.timers.filter((t) => t.live).length, 2, "after one resume a change is scheduled again");
  h.state.editSeq = 2;
  await drafts.flush();
  assert.deepEqual(drafts.detachSource(), { ok: true });
  drafts.dispose();
  assert.equal(drafts.resumeWriting(), false);
  assert.deepEqual(drafts.detachSource(), { ok: false, reason: "disposed" });
  assert.equal(h.timers.some((t) => t.live), false);
  await settle();
  assert.equal(h.written.length, 2);
  assert.deepEqual(h.discarded, []);
});

type HeldWrite = { payload: Record<string, unknown>; answer: (reply: unknown) => void; fail: (error: Error) => void };
type HeldDiscard = { seq: number; answer: () => void; fail: (error: Error) => void };

function holdStore(h: ReturnType<typeof harness>) {
  const held = { writes: [] as HeldWrite[], discards: [] as HeldDiscard[] };
  h.desktop.write = (payload) => new Promise((resolve, reject) => {
    h.written.push(payload as Record<string, unknown>);
    held.writes.push({ payload: payload as Record<string, unknown>, answer: resolve as (reply: unknown) => void, fail: reject });
  });
  h.desktop.discard = (seq) => new Promise((resolve, reject) => {
    h.discarded.push(seq);
    held.discards.push({ seq, answer: () => { resolve({ ok: true } as const); }, fail: reject });
  });
  return held;
}

const RESTORE_DOC_ID = "d0123456789abcdef0123456789abcdef";

function restoreVersion(title: string) {
  return migrateRows({ title, docId: RESTORE_DOC_ID, rows: [] }, fakeMigration().ports);
}

function takenFileDraft() {
  return {
    header: { origin: { kind: "file" }, docIdWrittenOut: true },
    file: { id: "f1", name: "pilot.splitpage" },
    stateJson: JSON.stringify(restoreVersion("Mine")),
    baseJson: JSON.stringify(restoreVersion("Base"))
  };
}

type RestoreGates = { [K in "take" | "file" | "parse" | "open" | "merge"]: ReturnType<typeof deferred<undefined>> };

function restoreGates(): RestoreGates {
  return { take: deferred(), file: deferred(), parse: deferred(), open: deferred(), merge: deferred() };
}

function restorePorts(h: ReturnType<typeof harness>, gates: RestoreGates, hold: keyof RestoreGates): Partial<DraftsPorts> {
  const gate = (name: keyof RestoreGates) => name === hold ? gates[name].promise : Promise.resolve(undefined);
  const file = { name: "pilot.splitpage", lastModified: 4 };
  return {
    files: {
      handle: () => ({ getFile: () => gate("file").then(() => file) }),
      parse: () => gate("parse").then(() => ({ state: restoreVersion(hold === "open" ? "Mine" : "Disk"), kind: "splitpage", docIdEmbedded: true }))
    } as DraftsPorts["files"],
    documents: { open: () => gate("open").then(() => true) },
    recovery: { ...h.ports.recovery, applyStashedWork: (state) => gate("merge").then(() => ({ state, report: null, snapshot: null })) }
  };
}

async function drain(held: ReturnType<typeof holdStore>) {
  for (let round = 0; round < 8; round++) {
    await settle();
    for (const write of held.writes.splice(0)) write.answer({ ok: true, seq: write.payload["seq"], bytes: 1 });
    for (const discard of held.discards.splice(0)) discard.answer();
  }
  await settle();
}

async function landFirstWrite(drafts: DraftsMount, held: ReturnType<typeof holdStore>) {
  const flush = drafts.flush();
  await drain(held);
  assert.equal((await flush).ok, true);
}

type YieldPoint = {
  name: string;
  reason: string;
  pictures?: boolean;
  hold?: keyof RestoreGates;
  reach: (h: ReturnType<typeof harness>, drafts: DraftsMount, held: ReturnType<typeof holdStore>, persist: { resolve: (failed: string[]) => void }) => Promise<void>;
  last?: (drafts: DraftsMount, h: ReturnType<typeof harness>) => void;
  release?: (h: ReturnType<typeof harness>) => void;
};

async function restoreFrom(h: ReturnType<typeof harness>, drafts: DraftsMount) {
  h.resume.setRestorePending(false);
  void drafts.applyTaken(takenFileDraft());
  await settle();
}

const YIELD_POINTS: YieldPoint[] = [
  { name: "a flush queued before its capture", reason: "flushing", reach: async () => {}, last: (drafts) => { void drafts.flush(); } },
  { name: "a timer capture whose write is queued before the store is asked", reason: "writing", reach: async (_h, drafts) => { drafts.noteChange(); },
    last: (_drafts, h) => { fireIdle(h.timers); assert.equal(h.written.length, 0); } },
  { name: "a write awaiting picture persistence", reason: "writing", pictures: true, reach: async (_h, drafts) => { void drafts.flush(); await settle(); } },
  { name: "a write awaiting the store", reason: "writing", reach: async (h, drafts) => {
    void drafts.flush(); await settle(); assert.equal(h.written.length, 1);
  } },
  { name: "a write awaiting its NEED_BASE resend", reason: "writing", reach: async (h, drafts, held) => {
    void drafts.flush(); await settle();
    held.writes.splice(0)[0]?.answer({ ok: false, code: "NEED_BASE" });
    await settle();
    assert.equal(h.written.length, 2);
  } },
  { name: "a timer discard queued before the store is asked", reason: "discarding", reach: async (h, drafts, held) => {
    await landFirstWrite(drafts, held);
    h.state.unsaved = false; drafts.noteChange();
  }, last: (_drafts, h) => { fireIdle(h.timers); assert.equal(h.discarded.length, 0); } },
  { name: "a discard awaiting its answer", reason: "discarding", reach: async (h, drafts, held) => {
    await landFirstWrite(drafts, held);
    h.state.unsaved = false; void drafts.flush(); await settle();
    assert.equal(h.discarded.length, 1);
  } },
  { name: "two flushes queued", reason: "flushing", reach: async () => {}, last: (drafts) => { void drafts.flush(); void drafts.flush({ keep: true }); } },
  { name: "two discards outstanding, the first answered", reason: "discarding", reach: async (h, drafts, held) => {
    await landFirstWrite(drafts, held);
    h.state.unsaved = false; void drafts.flush(); await settle();
    h.state.unsaved = true; h.state.editSeq = 2;
    const rewrite = drafts.flush(); await settle();
    held.writes.splice(0)[0]?.answer({ ok: true, seq: 3, bytes: 1 }); await rewrite;
    h.state.unsaved = false; void drafts.flush(); await settle();
    assert.equal(held.discards.length, 2);
    held.discards.splice(0, 1)[0]?.answer(); await settle();
  } },
  { name: "a write in flight and a flush queued behind it", reason: "writing", reach: async (_h, drafts) => {
    void drafts.flush(); await settle();
  }, last: (drafts) => { void drafts.flush({ keep: true }); } },
  { name: "a discard in flight and a flush queued", reason: "discarding", reach: async (h, drafts, held) => {
    await landFirstWrite(drafts, held);
    h.state.unsaved = false; void drafts.flush(); await settle();
  }, last: (drafts) => { void drafts.flush(); } },
  { name: "a write awaiting the store while a discard awaits its answer", reason: "writing", reach: async (h, drafts, held) => {
    await landFirstWrite(drafts, held);
    h.state.unsaved = false; void drafts.flush(); await settle();
    h.state.unsaved = true; h.state.editSeq = 2; void drafts.flush(); await settle();
    assert.deepEqual([held.writes.length, held.discards.length], [1, 1]);
  } },
  { name: "taking a draft, while the store's take is unanswered", reason: "restoring", hold: "take", reach: async (h, drafts) => {
    h.resume.setRestorePending(true);
    const take = drafts.taker();
    assert.ok(take);
    h.resume.setRestorePending(false);
    void take().then((value) => drafts.applyTaken(value));
  } },
  { name: "a file draft restore awaiting its file read", reason: "restoring", hold: "file", reach: restoreFrom },
  { name: "a file draft restore awaiting the parse", reason: "restoring", hold: "parse", reach: restoreFrom },
  { name: "a file draft restore that answered while the document it opened is still opening", reason: "restoring", hold: "open", reach: restoreFrom },
  { name: "a file draft restore awaiting the merge and its undo point", reason: "restoring", hold: "merge", reach: restoreFrom },
  { name: "a second NEED_BASE, ending in a scheduled retry", reason: "retrying", reach: async (h, drafts, held) => {
    void drafts.flush(); await settle();
    held.writes.splice(0)[0]?.answer({ ok: false, code: "NEED_BASE" }); await settle();
    held.writes.splice(0)[0]?.answer({ ok: false, code: "NEED_BASE" }); await settle();
    assert.equal(h.written.length, 2);
  } },
  { name: "a rejected write, whose retry is scheduled", reason: "retrying", reach: async (_h, drafts, held) => {
    void drafts.flush(); await settle();
    held.writes.splice(0)[0]?.fail(new Error("write failed")); await settle();
  } },
  { name: "the store's availability lost after a change was scheduled", reason: "pending", reach: async (h, drafts) => {
    drafts.noteChange();
    h.desktop.writable = () => false;
  }, release: (h) => { h.desktop.writable = () => true; } }
];

for (const point of YIELD_POINTS) {
  test("detach refuses at every yield of outstanding draft work: " + point.name, async () => {
    const h = harness();
    const persisting = deferred<string[]>();
    const gates = restoreGates();
    if (point.pictures) h.state.base = { rows: [{ id: "r", imageRef: { sha256: "a".repeat(64) } }] };
    if (point.hold === "take") h.desktop.taker = () => () => gates.take.promise.then(() => null);
    const drafts = mount({ ...h.ports,
      ...(point.pictures ? { pictures: { persist: () => persisting.promise, inline: (json: string) => json } } : {}),
      ...(point.hold ? restorePorts(h, gates, point.hold) : {}) });
    const held = holdStore(h);
    try {
      await point.reach(h, drafts, held, persisting);
      point.last?.(drafts, h);
      await refusedWhile(drafts, h, point.reason);
      persisting.resolve([]);
      for (const gate of Object.values(gates)) gate.resolve(undefined);
      point.release?.(h);
      await drain(held);
      for (const timer of h.timers) if (timer.live) { timer.live = false; timer.run(); }
      await drain(held);
      assert.equal(drafts.detachRefusal(), null);
      assert.deepEqual(drafts.detachSource(), { ok: true });
    } finally {
      drafts.dispose();
    }
  });
}

test("a keep flush whose capture is still queued refuses the detach and then certifies only the copy the store holds", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    await drafts.flush();
    assert.equal(drafts.detachRefusal(), null);
    const keep = drafts.flush({ keep: true });
    assert.deepEqual(drafts.detachSource(), { ok: false, reason: "flushing" });
    const changed = migrateRows({ ...h.state.current, title: "Document B" }, fakeMigration().ports);
    h.state.current = changed; h.state.editSeq = 2;
    drafts.noteChange();
    assert.equal((await keep).ok, true);
    assert.equal((JSON.parse(String(h.written.at(-1)?.["stateJson"])) as { title: string }).title, "Document B");
    assert.deepEqual(drafts.detachSource(), { ok: true });
  } finally {
    drafts.dispose();
  }
});

test("a detach waits for every outstanding discard, not only the first to answer", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  const held = holdStore(h);
  try {
    await landFirstWrite(drafts, held);
    h.state.unsaved = false;
    const second = drafts.flush(); await settle();
    h.state.unsaved = true; h.state.editSeq = 2;
    const third = drafts.flush(); await settle();
    held.writes.splice(0)[0]?.answer({ ok: true, seq: 3, bytes: 1 });
    await third;
    h.state.unsaved = false;
    const fourth = drafts.flush(); await settle();
    assert.equal(held.discards.length, 2);
    held.discards.splice(0, 1)[0]?.answer();
    await second;
    assert.deepEqual(drafts.detachSource(), { ok: false, reason: "discarding" });
    held.discards.splice(0, 1)[0]?.answer();
    await fourth;
    assert.deepEqual(drafts.detachSource(), { ok: true });
  } finally {
    drafts.dispose();
  }
});

test("a flush whose capture finds the writer not live answers that nothing was kept: shared before the capture, or stopped by the write ahead of it", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    const shared = drafts.flush({ keep: true });
    h.state.mode = "shared";
    assert.deepEqual(await shared, { ok: false, code: "DETACHED" });
    assert.deepEqual(h.written, []);
  } finally {
    drafts.dispose();
  }
  for (const code of ["DISCARDED", "NO_TAB"]) {
    const s = harness();
    const stopping = mount(s.ports);
    const held = holdStore(s);
    try {
      const first = stopping.flush(); await settle();
      const queued = stopping.flush({ keep: true });
      held.writes.splice(0)[0]?.answer({ ok: false, code });
      assert.deepEqual(await first, { ok: false, code });
      assert.deepEqual(await queued, { ok: false, code });
      assert.equal(s.written.length, 1);
    } finally {
      stopping.dispose();
    }
  }
});

test("a keep flush that captured nothing answers TOO_LARGE when a capture stops the writer before its answer", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  const real = JSON.stringify;
  try {
    await drafts.flush();
    const first = drafts.flush({ keep: true });
    await Promise.resolve();
    const changed = restoreVersion("Document B");
    h.state.current = changed; h.state.editSeq = 2;
    JSON.stringify = function (value: unknown, ...rest: unknown[]) {
      if (value === changed) throw new RangeError("test: too large");
      return (real as (...args: unknown[]) => string).call(JSON, value, ...rest);
    } as typeof JSON.stringify;
    drafts.noteChange();
    fireIdle(h.timers);
    JSON.stringify = real;
    assert.equal((drafts.testing["status"] as () => { stopped: boolean })().stopped, true);
    assert.deepEqual(await first, { ok: false, code: "TOO_LARGE" });
    assert.equal(h.written.length, 1);
  } finally {
    JSON.stringify = real;
    drafts.dispose();
  }
});

test("a file draft restore waiting on its file read refuses the detach, then adopts its copy on an attached writer", async () => {
  const h = harness();
  const reading = deferred<undefined>();
  const drafts = mount({ ...h.ports, files: {
    handle: () => ({ getFile: () => reading.promise.then(() => { throw new Error("unreadable"); }) }),
    parse: () => Promise.resolve(null)
  } });
  try {
    h.resume.setRestorePending(false);
    const restoring = drafts.applyTaken(takenFileDraft());
    await settle();
    assert.equal(drafts.detachRefusal(), "restoring");
    assert.deepEqual(drafts.detachSource(), { ok: false, reason: "restoring" });
    reading.resolve(undefined);
    await restoring;
    assert.equal(h.recovered.length, 1);
    assert.equal(drafts.resumeWriting(), false, "the writer was never detached");
  } finally {
    drafts.dispose();
  }
});

test("while a draft restore is pending the detach refuses as restoring", () => {
  const h = harness({ hasDraft: true });
  const drafts = mount(h.ports);
  try {
    assert.equal(h.resume.restorePending(), true);
    assert.deepEqual(drafts.detachSource(), { ok: false, reason: "restoring" });
    h.resume.setRestorePending(false);
    assert.deepEqual(drafts.detachSource(), { ok: true });
  } finally {
    drafts.dispose();
  }
});

test("losing the store after a change was scheduled still refuses the detach while the capture is armed", () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    drafts.noteChange();
    h.desktop.writable = () => false;
    assert.deepEqual(drafts.detachSource(), { ok: false, reason: "pending" });
    assert.equal(h.timers.filter((t) => t.live).length, 2);
  } finally {
    drafts.dispose();
  }
});

test("a detach tried from inside a flush, between its no-op capture and its answer, refuses as flushing", async () => {
  const h = harness();
  const tried: unknown[] = [];
  let probing = false;
  let drafts: DraftsMount | null = null;
  drafts = mount({ ...h.ports, saves: { ...h.ports.saves, editSeq: () => {
    if (probing) tried.push(drafts?.detachSource());
    return h.ports.saves.editSeq();
  } } });
  try {
    await drafts.flush();
    const answer = drafts.flush({ keep: true });
    probing = true;
    assert.deepEqual(await answer, { ok: true });
    probing = false;
    assert.ok(tried.length >= 2, "the capture and the answer both read the edit sequence");
    assert.ok(tried.every((t) => JSON.stringify(t) === JSON.stringify({ ok: false, reason: "flushing" })), JSON.stringify(tried));
    assert.equal(h.written.length, 1);
  } finally {
    drafts.dispose();
  }
});

test("a detach tried inside a write's answer handler refuses as writing, and one in a finally on the answered flush succeeds", async () => {
  const h = harness({ writes: [{ ok: false, code: "ENOSPC" }] });
  const inside: unknown[] = [];
  let drafts: DraftsMount | null = null;
  drafts = mount({ ...h.ports, notices: { show: (message, kind, sticky) => {
    inside.push(drafts?.detachSource());
    return h.ports.notices.show(message, kind, sticky);
  } } });
  try {
    await drafts.flush();
    assert.deepEqual(inside, [{ ok: false, reason: "writing" }]);
    fireDue(h.timers);
    await settle();
    let after: unknown = null;
    await drafts.flush().finally(() => { after = drafts?.detachSource(); });
    assert.deepEqual(after, { ok: true });
  } finally {
    drafts.dispose();
  }
});

test("a rejected discard deregisters, so it does not hold the detach", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  const held = holdStore(h);
  try {
    await landFirstWrite(drafts, held);
    h.state.unsaved = false;
    const flush = drafts.flush(); await settle();
    assert.equal(drafts.detachRefusal(), "discarding");
    held.discards.splice(0)[0]?.fail(new Error("discard failed"));
    await flush;
    assert.equal(drafts.detachRefusal(), null);
    assert.equal(statusOf(drafts)().onDisk, true);
  } finally {
    drafts.dispose();
  }
});

test("disposal with a write, a discard and a flush outstanding answers disposed, and the late answers change nothing", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  const held = holdStore(h);
  await landFirstWrite(drafts, held);
  h.state.unsaved = false;
  const discarding = drafts.flush(); await settle();
  h.state.unsaved = true; h.state.editSeq = 2;
  const writing = drafts.flush(); await settle();
  const queued = drafts.flush({ keep: true });
  drafts.dispose();
  assert.deepEqual(drafts.detachSource(), { ok: false, reason: "disposed" });
  for (const write of held.writes.splice(0)) write.answer({ ok: true, seq: write.payload["seq"], bytes: 1 });
  for (const discard of held.discards.splice(0)) discard.answer();
  assert.deepEqual((await Promise.all([writing, queued])).map((r) => r.ok), [false, false]);
  await discarding;
  assert.deepEqual(drafts.detachSource(), { ok: false, reason: "disposed" });
  assert.equal(drafts.resumeWriting(), false);
  assert.equal(h.timers.some((t) => t.live), false);
});

test("with no draft store there is nothing to settle, so the detach succeeds at once", () => {
  const h = harness({ running: false });
  const drafts = mount(h.ports);
  try {
    drafts.noteChange();
    assert.equal(drafts.detachRefusal(), null);
    assert.deepEqual(drafts.detachSource(), { ok: true });
  } finally {
    drafts.dispose();
  }
});

type TakenWire = Awaited<ReturnType<NonNullable<ReturnType<DesktopDraftStore["taker"]>>>>;
const titleOf = (payload: Record<string, unknown> | undefined) => (JSON.parse(String(payload?.["stateJson"])) as { title: string }).title;

test("a keep flush over a stored A whose capture skipped while the store was gone does not answer kept for B", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    await drafts.flush();
    assert.equal(titleOf(h.written.at(-1)), "Pilot");
    const keep = drafts.flush({ keep: true });
    h.state.current = restoreVersion("Document B"); h.state.editSeq = 2;
    let reads = 0;
    h.desktop.writable = () => ++reads !== 1;
    const answer = await keep;
    assert.ok(reads >= 1, "the capture found the store gone");
    assert.notEqual(answer.ok, true, JSON.stringify(answer));
    assert.equal(h.written.length, 1);
  } finally {
    drafts.dispose();
  }
});

test("a take whose caller applies it later holds the detach until that apply, whatever another apply or flush does meanwhile", async () => {
  const h = harness({ hasDraft: true });
  const gate = deferred<TakenWire>();
  h.desktop.taker = () => () => gate.promise;
  const drafts = mount(h.ports);
  try {
    const take = drafts.taker();
    assert.ok(take);
    const applied = take().then((value) => drafts.applyTaken(value));
    let between: unknown = null, recoveredAtDetach = -1;
    void gate.promise.then(() => {
      between = drafts.detachSource();
      recoveredAtDetach = h.recovered.length;
    });
    await drafts.applyTaken(null);
    assert.equal(h.resume.restorePending(), false);
    fireDue(h.timers);
    await settle();
    await drafts.flush();
    assert.equal(drafts.detachRefusal(), "restoring");
    gate.resolve({ header: { origin: { kind: "untitled" }, docIdWrittenOut: false }, stateJson: JSON.stringify(restoreVersion("Recovered")) } as unknown as TakenWire);
    await applied;
    assert.equal(h.recovered.length, 1, "the caller restored the draft");
    assert.notEqual((between as { ok?: boolean } | null)?.ok, true, `detached with ${recoveredAtDetach} restores done, then the caller restored`);
  } finally {
    drafts.dispose();
  }
});

test("a change armed while a keep flush waits keeps its timers when the store is gone at capture, and writes B once it is back", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  const held = holdStore(h);
  try {
    await landFirstWrite(drafts, held);
    const keep = drafts.flush({ keep: true });
    h.state.current = restoreVersion("Document B"); h.state.editSeq = 2;
    drafts.noteChange();
    h.desktop.writable = () => false;
    assert.notEqual((await keep).ok, true);
    assert.equal(h.written.length, 1);
    assert.equal(drafts.detachRefusal(), "pending");
    assert.ok(h.timers.some((t) => t.live), "a pending change keeps a wake-up");
    h.desktop.writable = () => true;
    fireIdle(h.timers);
    await drain(held);
    assert.equal(titleOf(h.written.at(-1)), "Document B");
    assert.equal(drafts.detachRefusal(), null);
  } finally {
    drafts.dispose();
  }
});

test("the taker hands its caller the store's own promise, so the take answers in the same reaction as on main", async () => {
  const h = harness({ hasDraft: true });
  const answer = Promise.resolve(null);
  h.desktop.taker = () => () => answer;
  const drafts = mount(h.ports);
  try {
    const take = drafts.taker();
    assert.ok(take);
    assert.equal(take(), answer);
  } finally {
    drafts.dispose();
  }
});

test("a take whose store throws at once rethrows and leaves nothing open, so it does not hold the detach", async () => {
  const h = harness({ hasDraft: true });
  const failure = new Error("test: the take failed");
  h.desktop.taker = () => () => { throw failure; };
  const drafts = mount(h.ports);
  try {
    const take = drafts.taker();
    assert.ok(take);
    assert.throws(() => take(), failure);
    await drafts.applyTaken(null);
    fireDue(h.timers);
    await settle();
    await drafts.flush();
    assert.equal(drafts.detachRefusal(), null);
    assert.equal(drafts.detachSource().ok, true);
  } finally {
    drafts.dispose();
  }
});

test("a taker invoked after a successful detach takes nothing, and an apply while detached restores and reports nothing", async () => {
  const h = harness({ hasDraft: true });
  let takes = 0;
  h.desktop.taker = () => () => { takes++; return Promise.resolve(null); };
  const drafts = mount(h.ports);
  try {
    const take = drafts.taker();
    assert.ok(take);
    await drafts.applyTaken(await take());
    fireDue(h.timers);
    await settle();
    await drafts.flush();
    assert.equal(drafts.detachSource().ok, true);
    const before = [h.recovered.length, h.restoreDone.length];
    assert.equal(await take(), null);
    assert.equal(takes, 1);
    const late = { header: { origin: { kind: "untitled" }, docIdWrittenOut: false }, stateJson: JSON.stringify(restoreVersion("Late")) };
    assert.equal(await drafts.applyTaken(late), "DETACHED");
    assert.deepEqual([h.recovered.length, h.restoreDone.length], before);
    assert.equal(drafts.detachRefusal(), "detached");
  } finally {
    drafts.dispose();
  }
});

test("an edit followed at once by a keep flush answers ok with that edit stored, so the close asks nothing more", async () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    await drafts.flush();
    h.state.current = restoreVersion("Edited"); h.state.editSeq = 2;
    drafts.noteChange();
    const answer = await drafts.flush({ keep: true });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(titleOf(h.written.at(-1)), "Edited");
    assert.equal(h.written.length, 2);
  } finally {
    drafts.dispose();
  }
});

test("an unawaited document open that rejects surfaces once as an unhandled rejection with its own reason, and releases the restore count", async () => {
  const h = harness();
  const failure = new Error("test: the open failed");
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  const runner = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", listener);
  const file = { name: "pilot.splitpage", lastModified: 4 };
  const drafts = mount({ ...h.ports,
    files: { handle: () => ({ getFile: () => Promise.resolve(file) }),
      parse: () => Promise.resolve({ state: restoreVersion("Mine"), kind: "splitpage", docIdEmbedded: true }) } as DraftsPorts["files"],
    documents: { open: () => Promise.reject(failure) } });
  try {
    h.resume.setRestorePending(false);
    assert.equal(await drafts.applyTaken(takenFileDraft()), "nothing-unsaved");
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(unhandled, [failure]);
    assert.notEqual(drafts.detachRefusal(), "restoring");
  } finally {
    process.off("unhandledRejection", listener);
    for (const handler of runner) process.on("unhandledRejection", handler);
    drafts.dispose();
  }
});

const SEQUENCE_OPS = ["edit", "noteChange", "flush", "flushKeep", "fireTimers", "writeOk", "writeFails", "storeLost", "storeBack",
  "takeStart", "takeStartApplying", "takeAnswers", "applyTake", "applyNull", "detach", "resume", "settle"] as const;
type SequenceOp = typeof SEQUENCE_OPS[number];
const SEQUENCE_STARTS = ["no draft", "a draft to restore", "a take obtained and another restore done", "copy A stored"] as const;
type SequenceStart = typeof SEQUENCE_STARTS[number];
const SEQUENCE_LENGTH = 4;
const SEQUENCE_TAKEN = { header: { origin: { kind: "untitled" }, docIdWrittenOut: false }, stateJson: JSON.stringify(restoreVersion("Recovered")) } as unknown as TakenWire;

async function runSequence(ops: readonly SequenceOp[], start: SequenceStart): Promise<string | null> {
  const h = harness({ hasDraft: start === "a draft to restore" || start === "a take obtained and another restore done" });
  const gate = deferred<TakenWire>();
  h.desktop.taker = () => () => gate.promise;
  const writes: HeldWrite[] = [];
  let stored: string | null = null;
  h.desktop.write = (payload) => new Promise((resolve, reject) => {
    writes.push({ payload: payload as Record<string, unknown>, answer: resolve as (reply: unknown) => void, fail: reject });
  });
  const flushes: { answer: Promise<unknown>; matched: boolean | null }[] = [];
  const matches = () => stored === JSON.stringify(h.state.current);
  const freeze = () => {
    for (const f of flushes) if (f.matched === null && !inspect(f.answer).includes("<pending>")) f.matched = matches();
  };
  const drafts = mount({ ...h.ports, transitions: { ...h.ports.transitions, recover: (recovery) => { freeze(); return h.ports.transitions.recover(recovery); } } });
  const take = drafts.taker();
  let taking: Promise<unknown> | null = null, answeredTake = false;
  let delivered = null as { value: unknown } | null;
  let detachedAt: string | null = null, version = 0, failure: string | null = null;
  const owned = () => h.recovered.length + ":" + h.restoreDone.length;
  const watchFlush = (answer: Promise<{ ok?: boolean }>) => {
    const watched = { answer: answer as Promise<unknown>, matched: null as boolean | null };
    flushes.push(watched);
    void answer.then((value) => {
      if (value.ok === true && !(watched.matched ?? matches())) failure ??= "I1: a flush answered ok while the store holds another copy";
    });
  };
  const checkSettled = () => {
    if (drafts.detachRefusal() === "pending" && !h.timers.some((t) => t.live) && writes.length === 0) failure ??= "I3: pending with no wake-up";
  };
  try {
    if (start === "a take obtained and another restore done") await drafts.applyTaken(null);
    if (start === "copy A stored" || start === "a take obtained and another restore done") {
      void drafts.flush();
      await settle();
      const first = writes.shift();
      assert.ok(first);
      stored = String(first.payload["stateJson"]);
      first.answer({ ok: true, seq: first.payload["seq"], bytes: 1 });
    }
    await settle();
    for (const op of ops) {
      freeze();
      if (op === "edit") { h.state.current = { ...h.state.current, title: "v" + ++version } as typeof h.state.current; h.state.editSeq++; }
      else if (op === "noteChange") drafts.noteChange();
      else if (op === "flush" || op === "flushKeep") watchFlush(drafts.flush(op === "flushKeep" ? { keep: true } : null));
      else if (op === "fireTimers") { if (!h.timers.some((t) => t.live)) return null; fireDue(h.timers); }
      else if (op === "writeOk" || op === "writeFails") {
        const write = writes.shift();
        if (!write) return null;
        if (op === "writeFails") write.fail(new Error("test: write failed"));
        else { stored = String(write.payload["stateJson"]); write.answer({ ok: true, seq: write.payload["seq"], bytes: 1 }); }
      } else if (op === "storeLost" || op === "storeBack") {
        const writable = op === "storeBack";
        if (h.desktop.writable() === writable) return null;
        h.desktop.writable = () => writable;
      } else if (op === "takeStart" || op === "takeStartApplying") {
        if (!take || taking) return null;
        taking = take();
        if (op === "takeStart") void taking.then((value) => { delivered = { value }; });
        else void taking.then((value) => drafts.applyTaken(value));
      } else if (op === "takeAnswers") { if (!taking || answeredTake) return null; answeredTake = true; gate.resolve(SEQUENCE_TAKEN); }
      else if (op === "applyTake") { if (!delivered) return null; const value = delivered.value; delivered = null; void drafts.applyTaken(value); }
      else if (op === "applyNull") void drafts.applyTaken(null);
      else if (op === "detach") { if (drafts.detachSource().ok) detachedAt = owned(); }
      else if (op === "resume") { if (drafts.resumeWriting()) detachedAt = null; }
      if (op === "settle") await settle();
      else await Promise.resolve();
      if (detachedAt !== null && owned() !== detachedAt) failure ??= "I2: a restore changed the document or reported while detached";
      if (op === "settle") checkSettled();
      if (failure) return failure;
    }
    await settle();
    if (detachedAt !== null && owned() !== detachedAt) failure ??= "I2: a restore changed the document or reported while detached";
    checkSettled();
    return failure;
  } finally {
    await settle();
    drafts.dispose();
  }
}

test("every sequence of draft operations up to the fixed length, one reaction apart, keeps kept, restore and wake-up invariants", async () => {
  const sequences: SequenceOp[][] = [[]];
  for (let length = 0; length < SEQUENCE_LENGTH; length++) {
    for (const prefix of sequences.filter((s) => s.length === length)) for (const op of SEQUENCE_OPS) sequences.push([...prefix, op]);
  }
  const failures: string[] = [];
  for (const start of SEQUENCE_STARTS) for (const ops of sequences) {
    const failure = await runSequence(ops, start);
    if (failure) failures.push(`${start}: ${ops.join(", ")}: ${failure}`);
  }
  assert.deepEqual(failures.slice(0, 5), []);
});


