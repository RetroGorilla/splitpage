import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument, mergeBase } from "../bootstrap/wiring/session-owner.ts";
import { saveChanges, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";

await bootApp();
after(closeApp);

const { printDialog } = await import("../bootstrap/wiring/ports/printing.ts");
const { localFileMenuControls } = await import("../bootstrap/wiring/local-files.ts");
const { exportFormats } = await import("../bootstrap/wiring/export-registry.ts");
const { captureExportDocument } = await import("../bootstrap/wiring/export-capture.ts");
const { exportAssetsNow } = await import("../adapters/formats/export-assets.ts");
const { LONG_DEMO } = await import("../starters/index.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { loadTestDocument } = await import("./_document.mjs");

test("all four browser PDF products print without delivery or document save acknowledgements", async () => {
  loadTestDocument(migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state))));
  const reserve = printDialog.reserve;
  const pages = [];
  printDialog.reserve = () => ({ ended: new Promise(() => {}), print: async (html) => { pages.push(html); return "opened"; }, close() {} });
  const before = JSON.stringify([currentDocument(), mergeBase(), saveChanges(), unsavedChanges()]);
  try {
    for (const action of ["export-pdf", "export-packing-gear", "export-packing-prop", "export-broll-pdf"]) {
      assert.ok(exportFormats.byAction(action).printPage);
      await localFileMenuControls().runExport(action);
    }
    assert.equal(pages.length, 4);
    assert.ok(pages[0].includes('id="script"'));
    assert.ok(pages[1].includes('id="packing-gear"'));
    assert.ok(pages[2].includes('id="packing-prop"'));
    assert.ok(pages[3].includes('class="shot-list"'));
    assert.equal(JSON.stringify([currentDocument(), mergeBase(), saveChanges(), unsavedChanges()]), before);
    assert.equal(document.querySelector('a[download$=".pdf"]'), null);
  } finally { printDialog.reserve = reserve; }
});

test("print providers preserve a captured document, day and options while the live script changes", () => {
  const doc = captureExportDocument();
  const options = Object.freeze({ brollView: Object.freeze({ filter: "all", group: "scene" }) });
  const request = { doc, options, assets: exportAssetsNow(doc) };
  const providers = exportFormats.exporters().filter((entry) => entry.printPage);
  const before = providers.map((entry) => entry.printPage(request));
  const title = currentDocument().title;
  try {
    currentDocument().title = "Changed after capture";
    assert.deepEqual(providers.map((entry) => entry.printPage(request)), before);
    assert.ok(before.every((html) => !html.includes("Changed after capture")));
  } finally { currentDocument().title = title; }
});
