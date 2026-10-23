import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import type { EffectPorts, Notice } from "../../src/application/effects/ports.ts";
import { VIEWING_ONLY } from "../../src/application/collaboration/review.ts";
import { legacyExportServices } from "../../src/bootstrap/export-services.ts";
import { sharedPorts } from "../../src/bootstrap/wiring/shared-ports.ts";
import { startEffects } from "../../src/legacy/effects-bridge.ts";
import { documentLocation, setHome, startLocation } from "../../src/legacy/location-bridge.ts";
import { sanitizeHtml, storedHtmlFromDom } from "../../src/legacy/richtext.ts";
import { adoptReplacement } from "../../src/legacy/session-bridge.ts";
import { loadTestDocument } from "../../src/test/_document.mjs";
import { migrateRows } from "../../src/js/02-state.js";

test("review facts follow the location and refuse through the notices only while reviewing", () => {
  const { review } = sharedPorts();
  const stopLocation = startLocation({ storage: () => null });
  const shown: unknown[][] = [];
  const notice: Notice = { isConnected: true, dismiss: () => {}, removeEventListener: () => {} };
  const ports: EffectPorts<Element> = {
    notices: { show: (...args) => { shown.push(args); return notice; }, showAction: () => notice },
    menuItems: { setLabel: () => {}, setReason: () => {} },
    clipboard: { copyText: () => Promise.resolve(true) }
  };
  const stopEffects = startEffects(ports);
  try {
    assert.equal(review.reviewing(), false);
    assert.equal(review.refuseInReview(), false);
    assert.deepEqual(shown, []);
    documentLocation().setConnection({ serverUrl: "http://a:1/", token: "t", role: "review", scope: "doc-1" });
    setHome("server", { id: "doc-1" });
    assert.equal(review.reviewing(), true);
    assert.equal(review.refuseInReview(), true);
    assert.deepEqual(shown, [[VIEWING_ONLY, "warn", undefined]]);
  } finally {
    setHome("none");
    documentLocation().setConnection({});
    stopEffects();
    stopLocation();
  }
});

test("the document reader reads the session's document and hears replacements until unsubscribed", () => {
  const { document: reader } = sharedPorts();
  const first = migrateRows({ title: "First", rows: [{ id: "r1", visualText: "", audioText: "a", updatedAt: "" }] });
  loadTestDocument(first);
  assert.equal(reader.current()?.title, "First");
  assert.equal(reader.read((doc) => doc?.rows.length), 1);
  let replaced = 0;
  const off = reader.onReplaced(() => { replaced++; });
  adoptReplacement(migrateRows({ title: "Second", rows: [] }));
  assert.equal(reader.current()?.title, "Second");
  assert.equal(replaced, 1);
  off();
  adoptReplacement(migrateRows({ title: "Third", rows: [] }));
  assert.equal(replaced, 1);
});

test("the text services are the same functions and caches the export services use", () => {
  const { text } = sharedPorts();
  const exported = legacyExportServices();
  for (const name of ["cellOf", "inertBody", "fromHtml", "htmlToMarkdown", "htmlToPlainText", "productionReaders", "cacheSeal"] as const) {
    assert.equal(text[name], exported[name], name);
  }
  assert.equal(text.sanitizeHtml, sanitizeHtml);
  assert.equal(text.storedHtmlFromDom, storedHtmlFromDom);
});
