import "../../src/test/_dom.mjs";
import { documentReader as portDocument } from "../../src/bootstrap/wiring/ports/document.ts";
import { text as portText } from "../../src/bootstrap/wiring/ports/text.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { legacyExportServices } from "../../src/bootstrap/export-services.ts";

import { sanitizeHtml, storedHtmlFromDom } from "../../src/legacy/richtext.ts";
import { adoptReplacement } from "../../src/bootstrap/wiring/session-owner.ts";
import { loadTestDocument } from "../../src/test/_document.mjs";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";

test("the document reader reads the session's document and hears replacements until unsubscribed", () => {
  const reader = portDocument;
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
  const text = portText;
  const exported = legacyExportServices();
  for (const name of ["cellOf", "inertBody", "fromHtml", "htmlToMarkdown", "htmlToPlainText", "productionReaders", "cacheSeal"] as const) {
    assert.equal(text[name], exported[name], name);
  }
  assert.equal(text.sanitizeHtml, sanitizeHtml);
  assert.equal(text.storedHtmlFromDom, storedHtmlFromDom);
});
