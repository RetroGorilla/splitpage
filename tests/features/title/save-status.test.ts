import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSaveStatus } from "../../../src/features/title/save-status.js";
import type { SaveStatusMount, SaveStatusPorts } from "../../../src/features/title/ports.ts";
import type { Home } from "../../../src/application/location/document-location.ts";
import type { PreferenceName } from "../../../src/application/preferences/preferences.ts";
import type { AutoSaveTarget } from "../../../src/application/save/status.ts";
import { SAVE_DIRTY_LABEL, SAVE_LABEL, SAVING_LABEL } from "../../../src/application/save/status.ts";
import { fakeNotices, fakeSaveState } from "../fakes.ts";

const PAGE = '<button id="btn-save"></button><button id="wr-save"></button>' +
  '<span id="save-status" hidden></span><span id="wr-save-status" hidden></span>';

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
    autoSaveOn: true,
    expired: false,
    linkOff: false
  };
  const ports: SaveStatusPorts = {
    saves: save.saves,
    autoSave: {
      policy: () => ({ halted: () => state.halted, enabled: () => state.autoSaveOn }),
      target: () => { log.push("target"); return state.target; }
    },
    place: {
      home: () => state.home,
      sessionExpired: () => state.expired,
      linkTurnedOff: () => state.linkOff
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
    for (const id of ["btn-save", "wr-save"]) {
      assert.equal(byId(id).textContent, SAVE_DIRTY_LABEL);
      assert.equal(byId(id).classList.contains("is-dirty"), true);
      assert.equal((byId(id) as HTMLButtonElement).disabled, false);
    }
    for (const id of ["save-status", "wr-save-status"]) {
      assert.equal(byId(id).hidden, false);
      assert.equal(byId(id).textContent, "Unsaved changes");
      assert.equal(byId(id).className, "save-status is-pending");
      assert.equal(byId(id).title, "Autosave will write these to pilot.splitpage a moment after you stop typing.");
    }
    assert.equal(byId("btn-save").getAttribute("data-status"), "Unsaved changes");
    assert.equal(byId("btn-save").getAttribute("data-state"), "pending");
    assert.equal(byId("btn-save").getAttribute("aria-label"), "Unsaved changes. Save now");
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
    assert.equal(byId("btn-save").textContent, SAVE_LABEL);
    listeners.save("clean");
    assert.equal(byId("save-status").title, "Up to date with pilot.splitpage.");
    assert.equal(byId("btn-save").getAttribute("data-status"), "All changes saved");
  } finally {
    mount.dispose();
  }
});

test("the line follows location, server status and clock changes, and ignores the others", () => {
  const { mount, log, state } = mounted({ home: { kind: "server" }, target: "server" });
  try {
    const listeners = mount.listeners();
    listeners.location("writtenOut");
    listeners.status("mode");
    listeners.status("bookmarks");
    listeners.preference({ key: "splitpage-theme", value: "dark" });
    assert.deepEqual(log, []);
    state.linkOff = true;
    listeners.status("link");
    assert.equal(byId("save-status").textContent, "Not saving");
    assert.equal(byId("save-status").className, "save-status is-warn");
    state.linkOff = false;
    state.expired = true;
    listeners.status("session");
    assert.match(byId("save-status").title, /sign-in to the server has lapsed/);
    listeners.location("home");
    listeners.location("connection");
    listeners.preference({ key: "splitpage-clock", value: "12" });
    assert.deepEqual(log, ["target", "target", "target", "target", "target"]);
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
    assert.equal(byId("btn-save").getAttribute("data-status"), "Save");
    assert.equal(byId("btn-save").getAttribute("data-state"), "none");
    assert.equal(byId("btn-save").title, "Save this script");
  } finally {
    mount.dispose();
  }
});

test("refusals that are unavailable with a reason become a warning, with a full stop added when it has none", () => {
  const { mount, shown } = mounted();
  try {
    mount.showRefusal({ id: "a", kind: "unavailable", reason: "Close the prompter first" });
    mount.showRefusal({ id: "b", kind: "unavailable", reason: "Nothing to save…" });
    mount.showRefusal({ id: "c", kind: "unavailable", reason: "" });
    Reflect.apply(mount.showRefusal, undefined, [{ id: "d", kind: "unknown", reason: "Unknown action" }]);
    mount.showRefusal(null);
    assert.deepEqual(shown.map((s) => [s.message, s.kind]), [["Close the prompter first.", "warn"], ["Nothing to save…", "warn"]]);
  } finally {
    mount.dispose();
  }
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
