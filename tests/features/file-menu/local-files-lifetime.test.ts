import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startLocalFileMenu } from "../../../src/features/file-menu/local-files.ts";
import type { LocalFileMenuControls, LocalFileMenuPorts } from "../../../src/features/file-menu/local-files-ports.ts";
import { createActionRegistry } from "../../../src/application/actions.ts";
import { createExportRegistry } from "../../../src/application/export/registry.ts";
import type { ExportAssets } from "../../../src/application/export/assets.ts";
import { createDocumentLocation } from "../../../src/application/location/document-location.ts";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices } from "../fakes.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const assets: ExportAssets = { shas: [], missing: [], picture: () => null };

function harness(label: string) {
  const doc = migrateRows({ title: label, rows: [] }, fakeMigration().ports);
  const captured = buildExportDocument(doc, "2026-10-28T00:00:00.000Z", { production: [], commentNumbers: {}, broll: [] });
  const formats = createExportRegistry();
  const builds: unknown[] = [];
  const deliveries: unknown[] = [];
  const warnings: unknown[] = [];
  const zips: unknown[] = [];
  formats.defineCard({ id: "script", name: "Script", ext: "txt", icon: "", purpose: "", group: "whole", toggle: { id: "directions", label: "Directions", on: () => true, set: () => {} } });
  formats.register({ id: "txt", action: "export-txt", name: "Text", menuLabel: "Text", card: "script", fileName: (base) => label + ":" + base + ".txt", build: async (request) => { builds.push(request); return { data: label, diagnostics: { imagesLeftOut: 1 } }; } });
  const notices = fakeNotices();
  const place = createDocumentLocation();
  const ports: LocalFileMenuPorts = {
    document: fakeDocument(doc).document, preferences: { clock: () => "24h" }, place,
    exports: { captureExportDocument: () => captured, loadExportAssets: async () => assets }, formats,
    assets: { request: () => ({ shas: [] }) }, standaloneHtml: () => "",
    imagesLeftOut: (...args) => { warnings.push(args); }, brollView: { printView: () => ({ filter: "all", group: "scene" }) },
    notices: { ...notices.notices, busy: { withBar: async (_label, work) => work() } },
    delivery: { deliver: async (...args) => { deliveries.push(args); return true; } },
    scriptFiles: { export: async (...args) => { zips.push(args); return true; } },
    pdfPrint: { export: () => null },
    merge: { offer: async () => {}, reset: () => {} },
    exportControls: { isExportAction: () => false, rememberExport: () => {} }, actions: createActionRegistry()
  };
  return { ports, place, formats, builds, deliveries, warnings, notices, zips };
}

test("retired controls and repeated disposal cannot affect a replacement menu", () => {
  document.body.innerHTML = '<div id="resume-banner" hidden><span id="resume-banner-text"></span></div>';
  const old: LocalFileMenuControls = startLocalFileMenu(harness("old").ports);
  let refreshed = 0;
  const listeners = old.fileChipListeners(() => { refreshed++; });
  old.dispose();
  const fresh: LocalFileMenuControls = startLocalFileMenu(harness("fresh").ports);
  try {
    assert.throws(() => old.showResumeBanner({ name: "stale" }), /not started yet/);
    assert.throws(() => old.exportFileName("txt", "stale"), /not started yet/);
    assert.throws(() => old.pendingHandle(), /not started yet/);
    assert.throws(() => old.onFileMenuChoice(() => {}), /not started yet/);
    assert.throws(() => old.noteFileMenuChoice("save"), /not started yet/);
    listeners.location("home");
    listeners.save("clean");
    assert.equal(refreshed, 0);
    old.dispose();
    assert.equal(fresh.exportFileName("txt", "live"), "fresh:live.txt");
    assert.equal(document.getElementById("resume-banner")?.hasAttribute("hidden"), true);
  } finally { fresh.dispose(); }
});

for (const stage of ["assets", "build", "failed assets"]) {
  test("export stopped during " + stage + " neither delivers nor reports through a replacement", async () => {
    const old = harness("old");
    const fresh = harness("fresh");
    const entered = deferred<undefined>();
    const gate = deferred<undefined>();
    let ports = old.ports;
    if (stage === "build") {
      const formats = createExportRegistry();
      formats.register({ id: "txt", fileName: (base) => base + ".txt", build: async () => { entered.resolve(undefined); await gate.promise; return { data: "old", diagnostics: { imagesLeftOut: 1 } }; } });
      ports = { ...ports, formats };
    } else {
      ports = { ...ports, exports: { ...ports.exports, loadExportAssets: async () => { entered.resolve(undefined); await gate.promise; return assets; } } };
    }
    const mounted: LocalFileMenuControls = startLocalFileMenu(ports);
    const pending = mounted.exportAs("txt");
    await entered.promise;
    mounted.dispose();
    const replacement: LocalFileMenuControls = startLocalFileMenu(fresh.ports);
    try {
      if (stage === "failed assets") gate.reject(new Error("late asset failure"));
      else gate.resolve(undefined);
      await pending;
      assert.deepEqual(old.deliveries, []);
      assert.deepEqual(fresh.deliveries, []);
      assert.deepEqual(old.warnings, []);
      assert.deepEqual(fresh.warnings, []);
      assert.deepEqual(old.notices.shown, []);
      assert.deepEqual(fresh.notices.shown, []);
      if (stage !== "build") assert.deepEqual(old.builds, []);
    } finally { replacement.dispose(); }
  });
}

for (const [count, expected] of [[3, ["3 characters can't be shown in PDF"]], [1, ["1 character can't be shown in PDF"]], [0, []], [null, []]] as const) {
  test("a build reporting " + String(count) + " characters not shown gives the matching notice", async () => {
    const h = harness("live");
    const formats = createExportRegistry();
    const diagnostics = count === null ? { imagesLeftOut: 0 } : { imagesLeftOut: 0, unshownCharacters: count };
    formats.register({ id: "txt", fileName: (base) => base + ".txt", build: async () => ({ data: "x", diagnostics }) });
    const mounted: LocalFileMenuControls = startLocalFileMenu({ ...h.ports, formats });
    try {
      await mounted.buildFileData("txt", "script");
      assert.deepEqual(h.notices.shown.map((n) => n.message), expected);
      assert.deepEqual(h.warnings, [[0, "script.txt"]]);
    } finally { mounted.dispose(); }
  });
}

test("a retired conflict probe cannot reveal the replacement modal", async () => {
  document.body.innerHTML = '<div id="file-conflict-modal" hidden></div><div id="file-conflict-detail"></div>';
  const h = harness("old");
  const probe = deferred<undefined>();
  const old: LocalFileMenuControls = startLocalFileMenu({ ...h.ports, merge: { offer: () => probe.promise, reset: () => {} } });
  old.showFileConflictView({ kind: "project", fileName: "old.md", current: { lastModified: 1 } });
  old.dispose();
  const fresh: LocalFileMenuControls = startLocalFileMenu(harness("fresh").ports);
  try {
    probe.resolve(undefined);
    await probe.promise;
    assert.equal(document.getElementById("file-conflict-modal")?.hasAttribute("hidden"), true);
  } finally { fresh.dispose(); }
});

test("export options read the registry card toggle through the formats port", () => {
  const mounted: LocalFileMenuControls = startLocalFileMenu(harness("live").ports);
  try {
    const request = mounted.exportRequest("txt") as { options: { directions: boolean } };
    assert.equal(request.options.directions, true);
    const overridden = mounted.exportRequest("txt", { directions: false }) as { options: { directions: boolean } };
    assert.equal(overridden.options.directions, false);
  } finally { mounted.dispose(); }
});

test("an export built with the script's files goes to the files export, never to a plain download", async () => {
  const h = harness("live");
  const formats = createExportRegistry();
  formats.register({ id: "splitpage", fileName: (base) => base + " (with files).zip",
    build: async () => ({ data: "{\"rows\":[]}", withFiles: { scriptName: "script.splitpage" } }) });
  formats.register({ id: "plain", fileName: (base) => base + ".splitpage", build: async () => ({ data: "{}" }) });
  const mounted: LocalFileMenuControls = startLocalFileMenu({ ...h.ports, formats });
  try {
    await mounted.exportAs("splitpage");
    assert.deepEqual(h.zips, [["live (with files).zip", "script.splitpage", "{\"rows\":[]}", null]], "an unsaved script names no script to read files from");
    assert.deepEqual(h.deliveries, []);
    await mounted.exportAs("plain");
    assert.equal(h.deliveries.length, 1, "without the files it is an ordinary export");
    assert.equal(h.zips.length, 1);
  } finally { mounted.dispose(); }
});

test("the files export names the script its bytes were captured from, even when another script opens while they are built", async () => {
  const h = harness("live");
  const handle = { kind: "file" as const, name: "script.splitpage" };
  h.place.setHome("file", { handle, format: "splitpage", name: "script.splitpage" });
  const entered = deferred<undefined>();
  const gate = deferred<undefined>();
  const formats = createExportRegistry();
  formats.register({ id: "splitpage", fileName: (base) => base + " (with files).zip",
    build: async () => { entered.resolve(undefined); await gate.promise; return { data: "{}", withFiles: { scriptName: "script.splitpage" } }; } });
  const mounted: LocalFileMenuControls = startLocalFileMenu({ ...h.ports, formats });
  try {
    const exporting = mounted.exportAs("splitpage");
    await entered.promise;
    h.place.setHome("file", { handle: { kind: "file" as const, name: "other.splitpage" }, format: "splitpage", name: "other.splitpage" });
    gate.resolve(undefined);
    await exporting;
    assert.equal(h.zips.length, 1);
    assert.equal((h.zips[0] as unknown[])[3], handle);
  } finally { mounted.dispose(); }
});

test("a card toggle that is not offered here reads as off, whatever it was set to", () => {
  const h = harness("live");
  const formats = createExportRegistry();
  formats.defineCard({ id: "script", name: "Script", ext: "txt", icon: "", purpose: "", group: "whole",
    toggle: { id: "files", label: "Files", on: () => true, set: () => {}, offered: () => false } });
  formats.register({ id: "txt", action: "export-txt", name: "Text", menuLabel: "Text", card: "script", fileName: (base) => base + ".txt", build: async () => ({ data: "" }) });
  const mounted: LocalFileMenuControls = startLocalFileMenu({ ...h.ports, formats });
  try {
    assert.equal((mounted.exportRequest("txt") as { options: { files: boolean } }).options.files, false);
    assert.equal((mounted.exportRequest("txt", { files: true }) as { options: { files: boolean } }).options.files, false);
  } finally { mounted.dispose(); }
});