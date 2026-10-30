import test from "node:test";
import assert from "node:assert/strict";
import { documentGuardOn, documentView, isDocumentView, quietly, rawOf, startDocumentGuard, unwrapped } from "../../../src/application/identity/document-guard.ts";

function refused(): void {
  const raw = { title: "Original", rows: [] };
  let called = false;
  for (const operation of [() => documentGuardOn(), () => documentView(raw), () => unwrapped(raw), () => rawOf(raw), () => isDocumentView(raw), () => quietly(() => { called = true; raw.title = "Changed"; })]) {
    assert.throws(operation, /document guard is not started yet/);
  }
  assert.equal(called, false);
  assert.equal(raw.title, "Original");
}

test("the document guard refuses every operation before start and after stop", () => {
  refused();
  const stop = startDocumentGuard(true, () => {});
  const raw = { title: "Original" };
  const view = documentView(raw);
  assert.equal(documentGuardOn(), true);
  assert.notEqual(view, raw);
  assert.throws(() => quietly(() => { view.title = "Changed"; }), TypeError);
  assert.equal(raw.title, "Original");
  stop();
  stop();
  refused();
});

test("an explicitly started disabled guard preserves passthrough and quiet callbacks", () => {
  const stop = startDocumentGuard(false, () => { assert.fail("disabled guard must not report writes"); });
  const raw = { title: "Original" };
  try {
    assert.equal(documentGuardOn(), false);
    assert.equal(documentView(raw), raw);
    assert.equal(unwrapped(raw), raw);
    assert.equal(rawOf(raw), raw);
    assert.equal(isDocumentView(raw), false);
    assert.equal(quietly(() => { raw.title = "Changed"; return 7; }), 7);
    assert.equal(raw.title, "Changed");
  } finally {
    stop();
  }
  refused();
});

test("an old guard stop cannot disable its replacement", () => {
  const stopOld = startDocumentGuard(false, () => {});
  const stopNew = startDocumentGuard(true, () => {});
  stopOld();
  assert.equal(documentGuardOn(), true);
  const raw = { title: "Original" };
  assert.throws(() => quietly(() => { documentView(raw).title = "Changed"; }), TypeError);
  stopNew();
  refused();
});
