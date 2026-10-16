import { createViewLifetime } from "./lifetime.ts";

export interface ImportsPorts {
  readonly finishMarkdownRowChoice: (choice: string) => void;
  readonly closeImportModal: () => void;
  readonly confirmImport: () => void;
  readonly clearPendingFileRows: () => void;
  readonly maybeAutoDetectTwoColumn: (value: string) => void;
  readonly updateImportPreview: () => void;
  readonly handleImportFile: (file: File) => void;
  readonly touchMode: () => void;
  readonly capture: () => () => boolean;
}

export function mountImports(mount: { window: Window; ports: ImportsPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  let previewGeneration = 0;
  life.listen(element("md-rows-keep"), "click", function () {
    ports.finishMarkdownRowChoice("keep");
  });
  life.listen(element("md-rows-table"), "click", function () {
    ports.finishMarkdownRowChoice("table");
  });
  life.listen(window, "keydown", function (e) {
    if (e.key === "Escape" && !element("md-rows-modal").hidden) {
      ports.finishMarkdownRowChoice("keep");
    }
  });

  life.listen(element("import-close"), "click", ports.closeImportModal);
  life.listen(element("import-cancel"), "click", ports.closeImportModal);
  life.listen(element("import-confirm"), "click", ports.confirmImport);
  let importPreviewDebounce: number | undefined;
  life.release(() => window.clearTimeout(importPreviewDebounce));
  life.listen(element("import-textarea"), "input", function (e) {
    const value = e.target.value;
    if (value) ports.clearPendingFileRows();
    window.clearTimeout(importPreviewDebounce);
    const owns = ports.capture();
    const textarea = e.target;
    const generation = ++previewGeneration;
    importPreviewDebounce = window.setTimeout(function () {
      if (!life.active() || !owns() || generation !== previewGeneration || element("import-textarea") !== textarea) return;
      importPreviewDebounce = undefined;
      ports.maybeAutoDetectTwoColumn(value);
      ports.updateImportPreview();
    }, 150);
  });
  document.querySelectorAll('input[name="import-split"]').forEach(function (r) {
    life.listen(r, "change", function () {
      ports.touchMode();
      ports.updateImportPreview();
    });
  });
  life.listen(element("import-choose-file"), "click", function () {
    element("import-file-input").click();
  });
  life.listen(element("import-file-input"), "change", function (e) {
    const file = e.target.files && e.target.files[0];
    if (file) ports.handleImportFile(file);
    e.target.value = "";
  });
  life.listen(element("import-modal"), "click", function (e) {
    if (e.target.id === "import-modal") ports.closeImportModal();
  });
  life.listen(window, "keydown", function (e) {
    if (e.key === "Escape" && !element("import-modal").hidden) ports.closeImportModal();
  });
  return { dispose: life.dispose };
}

export interface GdocPorts {
  readonly closeGdocModal: () => void;
  readonly confirmGdocImport: () => void;
}

export function mountGdoc(mount: { window: Window; ports: GdocPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("gdoc-close"), "click", ports.closeGdocModal);
  life.listen(element("gdoc-cancel"), "click", ports.closeGdocModal);
  life.listen(element("gdoc-confirm"), "click", ports.confirmGdocImport);
  life.listen(element("gdoc-url-input"), "keydown", function (e) {
    if (e.key === "Enter") ports.confirmGdocImport();
  });
  life.listen(element("gdoc-modal"), "click", function (e) {
    if (e.target.id === "gdoc-modal") ports.closeGdocModal();
  });
  life.listen(window, "keydown", function (e) {
    if (e.key === "Escape" && !element("gdoc-modal").hidden) ports.closeGdocModal();
  });
  return { dispose: life.dispose };
}
