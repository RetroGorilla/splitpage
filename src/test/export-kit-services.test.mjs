import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { installExportServices } from "../application/export/services.ts";
import { legacyExportServices } from "../bootstrap/export-services.ts";
import { migrateRows } from "../js/02-state.js";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { exportRuns } from "../adapters/formats/export-kit.ts";
import { exportFacts } from "../adapters/formats/export-kit.ts";

function counted() {
  const real = legacyExportServices();
  const calls = { cellOf: 0, inertBody: 0, htmlToPlainText: 0, wordCount: 0, cacheSeal: 0 };
  const services = {
    ...real,
    cellOf: (html) => { calls.cellOf++; return real.cellOf(html); },
    inertBody: (html) => { calls.inertBody++; return real.inertBody(html); },
    htmlToPlainText: (html) => { calls.htmlToPlainText++; return real.htmlToPlainText(html); },
    productionReaders: { ...real.productionReaders, wordCount: (html) => { calls.wordCount++; return real.productionReaders.wordCount(html); } },
    cacheSeal: (value) => { calls.cacheSeal++; return real.cacheSeal(value); }
  };
  return { services, calls };
}

const state = () => migrateRows({
  schema: 5, title: "Port", docId: "d" + "7".repeat(32),
  comments: [{ id: "c1", field: "audioText", rowId: "r1", body: "<p>Check</p>", resolved: false }],
  rows: [{ id: "r1", visualText: "<p>Wide</p>", audioText: "<p>Hello <span class=\"cmt-anchor\" data-cmt=\"c1\">there</span> now</p>", status: "todo" }]
});

test("the export kit reads the decoders, the production readers and the cache seal through the export services port", () => {
  assert.throws(() => exportDocumentOf(state()), /The export services are not started yet/);
  const { services, calls } = counted();
  const stop = installExportServices(services);
  try {
    const doc = exportDocumentOf(state());
    assert.deepEqual({ ...doc.commentNumbers }, { c1: 1 });
    assert.ok(calls.cellOf > 0 && calls.inertBody > 0 && calls.cacheSeal > 0, "the comment anchor order decodes and seals through the port");
    const facts = exportFacts(doc);
    assert.equal(facts.words, 3);
    assert.ok(calls.wordCount > 0, "the word count reads the port's production readers");
    const before = calls.cellOf;
    const runs = exportRuns(doc.scenes[0].audioText, doc.commentNumbers);
    assert.equal(calls.cellOf, before + 1);
    assert.deepEqual(runs.filter((r) => r.markers).map((r) => [r.text, r.markers]), [["there", [1]]]);
  } finally {
    stop();
  }
  assert.throws(() => exportFacts({ document: { rows: [{ audioText: "" }] }, capturedAt: 0 }), /The export services are not started yet/);
});
