import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { openNativeEditor } from "../../src/bootstrap/wiring/native-shared-session.ts";
import { currentDocument, onSessionChange, runCommand, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, sharedSessionParts } from "../../src/bootstrap/wiring/shared-session.ts";
import { bootEntrySwitchFixture, entrySwitchFixture, stopEntrySwitchFixture } from "./shared-entry-switch-support.ts";
import { notices } from "../../src/bootstrap/wiring/ports/effects.ts";
import { sharedUndoRoute, stepSharedUndo } from "../../src/bootstrap/wiring/undo.ts";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

before(bootEntrySwitchFixture);
after(stopEntrySwitchFixture);

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

test("preflight refuses before selecting a backend and default entry builds the legacy parts", async t => {
  const fixture = entrySwitchFixture();
  t.after(fixture.close);
  const open = t.mock.fn(() => { throw new Error("open"); });
  assert.deepEqual(await enterSharedSession({ ...fixture.ports, refusal: () => "held" }, open), { ok: false, reason: "held" });
  assert.equal(open.mock.callCount(), 0);
  assert.deepEqual(await fixture.enter(), { ok: true });
  assert.ok(sharedSessionParts()?.handle);
  assert.equal(currentDocument()?.rows[0]?.audioText, "Captured words");
});

test("the installed owner hears adoption and diffs the asynchronous native snapshot", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const seen: { kind: string; text: string | null | undefined; fields: readonly unknown[] }[] = [];
  t.after(onSessionChange(change => seen.push({ kind: change.kind, text: currentDocument()?.rows[0]?.audioText, fields: change.changes.cells })));
  const native = await nativeEntry(fixture);
  assert.equal(sharedSessionParts(), null);
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

test("native undo and redo reach the shared notice route without creating a replay", async t => {
  const fixture = entrySwitchFixture();
  t.after(() => { if (sharedSession()) leaveRunningSharedSession(); });
  const native = await nativeEntry(fixture), beforeUndo = native.encodeState(), warn = t.mock.fn();
  const route = sharedUndoRoute();
  assert.ok(route);
  assert.deepEqual(stepSharedUndo(route, "undo", warn), { ok: false, reason: "native-command-unavailable", skipped: true });
  assert.deepEqual(stepSharedUndo(route, "redo", warn), { ok: false, reason: "native-command-unavailable", skipped: true });
  assert.equal(warn.mock.callCount(), 2);
  assert.deepEqual(native.encodeState(), beforeUndo);
});

test("the release hook bundle omits the native editor entry and test peer", async () => {
  const result = await build({
    entryPoints: ["src/bootstrap/wiring/shared-test.ts"], absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
    bundle: true, write: false, format: "esm", platform: "browser", minify: true,
    define: { SPLITPAGE_TEST_HOOKS: "false" }, logLevel: "silent"
  });
  const code = result.outputFiles[0]?.text;
  assert.ok(code);
  for (const token of ["native-command-unavailable", "nativePeer", "The shared session stopped"]) assert.equal(code.includes(token), false, token);
});
