import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { startDocumentGuard } from "../../../src/application/identity/document-guard.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { CapabilityPort } from "../../../src/application/session/ports.ts";
import { mountFileSaving } from "../../../src/application/save/file-saving.ts";
import type { FileSavingPorts, FileSaveTarget } from "../../../src/application/save/file-saving-ports.ts";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeClock } from "../session-fakes.ts";
import { fakeNotices } from "../../features/fakes.ts";
import { adoptReplacement, currentCapabilities, currentDocument, heldDocument, liveSession, stampDocument, startSessionBridge } from "../../../src/bootstrap/wiring/session-owner.ts";
import { startLocation, documentLocation } from "../../../src/bootstrap/wiring/location-owner.ts";
import { startUndo, undoPorts, undoOwner, undoSessionPort, routeUndoReplays } from "../../../src/bootstrap/wiring/undo.ts";
import { captureOperation, documentTransitions, startTransitions, stillOwns } from "../../../src/bootstrap/wiring/transition-owners.ts";
import { capabilities } from "../../../src/bootstrap/wiring/ports/capabilities.ts";
import { autoSavePolicy, confirmBaseline, confirmSavedNow, fileConflicts, noteSaveChange, requestSave, saveChanges, saveDestinations, startSaves } from "../../../src/bootstrap/wiring/save-owners.ts";
import { startEffects } from "../../../src/bootstrap/wiring/effects-owner.ts";

const STANDALONE = createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
const SHARED = createSessionCapabilities("shared", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(t: TestContext, mode: "assets" | "picker" | "bundle" | "failure" | "conflict" | "queued conflict" = "assets", source: CapabilityPort = STANDALONE) {
  const clock = fakeClock();
  const effects: string[] = [];
  const writes: unknown[][] = [];
  const obsolete: unknown[][] = [];
  const remembered: string[] = [];
  const captured: string[] = [];
  const notices = fakeNotices();
  const gate = deferred<undefined>();
  const entered = deferred<undefined>();
  let replacement = false;
  let nextCapability = source;
  const doc = (text: string, id: string) => migrateRows({ docId: id, title: "Pilot", rows: [{ id: "r1", audioText: text, visualText: "" }] }, fakeMigration().ports);
  t.after(startDocumentGuard(false, error => { throw error; }));
  t.after(startEffects({ notices: notices.notices, menuItems: { setLabel: () => {}, setReason: () => {} }, clipboard: { copyText: async () => false } }));
  t.after(startLocation());
  t.after(startUndo(undoPorts()));
  t.after(startSessionBridge({
    entry: raw => migrateRows(raw, fakeMigration().ports),
    undo: { adapter: undoSessionPort(), route: routeUndoReplays },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: source, editor: { name: () => "Editor" }, records: () => null,
    attribution: { attribute: () => null }, report: error => { throw error; }, timers: clock
  }));
  const location = documentLocation();
  t.after(startTransitions({
    live: { current: heldDocument, assign: next => { adoptReplacement(next, nextCapability); } },
    destination: { set: destination => { location.setHome(destination.kind, destination.fields); }, confirm: baseline => { confirmBaseline(baseline); } },
    identity: { mint: () => "d33333333333333333333333333333333", writtenOut: location.writtenOut, markWrittenOut: location.markWrittenOut },
    history: { keep: () => null }
  }));
  const touch = (name: string) => { if (replacement) effects.push(name); };
  const original = { name: "old.splitpage" };
  const copy = { name: "copy.splitpage" };
  const ports: FileSavingPorts = {
    capability: capabilities,
    edits: { edit: () => { touch("edit"); return false; } },
    history: { hold: () => { touch("hold"); return undoOwner().hold(); }, amendRows: () => { touch("amend rows"); return "unchanged"; }, reset: () => { touch("reset undo"); } },
    deferred: { copyHistory: () => {}, syncIdentity: () => { touch("identity"); }, setBaseline: () => { touch("baseline"); } },
    ids: { docId: () => "d33333333333333333333333333333333" }, clock: { nowIso: () => "2026-11-12T00:00:00.000Z" },
    document: { current: () => { touch("current document"); return currentDocument(); }, stamp: (...args) => { touch("stamp"); return stampDocument(...args); } },
    location: {
      home: location.home, fileHome: location.fileHome, writtenOut: location.writtenOut, restoreHome: record => { touch("restore home"); return location.restoreHome(record); },
      setHome: (kind, fields) => { touch("set home"); return location.setHome(kind, fields); },
      amendHome: (record, fields) => { touch("amend home"); return location.amendHome(record, fields); },
      markWrittenOut: value => { touch("written out"); location.markWrittenOut(value); }
    },
    lastFile: { remember: async handle => { remembered.push(handle.name); touch("remember"); } },
    pictures: { ensureBytes: async () => { if (mode === "assets" || mode === "failure") { entered.resolve(undefined); await gate.promise; } return []; } },
    exports: { captureExportDocument: options => {
      const current = currentDocument();
      assert.ok(current);
      captured.push(String(current.rows[0]?.audioText));
      return buildExportDocument(current, "2026-11-12T00:00:00.000Z", { production: [], commentNumbers: {}, broll: [] }, options);
    } },
    formats: { buildSplitpage: capture => String(capture.document.rows[0]?.audioText), buildMarkdown: capture => String(capture.document.rows[0]?.audioText), imagesMissing: () => [] },
    files: {
      dialogs: () => ({ desktop: null, browser: null }),
      pick: async (): Promise<FileSaveTarget> => { if (mode === "picker" || mode === "queued conflict") { entered.resolve(undefined); await gate.promise; } return { kind: "handle", handle: copy, picked: true }; },
      existing: handle => ({ kind: "handle", handle, picked: false }), checkConflict: async () => {
        if (mode === "conflict") { entered.resolve(undefined); await gate.promise; return { ok: false, current: null }; }
        if (mode === "queued conflict") return { ok: false, current: null };
        return { ok: true };
      },
      write: async (handle, body) => { writes.push([handle.name, body]); if (mode === "failure") throw new Error("write failed"); return { lastModified: 10 }; }, isAbort: () => false
    },
    delivery: { deliver: async () => { throw new Error("unexpected download"); } },
    saves: { policy: autoSavePolicy, confirmSavedNow: () => { touch("confirm clean"); confirmSavedNow(); }, changes: saveChanges,
      halt: () => { touch("halt"); }, resume: () => { touch("resume"); } },
    notices: { ...notices.notices, imagesLeftOut: () => {} },
    preferences: { editorName: () => "Editor", autosave: () => true }, page: { getElementById: () => null },
    bundles: { beginSave: () => ({ drained: mode === "bundle" ? (entered.resolve(undefined), gate.promise.then(() => true)) : null, ask: async () => [], end: () => {} }) }
  };
  const saving = mountFileSaving(ports);
  t.after(saving.dispose);
  t.after(startSaves({ ...saving.savePorts({ capture: captureOperation, stillOwns }), obsolete: (request, here) => { obsolete.push([request.kind, here]); } }, clock));
  const registered = { ...saving.destination() };
  t.after(saveDestinations().register(registered));
  documentTransitions().open({ from: { document: doc("Captured standalone text.", "d11111111111111111111111111111111") }, reason: "initial", destination: { kind: "file", fields: { handle: original, format: "splitpage", name: original.name } }, writtenOut: true });
  noteSaveChange();
  return {
    entered: entered.promise, release: () => { gate.resolve(undefined); }, effects, writes, obsolete, remembered, captured, location, clock, registered, notices,
    replace: (retainHome = false, mode: "shared" | "standalone" = "shared") => {
      nextCapability = mode === "shared" ? SHARED : STANDALONE;
      const previousEpoch = liveSession().epoch();
      const text = mode === "shared" ? "Shared replacement text." : "Standalone replacement text.";
      if (retainHome) documentTransitions().restore({ from: { document: doc(text, "d22222222222222222222222222222222") } });
      else documentTransitions().open({ from: { document: doc(text, "d22222222222222222222222222222222") }, reason: "replacement", destination: { kind: "none" }, writtenOut: false });
      assert.equal(liveSession().epoch(), previousEpoch + 1);
      replacement = true;
    }
  };
}

for (const mode of ["standalone", "shared"] as const) {
  test(mode + " replacement: a late manual conflict remains visible without offering shared file actions", async t => {
    const h = harness(t, "conflict");
    const saving = requestSave({ kind: "save" });
    await h.entered;
    h.replace(false, mode);
    h.release();
    assert.deepEqual(await saving, { kind: "refused", reason: "The file changed on disk since it was opened", conflict: { fileName: "old.splitpage", current: null, kind: "project" } });
    assert.deepEqual(fileConflicts().current(), mode === "standalone" ? { fileName: "old.splitpage", current: null, kind: "project" } : null);
    assert.deepEqual(h.notices.shown.map(({ message, kind }) => [message, kind]), mode === "standalone" ? [] : [["The file changed on disk since it was opened", "warn"]]);
    assert.deepEqual(h.notices.shown.map(({ label, action }) => [label, action]), mode === "standalone" ? [] : [[undefined, undefined]]);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.effects, []);
    assert.deepEqual(h.location.home(), { kind: "none" });
    assert.equal(h.clock.armed(), 0);
  });

  test(mode + " replacement: a completed captured Save As remembers its handle only when the current session permits it", async t => {
    const h = harness(t);
    const saving = requestSave({ kind: "saveAs" });
    await h.entered;
    const home = h.location.home();
    h.replace(true, mode);
    h.release();
    assert.deepEqual(await saving, { kind: "obsolete", here: true });
    assert.deepEqual(h.writes, [["copy.splitpage", "Captured standalone text."]]);
    assert.deepEqual(h.remembered, mode === "standalone" ? ["copy.splitpage"] : []);
    assert.deepEqual(h.effects, mode === "standalone" ? ["remember"] : []);
    assert.equal(h.location.home(), home);
    assert.deepEqual(h.notices.shown.map(({ message, kind }) => [message, kind]), mode === "standalone"
      ? [["Saved a new copy: copy.splitpage", "ok"]]
      : [["Save destinations are not available in a shared session.", "warn"], ["Saved a new copy: copy.splitpage", "ok"]]);
    assert.equal(h.clock.armed(), 0);
  });

  test(mode + " replacement: a failed captured Save As rolls back its target only when the current session permits it", async t => {
    const h = harness(t, "failure");
    const previousHome = h.location.home();
    const saving = requestSave({ kind: "saveAs" });
    await h.entered;
    const home = h.location.home();
    h.replace(true, mode);
    h.release();
    assert.deepEqual(await saving, { kind: "failed", error: new Error("write failed") });
    assert.equal(h.location.home(), mode === "standalone" ? previousHome : home);
    assert.deepEqual(h.writes, [["copy.splitpage", "Captured standalone text."]]);
    assert.deepEqual(h.remembered, []);
    assert.deepEqual(h.effects, mode === "standalone" ? ["restore home"] : []);
    assert.deepEqual(h.notices.shown.map(({ message, kind }) => [message, kind]), mode === "standalone"
      ? [["Could not save — write failed.", "error"]]
      : [["Could not save — write failed.", "error"], ["Save destinations are not available in a shared session.", "warn"]]);
    assert.equal(h.clock.armed(), 0);
  });

  test(mode + " replacement: an uncaptured Save As leaving bundle drain asks the current session before capture", async t => {
    const h = harness(t, "bundle");
    const saving = requestSave({ kind: "saveAs" });
    await h.entered;
    h.replace(false, mode);
    h.release();
    assert.deepEqual(await saving, mode === "standalone" ? { kind: "obsolete", here: false } : { kind: "cancelled" });
    assert.deepEqual(h.captured, mode === "standalone" ? ["Standalone replacement text."] : []);
    assert.deepEqual(h.writes, mode === "standalone" ? [["copy.splitpage", "Standalone replacement text."]] : []);
    assert.deepEqual(h.effects, mode === "standalone" ? ["hold", "current document", "current document"] : []);
    assert.deepEqual(h.remembered, []);
    assert.deepEqual(h.location.home(), { kind: "none" });
    assert.deepEqual(h.notices.shown.map(({ message, kind }) => [message, kind]), mode === "standalone"
      ? [["Saved a new copy: copy.splitpage", "ok"]]
      : [["Save destinations are not available in a shared session.", "warn"]]);
    assert.equal(h.clock.armed(), 0);
  });
}

for (const kind of ["save", "force", "auto", "autosave", "saveAs"] as const) {
  test(kind + ": real replacement by shared answers preserves the captured write and drops landing effects", async t => {
    const h = harness(t);
    const heldCapability = currentCapabilities();
    const saving = requestSave({ kind });
    await h.entered;
    h.replace();
    assert.notEqual(currentCapabilities(), heldCapability);
    assert.deepEqual(heldCapability.saveDestinations(), { allowed: true });
    assert.deepEqual(currentCapabilities().saveDestinations(), { allowed: false, reason: "Save destinations are not available in a shared session." });
    h.registered.write = async () => { h.writes.push(["replacement writer"]); return { kind: "failed" }; };
    h.release();
    assert.deepEqual(await saving, { kind: "obsolete", here: false });
    assert.deepEqual(h.writes, [[kind === "saveAs" ? "copy.splitpage" : "old.splitpage", "Captured standalone text."]]);
    assert.deepEqual(h.captured, ["Captured standalone text."]);
    assert.deepEqual(h.obsolete, [[kind, false]]);
    assert.deepEqual(h.effects, []);
    assert.deepEqual(h.remembered, []);
    assert.deepEqual(h.location.home(), { kind: "none" });
    assert.equal(h.clock.armed(), 0);
    assert.equal(currentDocument()?.rows[0]?.audioText, "Shared replacement text.");
    for (const attempt of ["save", "force", "auto", "autosave", "saveAs"] as const) {
      assert.deepEqual(await requestSave({ kind: attempt }), { kind: "refused", reason: "Save destinations are not available in a shared session." });
    }
    assert.deepEqual(h.effects, []);
    assert.equal(h.writes.length, 1);
    assert.equal(h.clock.armed(), 0);
  });
}

test("a picker resolving after real shared replacement writes the captured copy without adopting or remembering its target", async t => {
  const h = harness(t, "picker");
  const saving = requestSave({ kind: "saveAs" });
  await h.entered;
  h.replace();
  h.release();
  assert.deepEqual(await saving, { kind: "obsolete", here: false });
  assert.deepEqual(h.writes, [["copy.splitpage", "Captured standalone text."]]);
  assert.deepEqual(h.effects, []);
  assert.deepEqual(h.remembered, []);
  assert.deepEqual(h.location.home(), { kind: "none" });
  assert.equal(h.clock.armed(), 0);
});

test("a shared replacement retaining the same home cannot inherit the old Save As handle reminder", async t => {
  const h = harness(t);
  const saving = requestSave({ kind: "saveAs" });
  await h.entered;
  const home = h.location.home();
  h.replace(true);
  h.release();
  assert.deepEqual(await saving, { kind: "obsolete", here: true });
  assert.deepEqual(h.writes, [["copy.splitpage", "Captured standalone text."]]);
  assert.equal(h.location.home(), home);
  assert.deepEqual(h.remembered, []);
  assert.deepEqual(h.effects, []);
  assert.equal(h.clock.armed(), 0);
});

test("a failed obsolete Save As cannot roll back a shared replacement to the previous file target", async t => {
  const h = harness(t, "failure");
  const saving = requestSave({ kind: "saveAs" });
  await h.entered;
  const home = h.location.home();
  h.replace(true);
  h.release();
  assert.equal((await saving).kind, "failed");
  assert.equal(h.location.home(), home);
  assert.deepEqual(h.writes, [["copy.splitpage", "Captured standalone text."]]);
  assert.deepEqual(h.effects, []);
  assert.deepEqual(h.remembered, []);
});

test("a late automatic conflict preserves main's pause diagnostic without scheduling or writing the shared replacement", async t => {
  const h = harness(t, "conflict");
  const saving = requestSave({ kind: "auto" });
  await h.entered;
  h.replace();
  h.release();
  assert.deepEqual(await saving, { kind: "refused", reason: "The file changed on disk since it was opened" });
  assert.deepEqual(h.effects, ["halt"]);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.location.home(), { kind: "none" });
  assert.equal(h.clock.armed(), 0);
});

test("a late manual conflict belongs to the captured session and cannot open a conflict on its shared replacement", async t => {
  const h = harness(t, "conflict");
  const saving = requestSave({ kind: "save" });
  await h.entered;
  h.replace();
  h.release();
  assert.deepEqual(await saving, { kind: "refused", reason: "The file changed on disk since it was opened", conflict: { fileName: "old.splitpage", current: null, kind: "project" } });
  assert.equal(fileConflicts().current(), null);
  assert.deepEqual(h.effects, []);
  assert.deepEqual(h.writes, []);
  assert.equal(h.clock.armed(), 0);
});

test("a Save queued behind Save As still presents its own conflict after that same session moves destination", async t => {
  const h = harness(t, "queued conflict");
  const copying = requestSave({ kind: "saveAs" });
  await h.entered;
  const saving = requestSave({ kind: "save" });
  h.release();
  assert.deepEqual(await copying, { kind: "saved", acknowledged: true });
  assert.deepEqual(await saving, { kind: "refused", reason: "The file changed on disk since it was opened", conflict: { fileName: "copy.splitpage", current: null, kind: "project" } });
  assert.deepEqual(fileConflicts().current(), { fileName: "copy.splitpage", current: null, kind: "project" });
  assert.deepEqual(h.writes, [["copy.splitpage", "Captured standalone text."]]);
  assert.deepEqual(h.obsolete, []);
});

test("replacement during bundle drain cancels the uncaptured Save As before it can hold undo or capture the shared document", async t => {
  const h = harness(t, "bundle");
  const saving = requestSave({ kind: "saveAs" });
  await h.entered;
  h.replace();
  h.release();
  assert.deepEqual(await saving, { kind: "cancelled" });
  assert.deepEqual(h.captured, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.effects, []);
  assert.deepEqual(h.location.home(), { kind: "none" });
  assert.equal(h.clock.armed(), 0);
});

test("a session retains the same frozen mode answers until real replacement, even if the supplied port is later changed", t => {
  const supplied = { ...STANDALONE };
  const h = harness(t, "assets", supplied);
  const held = currentCapabilities();
  const names = ["saveDestinations", "autosave", "merge", "stash", "drafts", "history", "folders", "bundles"] as const;
  for (const name of names) {
    const answer = held[name]();
    supplied[name] = SHARED[name];
    assert.equal(held[name](), answer);
    assert.deepEqual(answer, { allowed: true });
    assert.equal(Object.isFrozen(answer), true);
    assert.equal(Reflect.set(answer, "allowed", false), false);
    assert.equal(Reflect.set(held, name, SHARED[name]), false);
  }
  assert.equal(Object.isFrozen(held), true);
  assert.equal(currentCapabilities(), held);
  h.replace();
  assert.notEqual(currentCapabilities(), held);
  assert.equal(held.saveDestinations().allowed, true);
  assert.equal(currentCapabilities().saveDestinations().allowed, false);
});
