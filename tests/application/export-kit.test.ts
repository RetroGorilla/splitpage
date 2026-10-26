import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportKit, commentNumbers } from "../../src/application/save/export-kit.ts";
import type { ExportAnchor, ExportKitPorts } from "../../src/application/save/export-kit.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { createProductionReaders } from "../../src/core/production/readers.ts";
import type { ExportServices } from "../../src/application/export/services.ts";
import type { ExportAnchorBody } from "../../src/application/save/export-kit.ts";
import type { DocumentView } from "../../src/application/session/document-session.ts";
import { captureExportDocument, exportDocumentOf, loadExportAssets, startExportKit } from "../../src/legacy/export-kit-bridge.ts";

function fake() {
  const log: string[] = [];
  const entry = (raw: unknown) => migrateRows(raw, fakeMigration().ports);
  const doc = entry({ title: "Capture", rows: [{ id: "r1", visualText: "", audioText: "", status: "todo" }] });
  const cellOf = () => [];
  let anchors: ExportAnchor[] = [];
  const services: ExportServices<ExportAnchorBody> = {
    cellOf: () => { log.push("cell"); return []; },
    inertBody: () => { log.push("anchors"); return { querySelectorAll: () => anchors }; },
    fromHtml: cellOf,
    htmlToMarkdown: () => "",
    htmlToPlainText: () => "",
    productionReaders: createProductionReaders(cellOf, deepFreeze),
    cacheSeal: (value) => { log.push("seal"); return deepFreeze(value); }
  };
  let live: DocumentView | null = doc;
  const ports: ExportKitPorts = {
    read: (select) => { log.push("read"); return select(live); },
    preferences: { clock: () => { log.push("preference"); return "24"; } },
    clock: { nowIso: () => { log.push("clock"); return "2026-10-26T12:00:00.000Z"; } },
    ids: { id: () => { log.push("id"); return "bs1"; }, docId: () => "d1" },
    services: () => { log.push("services"); return services; },
    entry: (raw) => { log.push("entry"); return entry(raw); },
    following: 4,
    assets: {
      load: async () => { log.push("load"); },
      bytes: () => { log.push("bytes"); return new Uint8Array([1, 2]); },
      mime: () => { log.push("mime"); return "image/png"; }
    }
  };
  return { doc, log, ports, owner: createExportKit(ports), setLive: (value: DocumentView | null) => { live = value; }, setAnchors: (value: ExportAnchor[]) => { anchors = value; } };
}

function anchor(id: string | null, position: number, contains: readonly number[] = []): ExportAnchor {
  return {
    contains: (other) => contains.some((p) => other === items[p]),
    compareDocumentPosition: (other) => position < items.indexOf(other) ? 4 : 2,
    getAttribute: () => id
  };
}

const items: ExportAnchor[] = [];

function must<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

test("capture keeps preference, session, clock and model reads in order and freezes an independent copy", () => {
  const f = fake();
  assert.deepEqual(f.log, []);
  const got = f.owner.captureExportDocument({ docId: "fork", stamp: { rev: 7, lastEditedBy: "Ann", lastEditedAt: "then" }, clockMode: "12" });
  assert.deepEqual(f.log, ["preference", "read", "clock", "services"]);
  assert.equal(got.capturedAt, "2026-10-26T12:00:00.000Z");
  assert.equal(got.clockMode, "12");
  assert.equal(got.document.docId, "fork");
  assert.equal(got.document.rev, 7);
  assert.notEqual(f.doc.docId, "fork");
  f.doc.title = "Later";
  assert.equal(got.title, "Capture");
  assert.ok(Object.isFrozen(got.document));
  assert.ok(Object.isFrozen(got.scenes));
  assert.equal(commentNumbers(got), got.commentNumbers);
});

test("capture without a live document reads preferences and session only", () => {
  const f = fake();
  f.setLive(null);
  assert.throws(() => f.owner.captureExportDocument(), /There is no document to capture/);
  assert.deepEqual(f.log, ["preference", "read"]);
});

test("explicit-state serialization clones before entry, then reads clock, models and preference", () => {
  const f = fake();
  const state = { title: "Input", rows: [], extension: { keep: true } };
  const got = createExportKit({ ...f.ports, entry: (raw) => {
    f.log.push("entry");
    assert.notEqual(raw, state);
    assert.deepEqual(raw, state);
    (raw as { title: string }).title = "Migrated";
    return f.ports.entry(raw);
  } }).exportDocumentOf(state);
  assert.deepEqual(f.log, ["entry", "entry", "clock", "services", "preference"]);
  assert.equal(state.title, "Input");
  assert.equal(got.title, "Migrated");
  assert.equal(got.clockMode, "24");
});

test("comment numbering keeps nested and document ordering, duplicates, fields and the sealed content cache", () => {
  const f = fake();
  items.splice(0, items.length, anchor("outer", 0, [1]), anchor("inner", 1), anchor("outer", 2), anchor("last", 3), anchor("closed", 4), anchor("title", 5));
  f.setAnchors([5, 4, 3, 2, 0, 1].map((at) => must(items[at])));
  f.doc.comments = ["outer", "inner", "last", "closed", "title"].map((id) => ({ id, resolved: id === "closed", field: id === "title" ? "title" : "audioText" }));
  f.doc.rows = [{ id: "r1", visualText: "cmt-anchor one", audioText: "cmt-anchor two" }];
  const first = f.owner.captureExportDocument();
  assert.deepEqual({ ...first.commentNumbers }, { inner: 1, outer: 2, last: 4 });
  assert.equal(f.log.filter((x) => x === "anchors").length, 2);
  assert.equal(f.log.filter((x) => x === "seal").length, 2);
  must(f.doc.comments[1]).resolved = true;
  const next = f.owner.captureExportDocument();
  assert.deepEqual({ ...next.commentNumbers }, { outer: 1, last: 3 });
  assert.equal(f.log.filter((x) => x === "anchors").length, 2);
  assert.equal(f.log.filter((x) => x === "seal").length, 2);
  must(f.doc.rows[0]).audioText = "cmt-anchor changed";
  f.owner.captureExportDocument();
  assert.equal(f.log.filter((x) => x === "anchors").length, 3);
  assert.equal(f.log.filter((x) => x === "seal").length, 3);
});

test("export assets load before their bytes and mime are held, including a failed load", async () => {
  const f = fake();
  const source = () => null;
  const owner = createExportKit({ ...f.ports, assets: { ...f.ports.assets, load: async (shas, passed) => {
    assert.deepEqual(shas, ["sha"]);
    assert.equal(passed, source);
    f.log.push("load");
    throw new Error("offline");
  } } });
  const got = await owner.loadExportAssets({ shas: ["sha"], source });
  assert.deepEqual(f.log, ["load", "bytes", "mime"]);
  assert.deepEqual(got.picture("sha"), { bytes: new Uint8Array([1, 2]), mime: "image/png" });
});

test("read models derive production, comment order and b-roll in order, drawing ids only for missing shot records", () => {
  const f = fake();
  const real = f.ports.services();
  let production = false;
  let broll = false;
  const services = { ...real, productionReaders: {
    ...real.productionReaders,
    tagsInField: () => { if (!production) { production = true; f.log.push("production"); } return []; },
    brollInField: (html: unknown) => {
      if (!broll) { broll = true; f.log.push("broll"); }
      return html === "shot" ? [{ id: "", name: "Wide", desc: "Scene" }] : [];
    }
  } };
  f.doc.rows = [{ id: "r1", visualText: "shot", audioText: "cmt-anchor" }];
  f.doc.comments = [{ id: "c1", field: "audioText" }];
  f.setAnchors([{ contains: () => false, compareDocumentPosition: () => 4, getAttribute: () => "c1" }]);
  f.log.length = 0;
  const owner = createExportKit({ ...f.ports, services: () => { f.log.push("services"); return services; } });
  const got = owner.captureExportDocument();
  assert.deepEqual(f.log, ["preference", "read", "clock", "services", "production", "services", "cell", "anchors", "services", "seal", "broll", "id"]);
  assert.equal(got.broll[0]?.id, "bs1");
  assert.equal(got.broll[0]?.name, "Wide");
  assert.equal(got.commentNumbers["c1"], 1);
  assert.deepEqual(f.doc.brollShots, []);
  assert.equal("rec" in must(got.broll[0]), false);
});

test("the numbered bridge throws outside startup and an old teardown leaves a replacement running", async () => {
  const f = fake();
  assert.throws(() => captureExportDocument(), /not started yet/);
  assert.throws(() => exportDocumentOf({}), /not started yet/);
  assert.throws(() => loadExportAssets({ shas: [], source: null }), /not started yet/);
  const stop = startExportKit(f.owner);
  assert.throws(() => startExportKit(fake().owner), /already started/);
  assert.equal(captureExportDocument().title, "Capture");
  assert.equal(exportDocumentOf(f.doc).title, "Capture");
  assert.deepEqual((await loadExportAssets({ shas: [], source: null })).shas, []);
  stop();
  const replacement = fake();
  replacement.doc.title = "Replacement";
  const stopReplacement = startExportKit(replacement.owner);
  try {
    stop();
    assert.equal(captureExportDocument().title, "Replacement");
  } finally { stopReplacement(); }
  assert.throws(() => captureExportDocument(), /not started yet/);
});
