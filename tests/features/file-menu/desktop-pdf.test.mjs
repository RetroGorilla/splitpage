import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { exportDesktopPdf } from "../../../src/features/file-menu/desktop-pdf.ts";
import { fakeNotices, fakePdfPrinter } from "../fakes.ts";
import { createExportRegistry } from "../../../src/application/export/registry.ts";

function harness() {
  const printer = fakePdfPrinter();
  const notices = fakeNotices();
  const formats = createExportRegistry();
  const bars = [];
  const delivered = [];
  let doc = Object.freeze({ title: "Captured", capturedAt: "2026-10-31T00:00:00Z" });
  let desktop = true;
  let captures = 0;
  let resolve;
  let received;
  const assets = { shas: [], missing: [], picture: () => null };
  const loaded = new Promise((done) => { resolve = done; });
  for (const id of ["pdf", "packing-gear", "packing-prop", "b-roll pdf"]) {
    formats.register({ id, fileName: (base) => base + " - " + id + ".pdf", build: () => { throw new Error("old writer"); },
      printPage: (request) => { received = request; return id + "|" + request.doc.title + "|" + request.options.brollView.filter; } });
  }
  formats.register({ id: "txt", fileName: () => "script.txt", build: () => ({ data: "text" }) });
  const ports = {
    pdfPrinter: printer.pdfPrinter, formats, desktop: () => desktop, baseName: () => "My script",
    exports: { captureExportDocument: () => { captures++; return doc; }, loadExportAssets: () => loaded },
    assets: { request: () => ({ shas: [] }) },
    brollView: { printView: (value) => ({ filter: value?.filter || "all", group: value?.group || "scene" }) },
    notices: { ...notices.notices, busy: { withBar: (label, work) => { bars.push(label); return work(); } } },
    delivery: { deliver: async (filename, data, options) => { delivered.push({ filename, data, options }); return true; } }
  };
  return { ports, printer, notices, bars, delivered, release: () => resolve(assets), captures: () => captures,
    switch: () => { doc = { title: "Replacement" }; }, browser: () => { desktop = false; }, received: () => received };
}

test("each desktop PDF product prints its captured page and is delivered under its own file name", async () => {
  const h = harness();
  h.release();
  for (const id of ["pdf", "packing-gear", "packing-prop", "b-roll pdf"]) {
    await exportDesktopPdf(h.ports, id, undefined, () => true);
  }
  assert.deepEqual(h.printer.pages.map((page) => page.html), ["pdf|Captured|all", "packing-gear|Captured|all", "packing-prop|Captured|all", "b-roll pdf|Captured|all"]);
  assert.ok(h.printer.pages.every((page) => page.doc.title === "Captured"));
  assert.deepEqual(h.delivered.map((d) => [d.filename, d.options.savedMsg]), [
    ["My script - pdf.pdf", "Exported My script - pdf.pdf"],
    ["My script - packing-gear.pdf", "Exported My script - packing-gear.pdf"],
    ["My script - packing-prop.pdf", "Exported My script - packing-prop.pdf"],
    ["My script - b-roll pdf.pdf", "Exported My script - b-roll pdf.pdf"]
  ]);
  assert.ok(h.delivered.every((d) => d.data === h.printer.pdf));
  assert.deepEqual(h.bars, ["Building the PDF file…", "Building the PACKING-GEAR file…", "Building the PACKING-PROP file…", "Building the B-ROLL PDF file…"]);
  assert.deepEqual(h.notices.shown, []);
});

test("captures document and options before asset loading, even across a document switch", async () => {
  const h = harness();
  const view = { filter: "flagged", group: "person" };
  const pending = exportDesktopPdf(h.ports, "b-roll pdf", { brollView: view }, () => true);
  assert.equal(h.captures(), 1);
  h.switch();
  view.filter = "shot";
  h.release();
  await pending;
  assert.deepEqual(h.printer.pages.map((page) => page.html), ["b-roll pdf|Captured|flagged"]);
  assert.equal(h.printer.pages[0].doc.title, "Captured");
  assert.ok(Object.isFrozen(h.received().options));
  assert.ok(Object.isFrozen(h.received().options.brollView));
  assert.equal(h.received().options.brollView.group, "person");
  assert.equal(h.captures(), 1);
});

test("the browser and non-PDF exports leave this route", () => {
  const h = harness();
  assert.equal(exportDesktopPdf(h.ports, "txt", undefined, () => true), null);
  assert.equal(exportDesktopPdf(h.ports, "unknown", undefined, () => true), null);
  h.browser();
  assert.equal(exportDesktopPdf(h.ports, "pdf", undefined, () => true), null);
  assert.equal(h.captures(), 0);
});

test("a print failure shows the old build error and delivers nothing", async () => {
  const h = harness();
  h.ports.pdfPrinter = { print: async () => { throw new Error("A picture could not be prepared for printing"); } };
  h.release();
  await exportDesktopPdf(h.ports, "packing-gear", undefined, () => true);
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(h.notices.shown.map((n) => [n.message, n.kind]), [["Could not build the PACKING-GEAR file.", "error"]]);
});

test("an asset load failure shows the error and never prints", async () => {
  const h = harness();
  h.ports.exports.loadExportAssets = async () => { throw new Error("storage"); };
  await exportDesktopPdf(h.ports, "pdf", undefined, () => true);
  assert.deepEqual(h.printer.pages, []);
  assert.deepEqual(h.delivered, []);
  assert.equal(h.notices.shown[0].message, "Could not build the PDF file.");
});

test("retiring the originating mount while assets load prints nothing and says nothing", async () => {
  const h = harness();
  let alive = true;
  const pending = exportDesktopPdf(h.ports, "pdf", undefined, () => alive);
  alive = false;
  h.release();
  await pending;
  assert.deepEqual(h.printer.pages, []);
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(h.notices.shown, []);
});

test("retiring the mount while the page prints delivers nothing", async () => {
  const h = harness();
  let alive = true;
  h.ports.pdfPrinter = { print: async () => { alive = false; return new Uint8Array([37]); } };
  h.release();
  await exportDesktopPdf(h.ports, "pdf", undefined, () => alive);
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(h.notices.shown, []);
});

test("a cancelled save dialog is the delivery's answer and adds no error", async () => {
  const h = harness();
  h.ports.delivery = { deliver: async () => false };
  h.release();
  await exportDesktopPdf(h.ports, "pdf", undefined, () => true);
  assert.equal(h.printer.pages.length, 1);
  assert.deepEqual(h.notices.shown, []);
});
