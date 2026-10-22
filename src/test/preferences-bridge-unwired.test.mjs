import test from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../legacy/preferences-bridge.ts");

function memory() {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); }
  };
}

test("before the preferences are started, every accessor throws instead of running on a default", () => {
  assert.equal(bridge.preferencesStarted(), false);
  assert.throws(() => bridge.preferences(), /The preferences are not started yet/);
  assert.throws(() => bridge.viewFlags(), /not started yet/);
  assert.throws(() => bridge.panelWidths(), /not started yet/);
});

test("started once with fresh owners; a second start throws until the first is stopped, and a restart forgets the old flags", () => {
  const storage = memory();
  const heard = [];
  const stop = bridge.startPreferences({ storage: () => storage, announce: (change) => heard.push(change) });
  let flags;
  try {
    assert.equal(bridge.preferencesStarted(), true);
    assert.throws(() => bridge.startPreferences(), /already started/);
    flags = bridge.viewFlags();
    flags.setWriterOpen(true);
    bridge.preferences().setAutosave(false);
    bridge.panelWidths().save("gear-panel", 300);
    assert.deepEqual(heard, [{ key: "splitpage-autosave", value: "0" }]);
    assert.equal(storage.items.get("splitpage-autosave"), "0");
  } finally {
    stop();
  }
  assert.equal(bridge.preferencesStarted(), false);
  assert.throws(() => bridge.viewFlags(), /not started yet/);
  const again = bridge.startPreferences({ storage: () => storage, announce: () => {} });
  try {
    assert.notEqual(bridge.viewFlags(), flags);
    assert.equal(bridge.viewFlags().writerOpen(), false);
    assert.equal(bridge.panelWidths().read("gear-panel"), 300, "saved widths survive a restart: they live in storage");
  } finally {
    again();
  }
});

test("hide-shot starts from the stored preference when the preferences start", () => {
  const storage = memory();
  storage.items.set("splitpage-hide-shot", "1");
  const stop = bridge.startPreferences({ storage: () => storage, announce: () => {} });
  try {
    assert.equal(bridge.viewFlags().hideShot(), true);
  } finally {
    stop();
  }
});

test("an old stop run after a newer start leaves the newer owners in place", () => {
  const ports = { storage: () => memory(), announce: () => {} };
  const first = bridge.startPreferences(ports);
  first();
  const second = bridge.startPreferences(ports);
  try {
    first();
    assert.equal(bridge.preferencesStarted(), true);
  } finally {
    second();
  }
});
