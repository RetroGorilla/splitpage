import test from "node:test";
import assert from "node:assert/strict";
import { mountIdentity, mountServer, mountDrive } from "../../../src/features/settings/mount.ts";
import type { IdentityPorts, ServerPorts, DrivePorts } from "../../../src/features/settings/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const expected: readonly Registration[] = [
  [
    "identity-chip",
    "click"
  ],
  [
    "server-modal",
    "click"
  ],
  [
    "server-close",
    "click"
  ],
  [
    "server-cancel",
    "click"
  ],
  [
    "window",
    "keydown"
  ],
  [
    "drive-modal",
    "click"
  ],
  [
    "drive-close",
    "click"
  ],
  [
    "drive-done",
    "click"
  ],
  [
    "drive-folder-input",
    "keydown"
  ],
  [
    "drive-newfolder-input",
    "keydown"
  ],
  [
    "drive-api-key",
    "keydown"
  ],
  [
    "drive-client-id",
    "keydown"
  ],
  [
    "drive-upload-input",
    "change"
  ],
  [
    "window",
    "keydown"
  ]
];

export function setup() {
  const h = viewHarness();
  const p0: IdentityPorts = {
    promptForName: h.log("promptForName")
  };
  const p1: ServerPorts = {
    closeServerPicker: h.log("closeServerPicker"),
    openServerDoc: h.log("openServerDoc"),
    armServerDelete: h.log("armServerDelete"),
    routeOpen: () => null,
    capture: h.capture
  };
  const p2: DrivePorts = {
    closeDriveModal: h.log("closeDriveModal"),
    driveSaveCredsFromForm: h.log("driveSaveCredsFromForm"),
    driveShowCredsForm: h.log("driveShowCredsForm"),
    driveConnect: h.log("driveConnect"),
    driveCrumbTo: h.log("driveCrumbTo"),
    driveOpenItem: h.log("driveOpenItem"),
    driveListCurrent: h.log("driveListCurrent"),
    toggleDriveNewFolder: h.log("toggleDriveNewFolder"),
    driveCreateFolder: h.log("driveCreateFolder"),
    driveSignIn: h.log("driveSignIn"),
    driveSignOut: h.log("driveSignOut"),
    driveStartRename: h.log("driveStartRename"),
    driveSaveRename: h.log("driveSaveRename"),
    driveCancelRename: h.log("driveCancelRename"),
    driveItemById: () => null,
    armDriveDelete: h.log("armDriveDelete"),
    driveUploadFiles: h.log("driveUploadFiles")
  };
  const mount = () => [mountIdentity({ window: h.window, ports: p0 }), mountServer({ window: h.window, ports: p1 }), mountDrive({ window: h.window, ports: p2 })];
  return { ...h, mount, p0, p1, p2 };
}

test("settings: every target, event, phase and multiplicity across dispose and remount", () => {
  const h = setup();
  h.assertRemount(h.mount, expected);
  h.window.close();
});

for (const scenario of ["dispose and reopen", "same-ID replacement", "stale completion after remount", "normal completion"]) {
  test("settings: deferred server route, " + scenario, async () => {
    const h = setup();
    let finish: (here: boolean) => void = () => { throw new Error("Route did not start"); };
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const mount = () => mountServer({ window: h.window, ports: { ...h.p1, routeOpen: () => pending } });
    const owner = mount();
    h.el("server-modal").innerHTML = '<button data-action="server-open" data-id="doc1"></button>';
    const button = h.el("server-modal").querySelector("button");
    assert.ok(button);
    h.fire(button, "click");
    let replacement: ReturnType<typeof mount> | undefined;
    if (scenario === "dispose and reopen" || scenario === "stale completion after remount") {
      owner.dispose();
      h.replaceDocument();
      replacement = mount();
    } else if (scenario === "same-ID replacement") h.replaceDocument();
    finish(true);
    await pending;
    assert.deepEqual(h.calls, scenario === "normal completion" ? [{ name: "openServerDoc", args: ["doc1"] }] : []);
    owner.dispose();
    replacement?.dispose();
    h.window.close();
  });
}

test("settings: Drive action dispatch, credentials, reset, Enter and Escape preserve ordering", () => {
  const h = setup();
  const owner = mountDrive({ window: h.window, ports: h.p2 });
  const actions = ["drive-save-creds", "drive-edit-creds", "drive-connect", "drive-crumb", "drive-open-item", "drive-refresh", "drive-newfolder-toggle", "drive-newfolder-create", "drive-newfolder-cancel", "drive-signin", "drive-signout", "drive-rename", "drive-rename-save", "drive-rename-cancel"];
  h.el("drive-folder-input").value = "folder";
  const button = h.document.createElement("button");
  h.el("drive-modal").append(button);
  for (const action of actions) {
    button.dataset.action = action;
    button.dataset.id = "item";
    button.dataset.index = "2";
    h.fire(button, "click");
  }
  h.fire(h.el("drive-folder-input"), "keydown", { key: "Enter" });
  h.fire(h.el("drive-newfolder-input"), "keydown", { key: "Escape" });
  h.fire(h.el("drive-api-key"), "keydown", { key: "Enter" });
  h.fire(h.el("drive-client-id"), "keydown", { key: "Enter" });
  assert.deepEqual(h.calls.map((call) => call.name), ["driveSaveCredsFromForm", "driveShowCredsForm", "driveConnect", "driveCrumbTo", "driveOpenItem", "driveListCurrent", "toggleDriveNewFolder", "driveCreateFolder", "toggleDriveNewFolder", "driveSignIn", "driveSignOut", "driveStartRename", "driveSaveRename", "driveCancelRename", "driveConnect", "toggleDriveNewFolder", "driveSaveCredsFromForm", "driveSaveCredsFromForm"]);
  assert.deepEqual(h.calls[2]?.args, ["folder"]);
  assert.deepEqual(h.calls[3]?.args, [2]);
  assert.deepEqual(h.calls[8]?.args, [false]);
  owner.dispose();
  h.window.close();
});
