import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaveCoordinator } from "../../src/application/save/coordinator.ts";
import type { SaveCoordinator, SaveOutcome } from "../../src/application/save/coordinator.ts";
import { mountFileSaving, obsoleteSaveText } from "../../src/application/save/file-saving.ts";
import type { FileSaveHandle, FileSaveRequest, FileSaveTarget, FileSavingMount, FileSavingPorts } from "../../src/application/save/file-saving-ports.ts";
import { createDocumentLocation } from "../../src/application/location/document-location.ts";
import type { DocumentLocation, Home } from "../../src/application/location/document-location.ts";
import { createOperations } from "../../src/application/session/operation.ts";
import type { Operations } from "../../src/application/session/operation.ts";
import type { Stamp } from "../../src/application/session/document-session.ts";
import { joinSaves } from "../../src/bootstrap/wiring/save-owners.ts";
import { cloneState } from "../../src/core/document/clone.ts";
import { buildExportDocument } from "../../src/core/document/export-document.ts";
import type { ExportReadModels } from "../../src/core/document/export-document.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { fakeNotices } from "../features/fakes.ts";

const NO_MODELS: ExportReadModels = { production: [], commentNumbers: {}, broll: [] };
const OLD_ID = "d0123456789abcdef0123456789abcdef";
const NEW_ID = "dfedcba9876543210fedcba9876543210";
const OTHER_ID = "d00000000000000000000000000000000";

interface Disk extends FileSaveHandle {
  text: string;
  lastModified: number;
  writes: number;
  changedOnDisk: boolean;
  fails: Error | null;
  held: { readonly arrived: () => void; readonly released: Promise<void> } | null;
}

function disk(name: string, text = ""): Disk {
  return { name, text, lastModified: 1000, writes: 0, changedOnDisk: false, fails: null, held: null };
}

function hold(target: Disk): { readonly arrived: Promise<void>; readonly release: () => void } {
  let arrived: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  target.held = { arrived, released };
  return { arrived: reached, release };
}

function script(docId: string, audio: string): ValidatedDocument {
  return migrateRows({ title: "Pilot", docId, rev: 2, rows: [{ id: "r1", visualText: "Wide", audioText: audio }] }, fakeMigration().ports);
}

interface Scripted {
  readonly docId: string;
  readonly rows: readonly { readonly audioText?: unknown }[];
}

function audioOf(doc: unknown): string | null {
  if (!doc) return null;
  return String((doc as Scripted).rows[0]?.audioText);
}

interface World {
  epoch: number;
  doc: ValidatedDocument;
  readonly location: DocumentLocation;
  readonly ownership: Operations;
  readonly coordinator: SaveCoordinator<FileSaveRequest, unknown>;
  readonly mounted: FileSavingMount;
  readonly toasts: string[];
  readonly history: string[];
  readonly remembered: string[];
  readonly downloads: string[];
  readonly confirms: string[];
  picks: (FileSaveTarget | { readonly kind: "cancelled" } | Error)[];
  historyHangs: boolean;
  onRemember: (() => void) | null;
  onToast: ((message: string) => void) | null;
}

function world(): World {
  const location = createDocumentLocation();
  const w: Omit<World, "ownership" | "coordinator" | "mounted"> = {
    epoch: 1,
    doc: script(OLD_ID, "One."),
    location,
    toasts: [],
    history: [],
    remembered: [],
    downloads: [],
    confirms: [],
    picks: [],
    historyHangs: false,
    onRemember: null,
    onToast: null
  };
  const shown = fakeNotices().notices;
  let coordinator: SaveCoordinator<FileSaveRequest, unknown> | null = null;
  const live = (): SaveCoordinator<FileSaveRequest, unknown> => {
    if (!coordinator) throw new Error("no coordinator yet");
    return coordinator;
  };
  const ownership = createOperations({
    session: { epoch: () => w.epoch, generation: () => live().changes() },
    document: { id: () => w.doc.docId },
    destination: { identity: () => location.home(), generation: () => live().confirmed().generation }
  });
  let minted = 0;
  const ports: FileSavingPorts = {
    edits: { edit: () => { throw new Error("unexpected title change"); } },
    deferred: {
      copyHistory: (fromId, toId) => {
        w.history.push(fromId + ">" + toId);
        return w.historyHangs ? new Promise<never>(() => {}) : undefined;
      },
      syncIdentity: () => {},
      setBaseline: (state) => { live().confirmBaseline(state); }
    },
    ids: { docId: () => { minted++; return minted === 1 ? NEW_ID : "d" + String(minted).padStart(32, "f"); } },
    clock: { nowIso: () => "2026-10-31T00:00:00.000Z" },
    document: {
      current: () => w.doc,
      stamp: (stamp: Stamp) => {
        const plan = stamp.plan(w.doc);
        if (plan) plan.apply(w.doc);
        return null;
      }
    },
    location: {
      home: () => location.home(),
      fileHome: () => location.fileHome(),
      setHome: (kind, fields) => location.setHome(kind, fields),
      amendHome: (record, fields) => location.amendHome(record, fields),
      restoreHome: (record) => location.restoreHome(record),
      writtenOut: () => location.writtenOut(),
      markWrittenOut: (on) => { location.markWrittenOut(on); }
    },
    lastFile: { remember: (handle) => { w.remembered.push(handle.name); w.onRemember?.(); return Promise.resolve(); } },
    pictures: { ensureBytes: () => Promise.resolve([]) },
    exports: { captureExportDocument: (opts) => buildExportDocument(w.doc, "2026-10-31T00:00:00.000Z", NO_MODELS, opts) },
    formats: {
      buildSplitpage: (doc) => JSON.stringify(doc.document),
      buildMarkdown: (doc) => JSON.stringify(doc.document),
      imagesMissing: () => []
    },
    files: {
      dialogs: () => ({ desktop: null, browser: null }),
      pick: () => {
        const next = w.picks.shift() ?? { kind: "cancelled" as const };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      existing: (handle) => ({ kind: "handle", handle, picked: false }),
      checkConflict: (handle) => {
        const target = handle as Disk;
        return Promise.resolve(target.changedOnDisk ? { ok: false, current: { lastModified: target.lastModified } } : { ok: true });
      },
      write: async (handle, body) => {
        const target = handle as Disk;
        const held = target.held;
        target.held = null;
        if (held) { held.arrived(); await held.released; }
        if (target.fails) { const error = target.fails; target.fails = null; throw error; }
        target.text = body;
        target.lastModified += 1000;
        target.writes++;
        return { lastModified: target.lastModified };
      },
      isAbort: (error) => !!error && (error as { name?: string }).name === "AbortError"
    },
    delivery: { deliver: (filename) => { w.downloads.push(filename); return Promise.resolve(true); } },
    saves: {
      policy: () => ({ enabled: () => false }),
      confirmSavedNow: () => { w.confirms.push("confirmSavedNow"); live().confirmClean(); },
      halt: () => {},
      resume: () => {},
      changes: () => live().changes()
    },
    notices: {
      show: (message, kind, sticky) => { w.toasts.push(message); w.onToast?.(message); return shown.show(message, kind, sticky); },
      imagesLeftOut: () => {}
    },
    preferences: { editorName: () => "Adam", autosave: () => false },
    page: { getElementById: () => null },
    bundles: { beginMove: () => null }
  };
  const mounted = mountFileSaving(ports);
  const savePorts = mounted.savePorts(ownership);
  coordinator = createSaveCoordinator<FileSaveRequest, unknown>({
    ownership,
    destination: { current: savePorts.destination, keyOf: savePorts.keyOf },
    writer: { write: (job) => mounted.destination().write(job) },
    report: { obsolete: savePorts.obsolete },
    join: joinSaves as unknown as (pending: FileSaveRequest, next: FileSaveRequest) => FileSaveRequest | null
  });
  const built: World = Object.assign(w, { ownership, coordinator: live(), mounted });
  return built;
}

function open(w: World, target: Disk, docId: string, audio: string, readAt = target.lastModified): Home {
  w.epoch++;
  w.doc = script(docId, audio);
  const home = w.location.setHome("file", { handle: target, format: "splitpage", name: target.name, lastModified: readAt, diskBase: cloneState(w.doc) });
  w.location.markWrittenOut(true);
  w.coordinator.confirmBaseline(cloneState(w.doc));
  w.coordinator.confirmClean();
  return home;
}

function edit(w: World, audio: string): void {
  (w.doc.rows[0] as { audioText: string }).audioText = audio;
  w.coordinator.noteChange();
}

function request(w: World, kind: string): Promise<SaveOutcome> {
  return w.coordinator.request({ kind });
}

function snapshot(w: World) {
  const home = w.location.home();
  const confirmed = w.coordinator.confirmed();
  return {
    docId: w.doc.docId,
    rev: w.doc.rev,
    audio: audioOf(w.doc),
    home: home.kind === "file" ? (home.handle as Disk).name : home.kind,
    lastModified: home.kind === "file" ? home.lastModified : null,
    diskBase: home.kind === "file" ? audioOf(home.diskBase) : null,
    writtenOut: w.location.writtenOut(),
    baseline: audioOf(confirmed.baseline),
    baselineId: confirmed.baseline ? (confirmed.baseline as Scripted).docId : null,
    generation: confirmed.generation,
    changes: w.coordinator.changes(),
    dirty: w.coordinator.dirty(),
    unsaved: w.coordinator.unsaved()
  };
}

async function turns(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("later edits: an edit while the write runs keeps the save's baseline and generation and leaves the document dirty", async () => {
  const w = world();
  const a = disk("a.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "Before.");
  const held = hold(a);
  const saving = request(w, "save");
  await held.arrived;
  edit(w, "During.");
  held.release();
  assert.deepEqual(await saving, { kind: "saved", acknowledged: true });
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 3, audio: "During.", home: "a.splitpage", lastModified: 2000, diskBase: "Before.", writtenOut: true,
    baseline: "Before.", baselineId: OLD_ID, generation: 1, changes: 2, dirty: true, unsaved: true
  });
  assert.deepEqual(w.confirms, [], "the edit made during the write keeps the document unconfirmed");
  assert.deepEqual(w.toasts, ["Saved to a.splitpage"]);
});

test("a queued second save waits for the first and ends clean with the later bytes as baseline", async () => {
  const w = world();
  const a = disk("a.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "First.");
  const held = hold(a);
  const first = request(w, "save");
  await held.arrived;
  edit(w, "Second.");
  const second = request(w, "force");
  assert.equal(w.coordinator.waiting(), 1, "the second save waits behind the running one");
  held.release();
  assert.deepEqual(await first, { kind: "saved", acknowledged: true });
  assert.deepEqual(await second, { kind: "saved", acknowledged: true });
  assert.equal(a.writes, 2);
  assert.ok(a.text.includes("Second."));
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 4, audio: "Second.", home: "a.splitpage", lastModified: 3000, diskBase: "Second.", writtenOut: true,
    baseline: "Second.", baselineId: OLD_ID, generation: 2, changes: 2, dirty: false, unsaved: false
  });
  assert.deepEqual(w.toasts, ["Saved to a.splitpage", "Saved to a.splitpage"]);
});

test("same-id reopen: a write that lands after its file was reopened is obsolete here, reported once, and changes nothing open", async () => {
  const w = world();
  const a = disk("a.splitpage");
  const first = open(w, a, OLD_ID, "One.");
  edit(w, "Before.");
  const held = hold(a);
  const saving = request(w, "save");
  await held.arrived;
  const reopened = open(w, a, OLD_ID, "One.");
  assert.notEqual(reopened, first);
  held.release();
  assert.deepEqual(await saving, { kind: "obsolete", here: true });
  assert.ok(a.text.includes("Before."), "the bytes landed");
  assert.equal(w.location.home(), reopened);
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 2, audio: "One.", home: "a.splitpage", lastModified: 1000, diskBase: "One.", writtenOut: true,
    baseline: "One.", baselineId: OLD_ID, generation: 1, changes: 1, dirty: false, unsaved: false
  });
  assert.deepEqual(w.toasts, ["Saved to a.splitpage", obsoleteSaveText("Pilot")]);
});

test("replacement: a write that lands after another file was opened is obsolete elsewhere, says nothing more and confirms neither place", async () => {
  const w = world();
  const a = disk("a.splitpage");
  const b = disk("b.splitpage");
  const homeA = open(w, a, OLD_ID, "One.");
  edit(w, "Before.");
  const held = hold(a);
  const saving = request(w, "save");
  await held.arrived;
  open(w, b, OTHER_ID, "Other.");
  edit(w, "Other edit.");
  held.release();
  assert.deepEqual(await saving, { kind: "obsolete", here: false });
  assert.deepEqual(snapshot(w), {
    docId: OTHER_ID, rev: 2, audio: "Other edit.", home: "b.splitpage", lastModified: 1000, diskBase: "Other.", writtenOut: true,
    baseline: "Other.", baselineId: OTHER_ID, generation: 1, changes: 2, dirty: true, unsaved: true
  });
  assert.equal(w.coordinator.confirmed(homeA).generation, 0,"the old file's confirmed generation did not advance");
  assert.equal(audioOf(w.coordinator.confirmed(homeA).baseline), "One.");
  assert.equal(homeA.lastModified, 1000, "the old home keeps its stamp");
  assert.deepEqual(w.toasts, ["Saved to a.splitpage"]);
});

test("a save queued before a reopen settles obsolete without writing", async () => {
  const w = world();
  const a = disk("a.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "First.");
  const held = hold(a);
  const first = request(w, "save");
  await held.arrived;
  edit(w, "Second.");
  const second = request(w, "force");
  open(w, a, OLD_ID, "One.");
  held.release();
  assert.deepEqual(await first, { kind: "obsolete", here: true });
  assert.deepEqual(await second, { kind: "obsolete", here: false });
  assert.equal(a.writes, 1, "the queued save from the earlier epoch never wrote");
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 2, audio: "One.", home: "a.splitpage", lastModified: 1000, diskBase: "One.", writtenOut: true,
    baseline: "One.", baselineId: OLD_ID, generation: 2, changes: 2, dirty: false, unsaved: false
  });
  assert.deepEqual(w.toasts, ["Saved to a.splitpage", obsoleteSaveText("Pilot")]);
});

test("Save As of a written-out script forks the id, moves the destination and confirms the new place only", async () => {
  const w = world();
  const a = disk("a.splitpage");
  const b = disk("b.splitpage");
  const homeA = open(w, a, OLD_ID, "One.");
  edit(w, "Copied.");
  w.picks.push({ kind: "handle", handle: b, picked: true });
  assert.deepEqual(await request(w, "saveAs"), { kind: "saved", acknowledged: true });
  assert.deepEqual(snapshot(w), {
    docId: NEW_ID, rev: 3, audio: "Copied.", home: "b.splitpage", lastModified: 2000, diskBase: "Copied.", writtenOut: true,
    baseline: "Copied.", baselineId: NEW_ID, generation: 1, changes: 1, dirty: false, unsaved: false
  });
  assert.equal(w.coordinator.confirmed(homeA).generation, 0,"the old file's generation stays where it was");
  assert.equal(audioOf(w.coordinator.confirmed(homeA).baseline), "One.");
  assert.equal(a.writes, 0);
  assert.deepEqual(w.history, [OLD_ID + ">" + NEW_ID]);
  assert.deepEqual(w.remembered, ["b.splitpage"]);
  assert.deepEqual(w.toasts, ["Saved a new copy: b.splitpage"]);
});

test("Save As: a Save asked for while it writes waits behind it and writes the new file", async () => {
  const w = world();
  const a = disk("a.splitpage");
  const b = disk("b.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "Copied.");
  w.picks.push({ kind: "handle", handle: b, picked: true });
  const held = hold(b);
  const copy = request(w, "saveAs");
  await held.arrived;
  edit(w, "After.");
  const save = request(w, "save");
  assert.equal(w.coordinator.waiting(), 1, "the Save waits behind the Save As on the new file");
  held.release();
  assert.deepEqual(await copy, { kind: "saved", acknowledged: true });
  assert.deepEqual(await save, { kind: "saved", acknowledged: true });
  assert.equal(a.writes, 0);
  assert.equal(b.writes, 2);
  assert.ok(b.text.includes("After."));
  assert.deepEqual(snapshot(w), {
    docId: NEW_ID, rev: 4, audio: "After.", home: "b.splitpage", lastModified: 3000, diskBase: "After.", writtenOut: true,
    baseline: "After.", baselineId: NEW_ID, generation: 2, changes: 2, dirty: false, unsaved: false
  });
  assert.deepEqual(w.toasts, ["Saved a new copy: b.splitpage", "Saved to b.splitpage"]);
});

test("an untitled Save picks a file, keeps its id and confirms the picked place", async () => {
  const w = world();
  const b = disk("b.splitpage");
  edit(w, "Typed.");
  w.picks.push({ kind: "handle", handle: b, picked: true });
  assert.deepEqual(await request(w, "save"), { kind: "saved", acknowledged: true });
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 3, audio: "Typed.", home: "b.splitpage", lastModified: 2000, diskBase: "Typed.", writtenOut: true,
    baseline: "Typed.", baselineId: OLD_ID, generation: 1, changes: 1, dirty: false, unsaved: false
  });
  assert.deepEqual(w.history, []);
  assert.deepEqual(w.toasts, ["Saved to b.splitpage"]);
});

test("an untitled Save with no picker downloads and confirms the document with no file home", async () => {
  const w = world();
  edit(w, "Typed.");
  w.picks.push({ kind: "download" });
  assert.deepEqual(await request(w, "save"), { kind: "saved", acknowledged: true });
  assert.deepEqual(w.downloads, ["pilot.md"]);
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 3, audio: "Typed.", home: "none", lastModified: null, diskBase: null, writtenOut: true,
    baseline: "Typed.", baselineId: OLD_ID, generation: 1, changes: 1, dirty: false, unsaved: false
  });
});

const UNTOUCHED_UNTITLED = {
  docId: OLD_ID, rev: 2, audio: "Typed.", home: "none", lastModified: null, diskBase: null, writtenOut: false,
  baseline: null, baselineId: null, generation: 0, changes: 1, dirty: true, unsaved: true
};

test("cancellation: a dismissed picker and an aborted one are cancelled and change nothing", async () => {
  for (const pick of [{ kind: "cancelled" } as const, Object.assign(new Error("no"), { name: "AbortError" })]) {
    const w = world();
    edit(w, "Typed.");
    w.picks.push(pick);
    assert.deepEqual(await request(w, "save"), { kind: "cancelled" });
    assert.deepEqual(snapshot(w), UNTOUCHED_UNTITLED);
    assert.deepEqual(w.toasts, []);
  }
});

test("refusal: a file changed on disk refuses the save with its conflict and changes nothing", async () => {
  const w = world();
  const a = disk("a.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "Before.");
  a.changedOnDisk = true;
  assert.deepEqual(await request(w, "save"), {
    kind: "refused", reason: "The file changed on disk since it was opened",
    conflict: { fileName: "a.splitpage", current: { lastModified: 1000 }, kind: "project" }
  });
  assert.equal(a.writes, 0);
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 2, audio: "Before.", home: "a.splitpage", lastModified: 1000, diskBase: "One.", writtenOut: true,
    baseline: "One.", baselineId: OLD_ID, generation: 0, changes: 1, dirty: true, unsaved: true
  });
  assert.deepEqual(w.toasts, []);
});

test("failure: a Save As whose write fails puts the old place back and keeps the id, the baseline and the dirty state", async () => {
  const w = world();
  const a = disk("a.splitpage");
  const b = disk("b.splitpage");
  const homeA = open(w, a, OLD_ID, "One.");
  edit(w, "Before.");
  b.fails = new Error("disk full");
  w.picks.push({ kind: "handle", handle: b, picked: true });
  const outcome = await request(w, "saveAs");
  assert.equal(outcome.kind, "failed");
  assert.equal(w.location.home(), homeA, "the retarget was undone");
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 2, audio: "Before.", home: "a.splitpage", lastModified: 1000, diskBase: "One.", writtenOut: true,
    baseline: "One.", baselineId: OLD_ID, generation: 0, changes: 1, dirty: true, unsaved: true
  });
  assert.deepEqual(w.history, []);
  assert.deepEqual(w.toasts, ["Could not save — disk full."]);
});

test("a landed obsolete Save As copies the history only and is not acknowledged anywhere", async () => {
  const w = world();
  const a = disk("a.splitpage");
  const b = disk("b.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "Copied.");
  w.picks.push({ kind: "handle", handle: b, picked: true });
  const held = hold(b);
  const copy = request(w, "saveAs");
  await held.arrived;
  const reopened = open(w, a, OLD_ID, "One.");
  held.release();
  assert.deepEqual(await copy, { kind: "obsolete", here: false });
  assert.ok(b.text.includes("Copied."), "the copy's bytes landed");
  assert.equal(w.location.home(), reopened);
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 2, audio: "One.", home: "a.splitpage", lastModified: 1000, diskBase: "One.", writtenOut: true,
    baseline: "One.", baselineId: OLD_ID, generation: 1, changes: 1, dirty: false, unsaved: false
  });
  assert.equal(w.coordinator.confirmed({ kind: "file", handle: b }).generation, 0, "the copy's file was never confirmed");
  assert.deepEqual(w.history, [OLD_ID + ">" + NEW_ID]);
  assert.deepEqual(w.remembered, []);
  assert.deepEqual(w.toasts, ["Saved a new copy: b.splitpage"]);
});

test("disposal during a write: the stopped coordinator's save settles obsolete and touches neither the document nor the save state", async () => {
  const w = world();
  const a = disk("a.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "Before.");
  const held = hold(a);
  const saving = request(w, "save");
  await held.arrived;
  const before = snapshot(w);
  w.coordinator.stop();
  held.release();
  assert.deepEqual(await saving, { kind: "obsolete", here: false });
  assert.ok(a.text.includes("Before."), "the bytes landed");
  assert.deepEqual(snapshot(w), before);
  assert.deepEqual(w.confirms, []);
  assert.deepEqual(w.toasts, ["Saved to a.splitpage"]);
});

test("history that never resolves: a forked Save As still settles saved, and a forked obsolete one still settles obsolete", async () => {
  const w = world();
  w.historyHangs = true;
  const a = disk("a.splitpage");
  const b = disk("b.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "Copied.");
  w.picks.push({ kind: "handle", handle: b, picked: true });
  const copy = request(w, "saveAs");
  await turns();
  assert.deepEqual(await copy, { kind: "saved", acknowledged: true });
  assert.equal(w.doc.docId, NEW_ID);
  assert.equal(w.coordinator.running(), false);
  assert.deepEqual(w.history, [OLD_ID + ">" + NEW_ID]);

  const v = world();
  v.historyHangs = true;
  const c = disk("c.splitpage");
  const d = disk("d.splitpage");
  open(v, c, OLD_ID, "One.");
  edit(v, "Copied.");
  v.picks.push({ kind: "handle", handle: d, picked: true });
  const held = hold(d);
  const late = request(v, "saveAs");
  await held.arrived;
  open(v, c, OLD_ID, "One.");
  held.release();
  assert.deepEqual(await late, { kind: "obsolete", here: false });
  assert.equal(v.doc.docId, OLD_ID);
  assert.deepEqual(v.history, [OLD_ID + ">" + NEW_ID]);
  assert.equal(v.coordinator.running(), false);
});

test("same-file reopen after the landing: an open of the same file that adopts bytes it read earlier, before the writer answers, still gets the late-save warning", async () => {
  const w = world();
  const a = disk("a.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "Before.");
  const readEarlier = a.lastModified;
  let reopened: Home | null = null;
  w.onToast = (message) => {
    if (message !== "Saved to a.splitpage" || reopened) return;
    reopened = open(w, a, OLD_ID, "One.", readEarlier);
  };
  assert.deepEqual(await request(w, "save"), { kind: "obsolete", here: true });
  assert.equal(w.location.home(), reopened);
  assert.ok(a.text.includes("Before."), "the bytes landed");
  assert.deepEqual(w.toasts, ["Saved to a.splitpage", obsoleteSaveText("Pilot")]);
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 2, audio: "One.", home: "a.splitpage", lastModified: 1000, diskBase: "One.", writtenOut: true,
    baseline: "One.", baselineId: OLD_ID, generation: 1, changes: 1, dirty: false, unsaved: false
  });
});

test("one decision: a Save As decided current when it landed is complete there, and a move before the writer answers is still judged obsolete elsewhere", async () => {
  const w = world();
  const a = disk("a.splitpage");
  const b = disk("b.splitpage");
  open(w, a, OLD_ID, "One.");
  edit(w, "Copied.");
  w.picks.push({ kind: "handle", handle: b, picked: true });
  const copyHome: Home[] = [];
  w.onRemember = () => { copyHome.push(w.location.home()); open(w, a, OLD_ID, "One."); };
  assert.deepEqual(await request(w, "saveAs"), { kind: "obsolete", here: false });
  const [picked] = copyHome;
  assert.ok(picked);
  assert.equal(w.coordinator.confirmed(picked).generation, 1, "the copy's file was confirmed when the write landed");
  assert.equal(audioOf(w.coordinator.confirmed(picked).baseline), "Copied.");
  assert.equal((w.coordinator.confirmed(picked).baseline as Scripted).docId, NEW_ID);
  assert.deepEqual(w.history, [OLD_ID + ">" + NEW_ID]);
  assert.deepEqual(w.toasts, ["Saved a new copy: b.splitpage"], "the reopened file is not where the copy landed, so no late-save notice");
  assert.deepEqual(snapshot(w), {
    docId: OLD_ID, rev: 2, audio: "One.", home: "a.splitpage", lastModified: 1000, diskBase: "One.", writtenOut: true,
    baseline: "One.", baselineId: OLD_ID, generation: 1, changes: 1, dirty: false, unsaved: false
  });
});
