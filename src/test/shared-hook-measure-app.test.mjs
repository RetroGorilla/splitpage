import { bootApp, closeApp } from "./_legacy-shared-app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(() => { closeApp(); });

const { adoptReplacement, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { sanitizeHtml, scriptCellOf } = await import("../bootstrap/richtext.ts");
const { openNativeSession } = await import("../adapters/collab/native/session.ts");
const hook = window.__legacySharedTest;

const ROWS = [{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "World", visualText: "" }];

function script(given = ROWS) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Measure", rows: given }));
  undoOwner().flush();
  writerControls().openWriter();
}

const rows = doc => doc.rows.map(row => [row.id, row.audioText]);

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
