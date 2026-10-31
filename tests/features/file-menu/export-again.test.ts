import "../../../src/test/_dom.mjs";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { startExportDialog } from "../../../src/features/file-menu/export-dialog.js";
import { createExportRegistry } from "../../../src/application/export/registry.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices } from "../fakes.ts";

function scriptDoc() {
  return migrateRows({ title: "Export", rows: [{ id: "r1", visualText: "One", audioText: "" }] }, fakeMigration().ports);
}

interface Listed {
  readonly id: string;
  readonly action?: string;
  readonly choices?: readonly { value: string; label: string; action: string }[];
  readonly pictures: boolean;
  readonly extras: boolean;
}

type Reasons = Record<string, string>;

function mount(t: TestContext, options: { loaded?: boolean; reasons?: Reasons } = {}) {
  localStorage.clear();
  const registry = createExportRegistry();
  registry.defineCard({ id: "plain", group: "whole", name: "Plain text", ext: "txt", icon: "t", purpose: "Words only" });
  registry.defineCard({ id: "sheet", group: "part", name: "Sheet", ext: "csv", icon: "s", purpose: "Rows" });
  const reasons = options.reasons ?? {};
  const base = {
    fileName: (name: string) => name + ".txt",
    build: () => ({ data: "" })
  };
  registry.register({ ...base, id: "plain", action: "export-plain", card: "plain", name: "Plain text", menuLabel: "Plain text (.txt)", reason: () => reasons["export-plain"] ?? "" });
  registry.register({ ...base, id: "sheet-a", action: "export-sheet-a", card: "sheet", name: "Sheet A", menuLabel: "Sheet A", choice: { value: "a", label: "A" }, reason: () => reasons["export-sheet-a"] ?? "" });
  registry.register({ ...base, id: "sheet-b", action: "export-sheet-b", card: "sheet", name: "Sheet B", menuLabel: "Sheet B", choice: { value: "b", label: "B" } });
  registry.register({ ...base, id: "hidden-helper" });
  const ports = {
    document: fakeDocument(options.loaded === false ? null : scriptDoc()).document,
    capture: () => ({}),
    notices: fakeNotices().notices,
    exports: registry,
    exportAction: () => true,
    printWorkflow: () => false,
    onMenuRefresh: () => () => undefined,
    menuItems: { setLabel: () => undefined, setReason: () => undefined },
    text: { cellOf: () => null },
    preview: {}
  };
  const controls = startExportDialog(ports);
  t.after(() => {
    controls.dispose();
    localStorage.clear();
  });
  return controls;
}

test("export again: nothing remembered hides the menu item", (t) => {
  const controls = mount(t);
  assert.equal(controls.lastExportAction(), null);
  assert.deepEqual(controls.exportAgainItemState(), { hidden: true, disabled: false, reason: "", label: "" });
});

test("export again: remembers the last export and labels the menu item with its name", (t) => {
  const controls = mount(t);
  controls.rememberExport("export-sheet-b");
  assert.equal(controls.lastExportAction(), "export-sheet-b");
  assert.deepEqual(controls.exportAgainItemState(), {
    hidden: false, disabled: false, reason: "", label: "Export again as Sheet B"
  });
  controls.rememberExport("export-plain");
  assert.equal(controls.lastExportAction(), "export-plain");
});

test("export again: ignores an action that is not a registered export", (t) => {
  const controls = mount(t);
  controls.rememberExport("export-plain");
  controls.rememberExport("export-nonsense");
  controls.rememberExport("");
  assert.equal(controls.lastExportAction(), "export-plain");
  assert.equal(localStorage.getItem("splitpage-last-export"), "export-plain");
});

test("export again: forgets a saved action that is no longer registered", (t) => {
  const controls = mount(t);
  localStorage.setItem("splitpage-last-export", "export-removed");
  assert.equal(controls.lastExportAction(), null);
  assert.equal(controls.exportAgainItemState().hidden, true);
});

test("export again: disables the menu item and shows the reason when the export is refused", (t) => {
  const controls = mount(t, { reasons: { "export-sheet-a": "No scenes yet" } });
  controls.rememberExport("export-sheet-a");
  assert.deepEqual(controls.exportAgainItemState(), {
    hidden: false, disabled: true, reason: "No scenes yet", label: "Export again as Sheet A"
  });
});

test("export again: reports that the document is still loading", (t) => {
  const controls = mount(t, { loaded: false });
  controls.rememberExport("export-plain");
  const state = controls.exportAgainItemState() as { disabled: boolean; reason: string };
  assert.equal(state.disabled, true);
  assert.match(state.reason, /^Still loading/);
  assert.equal(controls.exportActionReason("export-plain"), state.reason);
});

test("export dialog: an action's reason is empty when the exporter gives none", (t) => {
  const controls = mount(t);
  assert.equal(controls.exportActionReason("export-plain"), "");
  assert.equal(controls.exportActionReason("export-unknown"), "");
});

test("export dialog: names an action and recognises only registered actions", (t) => {
  const controls = mount(t);
  assert.equal(controls.exportActionName("export-sheet-a"), "Sheet A");
  assert.equal(controls.exportActionName("export-unknown"), "");
  assert.equal(controls.isExportAction("export-plain"), true);
  assert.equal(controls.isExportAction("hidden-helper"), false);
  assert.equal(controls.isExportAction(undefined), false);
  assert.equal(controls.isExportAction(""), false);
});

test("export dialog: lists a single-variant card by action and a choice card by its choices", (t) => {
  const controls = mount(t);
  const formats = controls.exportFormatList() as Listed[];
  assert.deepEqual(formats.map((f) => f.id), ["plain", "sheet"]);
  const plain = formats[0];
  assert.equal(plain?.action, "export-plain");
  assert.equal(plain?.choices, undefined);
  assert.equal(plain?.pictures, false);
  assert.equal(plain?.extras, false);
  const sheet = formats[1];
  assert.equal(sheet?.action, undefined);
  assert.deepEqual(sheet?.choices, [
    { value: "a", label: "A", action: "export-sheet-a" },
    { value: "b", label: "B", action: "export-sheet-b" }
  ]);
});

test("export dialog: with no dialog markup on the page, opening is reported closed", (t) => {
  const controls = mount(t);
  assert.equal(controls.exportDialogOpen(), false);
});
