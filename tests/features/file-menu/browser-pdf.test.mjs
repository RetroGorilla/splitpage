import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { exportBrowserPdf } from "../../../src/features/file-menu/browser-pdf.ts";
import { fakePrintDialog, fakeNotices } from "../fakes.ts";
import { createExportRegistry } from "../../../src/application/export/registry.ts";

function harness() {
  const print = fakePrintDialog();
  const notices = fakeNotices();
  const formats = createExportRegistry();
  let doc = Object.freeze({ title: "Captured", capturedAt: "2026-10-31T00:00:00Z" });
  let desktop = false;
  let captures = 0;
  let resolve;
  let received;
  const assets = { shas: [], missing: [], picture: () => null };
  const loaded = new Promise((done) => { resolve = done; });
  formats.register({ id: "pdf", fileName: () => "script.pdf", build: () => { throw new Error("old writer"); },
    printPage: (request) => { received = request; return request.doc.title + "|" + request.options.brollView.filter; } });
  formats.register({ id: "txt", fileName: () => "script.txt", build: () => ({ data: "text" }) });
  const ports = {
    printDialog: print.printDialog, formats, desktop: () => desktop,
    exports: { captureExportDocument: () => { captures++; return doc; }, loadExportAssets: () => loaded },
    assets: { request: () => ({ shas: [] }) },
    brollView: { printView: (value) => ({ filter: value?.filter || "all", group: "scene" }) },
    notices: notices.notices
  };
  return { ports, print, notices, release: () => resolve(assets), captures: () => captures,
    switch: () => { doc = { title: "Replacement" }; }, desktop: () => { desktop = true; }, received: () => received };
}

test("captures document and options before asset loading, even across a document switch", async () => {
  const h = harness();
  const view = { filter: "flagged" };
  const pending = exportBrowserPdf(h.ports, "pdf", { brollView: view }, () => true);
  assert.equal(h.captures(), 1);
  h.switch();
  view.filter = "shot";
  h.release();
  await pending;
  assert.deepEqual(h.print.pages, ["Captured|flagged"]);
  assert.ok(Object.isFrozen(h.received().options.brollView));
  assert.equal(h.captures(), 1);
  assert.equal(h.notices.shown[0].message, "Print dialog opened. Choose Save as PDF to save a PDF.");
});

test("desktop and non-PDF exports stay on byte delivery", () => {
  const h = harness();
  assert.equal(exportBrowserPdf(h.ports, "txt", undefined, () => true), null);
  h.desktop();
  assert.equal(exportBrowserPdf(h.ports, "pdf", undefined, () => true), null);
  assert.equal(h.captures(), 0);
});

test("retiring the originating mount while assets load closes its print window", async () => {
  const h = harness();
  let alive = true;
  const pending = exportBrowserPdf(h.ports, "pdf", undefined, () => alive);
  alive = false;
  h.release();
  await pending;
  assert.deepEqual(h.print.pages, []);
  assert.equal(h.print.closed(), 1);
  assert.deepEqual(h.notices.shown, []);
});

test("preparation failures and blocked popups show errors; cancelling reports no saved file", async () => {
  const h = harness();
  h.ports.printDialog = { reserve: () => { throw new Error("Allow pop-ups"); } };
  await exportBrowserPdf(h.ports, "pdf", undefined, () => true);
  assert.equal(h.notices.shown[0].message, "Allow pop-ups");
  h.ports.printDialog = { reserve: () => ({ ended: new Promise(() => {}), print: async () => { throw new Error("broken"); }, close: () => {} }) };
  h.release();
  await exportBrowserPdf(h.ports, "pdf", undefined, () => true);
  assert.match(h.notices.shown[1].message, /Could not prepare/);
  h.ports.printDialog = { reserve: () => ({ ended: new Promise(() => {}), print: async () => "closed", close: () => {} }) };
  await exportBrowserPdf(h.ports, "pdf", undefined, () => true);
  assert.equal(h.notices.shown.length, 2);
});

test("closing or timing out during asset loading ends the flow without waiting for the storage read", async () => {
  for (const result of ["closed", "failed"]) {
    const h = harness();
    h.ports.printDialog = { reserve: () => ({ ended: Promise.resolve(result), print: async () => { throw new Error("must not print"); }, close: () => {} }) };
    await exportBrowserPdf(h.ports, "pdf", undefined, () => true);
    assert.deepEqual(h.print.pages, []);
    assert.equal(h.notices.shown.length, result === "failed" ? 1 : 0);
    if (result === "failed") assert.match(h.notices.shown[0].message, /Could not prepare/);
  }
});
