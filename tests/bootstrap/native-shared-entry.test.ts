import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { openNativeEditor } from "../../src/bootstrap/wiring/native-shared-session.ts";
import { adoptReplacement, currentDocument, holdSessionCommands, liveSession, mergeBase, onDocumentReplaced, onRefresh, onSessionChange, runCommand, sessionEntryRefusal, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession, leaveSharedSession,
  nativeEditorActive, nativeEditorRecords, SHARED_NOT_RUNNING, SHARED_SWITCHING } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedEditorBackend, SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { attemptNativeSwitchEntry, bootNativeEntrySwitchFixture as bootEntrySwitchFixture,
  nativeEntrySwitchFixture as entrySwitchFixture, stopNativeEntrySwitchFixture as stopEntrySwitchFixture } from "./native-entry-switch-support.ts";
import { titleCommand } from "../../src/application/commands/title.ts";
import { draftSource } from "../../src/bootstrap/wiring/drafts.ts";
import { notices } from "../../src/bootstrap/wiring/ports/effects.ts";
import { sharedUndoRoute, stepSharedUndo } from "../../src/bootstrap/wiring/undo.ts";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createNativeTestPeer } from "../../src/bootstrap/wiring/shared-native-test-peer.ts";
import { mountNativeSharedInput } from "../../src/bootstrap/wiring/native-shared-input.ts";
import { nativeUndoRoute } from "../../src/bootstrap/wiring/native-shared-undo.ts";
import { applyNativePeerUpdate } from "../../src/adapters/collab/native/peer-update.ts";
import { createNativeEditorRecords } from "../../src/bootstrap/wiring/native-shared-records.ts";
import { openNativeSession } from "../../src/adapters/collab/native/session.ts";
import { sanitizeHtml } from "../../src/bootstrap/richtext.ts";
import { addGalleryPicture, removeGallerySlot } from "../../src/core/document/gallery.ts";
import { fakeClock } from "../application/session-fakes.ts";

before(bootEntrySwitchFixture);
after(stopEntrySwitchFixture);

test("native hydration consumes the revision already included in its first paint", async t => {
  const { ports } = entrySwitchFixture(), doc = currentDocument();
  assert.ok(doc);
  const { native, backend } = openNativeEditor(ports, doc, () => false);
  t.after(() => { backend.dispose(step => { step(); return true; }); });
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 8);
  assert.ok(at.kind === "anchored");
  assert.equal(native.commands.typeText(at.range, "!", {}).kind, "written");
  backend.start();
  assert.equal(backend.replica.revision(), 1);
  await Promise.resolve();
  assert.equal(backend.replica.revision(), 1);
  assert.equal(native.narrationHtml("R1"), "Captured! words");
});

async function nativeEntry(fixture: ReturnType<typeof entrySwitchFixture>) {
  const opened: { value?: ReturnType<typeof openNativeEditor> } = {};
  const result = await enterSharedSession(fixture.ports, (doc, failed) => {
    opened.value = openNativeEditor(fixture.ports, doc, failed);
    return opened.value.backend;
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(opened.value);
  return opened.value.native;
}

test("preflight refuses before selecting a backend and retry opens the native backend", async t => {
  const fixture = entrySwitchFixture();
  t.after(fixture.close);
  const open = t.mock.fn(() => { throw new Error("open"); });
  assert.deepEqual(await enterSharedSession({ ...fixture.ports, refusal: () => "held" }, open), { ok: false, reason: "held" });
  assert.equal(open.mock.callCount(), 0);
  await nativeEntry(fixture);
  assert.equal(nativeEditorActive(), true);
  assert.equal(currentDocument()?.rows[0]?.audioText, "Captured words");
});

test("the installed owner hears adoption and diffs the asynchronous native snapshot", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const seen: { kind: string; text: string | null | undefined; fields: readonly unknown[] }[] = [];
  t.after(onSessionChange(change => seen.push({ kind: change.kind, text: currentDocument()?.rows[0]?.audioText, fields: change.changes.cells })));
  const native = await nativeEntry(fixture);
  assert.deepEqual(seen, [{ kind: "adopt", text: "Captured words", fields: [] }]);
  const anchor = native.commands.anchorText({ beat: "R1", cell: "narration" }, 8);
  if (anchor.kind !== "anchored") throw new Error(anchor.reason);
  assert.equal(native.commands.typeText(anchor.range, "!", {}).kind, "written");
  assert.equal(currentDocument()?.rows[0]?.audioText, "Captured words");
  await Promise.resolve();
  assert.deepEqual(seen.at(-1), { kind: "remote", text: "Captured! words", fields: [{ rowId: "R1", field: "audioText" }] });
  assert.equal(seen.length, 2);
});

test("native entry rolls back after adoption if draft detachment fails", async () => {
  const fixture = entrySwitchFixture(), beforeEntry = currentDocument();
  const reattach = test.mock.fn();
  const result = await enterSharedSession({ ...fixture.ports, reattach, detach: () => { throw new Error("detach"); } },
    (doc, failed) => openNativeEditor(fixture.ports, doc, failed).backend);
  assert.deepEqual(result, { ok: false, reason: "enter-failed" });
  assert.equal(sharedSession(), false);
  assert.equal(currentDocument(), beforeEntry);
  assert.equal(reattach.mock.callCount(), 1);
});

test("failed close lands the committed bytes when no changed event was emitted", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const notice = t.mock.method(notices, "show", () => {});
  const native = await nativeEntry(fixture);
  const sharedId = currentDocument()?.docId;
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 0);
  if (at.kind !== "anchored") throw new Error(at.reason);
  native.ydoc.once("afterTransactionCleanup", () => { throw new Error("interrupted cleanup"); });
  assert.throws(() => native.commands.typeText(at.range, "!", {}), /interrupted cleanup/);
  assert.equal(currentDocument()?.rows[0]?.audioText, "Captured words");
  await Promise.resolve();
  assert.equal(sharedSession(), false);
  assert.notEqual(currentDocument()?.docId, sharedId);
  assert.equal(currentDocument()?.rows[0]?.audioText, "!Captured words");
  assert.equal(native.ydoc.isDestroyed, true);
  assert.match(String(notice.mock.calls[0]?.arguments[0]), /shared session stopped/);
});

test("a field interrupted after writing is recovered from the failed close bytes", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const notice = t.mock.method(notices, "show", () => {});
  const native = await nativeEntry({ ...fixture, ports: { ...fixture.ports, commandRefused: () => {} } });
  const failure = new Error("interrupted field cleanup");
  native.ydoc.once("afterTransactionCleanup", () => { throw failure; });
  assert.deepEqual(nativeEditorRecords()?.beatField("R1", "lengthSeconds", 31), { changed: false, held: true });
  await Promise.resolve();
  assert.equal(sharedSession(), false);
  assert.equal(currentDocument()?.rows[0]?.lengthSeconds, 31);
  assert.deepEqual(fixture.errors, [failure]);
  assert.match(String(notice.mock.calls.at(-1)?.arguments[0]), /shared session stopped/);
});

test("record outcomes retain refusals and mark only written results as changed", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const native = await nativeEntry(fixture);
  const refused = t.mock.fn(), show = t.mock.method(notices, "show", () => {});
  const admission = { admit: () => null, refuse: (reason: string) => {
    refused(reason);
    return { kind: "rejected" as const, reason };
  } };
  for (const reason of ["missing", "range", "value", "taken", "author", "stored", "anchor", "text", "busy", "closed", "future"]) {
    const command = t.mock.fn(() => ({ kind: "refused" as const, reason: reason as "busy" }));
    const setField = Object.assign(command, { withSelection: native.commands.setField.withSelection });
    const records = createNativeEditorRecords({ ...native, commands: { ...native.commands, setField } },
      () => admission, "Editor", () => 0, fixture.ports.report);
    assert.deepEqual(records.beatField("R1", "lengthSeconds", 42), { changed: false, held: true });
    assert.equal(command.mock.callCount(), 1);
    if (reason === "missing") assert.deepEqual(show.mock.calls.at(-1)?.arguments, ["That beat no longer exists.", "warn"]);
    else assert.deepEqual(refused.mock.calls.at(-1)?.arguments, [reason]);
  }
  const records = createNativeEditorRecords(native, () => admission, "Editor", () => 0, fixture.ports.report);
  assert.deepEqual(records.beatField("R1", "lengthSeconds", 42), { changed: true, held: false });
  assert.deepEqual(records.beatField("R1", "lengthSeconds", 42), { changed: false, held: false });
  assert.equal(refused.mock.callCount(), 10);
  assert.equal(show.mock.callCount(), 1);
  const release = native.holdIngress();
  assert.deepEqual(records.beatField("R1", "lengthSeconds", 40), { changed: false, held: true });
  assert.deepEqual(refused.mock.calls.at(-1)?.arguments, ["busy"]);
  release();
  const closed = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Editor", sanitize: sanitizeHtml });
  closed.close();
  const ended = createNativeEditorRecords(closed, () => admission, "Editor", () => 0, fixture.ports.report);
  assert.deepEqual(ended.beatField("R1", "lengthSeconds", 40), { changed: false, held: true });
  assert.deepEqual(refused.mock.calls.at(-1)?.arguments, ["closed"]);
});

test("a missing admission owner or closed native gallery refuses without reading or planning the edit", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const native = await nativeEntry(fixture);
  const show = t.mock.method(notices, "show", () => {});
  const read = t.mock.fn(native.document), edit = t.mock.fn(() => true);
  const missing = createNativeEditorRecords({ ...native, document: read }, () => null, "Editor", () => 0, fixture.ports.report);
  assert.deepEqual(missing.gallery("R1", "Edit gallery", edit), { changed: false, held: true });
  assert.deepEqual(show.mock.calls[0]?.arguments, ["This is not available in a shared session yet.", "warn"]);
  const closed = openNativeSession({ kind: "state", state: native.encodeState() }, { actor: "Editor", sanitize: sanitizeHtml });
  closed.close();
  const closedRead = t.mock.fn(closed.document), refused = t.mock.fn((reason: string) => ({ kind: "rejected" as const, reason }));
  const ended = createNativeEditorRecords({ ...closed, document: closedRead }, () => ({
    admit: () => null, refuse: refused
  }), "Editor", () => 0, fixture.ports.report);
  assert.deepEqual(ended.gallery("R1", "Edit gallery", edit), { changed: false, held: true });
  assert.deepEqual(refused.mock.calls[0]?.arguments, ["closed"]);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(closedRead.mock.callCount(), 0);
  assert.equal(edit.mock.callCount(), 0);
  assert.deepEqual(fixture.errors, []);
});

test("leaving removes the native comment, paste and drop capture listeners", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const added = t.mock.method(window, "addEventListener"), removed = t.mock.method(window, "removeEventListener");
  await nativeEntry(fixture);
  const events = added.mock.calls.map(call => call.arguments).filter(([type, callback, capture]) =>
    capture === true && typeof callback === "function"
    && (type === "click" && callback.name === "comment" || (type === "paste" || type === "drop") && callback.name === "pictures"));
  assert.deepEqual(events.map(([type]) => type), ["click", "paste", "drop"]);
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  for (const [type, callback, capture] of events) {
    assert.ok(removed.mock.calls.some(({ arguments: args }) => args[0] === type && args[1] === callback && args[2] === capture), type);
  }
});

test("permissions, held admissions and admission failures stop a native command before it writes", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const native = await nativeEntry({ ...fixture, ports: { ...fixture.ports, common: {
    edit: () => ({ allowed: false, reason: "locked" }), comment: () => ({ allowed: false, reason: "no comments" })
  } } });
  const command = t.mock.fn(native.commands.setField), observed = t.mock.fn((reason: string) => reason);
  const error = new Error("admission failed");
  const refusals = [null, { kind: "rejected", reason: "already told", notified: true }, { kind: "failed", error }] as const;
  for (const refusal of refusals) {
    const records = createNativeEditorRecords({ ...native, commands: { ...native.commands, setField: command } },
      () => ({ admit: () => refusal, refuse: reason => { observed(reason); return { kind: "rejected", reason }; } }),
      "Editor", () => 0, fixture.ports.report);
    assert.deepEqual(records.beatField("R1", "lengthSeconds", 42), { changed: false, held: true });
    if (!refusal) assert.deepEqual(records.comments.reply("missing", { id: "reply" }), { changed: false, held: true });
  }
  assert.equal(command.mock.callCount(), 0);
  assert.deepEqual(observed.mock.calls.map(call => call.arguments), [["locked"], ["no comments"], ["failed"]]);
  assert.deepEqual(fixture.errors, [error]);
});

test("a full script refuses additions with a notice but still takes gallery removals and field clears", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const native = await nativeEntry(fixture);
  const ref = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
  const records = nativeEditorRecords();
  assert.ok(records);
  assert.equal(records.beatField("R1", "lengthSeconds", 22).changed, true);
  assert.equal(records.gallery("R1", "Added", row => { addGalleryPicture(row, ref, "Picture"); return true; }).changed, true);
  await Promise.resolve();
  const state = native.encodeState(), limited = openNativeSession({ kind: "state", state }, {
    actor: "Editor", sanitize: sanitizeHtml, sizeLimit: Math.floor(state.byteLength * 0.8), sizeCeilingRatio: 2
  });
  t.after(limited.close);
  assert.equal(limited.size, "full");
  const show = t.mock.method(notices, "show", () => {});
  const edits = createNativeEditorRecords(limited, () => ({
    admit: () => null, refuse: reason => ({ kind: "rejected", reason })
  }), "Editor", () => 0, fixture.ports.report);
  assert.deepEqual(edits.beatField("R1", "lengthSeconds", 42), { changed: false, held: true });
  assert.deepEqual(edits.gallery("R1", "Added", row => { addGalleryPicture(row, { ...ref, sha256: "b".repeat(64) }, "Another"); return true; }),
    { changed: false, held: true });
  const fullNotice = ["This shared script is full. Export a copy to keep working.", "warn"];
  assert.deepEqual(show.mock.calls.map(call => call.arguments), [fullNotice, fullNotice]);
  assert.equal(edits.gallery("R1", "Removed", row => removeGallerySlot(row, 0)).changed, true);
  assert.equal(edits.beatField("R1", "lengthSeconds", null).changed, true);
  assert.equal(limited.document().rows[0]?.imageRef, null);
  assert.equal(limited.document().rows[0]?.lengthSeconds, undefined);
});

test("the native command guard refuses before planning and calls the refusal port once", async t => {
  const fixture = entrySwitchFixture(), notify = t.mock.fn();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const native = await nativeEntry({ ...fixture, ports: { ...fixture.ports, commandRefused: notify } });
  const beforeEdit = native.encodeState();
  const plan = t.mock.fn(() => { throw new Error("plan"); });
  assert.deepEqual(runCommand({ name: "edit", needs: "edit", plan }), { kind: "rejected", reason: "native-command-unavailable", notified: true });
  assert.equal(plan.mock.callCount(), 0);
  assert.deepEqual(native.encodeState(), beforeEdit);
  assert.equal(notify.mock.callCount(), 1);
});

test("native undo and redo step the session history through the shared route and publish at once", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const native = await nativeEntry(fixture), beforeUndo = native.encodeState(), warn = t.mock.fn();
  const route = sharedUndoRoute();
  assert.ok(route);
  assert.deepEqual(stepSharedUndo(route, "undo", warn), { ok: false, empty: true });
  assert.deepEqual(stepSharedUndo(route, "redo", warn), { ok: false, empty: true });
  assert.deepEqual(native.encodeState(), beforeUndo);
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 8);
  if (at.kind !== "anchored") throw new Error(at.reason);
  assert.equal(native.commands.typeText(at.range, "!", {}).kind, "written");
  assert.deepEqual(stepSharedUndo(route, "undo", warn), { ok: true, effective: true, label: "undo", selection: null });
  assert.equal(currentDocument()?.rows[0]?.audioText, "Captured words");
  assert.deepEqual(stepSharedUndo(route, "redo", warn), { ok: true, effective: true, label: "redo", selection: null });
  assert.equal(currentDocument()?.rows[0]?.audioText, "Captured! words");
  assert.equal(warn.mock.callCount(), 0);
});

test("a native press refused by admission, the typing buffer or the session writes nothing and keeps its step", async t => {
  const { ports } = entrySwitchFixture(), doc = currentDocument();
  assert.ok(doc);
  const { native, backend } = openNativeEditor(ports, doc, () => false);
  t.after(() => { backend.dispose(step => { step(); return true; }); });
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 8);
  if (at.kind !== "anchored") throw new Error(at.reason);
  assert.equal(native.commands.typeText(at.range, "!", {}).kind, "written");
  let admission: { kind: "rejected"; reason: string } | null = { kind: "rejected", reason: "held-for-test" }, held: string | null = "buffer";
  const publish = t.mock.fn(), pressed = t.mock.fn(() => held);
  const input = { beforePress: pressed, show: t.mock.fn(), endGroup: t.mock.fn() };
  const route = nativeUndoRoute({ native, admission: { admit: () => admission }, input: () => input, publish });
  const typed = native.encodeState();
  assert.deepEqual(route.actions.undo(), { ok: false, reason: "held-for-test" });
  assert.equal(pressed.mock.callCount(), 0);
  admission = null;
  assert.deepEqual(route.actions.undo(), { ok: false, reason: "buffer" });
  held = null;
  const release = native.holdIngress();
  assert.deepEqual(route.actions.undo(), { ok: false, reason: "busy" });
  release();
  assert.deepEqual(native.encodeState(), typed);
  assert.equal(publish.mock.callCount(), 0);
  assert.deepEqual(route.actions.undo(), { ok: true, effective: true, label: "undo", selection: null });
  assert.equal(publish.mock.callCount(), 1);
  assert.equal(native.narrationHtml("R1"), "Captured words");
  route.breakGroup();
  assert.equal(input.endGroup.mock.callCount(), 1);
});

test("a native press whose admission fails throws that error before flushing or stepping", async t => {
  const { ports } = entrySwitchFixture(), doc = currentDocument();
  assert.ok(doc);
  const { native, backend } = openNativeEditor(ports, doc, () => false);
  t.after(() => { backend.dispose(step => { step(); return true; }); });
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 8);
  if (at.kind !== "anchored") throw new Error(at.reason);
  assert.equal(native.commands.typeText(at.range, "!", {}).kind, "written");
  const failure = new Error("admission failed"), publish = t.mock.fn();
  const input = { beforePress: t.mock.fn(() => null), show: t.mock.fn(), endGroup: t.mock.fn() };
  const route = nativeUndoRoute({ native, admission: { admit: () => ({ kind: "failed", error: failure }) }, input: () => input, publish });
  assert.throws(() => route.actions.undo(), failure);
  assert.equal(input.beforePress.mock.callCount(), 0);
  assert.equal(publish.mock.callCount(), 0);
  assert.equal(native.narrationHtml("R1"), "Captured! words");
});

test("the release hook bundle omits the native editor entry and test peer", async () => {
  const result = await build({
    entryPoints: ["src/bootstrap/wiring/shared-test.ts"], absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    bundle: true, write: false, format: "esm", platform: "browser", minify: true,
    define: { SPLITPAGE_TEST_HOOKS: "false", SPLITPAGE_COLLAB_UI: "false" }, logLevel: "silent"
  });
  const code = result.outputFiles[0]?.text;
  assert.ok(code);
  for (const token of ["native-command-unavailable", "nativePeer", "The shared session stopped"]) assert.equal(code.includes(token), false, token);
});

test("native leave holds local commands and peers before capturing and announcing the standalone copy", async t => {
  const fixture = entrySwitchFixture(), native = await nativeEntry(fixture), peer = createNativeTestPeer(native);
  t.after(peer.dispose);
  const target = { beat: "R1", cell: "narration" } as const;
  const at = native.commands.anchorText(target, 0);
  if (at.kind !== "anchored") throw new Error(at.reason);
  let attempted: unknown, local: unknown, received: boolean | undefined;
  t.after(onDocumentReplaced(() => {
    if (sharedSession()) return;
    attempted = peer.type("R1", 0, "lost");
    local = native.commands.typeText(at.range, "local", {});
    received = applyNativePeerUpdate(native, native.encodeState());
  }));
  assert.equal(peer.type("R1", 0, "kept ").kind, "written");
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.deepEqual(attempted, { kind: "refused", reason: "closed" });
  assert.equal((local as { kind: string }).kind, "recovery");
  assert.equal(received, false);
  assert.equal(currentDocument()?.rows[0]?.audioText, "kept Captured words");
  await Promise.resolve();
  assert.equal(native.ydoc.isDestroyed, true);
});

for (const delayed of [false, true]) for (const committed of [false, true]) test(`failed close during adoption rolls back, delayed=${delayed}, committed=${committed}`, async t => {
  const fixture = entrySwitchFixture(), original = currentDocument();
  let native: ReturnType<typeof openNativeEditor>["native"] | undefined;
  t.after(onSessionChange(change => {
    if (!native || !sharedSession() || change.kind !== "adopt") return;
    const session = native;
    const fail = () => {
      const at = session.commands.anchorText({ beat: "R1", cell: "narration" }, 0);
      if (at.kind !== "anchored") throw new Error(at.reason);
      session.ydoc.once(committed ? "afterTransactionCleanup" : "beforeAllTransactions", () => { throw new Error("during adoption"); });
      assert.throws(() => session.commands.typeText(at.range, "kept ", {}), /during adoption/);
    };
    if (delayed) queueMicrotask(fail); else fail();
  }));
  const result = await enterSharedSession(fixture.ports, (doc, failed) => {
    const opened = openNativeEditor(fixture.ports, doc, failed);
    native = opened.native;
    return opened.backend;
  });
  assert.deepEqual(result, { ok: false, reason: "enter-failed" });
  assert.equal(sharedSession(), false);
  assert.equal(native?.ydoc.isDestroyed, true);
  if (committed) assert.equal(currentDocument()?.rows[0]?.audioText, "kept Captured words");
  else assert.equal(currentDocument(), original);
});

test("a native input binding unsubscribes its paint listener when torn down", async t => {
  const fixture = entrySwitchFixture(), native = await nativeEntry(fixture);
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const stopPaint = t.mock.fn();
  const unbind = mountNativeSharedInput({
    native, report: fixture.ports.report, editAttribution: () => ({ at: "now", by: "Writer" }),
    session: { admit: () => null, refuse: reason => ({ kind: "rejected", reason }), run: () => ({ kind: "noop" }), subscribe: () => stopPaint }
  });
  unbind.dispose();
  assert.equal(stopPaint.mock.callCount(), 1);
});

test("native unbind unsubscribes the duration repaint separately from editor input", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const stopDuration = t.mock.fn(), stopInput = t.mock.fn();
  const subscribed = t.mock.fn();
  assert.deepEqual(await enterSharedSession(fixture.ports, (doc, failed) => {
    const { backend } = openNativeEditor(fixture.ports, doc, failed);
    return { ...backend, bind: session => backend.bind({
      ...session, subscribe: listener => {
        subscribed(listener);
        if (subscribed.mock.callCount() === 1) return stopDuration;
        return stopInput;
      }
    }) };
  }), { ok: true });
  assert.equal(subscribed.mock.callCount(), 2);
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.equal(stopInput.mock.callCount(), 1);
  assert.equal(stopDuration.mock.callCount(), 1);
});

test("leaving unsubscribes the bridge before the queued update and closes the native adapter", async () => {
  const fixture = entrySwitchFixture();
  const captured: { value?: ReturnType<typeof openNativeEditor> } = {};
  assert.deepEqual(await enterSharedSession(fixture.ports, (doc, failed) => {
    captured.value = openNativeEditor(fixture.ports, doc, failed);
    return captured.value.backend;
  }), { ok: true });
  const opened = captured.value;
  assert.ok(opened);
  const { native, backend } = opened, revision = backend.replica.revision();
  const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, 0);
  if (at.kind !== "anchored") throw new Error(at.reason);
  assert.equal(native.commands.typeText(at.range, "kept ", {}).kind, "written");
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  await Promise.resolve();
  assert.equal(backend.replica.revision(), revision);
  assert.equal(native.ydoc.isDestroyed, true);
});

test("C8 entry-only holds admit settlement commands and retain an enclosing command refusal", () => {
  entrySwitchFixture();
  const entry = holdSessionCommands(SHARED_SWITCHING, "entries");
  try {
    assert.equal(sessionEntryRefusal(), SHARED_SWITCHING);
    assert.equal(runCommand(titleCommand("Settled title")).kind, "applied");
  } finally { entry(); }
  const outer = holdSessionCommands("outer-command"), inner = holdSessionCommands(SHARED_SWITCHING, "entries");
  try {
    assert.deepEqual(runCommand(titleCommand("Refused title")), { kind: "rejected", reason: "outer-command" });
    assert.equal(sessionEntryRefusal(), SHARED_SWITCHING);
    inner(); assert.equal(sessionEntryRefusal(), "outer-command");
  } finally { inner(); outer(); }
  assert.equal(sessionEntryRefusal(), null);
});

test("nested native switches cannot replace the entry or leave hold", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (nativeEditorActive()) forceLeaveSharedSession(); });
  const before = currentDocument(), nested: Promise<unknown>[] = [], leaving: unknown[] = [];
  const foreign: SharedSwitchPorts = { ...fixture.ports, migrate: () => assert.fail("foreign migration"), docId: () => assert.fail("foreign identity") };
  const ports = { ...fixture.ports, settle: () => {
    nested.push(enterSharedSession(foreign, () => assert.fail("nested open")));
    assert.equal(sessionEntryRefusal(), "session-switching");
    assert.equal(currentDocument(), before);
  }, left: t.mock.fn((landed: boolean) => landed) };
  const result = await enterSharedSession(ports, (doc, failed) => {
    const { backend } = openNativeEditor(ports, doc, failed);
    return { ...backend, unbind: () => {
      leaving.push(leaveSharedSession(foreign));
      assert.equal(sessionEntryRefusal(), "session-switching");
      backend.unbind();
    } };
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(await Promise.all(nested), [{ ok: false, reason: "session-switching" }]);
  assert.deepEqual(leaveSharedSession(foreign), { ok: true });
  assert.deepEqual(leaving, [{ ok: false, reason: "session-switching" }]);
  assert.equal(sessionEntryRefusal(), null);
  assert.equal(sharedSession(), false);
  assert.equal(sharedUndoRoute(), null);
  assert.equal(currentDocument()?.rows[0]?.audioText, "Captured words");
  assert.notEqual(currentDocument()?.docId, before?.docId);
  assert.deepEqual(ports.left.mock.calls.map(call => call.arguments), [[true]]);
  assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "not-shared" });
});

for (const step of ["refusal", "settle", "prepare", "docId", "migrate", "bind", "start", "detach"] as const) {
  test(`native entry rolls back or refuses before opening when ${step} throws, then retries`, async t => {
    const fixture = entrySwitchFixture(), before = currentDocument(), revision = liveSession().epoch(), base = mergeBase();
    t.after(() => { if (nativeEditorActive()) forceLeaveSharedSession(); });
    const failure = new Error(step), callback = new Error("shared replacement listener");
    const fail = () => { throw failure; };
    const reattach = t.mock.fn();
    const ports = { ...fixture.ports, ...(step === "bind" || step === "start" ? {} : { [step]: fail }), reattach };
    const opened: ReturnType<typeof openNativeEditor>[] = [];
    const removed = t.mock.fn();
    const listen = onDocumentReplaced(() => { if (sharedSession()) throw callback; });
    try {
      assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
        const editor = openNativeEditor(ports, doc, failed);
        opened.push(editor);
        editor.native.ydoc.on("destroy", removed);
        const { backend } = editor;
        if (step === "bind") return { ...backend, bind: session => { backend.bind(session); fail(); } };
        if (step === "start") return { ...backend, start: () => { backend.start(); fail(); } };
        return backend;
      }), { ok: false, reason: "enter-failed" });
    } finally { listen(); }
    assert.deepEqual([currentDocument(), liveSession().epoch(), mergeBase(), sharedSession(), nativeEditorActive(), sharedUndoRoute()],
      [before, revision, base, false, false, null]);
    assert.equal(currentDocument(), before);
    assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "not-shared" });
    assert.equal(reattach.mock.callCount(), step === "detach" ? 1 : 0);
    const openedBackend = step === "bind" || step === "start" || step === "detach";
    assert.equal(opened.length, openedBackend ? 1 : 0);
    assert.deepEqual(fixture.errors, openedBackend ? [failure, callback] : [failure]);
    assert.equal(removed.mock.callCount(), opened.length);
    if (openedBackend) assert.equal(opened[0]?.native.ydoc.isDestroyed, true);
    const retry = await nativeEntry(fixture);
    assert.notEqual(retry, opened[0]?.native);
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  });
}

for (const step of ["settle", "unbind", "docId", "migrate", "landing"] as const) {
  test(`native leave retries after ${step} throws and lands edits received after the refusal`, async t => {
    const fixture = entrySwitchFixture();
    t.after(() => { if (nativeEditorActive()) forceLeaveSharedSession(); });
    const failure = new Error(step), restoring = new Error("restoring binding");
    const left = t.mock.fn((landed: boolean) => landed);
    let armed = false, retryBinding = false;
    const trip = (at: typeof step) => { if (armed && step === at) { armed = false; throw failure; } };
    const ports = {
      ...fixture.ports, left,
      docId: () => { trip("docId"); return fixture.ports.docId(); },
      migrate: (raw: unknown) => { trip("migrate"); return fixture.ports.migrate(raw); }
    };
    const opened: ReturnType<typeof openNativeEditor>[] = [];
    assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
      const editor = openNativeEditor(ports, doc, failed);
      opened.push(editor);
      const { backend } = editor;
      return {
        ...backend,
        settle: () => { trip("settle"); return backend.settle(); },
        unbind: () => { backend.unbind(); trip("unbind"); },
        bind: session => {
          backend.bind(session);
          if (step === "unbind" && retryBinding) throw restoring;
        },
        landing: () => { trip("landing"); return backend.landing(); }
      };
    }), { ok: true });
    const native = opened[0]?.native;
    assert.ok(native);
    const destroyed = t.mock.fn();
    native.ydoc.on("destroy", destroyed);
    const peer = createNativeTestPeer(native);
    t.after(peer.dispose);
    assert.equal(peer.type("R1", 0, "Kept ").kind, "written");
    await Promise.resolve();
    const before = currentDocument(), route = sharedUndoRoute(), epoch = liveSession().epoch();
    armed = true;
    retryBinding = true;
    assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "leave-failed" });
    assert.equal(currentDocument(), before);
    assert.equal(sharedUndoRoute(), route);
    assert.deepEqual([sharedSession(), liveSession().epoch(), native.ydoc.isDestroyed, left.mock.callCount()], [true, epoch, false, 0]);
    assert.deepEqual(fixture.errors, step === "unbind" ? [failure, restoring] : [failure]);
    retryBinding = false;
    assert.equal(peer.type("R1", 5, "Again ").kind, "written");
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    assert.deepEqual([currentDocument()?.rows[0]?.audioText, sharedSession(), nativeEditorActive(), sharedUndoRoute()],
      ["Kept Again Captured words", false, false, null]);
    assert.notEqual(currentDocument()?.docId, before?.docId);
    assert.deepEqual(left.mock.calls.map(call => call.arguments), [[true]]);
    await Promise.resolve();
    assert.equal(destroyed.mock.callCount(), 1);
    assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "not-shared" });
  });
}

for (const blocked of [false, true]) test(`native forced leave releases the owner route and backend once, blocked=${blocked}`, async t => {
  const fixture = entrySwitchFixture(), left = t.mock.fn((landed: boolean) => landed);
  const ports = { ...fixture.ports, left };
  const steps: string[] = [];
  const opened: ReturnType<typeof openNativeEditor>[] = [];
  t.after(() => { if (nativeEditorActive()) forceLeaveSharedSession(); });
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const editor = openNativeEditor(ports, doc, failed);
    opened.push(editor);
    const { backend } = editor;
    return {
      ...backend,
      settle: () => { steps.push("settle"); return blocked ? "test-buffer-stuck" : backend.settle(); },
      unbind: () => { steps.push("unbind"); backend.unbind(); },
      abandon: () => { steps.push("abandon"); },
      drop: () => { steps.push("drop"); },
      dispose: attempt => { steps.push("dispose"); backend.dispose(attempt); }
    } satisfies SharedEditorBackend;
  }), { ok: true });
  const native = opened[0]?.native;
  assert.ok(native);
  const destroyed = t.mock.fn(), peer = createNativeTestPeer(native);
  t.after(peer.dispose);
  native.ydoc.on("destroy", destroyed);
  assert.equal(peer.type("R1", 0, "Delivered ").kind, "written");
  await Promise.resolve();
  peer.hold();
  assert.equal(peer.type("R1", 0, "Held ").kind, "written");
  const before = currentDocument();
  assert.deepEqual(forceLeaveSharedSession(), blocked ? { ok: false, reason: "test-buffer-stuck" } : { ok: true });
  assert.deepEqual(steps, blocked ? ["settle", "abandon", "settle", "drop", "unbind", "dispose"] : ["settle", "unbind", "dispose"]);
  assert.deepEqual([nativeEditorActive(), sharedUndoRoute(), sharedSession()], [false, null, blocked]);
  assert.deepEqual(left.mock.calls.map(call => call.arguments), [[!blocked]]);
  assert.equal(currentDocument()?.rows[0]?.audioText, "Delivered Captured words");
  if (blocked) {
    assert.equal(currentDocument(), before);
    assert.match(String(fixture.errors[0]), /ended without landing a standalone copy: test-buffer-stuck/);
    adoptReplacement(fixture.ports.migrate(structuredClone(before)), fixture.ports.standalone);
  } else {
    assert.notEqual(currentDocument()?.docId, before?.docId);
    assert.deepEqual(fixture.errors, []);
  }
  await Promise.resolve();
  assert.equal(destroyed.mock.callCount(), 1);
  assert.deepEqual(forceLeaveSharedSession(), { ok: false, reason: "not-shared" });
  assert.equal(left.mock.callCount(), 1);
});

test("native entry prepares after settlement and before rechecking refusal", async t => {
  const fixture = entrySwitchFixture(), original = currentDocument(), order: string[] = [];
  t.after(() => { if (nativeEditorActive()) forceLeaveSharedSession(); });
  let refusal: string | null = null;
  const ports = {
    ...fixture.ports, refusal: () => { order.push("refusal"); return refusal; },
    settle: () => {
      order.push("settle");
      queueMicrotask(() => { order.push("settled"); });
    },
    prepare: async () => { order.push("prepare"); refusal = "opening-after-settlement"; return null; }
  };
  const open = t.mock.fn(() => assert.fail("a refused entry opened the adapter"));
  const entering = enterSharedSession(ports, open);
  assert.deepEqual(order, ["refusal", "settle"]);
  assert.deepEqual(await entering, { ok: false, reason: "opening-after-settlement" });
  assert.deepEqual(order, ["refusal", "settle", "settled", "prepare", "refusal"]);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(currentDocument(), original);
  const native = await nativeEntry(fixture);
  assert.equal(native.document().rows[0]?.audioText, "Captured words");
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
});

test("native adoption and leave callbacks report errors without undoing the landed owners", async t => {
  const fixture = entrySwitchFixture(), before = currentDocument();
  t.after(() => { if (nativeEditorActive()) forceLeaveSharedSession(); });
  const entering = new Error("shared replacement callback"), leaving = new Error("standalone replacement callback");
  let landed: unknown;
  const left = t.mock.fn((ok: boolean) => { landed = [ok, currentDocument()?.rows[0]?.audioText, sharedSession(), sharedUndoRoute()]; });
  const clock = fakeClock(), stopping = new Error("refresh timer could not stop");
  const fixtureWithClock = { ...fixture, ports: { ...fixture.ports, left, timers: { ...clock, stop: () => { throw stopping; } } } };
  const release = onDocumentReplaced(() => { throw sharedSession() ? entering : leaving; });
  t.after(release);
  const native = await nativeEntry(fixtureWithClock);
  assert.deepEqual(fixture.errors, [entering]);
  assert.notEqual(currentDocument(), before);
  assert.equal(nativeEditorActive(), true);
  const peer = createNativeTestPeer(native);
  t.after(peer.dispose);
  assert.equal(peer.type("R1", 0, "Live ").kind, "written");
  const heard = t.mock.fn();
  t.after(onRefresh(heard));
  liveSession().refresh("probe");
  assert.equal(clock.armed(), 1);
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.deepEqual(landed, [true, "Live Captured words", false, null]);
  assert.deepEqual(fixture.errors, [entering, leaving, stopping]);
  assert.equal(left.mock.callCount(), 1);
  assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: "not-shared" });
  clock.advance(5000);
  assert.equal(heard.mock.callCount(), 0);
  await Promise.resolve();
  assert.equal(native.ydoc.isDestroyed, true);
});

test("no-argument native leave uses the running session and its original ports", async t => {
  const fixture = entrySwitchFixture();
  t.after(fixture.close);
  assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: SHARED_NOT_RUNNING });
  let ids = 0;
  const left = t.mock.fn((landed: boolean) => landed);
  const ports: SharedSwitchPorts = { ...fixture.ports, left, docId: () => "d" + String(100 + ++ids).padStart(32, "0") };
  const native = await nativeEntry({ ...fixture, ports });
  const peer = createNativeTestPeer(native);
  t.after(peer.dispose);
  assert.equal(peer.type("R1", 0, "Via ").kind, "written");
  assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  assert.equal(sharedSession(), false);
  assert.equal(nativeEditorActive(), false);
  assert.equal(sharedUndoRoute(), null);
  assert.equal(currentDocument()?.rows[0]?.audioText, "Via Captured words");
  assert.equal(currentDocument()?.docId, "d" + "102".padStart(32, "0"));
  assert.deepEqual(left.mock.calls.map(call => call.arguments), [[true]]);
  assert.deepEqual(leaveRunningSharedSession(), { ok: false, reason: SHARED_NOT_RUNNING });
  await Promise.resolve();
  assert.equal(native.ydoc.isDestroyed, true);
});

test("foreign leave ports remain unused when leaving a native session", async t => {
  const fixture = entrySwitchFixture();
  t.after(fixture.close);
  let ids = 0;
  const left = t.mock.fn((landed: boolean) => landed);
  const ports: SharedSwitchPorts = { ...fixture.ports, left, docId: () => "d" + String(200 + ++ids).padStart(32, "0") };
  const native = await nativeEntry({ ...fixture, ports });
  const wrong = (): never => { assert.fail("foreign switch ports were used"); };
  const foreign: SharedSwitchPorts = {
    ...fixture.ports,
    migrate: wrong, docId: wrong, left: wrong, report: wrong
  };
  assert.deepEqual(leaveSharedSession(foreign), { ok: true });
  assert.equal(sharedSession(), false);
  assert.equal(nativeEditorActive(), false);
  assert.equal(currentDocument()?.docId, "d" + "202".padStart(32, "0"));
  assert.deepEqual(left.mock.calls.map(call => call.arguments), [[true]]);
  assert.deepEqual(fixture.errors, []);
  await Promise.resolve();
  assert.equal(native.ydoc.isDestroyed, true);
});

for (const duringSettle of [false, true]) {
  test(`native entry refuses when opening is pending ${duringSettle ? "during settlement" : "before entry"}`, async t => {
    const fixture = entrySwitchFixture(), before = currentDocument(), epoch = liveSession().epoch();
    t.after(fixture.close);
    let pending = !duringSettle;
    const open = t.mock.fn(() => assert.fail("opening-pending must not open the native factory"));
    const ports: SharedSwitchPorts = {
      ...fixture.ports,
      opening: { openingPending: () => pending },
      settle: () => { if (duringSettle) pending = true; }
    };
    assert.deepEqual(await enterSharedSession(ports, open), { ok: false, reason: "opening-pending" });
    assert.equal(open.mock.callCount(), 0);
    assert.equal(currentDocument(), before);
    assert.equal(liveSession().epoch(), epoch);
    assert.equal(sharedSession(), false);
    assert.equal(nativeEditorActive(), false);
    assert.deepEqual(fixture.errors, []);
  });
}

for (const kind of ["open", "startNew"] as const) {
  test(`native entry settlement holds direct ${kind} and recursive entry while permitting settlement commands`, async t => {
    const fixture = entrySwitchFixture(), observed: unknown[] = [], nested: Promise<unknown>[] = [];
    t.after(fixture.close);
    let settledCommand: unknown = null;
    const ports: SharedSwitchPorts = {
      ...fixture.ports,
      settle: () => {
        observed.push(attemptNativeSwitchEntry(kind));
        nested.push(enterSharedSession(fixture.ports, () => assert.fail("recursive open")));
        settledCommand = runCommand(titleCommand("Settled during native entry"));
      }
    };
    const native = await nativeEntry({ ...fixture, ports });
    assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
    assert.deepEqual(await Promise.all(nested), [{ ok: false, reason: SHARED_SWITCHING }]);
    assert.equal((settledCommand as { kind?: string } | null)?.kind, "applied");
    assert.equal(sessionEntryRefusal(), null);
    assert.equal(currentDocument()?.title, "Settled during native entry");
    assert.equal(native.document().title, "Settled during native entry");
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  });

  for (const phase of ["settle", "unbind", "replacement"] as const) {
    test(`native leave ${phase} holds direct ${kind} until copy and draft ownership settle`, async t => {
      const fixture = entrySwitchFixture(), observed: unknown[] = [];
      t.after(fixture.close);
      let once = true;
      const attempt = () => { if (once) { once = false; observed.push(attemptNativeSwitchEntry(kind)); } };
      const stop = onDocumentReplaced(() => { if (phase === "replacement" && !sharedSession()) attempt(); });
      t.after(stop);
      let native: ReturnType<typeof openNativeEditor>["native"] | undefined;
      assert.deepEqual(await enterSharedSession(fixture.ports, (doc, failed) => {
        const opened = openNativeEditor(fixture.ports, doc, failed);
        native = opened.native;
        const { backend } = opened;
        return {
          ...backend,
          settle: explicit => { if (phase === "settle") attempt(); return backend.settle(explicit); },
          unbind: () => { if (phase === "unbind") attempt(); backend.unbind(); }
        };
      }), { ok: true });
      assert.ok(native);
      assert.deepEqual(leaveRunningSharedSession(), { ok: true });
      assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
      assert.equal(sharedSession(), false);
      assert.equal(nativeEditorActive(), false);
      assert.equal(sharedUndoRoute(), null);
      assert.equal(currentDocument()?.title, "Captured script");
      assert.equal(draftSource.detachRefusal(), null);
      assert.deepEqual(fixture.errors, []);
      await Promise.resolve();
      assert.equal(native.ydoc.isDestroyed, true);
      stop();
      assert.deepEqual(attemptNativeSwitchEntry(kind), { accepted: "Replacement script" });
    });
  }

  test(`native leave-first ${kind} blocks a nested replacement during continuation and lands cleanly`, async t => {
    const fixture = entrySwitchFixture(), observed: unknown[] = [];
    t.after(fixture.close);
    const native = await nativeEntry(fixture);
    let once = true;
    const stop = onDocumentReplaced(() => {
      if (!sharedSession() && once) { once = false; observed.push(attemptNativeSwitchEntry(kind)); }
    });
    t.after(stop);
    assert.deepEqual(attemptNativeSwitchEntry(kind), { accepted: "Replacement script" });
    assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
    assert.equal(sharedSession(), false);
    assert.equal(nativeEditorActive(), false);
    assert.equal(sharedUndoRoute(), null);
    assert.equal(currentDocument()?.title, "Replacement script");
    assert.deepEqual(fixture.errors, []);
    await Promise.resolve();
    assert.equal(native.ydoc.isDestroyed, true);
  });
}
