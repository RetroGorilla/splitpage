import "../../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createExportRegistry } from "../../application/export/registry.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import { buildExportDocument } from "../../core/document/export-document.ts";
import { migrateRows } from "../../core/migrate.ts";
import { fakeMigration } from "../../../tests/core/migrate-ports.ts";
import { fakeNotices } from "../../../tests/features/fakes.ts";
import { __init as mountExportDialog } from "./export-dialog.js";
import type { FileMenuExportPorts } from "./ports.ts";

function harness() {
  document.body.innerHTML = '<button id="back">Back</button><div id="file-menu"><div class="menu-hidden-actions"></div></div>' +
    '<button id="menu-export-again"><span class="mi-label"></span><span class="mi-why"></span></button>' +
    '<div id="export-modal" hidden><div id="export-formats"></div><div id="export-options"></div>' +
    '<div id="export-preview"></div><div id="export-summary"></div><div id="export-filename"></div>' +
    '<div id="export-why"></div><button id="export-close"></button><button id="export-cancel"></button>' +
    '<button id="export-go"></button><button id="export-share-link"></button></div>';
  localStorage.clear();
  const source = migrateRows({ schema: 5, title: "Test", rows: [] }, fakeMigration().ports);
  const captured = buildExportDocument(source, "2026-10-23T12:00:00.000Z", { production: [], commentNumbers: {}, broll: [] });
  let current: ReturnType<DocumentReader["current"]> = source;
  const registry = createExportRegistry();
  registry.defineCard({ id: "pdf", group: "whole", name: "PDF", ext: ".pdf", icon: "i-pdf", purpose: "Print it" });
  registry.register({ id: "pdf", action: "export-pdf", card: "pdf", name: "PDF", menuLabel: "PDF",
    fileName: (base) => base + ".pdf", build: () => ({ data: "" }) });
  const notices = fakeNotices();
  const menuListeners = new Set<() => void>();
  const formatListeners = new Set<() => void>();
  const exported: string[] = [];
  const effects: string[][] = [];
  let shares = 0;
  const ports: FileMenuExportPorts = {
    document: { current: () => current },
    text: { cellOf: () => [] },
    notices: notices.notices,
    menuItems: {
      setLabel: (_item, label) => { effects.push(["label", label]); },
      setReason: (_item, reason) => { effects.push(["reason", reason]); }
    },
    exports: {
      ...registry,
      onChange: (listener) => {
        formatListeners.add(listener);
        const off = registry.onChange(listener);
        return () => { formatListeners.delete(listener); off(); };
      }
    },
    capture: () => captured,
    preview: {
      facts: () => ({ seconds: 0, runtime: "0:00", words: 0, date: "23 October", target: null, status: { todo: 0, ready: 0, shot: 0 } }),
      scenes: () => [], breakdown: () => [], shots: () => [], runs: () => [], narration: () => [],
      meta: () => "", shotSummary: () => "", commentCount: () => 0,
      markdown: () => "", markdownTable: () => "", tagColor: () => null
    },
    fileName: () => "test.pdf",
    exportAction: (action) => { exported.push(action); return true; },
    share: () => { shares++; },
    onMenuRefresh: (listener) => { menuListeners.add(listener); return () => { menuListeners.delete(listener); }; }
  };
  return { ports, registry, menuListeners, formatListeners, exported, effects, notices,
    loading: () => { current = null; }, shares: () => shares };
}

test("the dialog runs with shared port fakes and releases its listeners and subscriptions on remount", () => {
  const h = harness();
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    assert.ok(found);
    return found;
  };
  let dialog = mountExportDialog(h.ports);
  try {
    assert.equal(h.menuListeners.size, 1);
    assert.equal(h.formatListeners.size, 1);
    element("back").focus();
    assert.equal(dialog.openExportDialog(), true);
    assert.equal(element("export-filename").textContent, "test.pdf");
    assert.equal(dialog.exportDialogOpen(), true);
    element("export-modal").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(dialog.exportDialogOpen(), false);
    assert.equal(document.activeElement, element("back"));
    dialog.rememberExport("export-pdf");
    h.menuListeners.forEach((listener) => listener());
    assert.deepEqual(h.effects, [["label", "Export again as PDF"], ["reason", ""]]);
    dialog.openExportDialog();
    element("export-go").click();
    assert.deepEqual(h.exported, ["export-pdf"]);
    dialog.openExportDialog();
    element("export-share-link").click();
    assert.equal(h.shares(), 1);
    dialog.dispose();
    dialog.dispose();
    assert.equal(h.menuListeners.size, 0);
    assert.equal(h.formatListeners.size, 0);
    element("export-share-link").click();
    assert.equal(h.shares(), 1);
    dialog = mountExportDialog(h.ports);
    dialog.openExportDialog();
    element("export-go").click();
    assert.deepEqual(h.exported, ["export-pdf", "export-pdf"]);
    h.registry.defineCard({ id: "demo", group: "part", name: "Demo", ext: ".demo", icon: "i-file", purpose: "Demo" });
    const remove = h.registry.register({ id: "demo", action: "export-demo", card: "demo", name: "Demo", menuLabel: "Demo",
      fileName: (base) => base + ".demo", build: () => ({ data: "" }) });
    assert.ok(document.querySelector('[data-file-action="export-demo"]'));
    dialog.rememberExport("export-demo");
    remove();
    assert.equal(dialog.lastExportAction(), null);
    assert.equal(dialog.exportAgainItemState().hidden, true);
    h.loading();
    assert.equal(dialog.openExportDialog(), false);
    assert.equal(h.notices.shown[0]?.message, "Still loading…");
  } finally {
    dialog.dispose();
    localStorage.clear();
  }
});
