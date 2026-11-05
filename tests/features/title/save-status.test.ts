import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSaveStatus } from "../../../src/features/title/save-status.ts";
import { showRefusal } from "../../../src/features/title/refusal.ts";
import type { SaveStatusMount, SaveStatusPorts } from "../../../src/features/title/ports.ts";
import type { Home } from "../../../src/application/location/document-location.ts";
import type { PreferenceName } from "../../../src/application/preferences/preferences.ts";
import type { AutoSaveTarget } from "../../../src/application/save/status.ts";
import { SAVING_LABEL } from "../../../src/application/save/status.ts";
import { fakeNotices, fakeSaveState } from "../fakes.ts";

const PAGE = '<button id="btn-save"></button><span id="save-status" hidden></span>';

interface Given {
  home?: Home;
  target?: AutoSaveTarget;
  unsaved?: boolean;
  busy?: boolean;
}

function mounted(given: Given = {}) {
  document.body.innerHTML = PAGE;
  const log: string[] = [];
  const save = fakeSaveState({ unsaved: !!given.unsaved, busy: !!given.busy });
  const { notices, shown } = fakeNotices();
  const state = {
    home: given.home ?? ({ kind: "file", handle: { name: "pilot.splitpage" } } as Home),
    target: given.target === undefined ? ("file" as AutoSaveTarget) : given.target,
    halted: "",
    autoSaveOn: true
  };
  const ports: SaveStatusPorts = {
    saves: save.saves,
    autoSave: {
      policy: () => ({ halted: () => state.halted, enabled: () => state.autoSaveOn }),
      target: () => { log.push("target"); return state.target; }
    },
    place: {
      home: () => state.home
    },
    preferences: {
      clock: () => "24",
      nameOf: (key: string) => (key === "splitpage-clock" ? "clock" : "theme") as PreferenceName
    },
    notices,
    drafts: { noteChange: () => { log.push("noteDraftChange"); } },
    identity: { sync: () => { log.push("syncIdentity"); } }
  };
  const mount: SaveStatusMount = mountSaveStatus(ports);
  return { mount, log, save, state, shown };
}

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

test("painting shows the buttons and the status line from the save state", () => {
  const { mount } = mounted({ unsaved: true });
  try {
    mount.listeners().paint();
    for (const id of ["btn-save"]) {
      assert.equal(byId(id).textContent, "Unsaved changes");
      assert.equal(byId(id).getAttribute("data-actionable"), "false");
      assert.equal((byId(id) as HTMLButtonElement).disabled, true);
    }
    for (const id of ["save-status"]) {
      assert.equal(byId(id).hidden, false);
      assert.equal(byId(id).textContent, "Unsaved changes");
      assert.equal(byId(id).className, "save-status is-pending");
      assert.equal(byId(id).title, "Autosave will write these to pilot.splitpage a moment after you stop typing.");
    }
    assert.equal(byId("btn-save").getAttribute("data-status"), "Unsaved changes");
    assert.equal(byId("btn-save").getAttribute("data-state"), "ok");
    assert.equal(byId("btn-save").getAttribute("aria-label"), "Unsaved changes");
  } finally {
    mount.dispose();
  }
});

test("a save change repaints, then keeps the identity and the draft in step, then refreshes the line, unless a save is running", () => {
  const { mount, log, save } = mounted({ unsaved: true });
  try {
    const listeners = mount.listeners();
    listeners.save("change");
    assert.deepEqual(log, ["syncIdentity", "noteDraftChange", "target"]);
    log.length = 0;
    save.state.busy = true;
    listeners.save("change");
    assert.deepEqual(log, []);
    listeners.save("running");
    assert.deepEqual(log, ["syncIdentity", "noteDraftChange", "target"]);
    assert.equal(byId("btn-save").textContent, SAVING_LABEL);
    assert.equal((byId("btn-save") as HTMLButtonElement).disabled, true);
    assert.equal(byId("save-status").textContent, "Saving…");
    log.length = 0;
    listeners.save("halt");
    listeners.save("enabled");
    assert.deepEqual(log, ["target", "target"]);
  } finally {
    mount.dispose();
  }
});

test("a finished save shows when it was saved, and a clean confirmation forgets it", () => {
  const { mount, save } = mounted({ unsaved: true, busy: true });
  try {
    const listeners = mount.listeners();
    listeners.paint();
    assert.equal(byId("save-status").textContent, "Saving…");
    save.state.busy = false;
    save.state.unsaved = false;
    listeners.save("change");
    assert.equal(byId("save-status").textContent, "Saved");
    assert.match(byId("save-status").title, /^Last saved to pilot\.splitpage at .+\.$/);
    assert.equal(byId("btn-save").getAttribute("data-status"), "Saved just now");
    assert.equal(byId("btn-save").textContent, "Saved just now");
    listeners.save("clean");
    assert.equal(byId("save-status").title, "Up to date with pilot.splitpage.");
    assert.equal(byId("btn-save").getAttribute("data-status"), "All changes saved");
  } finally {
    mount.dispose();
  }
});

test("the line follows home and clock changes, and ignores the others", () => {
  const { mount, log, state } = mounted({ home: { kind: "none" }, target: null });
  try {
    const listeners = mount.listeners();
    listeners.location("writtenOut");
    listeners.preference({ key: "splitpage-theme", value: "dark" });
    assert.deepEqual(log, []);
    state.home = { kind: "file", handle: { name: "pilot.splitpage" } } as Home;
    state.target = "file";
    listeners.location("home");
    assert.equal(byId("save-status").textContent, "Saved");
    listeners.preference({ key: "splitpage-clock", value: "12" });
    assert.deepEqual(log, ["target", "target"]);
  } finally {
    mount.dispose();
  }
});

test("with nowhere to save and nothing unsaved the line is hidden and the button says Save", () => {
  const { mount } = mounted({ home: { kind: "none" }, target: null });
  try {
    mount.refresh();
    assert.equal(byId("save-status").hidden, true);
    assert.equal(byId("save-status").textContent, "");
    assert.equal(byId("save-status").hasAttribute("title"), false);
    assert.equal(byId("btn-save").getAttribute("data-status"), "Not saved yet");
    assert.equal(byId("btn-save").getAttribute("data-state"), "pending");
    assert.equal(byId("btn-save").title, "Save to choose where this script is kept. Click to save now.");
  } finally {
    mount.dispose();
  }
});

test("refusals that are unavailable with a reason become a warning, with a full stop added when it has none, mounted or not", () => {
  const { notices, shown } = fakeNotices();
  showRefusal(notices, { id: "a", kind: "unavailable", reason: "Close the prompter first" });
  showRefusal(notices, { id: "b", kind: "unavailable", reason: "Nothing to save…" });
  showRefusal(notices, { id: "c", kind: "unavailable", reason: "Already saved!" });
  showRefusal(notices, { id: "d", kind: "unavailable", reason: "" });
  Reflect.apply(showRefusal, undefined, [notices, { id: "e", kind: "unknown", reason: "Unknown action" }]);
  showRefusal(notices, null);
  showRefusal(notices, undefined);
  assert.deepEqual(shown.map((s) => [s.message, s.kind]), [["Close the prompter first.", "warn"], ["Nothing to save…", "warn"], ["Already saved!", "warn"]]);
});

test("the mount hears cleared crew owners and exposes the test refresh, and dispose removes both", () => {
  const { mount, shown } = mounted();
  const probe = (window as unknown as { __saveStatusTest?: { refresh: () => void } }).__saveStatusTest;
  assert.equal(probe?.refresh, mount.refresh);
  document.dispatchEvent(new window.CustomEvent("undo-owner-cleared", { detail: { count: 1 } }));
  document.dispatchEvent(new window.CustomEvent("undo-owner-cleared", { detail: { count: 3 } }));
  document.dispatchEvent(new window.CustomEvent("undo-owner-cleared", { detail: { count: 0 } }));
  assert.deepEqual(shown.map((s) => [s.message, s.kind]), [
    ["That person is no longer on the crew, so 1 item is now unassigned.", "warn"],
    ["That person is no longer on the crew, so 3 items are now unassigned.", "warn"]
  ]);
  mount.dispose();
  mount.dispose();
  document.dispatchEvent(new window.CustomEvent("undo-owner-cleared", { detail: { count: 2 } }));
  assert.equal(shown.length, 2);
  assert.equal("__saveStatusTest" in window, false);
});

test("disposing an earlier mount after a new one leaves the new one painting and hearing", () => {
  const first = mounted();
  const second = mounted({ unsaved: true });
  try {
    first.mount.dispose();
    second.mount.refresh();
    assert.equal(byId("save-status").textContent, "Unsaved changes");
    document.dispatchEvent(new window.CustomEvent("undo-owner-cleared", { detail: { count: 1 } }));
    assert.equal(first.shown.length, 0);
    assert.equal(second.shown.length, 1);
    assert.equal((window as unknown as { __saveStatusTest?: { refresh: () => void } }).__saveStatusTest?.refresh, second.mount.refresh);
  } finally {
    second.mount.dispose();
  }
});

test("the shared Save control distinguishes unsaved edits from an actionable untitled document", () => {
  const { mount, save } = mounted({ home: { kind: "none" }, target: null });
  try {
    mount.refresh();
    assert.equal(byId("btn-save").textContent, "Not saved yet");
    assert.equal(byId("btn-save").dataset.dirty, "false");
    save.state.unsaved = true;
    mount.refresh();
    assert.equal(byId("btn-save").textContent, "Not saved yet");
    assert.equal(byId("btn-save").dataset.dirty, "true");
    save.state.unsaved = false;
    mount.refresh();
    assert.equal(byId("btn-save").dataset.dirty, "false");
  } finally { mount.dispose(); }
});
