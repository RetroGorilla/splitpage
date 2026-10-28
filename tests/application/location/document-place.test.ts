import "../../../src/test/_dom.mjs";
import { place as portPlace } from "../../../src/bootstrap/wiring/ports/location.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentPlace } from "../../../src/application/location/document-place.ts";

import {
  currentHome, documentLocation, locationStarted, setHome, startLocation
} from "../../../src/legacy/location-bridge.ts";

test("document place is built without starting owners and exposes only reads and existing subscriptions", () => {
  const place: DocumentPlace = portPlace;
  assert.equal(portPlace, place);
  assert.equal(locationStarted(), false);
  assert.deepEqual(Object.keys(place).sort(), ["fileHome", "home", "importHome", "onChange", "writtenOut"]);
  const reads = [
    () => place.home(),
    () => place.fileHome(),
    () => place.importHome(),
    () => place.writtenOut(),
    () => place.onChange(() => {})
  ];
  for (const read of reads) {
    assert.throws(read, { name: "Error", message: "The document location is not started yet" });
  }
  assert.equal(locationStarted(), false);
});

test("document place returns the bridge's live location records and follows a stop and restart", () => {
  const place: DocumentPlace = portPlace;
  let stop = startLocation();
  try {
    const location = documentLocation();
    assert.equal(place.home(), currentHome());
    assert.deepEqual(place.home(), { kind: "none" });
    assert.equal(place.fileHome(), null);
    assert.equal(place.importHome(), null);
    assert.equal(place.writtenOut(), false);

    const file = setHome("file", { format: "md", name: "script.md" });
    assert.equal(place.home(), file);
    assert.equal(place.fileHome(), file);
    assert.equal(place.importHome(), null);
    const imported = setHome("import", { name: "notes.docx" });
    assert.equal(place.home(), imported);
    assert.equal(place.importHome(), imported);
    assert.equal(place.fileHome(), null);

    location.amendHome(imported, { dirty: true });
    assert.equal(place.home(), imported);
    assert.equal(imported["dirty"], true);
    location.markWrittenOut(true);
    assert.equal(place.writtenOut(), true);

    stop();
    assert.equal(locationStarted(), false);
    assert.throws(() => place.home(), { name: "Error", message: "The document location is not started yet" });
    assert.throws(() => place.writtenOut(), { name: "Error", message: "The document location is not started yet" });
    stop = startLocation();
    assert.equal(portPlace, place);
    assert.equal(place.home(), imported);
    assert.equal(place.importHome(), imported);
    assert.equal(place.writtenOut(), true);

    setHome("none");
    assert.equal(place.fileHome(), null);
    assert.equal(place.importHome(), null);
  } finally {
    setHome("none");
    documentLocation().markWrittenOut(false);
    stop();
  }
});

test("document place forwards subscriptions synchronously in the owner's listener order", () => {
  const place: DocumentPlace = portPlace;
  const stop = startLocation();
  const location = documentLocation();
  const order: string[] = [];
  const offBefore = location.onChange((change) => { order.push("before:" + change); });
  const offPlace = place.onChange((change) => { order.push("place:" + change); });
  const offAfter = location.onChange((change) => { order.push("after:" + change); });
  try {
    assert.deepEqual(order, []);
    setHome("file", { format: "md", name: "a.md" });
    location.markWrittenOut(true);
    assert.deepEqual(order, [
      "before:home", "place:home", "after:home",
      "before:writtenOut", "place:writtenOut", "after:writtenOut"
    ]);

    offPlace();
    offPlace();
    order.length = 0;
    location.amendHome(place.home(), { lastModified: 2 });
    assert.deepEqual(order, ["before:home", "after:home"]);
  } finally {
    offPlace();
    offBefore();
    offAfter();
    setHome("none");
    location.markWrittenOut(false);
    stop();
  }
});
