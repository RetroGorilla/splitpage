import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSaveStatus } from "../../../src/features/title/save-status.ts";
import type { Home } from "../../../src/application/location/document-location.ts";
import { fakeNotices, fakeSaveState } from "../fakes.ts";

  test("a failed retry keeps the actionable save problem", () => {
    document.body.innerHTML = '<button id="btn-save"></button><span id="save-status"></span>';
    const save = fakeSaveState({ unsaved: true, busy: false });
    let halted = "Permission denied. Press Save to try again.";
    const mount = mountSaveStatus({
      saves: save.saves,
      autoSave: { policy: () => ({ halted: () => halted, enabled: () => true }), target: () => "file" },
      place: { home: () => ({ kind: "file", handle: { name: "retry.splitpage" } }) as Home },
      preferences: { clock: () => "24", nameOf: () => "clock" },
      notices: fakeNotices().notices, drafts: { noteChange: () => {} }, identity: { sync: () => {} }
    });
    const button = document.getElementById("btn-save") as HTMLButtonElement;
    try {
      mount.listeners().paint();
      assert.equal(button.getAttribute("data-state"), "warn");
      halted = "";
      save.state.busy = true;
      mount.listeners().save("running");
      assert.equal(button.getAttribute("data-state"), "busy");
      save.state.busy = false;
      mount.listeners().save("running");
      assert.equal(button.disabled, false);
      assert.equal(button.getAttribute("data-status"), "Not saving");
      assert.equal(button.getAttribute("data-state"), "warn");
      assert.equal(button.title.includes("Permission denied"), true);
      save.state.unsaved = false;
      mount.listeners().save("running");
      assert.equal(button.getAttribute("data-state"), "ok");
      assert.equal(button.title.includes("Permission denied"), false);
      save.state.unsaved = true;
      mount.listeners().save("change");
      assert.equal(button.getAttribute("data-status"), "Unsaved changes");
    } finally {
      mount.dispose();
    }
  });
