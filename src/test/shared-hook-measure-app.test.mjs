import { bootApp, closeApp } from "./_legacy-shared-app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(() => { closeApp(); });

const { adoptReplacement, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { sharedSessionParts } = await import("../bootstrap/wiring/shared-session.ts");
const { sanitizeHtml, scriptCellOf } = await import("../bootstrap/richtext.ts");
const { openNativeSession } = await import("../adapters/collab/native/session.ts");
const { encodeSharedState, encodeSharedStateVector, encodeSharedUpdate } = await import("../adapters/collab/document.ts");
const hook = window.__legacySharedTest;

const ROWS = [{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "World", visualText: "" }];

function script(given = ROWS) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Measure", rows: given }));
  undoOwner().flush();
  writerControls().openWriter();
}

const rows = doc => doc.rows.map(row => [row.id, row.audioText]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function shared(run, given = ROWS) {
  script(given);
  assert.deepEqual(await hook.enter(), { ok: true });
  try { await run(hook.peer); } finally {
    if (sharedSession()) hook.leave();
  }
}

test("entry from an encoded shared state: the app enters the stored document with its history and recovery, the undo stack starts empty, and an empty, incomplete, truncated or unreadable state is refused with the standalone script unchanged", async () => {
  let stored = null, expected = null, recovery = null, partial = null, gapped = null;
  await shared(p => {
    const handle = sharedSessionParts().handle, start = encodeSharedState(handle), vector = encodeSharedStateVector(handle);
    assert.equal(p.type("r1", 5, "?").kind, "applied");
    assert.equal(p.deliver(), 1);
    const middle = encodeSharedStateVector(handle);
    assert.equal(p.type("r1", 6, "?").kind, "applied");
    assert.equal(p.deliver(), 1);
    gapped = Y.mergeUpdates([start, encodeSharedUpdate(handle, middle)]);
    assert.equal(p.erase("r1", 6, 7), "applied");
    assert.equal(p.remove("r2"), "applied");
    assert.equal(p.deliver(), 2);
    stored = encodeSharedState(sharedSessionParts().handle);
    partial = encodeSharedUpdate(sharedSessionParts().handle, vector);
    expected = rows(hook.read().app);
    recovery = p.recoveryEntries("app");
    assert.equal(recovery.length, 1);
  });
  const other = [{ id: "o1", audioText: "Other", visualText: "" }];
  for (const [name, bytes] of [["an empty state", new Uint8Array([0, 0])], ["an update without its base", partial],
    ["a script with pending structs", gapped],
    ["a truncated state", stored.slice(0, Math.floor(stored.length / 2))], ["unreadable bytes", new Uint8Array([1, 2, 3])]]) {
    script(other);
    const standalone = JSON.stringify(hook.read());
    assert.deepEqual(await hook.enterFrom(bytes), { ok: false, reason: "enter-failed" }, name);
    assert.equal(sharedSession(), false, name);
    assert.equal(JSON.stringify(hook.read()), standalone, name + " leaves the standalone script unchanged");
    assert.deepEqual(hook.leave(), { ok: false, reason: "not-shared" }, name);
  }
  script(other);
  let text = "";
  for (const byte of stored) text += String.fromCharCode(byte);
  assert.deepEqual(await hook.enterFrom(btoa(text)), { ok: true });
  try {
    assert.deepEqual(rows(hook.read().app), expected, "the stored document, not the open standalone script");
    assert.deepEqual(hook.peer.recoveryEntries("app"), recovery, "the stored recovery entry comes with it");
    assert.ok(same(hook.read().app, hook.read().peer), "the peer copies the stored state");
    assert.deepEqual(sharedSessionParts().undo.sizes(), { undo: 0, redo: 0, dropped: 0 }, "the undo stack starts empty");
    assert.equal(hook.peer.type("r1", 0, "N").kind, "applied");
    assert.equal(hook.peer.deliver(), 1);
    assert.equal(hook.read().app.rows[0].audioText, "NHello?");
  } finally { if (sharedSession()) hook.leave(); }
});

test("old stored entry refuses a complete native script and retains the four open beats", async () => {
  const openRows = ["one", "two", "three", "four"].map((audioText, i) => ({ id: "r" + (i + 1), audioText }));
  script(openRows);
  const source = migrateRows({ title: "Native four beats", rows: openRows });
  const native = openNativeSession({ kind: "document", document: source, conversion: {
    cells: scriptCellOf, creation: source.docId, at: "2026-11-20", by: "Writer"
  } }, { actor: "Writer", sanitize: sanitizeHtml });
  try {
    assert.equal(native.document().rows.length, 4);
    assert.deepEqual(await hook.enterFrom(native.encodeState()), { ok: false, reason: "enter-failed" });
    assert.equal(sharedSession(), false);
    assert.deepEqual(rows(hook.read().app), rows(source));
  } finally { native.close(); }
});
