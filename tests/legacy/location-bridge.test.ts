import test from "node:test";
import assert from "node:assert/strict";
import {
  amendHome,
  currentHome,
  documentLocation,
  fileHome,
  importHome,
  locationStarted,
  setHome,
  startLocation
} from "../../src/legacy/location-bridge.ts";

test("before the location is started, reading or changing it throws", () => {
  assert.equal(locationStarted(), false);
  assert.throws(() => documentLocation(), /not started yet/);
  assert.throws(() => currentHome(), /not started yet/);
  assert.throws(() => setHome("none"), /not started yet/);
  assert.throws(() => amendHome({ kind: "none" }, {}), /not started yet/);
  assert.throws(() => fileHome(), /not started yet/);
  assert.throws(() => importHome(), /not started yet/);
});

test("the bridge reads and changes the one running location", () => {
  const stop = startLocation();
  try {
    assert.equal(locationStarted(), true);
    const location = documentLocation();
    assert.equal(currentHome(), location.home());
    assert.deepEqual(currentHome(), { kind: "none" });
    assert.equal(fileHome(), null);
    assert.equal(importHome(), null);

    const file = setHome("file", { format: "md", name: "a.md" });
    assert.equal(location.home(), file);
    assert.equal(currentHome(), file);
    assert.equal(fileHome(), file);
    assert.equal(importHome(), null);
    assert.equal(amendHome(file, { lastModified: 3 }), file);
    assert.equal(file["lastModified"], 3);
    assert.throws(() => amendHome(file, { name: "b.md" }), /set when the home is made/);

    const imported = setHome("import", { name: "notes.docx", format: "docx" });
    assert.equal(importHome(), imported);
    assert.equal(fileHome(), null);
    assert.throws(() => setHome("server", { id: "doc-1" }), /unknown kind "server"/);
    assert.equal(currentHome(), imported, "a refused setHome leaves the home where it was");
  } finally {
    setHome("none");
    stop();
  }
});

test("the location outlives a stop and restart, as the document it describes does", () => {
  const stop = startLocation();
  assert.throws(() => startLocation(), /already started/);
  const location = documentLocation();
  const home = setHome("file", { format: "md", name: "a.md" });
  location.markWrittenOut(true);
  stop();
  assert.equal(locationStarted(), false);
  assert.throws(() => currentHome(), /not started yet/);
  stop();
  assert.equal(locationStarted(), false, "a second stop does nothing");
  const again = startLocation();
  try {
    assert.equal(documentLocation(), location);
    assert.equal(currentHome(), home);
    assert.equal(fileHome(), home);
    assert.equal(documentLocation().writtenOut(), true);
  } finally {
    setHome("none");
    documentLocation().markWrittenOut(false);
    again();
  }
});
