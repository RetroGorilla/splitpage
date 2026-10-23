import { createViewLifetime } from "../common/view-lifetime.ts";

export interface IdentityPorts {
  readonly promptForName: () => void;
}

export function mountIdentity(mount: { window: Window; ports: IdentityPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("identity-chip"), "click", ports.promptForName);
  return { dispose: life.dispose };
}

export interface ServerPorts {
  readonly closeServerPicker: () => void;
  readonly openServerDoc: (id: string | null) => void;
  readonly armServerDelete: (button: HTMLElement, id: string | null) => void;
  readonly routeOpen: (id: string | null) => Promise<boolean> | null;
  readonly capture: () => () => boolean;
}

export function mountServer(mount: { window: Window; ports: ServerPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("server-modal"), "click", function (e) {
    if (e.target.id === "server-modal") { ports.closeServerPicker(); return; }
    const openBtn = e.target.closest<HTMLElement>('[data-action="server-open"]');
    if (openBtn) {
      const sid = openBtn.getAttribute("data-id");
      const owns = ports.capture();
      const pending = ports.routeOpen(sid);
      if (pending) {
        void pending.then(function (here) {
          if (!life.active() || !owns()) return;
          if (here) ports.openServerDoc(sid); else ports.closeServerPicker();
        });
      } else ports.openServerDoc(sid);
      return;
    }
    const delBtn = e.target.closest<HTMLElement>('[data-action="server-delete"]');
    if (delBtn) { ports.armServerDelete(delBtn, delBtn.getAttribute("data-id")); return; }
  });
  life.listen(element("server-close"), "click", ports.closeServerPicker);
  life.listen(element("server-cancel"), "click", ports.closeServerPicker);
  life.listen(window, "keydown", function (e) {
    if (e.key === "Escape" && !element("server-modal").hidden) ports.closeServerPicker();
  });
  return { dispose: life.dispose };
}

export interface DrivePorts {
  readonly closeDriveModal: () => void;
  readonly driveSaveCredsFromForm: () => void;
  readonly driveShowCredsForm: () => void;
  readonly driveConnect: (value: string) => void;
  readonly driveCrumbTo: (index: number) => void;
  readonly driveOpenItem: (id: string | null) => void;
  readonly driveListCurrent: () => void;
  readonly toggleDriveNewFolder: (open?: boolean) => void;
  readonly driveCreateFolder: () => void;
  readonly driveSignIn: () => void;
  readonly driveSignOut: () => void;
  readonly driveStartRename: (id: string | null) => void;
  readonly driveSaveRename: (id: string | null) => void;
  readonly driveCancelRename: () => void;
  readonly driveItemById: (id: string | null) => unknown;
  readonly armDriveDelete: (button: HTMLElement, item: unknown) => void;
  readonly driveUploadFiles: (files: FileList | null) => void;
}

export function mountDrive(mount: { window: Window; ports: DrivePorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("drive-modal"), "click", function (e) {
    if (e.target.id === "drive-modal") { ports.closeDriveModal(); return; }
    const t = e.target.closest<HTMLElement>("[data-action]");
    if (!t) return;
    const act = t.getAttribute("data-action");
    const id = t.getAttribute("data-id");
    if (act === "drive-save-creds") ports.driveSaveCredsFromForm();
    else if (act === "drive-edit-creds") ports.driveShowCredsForm();
    else if (act === "drive-connect") ports.driveConnect(element("drive-folder-input").value);
    else if (act === "drive-crumb") ports.driveCrumbTo(Number(t.getAttribute("data-index")));
    else if (act === "drive-open-item") ports.driveOpenItem(id);
    else if (act === "drive-refresh") ports.driveListCurrent();
    else if (act === "drive-newfolder-toggle") ports.toggleDriveNewFolder();
    else if (act === "drive-newfolder-create") ports.driveCreateFolder();
    else if (act === "drive-newfolder-cancel") ports.toggleDriveNewFolder(false);
    else if (act === "drive-upload") element("drive-upload-input").click();
    else if (act === "drive-signin") ports.driveSignIn();
    else if (act === "drive-signout") ports.driveSignOut();
    else if (act === "drive-rename") ports.driveStartRename(id);
    else if (act === "drive-rename-save") ports.driveSaveRename(id);
    else if (act === "drive-rename-cancel") ports.driveCancelRename();
    else if (act === "drive-delete") { const it = ports.driveItemById(id); if (it) ports.armDriveDelete(t, it); }
  });
  life.listen(element("drive-close"), "click", ports.closeDriveModal);
  life.listen(element("drive-done"), "click", ports.closeDriveModal);
  life.listen(element("drive-folder-input"), "keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); ports.driveConnect(e.target.value); }
  });
  life.listen(element("drive-newfolder-input"), "keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); ports.driveCreateFolder(); }
    else if (e.key === "Escape") { e.preventDefault(); ports.toggleDriveNewFolder(false); }
  });
  ["drive-api-key", "drive-client-id"].forEach(function (id) {
    life.listen(element(id), "keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); ports.driveSaveCredsFromForm(); }
    });
  });
  life.listen(element("drive-upload-input"), "change", function (e) {
    ports.driveUploadFiles(e.target.files);
    e.target.value = "";
  });
  life.listen(window, "keydown", function (e) {
    if (e.key === "Escape" && !element("drive-modal").hidden) ports.closeDriveModal();
  });
  return { dispose: life.dispose };
}
