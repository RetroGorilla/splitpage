import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTHING_TO_CAPTURE, captureExportDocument } from "../../src/application/save/capture.ts";
import type { CapturePorts, ExportReadModels } from "../../src/application/save/capture.ts";
import type { DocumentView } from "../../src/application/session/document-session.ts";
import { harness, rawScript } from "./session-fakes.ts";

const MODELS: ExportReadModels = {
  production: [{ key: "prop lamp", id: "t1", catId: "prop", name: "Lamp", mentions: [], orphaned: true, owner: "", notes: "", status: "needed" }],
  commentNumbers: { c1: 1 },
  broll: []
};

function ports(read: CapturePorts["read"], log: string[]): CapturePorts {
  return {
    read: function (select) { log.push("read"); return read(select); },
    readModels: function (doc: DocumentView) { log.push("models:" + doc.title); return MODELS; },
    clock: { nowIso: function () { log.push("clock"); return "2026-10-13T17:30:00.000Z"; } }
  };
}

test("a capture reads the session once and derives its read models inside that read", () => {
  const h = harness();
  h.session.adopt(rawScript("Captured"));
  const log: string[] = [];
  const doc = captureExportDocument(ports(h.session.read, log));
  assert.deepEqual(log, ["read", "clock", "models:Captured"]);
  assert.equal(doc.title, "Captured");
  assert.equal(doc.capturedAt, "2026-10-13T17:30:00.000Z");
  assert.equal(doc.commentNumbers["c1"], 1);
  assert.equal(doc.production[0]?.name, "Lamp");
});

test("a capture is its own frozen copy: later edits to the session's document do not reach it", () => {
  const h = harness();
  const live = h.session.adopt(rawScript("Before"));
  assert.ok(live);
  const doc = captureExportDocument(ports(h.session.read, []));
  live.title = "After";
  (live.rows[0] as { audioText: string }).audioText = "Changed";
  assert.equal(doc.title, "Before");
  assert.equal(doc.document.title, "Before");
  assert.notEqual(doc.scenes[0]?.audioText, "Changed");
  assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.document) && Object.isFrozen(doc.scenes[0]));
  assert.throws(() => { (doc.document as { title: string }).title = "x"; }, TypeError);
});

test("a capture for Save As carries the new id and leaves the session's document as it was", () => {
  const h = harness();
  h.session.adopt(rawScript("Fork"));
  const doc = captureExportDocument(ports(h.session.read, []), { docId: "d" + "9".repeat(32) });
  assert.equal(doc.document.docId, "d" + "9".repeat(32));
  assert.equal(h.session.read((d) => d && d.docId), "d" + "1".repeat(32));
});

test("there is nothing to capture without a document", () => {
  const h = harness();
  assert.throws(() => captureExportDocument(ports(h.session.read, [])), new RegExp(NOTHING_TO_CAPTURE));
});
