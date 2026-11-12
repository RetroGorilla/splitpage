import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import { fileMenuActions, autosaveActions } from "../../../src/features/file-menu/actions.ts";
import type { FileMenuActionPorts, AutosaveActionPorts } from "../../../src/features/file-menu/ports.ts";
import { mountConflicts } from "../../../src/features/file-menu/mount.ts";
import type { ConflictsPorts } from "../../../src/features/file-menu/mount.ts";
import { fakeNotices } from "../fakes.ts";
import { viewHarness } from "../view-harness.ts";

const SHARED = createSessionCapabilities("shared", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
const STANDALONE = createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });

for (const id of ["save", "save-as", "autosave"]) {
  test("shared " + id + " availability and invocation refuse before reading menu, save state or preferences", async () => {
    const calls: string[] = [];
    const notices = fakeNotices();
    const ports = new Proxy({} as FileMenuActionPorts & AutosaveActionPorts, {
      get: (_target, key) => {
        if (key === "capability") return SHARED;
        if (key === "notices") return notices.notices;
        calls.push(String(key));
        throw new Error("unexpected standalone action port");
      }
    });
    const definitions = id === "autosave" ? autosaveActions(ports) : fileMenuActions(() => { calls.push("menu"); return null; }, ports);
    const action = definitions.find(definition => definition.id === id);
    assert.ok(action);
    const reason = id === "autosave" ? "File autosave is not available in a shared session." : "Save destinations are not available in a shared session.";
    assert.deepEqual(action.availability?.("menu"), id === "autosave" ? { enabled: false, reason, checked: false } : { enabled: false, reason });
    await action.run("native-menu");
    assert.deepEqual(calls, []);
    assert.deepEqual(notices.shown.map(({ message, kind }) => [message, kind]), [[reason, "warn"]]);
  });
}

for (const id of ["file-conflict-overwrite", "file-conflict-copy"]) {
  test("shared " + id + " refuses before reading or closing conflict context, capture, building or delivery", t => {
    const h = viewHarness();
    t.after(() => h.window.close());
    const calls: unknown[][] = [];
    const notices = fakeNotices();
    const ports = new Proxy({} as ConflictsPorts, {
      get: (_target, key) => {
        if (key === "capability") return SHARED;
        if (key === "notices") return notices.notices;
        return (...args: unknown[]) => { calls.push([key, ...args]); };
      }
    });
    const owner = mountConflicts({ window: h.window, ports });
    t.after(owner.dispose);
    h.fire(h.el(id), "click");
    assert.deepEqual(calls, []);
    assert.deepEqual(notices.shown.map(({ message, kind }) => [message, kind]), [["Save destinations are not available in a shared session.", "warn"]]);
  });
}

test("a conflict copy prepared before replacement drops delivery when ownership is lost", async t => {
  const h = viewHarness();
  t.after(() => h.window.close());
  let owns = true;
  let finish: (built: { data: string }) => void = () => { throw new Error("copy not started"); };
  const waiting = new Promise<{ data: string }>(resolve => { finish = resolve; });
  const calls: unknown[][] = [];
  const notices = fakeNotices();
  const owner = mountConflicts({ window: h.window, ports: {
    capability: STANDALONE,
    notices: notices.notices,
    closeFileConflict: () => { calls.push(["close"]); },
    reloadProjectFromDisk: () => {}, reloadFileFromDisk: () => {}, saveDoc: () => {},
    openMergeReview: () => {}, cancelMergeReview: () => {}, confirmFileMerge: () => {},
    importHome: () => { calls.push(["home"]); return { name: "Script.md", format: "md" }; },
    buildFileData: (format, name) => { calls.push(["build", format, name]); return waiting; },
    deliverFile: (...args) => { calls.push(["deliver", ...args]); },
    conflict: () => { calls.push(["conflict"]); return { kind: "import" }; },
    capture: () => { calls.push(["capture"]); return () => owns; }
  } });
  t.after(owner.dispose);
  h.fire(h.el("file-conflict-copy"), "click");
  assert.deepEqual(calls, [["conflict"], ["close"], ["home"], ["capture"], ["build", "md", "Script (copy)"]]);
  owns = false;
  finish({ data: "captured" });
  await waiting;
  await Promise.resolve();
  assert.deepEqual(calls, [["conflict"], ["close"], ["home"], ["capture"], ["build", "md", "Script (copy)"]]);
  assert.deepEqual(notices.shown, []);
});
