import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startLocalFileMenu } from "../../../src/features/file-menu/local-files.ts";
import type { LocalFileMenuPorts } from "../../../src/features/file-menu/local-files-ports.ts";
import { createActionRegistry } from "../../../src/application/actions.ts";
import { createExportRegistry } from "../../../src/application/export/registry.ts";
import { createDocumentLocation } from "../../../src/application/location/document-location.ts";
import { fakeDocument, fakeNotices } from "../fakes.ts";

test("local file menu mounts with named fakes, paints the chip, announces choices and manages resume", () => {
  document.body.innerHTML = '<div id="file-chip"><span id="file-chip-name"></span><span id="file-chip-state"></span></div><div id="readonly-banner"></div><div id="resume-banner" hidden><span id="resume-banner-text"></span></div>';
  const location = createDocumentLocation();
  location.setHome("import", { name: "draft.txt", dirty: true });
  const ports: LocalFileMenuPorts = {
    document: fakeDocument(null).document,
    preferences: { clock: () => "24h" }, place: location,
    exports: { captureExportDocument: () => { throw new Error("unused"); }, loadExportAssets: async () => { throw new Error("unused"); } },
    formats: createExportRegistry(),
    assets: { request: () => ({ shas: [] }) }, standaloneHtml: () => "",
    imagesLeftOut: () => {}, brollView: { printView: () => ({ filter: "all", group: "scene" }) },
    notices: { ...fakeNotices().notices, busy: { withBar: async (_label, work) => work() } },
    delivery: { deliver: async () => true },
    pdfPrint: { export: () => null },
    merge: { offer: async () => {}, reset: () => {} },
    exportControls: { isExportAction: () => false, rememberExport: () => {} }, actions: createActionRegistry()
  };
  const mounted = startLocalFileMenu(ports);
  mounted.updateFileChip();
  assert.equal(document.getElementById("file-chip-name")?.textContent, "draft.txt");
  assert.equal(document.getElementById("file-chip-state")?.textContent, "· unsaved changes");
  const choices: (string | null)[] = [];
  const unsubscribe = mounted.onFileMenuChoice((action: string | null) => choices.push(action));
  mounted.noteFileMenuChoice("save");
  unsubscribe();
  mounted.noteFileMenuChoice("open");
  assert.deepEqual(choices, ["save"]);
  const handle = { name: "script.md" };
  mounted.showResumeBanner(handle);
  assert.equal(mounted.pendingHandle(), handle);
  assert.equal(document.getElementById("resume-banner-text")?.textContent, " script.md needs a click to reopen.");
  mounted.hideResumeBanner();
  assert.equal(mounted.pendingHandle(), null);
  mounted.dispose();
  document.body.innerHTML = "";
});
