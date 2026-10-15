import { createViewLifetime } from "./lifetime.ts";

export interface ResumeHandle {
  readonly requestPermission: (options: { mode: "readwrite" }) => Promise<string>;
}

export interface SaveRecoveryPorts {
  readonly hideResumeBanner: () => void;
  readonly resumeFromHandle: (handle: ResumeHandle) => Promise<void>;
  readonly showToast: (message: string, kind: string) => void;
  readonly saveDoc: () => void;
  readonly exportAs: (format: string) => void;
  readonly pendingHandle: () => ResumeHandle | null;
  readonly capture: () => () => boolean;
}

export function mountSaveRecovery(mount: { window: Window; ports: SaveRecoveryPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("resume-continue"), "click", async function () {
    const handle = ports.pendingHandle();
    const owns = ports.capture();
    if (!handle) { ports.hideResumeBanner(); return; }
    try {
      const perm = await handle.requestPermission({ mode: "readwrite" });
      if (!life.active() || !owns() || ports.pendingHandle() !== handle) return;
      if (perm !== "granted") { ports.hideResumeBanner(); return; }
      await ports.resumeFromHandle(handle);
    } catch (e) {
      if (!life.active() || !owns()) return;
      ports.showToast("Could not reopen that file.", "error");
    }
    if (life.active() && ports.pendingHandle() === handle) ports.hideResumeBanner();
  });
  life.listen(element("resume-dismiss"), "click", ports.hideResumeBanner);

  life.listen(element("save-error-dismiss"), "click", function () {
    element("save-error-banner").hidden = true;
  });
  life.listen(element("save-error-retry"), "click", function () {
    element("save-error-banner").hidden = true;
    ports.saveDoc();
  });
  life.listen(element("save-error-export"), "click", function () {
    ports.exportAs("md");
  });
  return { dispose: life.dispose };
}

export interface ConflictsPorts {
  readonly closeFileConflict: () => void;
  readonly reloadProjectFromDisk: () => void;
  readonly reloadFileFromDisk: () => void;
  readonly saveDoc: (options: { force?: boolean; saveAs?: boolean }) => void;
  readonly saveBackToFile: (options: { force: boolean }) => void;
  readonly openMergeReview: () => void;
  readonly cancelMergeReview: () => void;
  readonly confirmFileMerge: () => void;
  readonly importHome: () => { name: string; format: string } | null;
  readonly buildFileData: (format: string, name: string) => Promise<{ data: unknown }>;
  readonly deliverFile: (name: string, data: unknown, options: { savedMsg: string }) => void;
  readonly conflict: () => { kind: string } | null;
  readonly capture: () => () => boolean;
}

export function mountConflicts(mount: { window: Window; ports: ConflictsPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("file-conflict-close"), "click", ports.closeFileConflict);
  life.listen(element("file-conflict-cancel"), "click", ports.closeFileConflict);
  life.listen(element("file-conflict-reload"), "click", function () {
    if (ports.conflict()?.kind === "project") ports.reloadProjectFromDisk();
    else ports.reloadFileFromDisk();
  });
  life.listen(element("file-conflict-overwrite"), "click", function () {
    const ctx = ports.conflict();
    ports.closeFileConflict();
    if (ctx && ctx.kind === "project") ports.saveDoc({ force: true });
    else ports.saveBackToFile({ force: true });
  });
  life.listen(element("file-conflict-merge"), "click", ports.openMergeReview);
  life.listen(element("merge-review-close"), "click", ports.cancelMergeReview);
  life.listen(element("merge-review-cancel"), "click", ports.cancelMergeReview);
  life.listen(element("merge-review-confirm"), "click", ports.confirmFileMerge);
  life.listen(window, "keydown", function (e) {
    if (e.key === "Escape" && !element("merge-review-modal").hidden) {
      e.preventDefault();
      ports.cancelMergeReview();
    }
  });

  life.listen(element("file-conflict-copy"), "click", function () {
    const ctx = ports.conflict();
    ports.closeFileConflict();
    if (ctx && ctx.kind === "project") { ports.saveDoc({ saveAs: true }); return; }
    const imported = ports.importHome();
    if (!imported) return;
    const base = imported.name.replace(/\.[^.]+$/, "");
    const ext = (/\.([^.]+)$/.exec(imported.name) || ["", "md"])[1];
    const owns = ports.capture();
    void ports.buildFileData(imported.format, base + " (copy)").then(function (built) {
      if (!life.active() || !owns()) return;
      ports.deliverFile(base + " (copy)." + ext, built.data, { savedMsg: "Saved a separate copy" });
    });
  });
  return { dispose: life.dispose };
}

export interface SavePorts {
  readonly saveFromButton: () => void;
  readonly updateSaveStatus: () => void;
}

export function mountSave(mount: { window: Window; ports: SavePorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("btn-save"), "click", ports.saveFromButton);
  life.listen(element("btn-save"), "mouseenter", ports.updateSaveStatus);
  life.listen(element("btn-save"), "focus", ports.updateSaveStatus);
  life.listen(element("wr-save-status"), "mouseenter", ports.updateSaveStatus);
  return { dispose: life.dispose };
}

export interface FileMenuPorts {
  readonly toggleFileMenu: (open?: boolean, options?: { focusFirst?: boolean; returnFocus?: boolean }) => void;
  readonly toggleSubmenu: (id: string | null, open?: boolean, focusFirst?: boolean) => void;
  readonly handleFileMenuAction: (action: string | null) => void;
  readonly openProjectFile: (file: File, handle: null) => void;
}

export function mountFileMenu(mount: { window: Window; ports: FileMenuPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("btn-file"), "click", function (e) {
    e.stopPropagation();
    ports.toggleFileMenu(undefined, { focusFirst: e.detail === 0 });
  });
  life.listen(element("file-menu"), "click", function (e) {
    const parent = e.target.closest(".mi-parent");
    if (parent) { ports.toggleSubmenu(parent.getAttribute("data-submenu"), undefined, e.detail === 0); return; }
    const item = e.target.closest<HTMLButtonElement>("[data-file-action]");
    if (item && !item.disabled) ports.handleFileMenuAction(item.getAttribute("data-file-action"));
  });
  life.listen(element("file-menu-close"), "click", function (e) {
    e.stopPropagation();
    ports.toggleFileMenu(false);
  });
  life.listen(element("file-menu-backdrop"), "click", function () {
    ports.toggleFileMenu(false);
  });
  life.listen(document, "click", function (e) {
    if (!e.target.closest(".menu-wrap")) ports.toggleFileMenu(false);
  });
  life.listen(window, "keydown", function (e) {
    if (e.key === "Escape" && !element("file-menu").hidden) ports.toggleFileMenu(false, { returnFocus: true });
  });
  life.listen(element("open-file-input"), "change", function (e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (file) ports.openProjectFile(file, null);
  });
  return { dispose: life.dispose };
}
