import { test } from "node:test";
import assert from "node:assert/strict";
import { __init } from "../../../src/application/recovery/drafts.js";
import type { DraftsMount, DraftsPorts } from "../../../src/application/recovery/drafts-ports.ts";
import { createDraftResume } from "../../../src/application/recovery/draft-resume.ts";
import type { DesktopDraftResult } from "../../../src/application/recovery/ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

interface Timer { run: () => void; ms: number; live: boolean }

function harness(start: { running?: boolean; unsaved?: boolean; hasDraft?: boolean; writes?: DesktopDraftResult[] } = {}) {
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
  const state = { unsaved: start.unsaved ?? true, editSeq: 1, now: 1000, base: null as unknown };
  const desktop = {
    writable: () => true,
    canDiscard: () => true,
    write: (payload: unknown) => {
      written.push(payload as Record<string, unknown>);
      return Promise.resolve(answers.shift() ?? { ok: true });
    },
    discard: (seq: number) => { discarded.push(seq); return Promise.resolve({ ok: true }); },
    taker: () => () => Promise.resolve(null),
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
    document: { current: () => doc },
    session: { mergeBase: () => state.base, noteAbsorbedDirty: (reason) => { log.push("absorbed:" + reason); } },
    place: {
      home: () => ({ kind: "none" }),
      connection: () => ({ serverUrl: "", token: "", role: "", scope: "", tunnel: null }),
      fileHome: () => null,
      importHome: () => null,
      stillOnServer: () => false,
      writtenOut: () => false,
      serverMode: () => ({ available: false, readOnly: false, checked: true, authRequired: false, reviewAvailable: false, version: null, links: false, linksPersist: false })
    },
    onServerDoc: () => false,
    markWrittenOut: (on) => { log.push("writtenOut:" + on); },
    review: { reviewing: () => false },
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
      recover: (recovery) => { recovered.push(recovery); log.push("recover"); return { document: doc, forkedFrom: null, kept: false }; },
      restore: () => ({ document: doc, forkedFrom: null, kept: false })
    },
    documents: { open: () => Promise.resolve(true) },
    resetProductionPanel: () => { log.push("resetPanel"); },
    pictures: { persist: () => Promise.resolve([]), inline: (json) => json },
    files: { handle: () => ({ getFile: () => Promise.resolve(null) }), parse: () => Promise.resolve(null) },
    recovery: {
      started: () => true,
      draftResume: () => resume,
      browserDrafts: () => { throw new Error("no browser drafts on the desktop"); },
      desktopDrafts: () => desktop,
      captureRestore: () => ({ epoch: 0, docId: null, destination: null, destinationGeneration: 0, generation: 0, connection: null, revision: null }),
      stillRestoring: () => true,
      applyStashedWork: () => { throw new Error("no stash"); },
      useBrowserDraftFactory: () => { throw new Error("no browser drafts on the desktop"); }
    },
    browserDraft: { key: (base, docId) => base + "#" + docId, base: () => "", normalizeBase: (value) => String(value ?? "") },
    lock: { writerId: () => "w".repeat(32), hold: () => { log.push("hold"); }, release: () => { log.push("release"); }, isLive: () => Promise.resolve(false) },
    documentState: { notify: () => { log.push("notify"); } },
    banner: { show: () => true, hide: () => {} }
  };
  return { ports, timers, log, written, discarded, toasts, recovered, restoreDone, resume, state };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function fireDue(timers: Timer[]) {
  const due = timers.filter((t) => t.live);
  for (const t of due) { t.live = false; t.run(); }
}

function mount(ports: DraftsPorts): DraftsMount {
  return __init(ports) as DraftsMount;
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

test("the desktop taker is offered only while a restore is pending", () => {
  const h = harness();
  const drafts = mount(h.ports);
  try {
    assert.equal(drafts.desktopTaker(), null);
    h.resume.setRestorePending(true);
    assert.equal(typeof drafts.desktopTaker(), "function");
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
