import assert from "node:assert/strict";
import { after, test } from "node:test";
import { encodeStateAsUpdate, encodeStateVector, mergeUpdates } from "yjs";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml, scriptCellOf } from "../bootstrap/richtext.ts";
import { currentHome, documentLocation, setHome } from "../bootstrap/wiring/location-owner.ts";
import { flushDraftNow } from "../bootstrap/wiring/recovery-owners.ts";
import { confirmSavedNow, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import { adoptReplacement, currentDocument, mergeBase, noteSessionEdit, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { undoOwner } from "../bootstrap/wiring/undo.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const listenerCounts = trackGlobalListeners();
await bootApp();
after(closeApp);

test("gapped native entry preserves the standalone script, undo, destination and saved state", async t => {
  const source = migrateRows({ title: "Stored script", rows: [
    { id: "r1", audioText: "Hello" }, { id: "r2", audioText: "World" }
  ] });
  const native = openNativeSession({ kind: "document", document: source, conversion: {
    cells: scriptCellOf, creation: source.docId, at: "2026-01-01", by: "Writer"
  } }, { actor: "Writer", sanitize: sanitizeHtml });
  t.after(native.close);
  const hook = window.__sharedTest;
  t.after(() => { if (sharedSession()) hook.leave(); });
  t.mock.method(console, "error", () => {});

  const base = native.encodeState();
  const append = text => {
    const end = native.document().rows[0].audioText.length;
    const at = native.commands.anchorText({ beat: "r1", cell: "narration" }, end);
    assert.equal(at.kind, "anchored");
    assert.equal(native.commands.typeText(at.range, text, {}).kind, "written");
  };
  append("?");
  const afterMiddle = encodeStateVector(native.ydoc);
  append("!");
  const gapped = mergeUpdates([base, encodeStateAsUpdate(native.ydoc, afterMiddle)]);

  const standalone = migrateRows({ title: "Open script", rows: [{ id: "open", audioText: "Standalone" }] });
  const original = standalone.rows[0].audioText;
  const edited = original + " edit";
  adoptReplacement(standalone);
  const handle = { kind: "file", name: "open.splitpage", createWritable: () => assert.fail("The open file was written") };
  setHome("file", { format: "splitpage", name: handle.name, handle });
  documentLocation().markWrittenOut(true);
  confirmSavedNow();
  currentDocument().rows[0].audioText = edited;
  noteSessionEdit();
  undoOwner().flush();
  assert.equal((await flushDraftNow()).ok, true);

  const home = currentHome(), saved = mergeBase(), history = undoOwner().sizes(), before = hook.read();
  const listeners = listenerCounts();
  assert.equal(home.handle, handle);
  assert.ok(history.undo > 0);
  assert.equal(unsavedChanges(), true);
  assert.deepEqual(await hook.enterFrom(gapped), { ok: false, reason: "enter-failed" });
  assert.equal(sharedSession(), false);
  assert.deepEqual(hook.leave(), { ok: false, reason: "not-shared" });
  assert.deepEqual(hook.read(), before);
  assert.deepEqual(listenerCounts(), listeners);
  assert.equal(currentHome(), home);
  assert.equal(mergeBase(), saved);
  assert.equal(documentLocation().writtenOut(), true);
  assert.equal(unsavedChanges(), true);
  assert.deepEqual(undoOwner().sizes(), history);
  undoOwner().undo();
  assert.equal(currentDocument().rows[0].audioText, original);
  undoOwner().redo();
  assert.equal(currentDocument().rows[0].audioText, edited);
});
