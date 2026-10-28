import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startLocalFileMenu } from "../../../src/features/file-menu/local-files.js";
import type { LocalFileMenuPorts } from "../../../src/features/file-menu/local-files-ports.ts";
import { createActionRegistry } from "../../../src/application/actions.ts";
import { createExportRegistry } from "../../../src/application/export/registry.ts";
import { createDocumentLocation } from "../../../src/application/location/document-location.ts";
import { createServerStatus } from "../../../src/application/location/server-status.ts";
import { fakeDocument, fakeNotices } from "../fakes.ts";

test("local file menu mounts with named fakes, paints the chip, announces choices and manages resume", () => {
  document.body.innerHTML = '<button id="menu-save-back"></button><div id="file-chip"><span id="file-chip-name"></span><span id="file-chip-state"></span></div><div id="readonly-banner"></div><div id="resume-banner" hidden><span id="resume-banner-text"></span></div>';
  const location = createDocumentLocation();
  location.setHome("import", { name: "draft.txt", dirty: true });
  const ports: LocalFileMenuPorts = {
    document: fakeDocument(null).document,
    preferences: { clock: () => "24h" }, onServerDoc: () => false,
    server: createServerStatus({ storage: () => null }), place: location,
    saves: { unsaved: () => true }, autoSaves: { policy: () => { throw new Error("unused"); } },
    writeback: { saveBackItemState: () => ({ hidden: false, disabled: false, reason: "", label: "Save to draft.txt" }) },
    exports: { captureExportDocument: () => { throw new Error("unused"); }, loadExportAssets: async () => { throw new Error("unused"); } },
    formats: createExportRegistry(), assetSource: () => null,
    assets: { request: () => ({ shas: [], source: null }) }, standaloneHtml: () => "",
    imagesLeftOut: () => {}, brollView: { printView: () => ({ filter: "all", group: "scene" }) },
    notices: { ...fakeNotices().notices, busy: { withBar: async (_label, work) => work() } },
    delivery: { deliver: async () => true }, menuItems: { setLabel: (item, label) => { if (item) item.textContent = label; } },
    merge: { offer: async () => {}, reset: () => {} },
    exportControls: { isExportAction: () => false, rememberExport: () => {} }, actions: createActionRegistry()
  };
  const mounted = startLocalFileMenu(ports);
  mounted.updateFileChip();
  assert.equal(document.getElementById("file-chip-name")?.textContent, "draft.txt");
  assert.equal(document.getElementById("file-chip-state")?.textContent, "· unsaved changes");
  const choices: string[] = [];
  const unsubscribe = mounted.onFileMenuChoice((action: string) => choices.push(action));
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
