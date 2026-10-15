import test from "node:test";
import assert from "node:assert/strict";
import { mountSaveRecovery, mountConflicts, mountSave, mountFileMenu } from "../../../src/features/file-menu/mount.ts";
import type { SaveRecoveryPorts, ConflictsPorts, SavePorts, FileMenuPorts } from "../../../src/features/file-menu/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const expected: readonly Registration[] = [
  [
    "resume-continue",
    "click"
  ],
  [
    "resume-dismiss",
    "click"
  ],
  [
    "save-error-dismiss",
    "click"
  ],
  [
    "save-error-retry",
    "click"
  ],
  [
    "save-error-export",
    "click"
  ],
  [
    "file-conflict-close",
    "click"
  ],
  [
    "file-conflict-cancel",
    "click"
  ],
  [
    "file-conflict-reload",
    "click"
  ],
  [
    "file-conflict-overwrite",
    "click"
  ],
  [
    "file-conflict-merge",
    "click"
  ],
  [
    "merge-review-close",
    "click"
  ],
  [
    "merge-review-cancel",
    "click"
  ],
  [
    "merge-review-confirm",
    "click"
  ],
  [
    "window",
    "keydown"
  ],
  [
    "file-conflict-copy",
    "click"
  ],
  [
    "btn-save",
    "click"
  ],
  [
    "btn-save",
    "mouseenter"
  ],
  [
    "btn-save",
    "focus"
  ],
  [
    "wr-save-status",
    "mouseenter"
  ],
  [
    "btn-file",
    "click"
  ],
  [
    "file-menu",
    "click"
  ],
  [
    "file-menu-close",
    "click"
  ],
  [
    "file-menu-backdrop",
    "click"
  ],
  [
    "document",
    "click"
  ],
  [
    "window",
    "keydown"
  ],
  [
    "open-file-input",
    "change"
  ]
];

export function setup() {
  const h = viewHarness();
  const p0: SaveRecoveryPorts = {
    hideResumeBanner: h.log("hideResumeBanner"),
    resumeFromHandle: async () => undefined,
    showToast: h.log("showToast"),
    saveDoc: h.log("saveDoc"),
    exportAs: h.log("exportAs"),
    pendingHandle: () => null,
    capture: h.capture
  };
  const p1: ConflictsPorts = {
    closeFileConflict: h.log("closeFileConflict"),
    reloadProjectFromDisk: h.log("reloadProjectFromDisk"),
    reloadFileFromDisk: h.log("reloadFileFromDisk"),
    saveDoc: h.log("saveDoc"),
    saveBackToFile: h.log("saveBackToFile"),
    openMergeReview: h.log("openMergeReview"),
    cancelMergeReview: h.log("cancelMergeReview"),
    confirmFileMerge: h.log("confirmFileMerge"),
    importHome: () => null,
    buildFileData: async () => ({ data: "copy" }),
    deliverFile: h.log("deliverFile"),
    conflict: () => null,
    capture: h.capture
  };
  const p2: SavePorts = {
    saveFromButton: h.log("saveFromButton"),
    updateSaveStatus: h.log("updateSaveStatus")
  };
  const p3: FileMenuPorts = {
    toggleFileMenu: h.log("toggleFileMenu"),
    toggleSubmenu: h.log("toggleSubmenu"),
    handleFileMenuAction: h.log("handleFileMenuAction"),
    openProjectFile: h.log("openProjectFile")
  };
  const mount = () => [mountSaveRecovery({ window: h.window, ports: p0 }), mountConflicts({ window: h.window, ports: p1 }), mountSave({ window: h.window, ports: p2 }), mountFileMenu({ window: h.window, ports: p3 })];
  return { ...h, mount, p0, p1, p2, p3 };
}

test("file-menu: every target, event, phase and multiplicity across dispose and remount", () => {
  const h = setup();
  h.assertRemount(h.mount, expected);
  h.window.close();
});

for (const work of ["resume", "copy"]) {
  for (const scenario of ["dispose and reopen", "same-ID replacement", "stale completion after remount", "normal completion"]) {
    test("file-menu: held " + work + ", " + scenario, async () => {
      const h = setup();
      let finish: () => void = () => { throw new Error("Work did not start"); };
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const handle = { requestPermission: async () => { await pending; return "granted"; } };
      const mount = work === "resume"
        ? () => mountSaveRecovery({ window: h.window, ports: {
          ...h.p0,
          pendingHandle: () => handle,
          resumeFromHandle: async () => { h.log("resume")(); }
        } })
        : () => mountConflicts({ window: h.window, ports: {
          ...h.p1, importHome: () => ({ name: "Script.md", format: "md" }),
          buildFileData: async () => { await pending; return { data: "captured" }; }
        } });
      const owner = mount();
      h.fire(h.el(work === "resume" ? "resume-continue" : "file-conflict-copy"), "click");
      let replacement: ReturnType<typeof mount> | undefined;
      if (scenario === "dispose and reopen" || scenario === "stale completion after remount") {
        owner.dispose();
        h.replaceDocument();
        replacement = mount();
      } else if (scenario === "same-ID replacement") h.replaceDocument();
      h.calls.length = 0;
      finish();
      await pending;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const live = scenario === "normal completion";
      assert.deepEqual(h.calls, !live ? [] : work === "resume" ? [
        { name: "resume", args: [] }, { name: "hideResumeBanner", args: [] }
      ] : [{ name: "deliverFile", args: ["Script (copy).md", "captured", { savedMsg: "Saved a separate copy" }] }]);
      owner.dispose();
      replacement?.dispose();
      h.window.close();
    });
  }
}

test("file-menu: captured project context survives closing and routes force, reload and save-as once", () => {
  const h = setup();
  let context: { kind: string } | null = { kind: "project" };
  const owner = mountConflicts({ window: h.window, ports: {
    ...h.p1, conflict: () => context,
    closeFileConflict: () => { context = null; h.log("close")(); }
  } });
  h.fire(h.el("file-conflict-reload"), "click");
  h.fire(h.el("file-conflict-overwrite"), "click");
  context = { kind: "project" };
  h.fire(h.el("file-conflict-copy"), "click");
  h.fire(h.el("file-conflict-reload"), "click");
  h.fire(h.el("file-conflict-overwrite"), "click");
  assert.deepEqual(h.calls, [
    { name: "reloadProjectFromDisk", args: [] }, { name: "close", args: [] }, { name: "saveDoc", args: [{ force: true }] },
    { name: "close", args: [] }, { name: "saveDoc", args: [{ saveAs: true }] },
    { name: "reloadFileFromDisk", args: [] }, { name: "close", args: [] }, { name: "saveBackToFile", args: [{ force: true }] }
  ]);
  owner.dispose();
  h.window.close();
});

test("file-menu: main save and all status refresh registrations reach the coordinator once after remount", () => {
  const h = setup();
  const old = mountSave({ window: h.window, ports: h.p2 });
  old.dispose();
  const owner = mountSave({ window: h.window, ports: h.p2 });
  h.fire(h.el("btn-save"), "click");
  h.fire(h.el("btn-save"), "mouseenter");
  h.fire(h.el("btn-save"), "focus");
  h.fire(h.el("wr-save-status"), "mouseenter");
  assert.deepEqual(h.calls.map((call) => call.name), ["saveFromButton", "updateSaveStatus", "updateSaveStatus", "updateSaveStatus"]);
  owner.dispose();
  h.window.close();
});

test("file-menu: submenu dispatch precedes actions; disabled actions, keyboard focus, outside and Escape stay intact", () => {
  const h = setup();
  const owner = mountFileMenu({ window: h.window, ports: h.p3 });
  const button = h.document.createElement("button");
  button.className = "mi-parent";
  button.dataset.submenu = "export";
  button.dataset.fileAction = "wrong";
  h.el("file-menu").append(button);
  h.fire(button, "click");
  button.className = "";
  button.disabled = true;
  h.fire(button, "click");
  button.disabled = false;
  button.dataset.fileAction = "export-md";
  h.fire(button, "click");
  h.fire(h.el("btn-file"), "click", { detail: 0 });
  h.el("file-menu").hidden = false;
  h.fire(h.window, "keydown", { key: "Escape" });
  h.fire(h.document.body, "click");
  assert.deepEqual(h.calls, [
    { name: "toggleSubmenu", args: ["export", undefined, true] }, { name: "handleFileMenuAction", args: ["export-md"] },
    { name: "toggleFileMenu", args: [undefined, { focusFirst: true }] },
    { name: "toggleFileMenu", args: [false, { returnFocus: true }] }, { name: "toggleFileMenu", args: [false] }
  ]);
  owner.dispose();
  h.window.close();
});
