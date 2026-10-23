import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentPlace } from "../../../src/application/location/document-place.ts";
import { sharedPorts } from "../../../src/bootstrap/wiring/shared-ports.ts";
import { arrivingOnLink } from "../../../src/js/13-hosted.js";
import {
  currentConn, currentHome, documentLocation, locationStarted, serverStatus, setHome, startLocation
} from "../../../src/legacy/location-bridge.ts";

test("document place is built without starting owners and exposes only reads and existing subscriptions", () => {
  const place: DocumentPlace = sharedPorts().place;
  assert.equal(sharedPorts().place, place);
  assert.equal(locationStarted(), false);
  assert.deepEqual(Object.keys(place).sort(), [
    "arrivingOnLink", "bookmarkById", "bookmarks", "connection", "fileHome", "home", "homeConn", "importHome",
    "linkTurnedOff", "onChange", "onServerStatusChange", "serverHomeId", "serverHomeRev", "serverMode",
    "serverOf", "sessionExpired", "stillOnServer", "writtenOut"
  ]);
  const reads = [
    () => place.home(),
    () => place.connection(),
    () => place.fileHome(),
    () => place.importHome(),
    () => place.homeConn(),
    () => place.serverHomeId(),
    () => place.serverHomeRev(),
    () => place.serverOf({}),
    () => place.writtenOut(),
    () => place.serverMode(),
    () => place.linkTurnedOff(),
    () => place.sessionExpired(),
    () => place.bookmarks(),
    () => place.bookmarkById("missing"),
    () => place.onChange(() => {}),
    () => place.onServerStatusChange(() => {})
  ];
  for (const read of reads) {
    assert.throws(read, { name: "Error", message: "The document location is not started yet" });
  }
  assert.equal(place.stillOnServer({}), false);
  assert.equal(locationStarted(), false);
});

test("document place delegates arrivingOnLink to the existing hosted function", () => {
  const place: DocumentPlace = sharedPorts().place;
  assert.equal(place.arrivingOnLink(), arrivingOnLink());
});

test("document place returns the bridge's live location records and follows a stop and restart", () => {
  const place: DocumentPlace = sharedPorts().place;
  let stop = startLocation({ storage: () => null });
  try {
    const location = documentLocation();
    assert.equal(place.home(), currentHome());
    assert.deepEqual(place.home(), { kind: "none" });
    assert.equal(place.connection(), currentConn());
    assert.deepEqual(place.connection(), { serverUrl: "", token: "", role: "", scope: "", tunnel: null });
    assert.equal(place.fileHome(), null);
    assert.equal(place.importHome(), null);
    assert.equal(place.homeConn(), null);
    assert.equal(place.serverHomeId(), null);
    assert.equal(place.serverHomeRev(), null);
    assert.equal(place.serverOf({}), null);
    assert.equal(place.writtenOut(), false);

    const file = setHome("file", { format: "md", name: "script.md" });
    assert.equal(place.home(), file);
    assert.equal(place.fileHome(), file);
    assert.equal(place.importHome(), null);
    const imported = setHome("import", { name: "notes.docx" });
    assert.equal(place.home(), imported);
    assert.equal(place.importHome(), imported);
    assert.equal(place.fileHome(), null);

    const connection = location.setConnection({ serverUrl: "https://server.example/", token: "token", role: "edit" });
    const home = setHome("server", { id: "doc-1", rev: 4 });
    assert.equal(place.home(), home);
    assert.equal(place.connection(), connection);
    assert.equal(place.homeConn(), connection);
    assert.equal(place.serverHomeId(), "doc-1");
    assert.equal(place.serverHomeRev(), 4);
    assert.equal(place.fileHome(), null);
    assert.equal(place.importHome(), null);
    assert.equal(place.serverOf(connection), location.serverOf(connection));
    assert.equal(place.stillOnServer(connection), true);

    location.amendHome(home, { rev: 5 });
    assert.equal(place.home(), home);
    assert.equal(home["rev"], 5);
    assert.equal(place.serverHomeRev(), 5);
    const updated = location.updateConnection({ token: "next-token", scope: "doc-1" });
    assert.equal(place.connection(), updated);
    assert.equal(place.homeConn(), updated);
    assert.equal(place.serverOf(updated), place.serverOf(connection));
    assert.equal(place.stillOnServer(connection), true);
    location.markWrittenOut(true);
    assert.equal(place.writtenOut(), true);

    stop();
    assert.equal(locationStarted(), false);
    assert.throws(() => place.home(), { name: "Error", message: "The document location is not started yet" });
    assert.throws(() => place.serverMode(), { name: "Error", message: "The document location is not started yet" });
    assert.equal(place.stillOnServer(updated), false);
    stop = startLocation({ storage: () => null });
    assert.equal(sharedPorts().place, place);
    assert.equal(place.home(), home);
    assert.equal(place.connection(), updated);
    assert.equal(place.serverHomeRev(), 5);
    assert.equal(place.writtenOut(), true);
    assert.equal(place.stillOnServer(updated), true);

    setHome("none");
    const elsewhere = location.setConnection({ serverUrl: "https://other.example/" });
    assert.equal(place.connection(), elsewhere);
    assert.equal(place.stillOnServer(updated), false);
    assert.equal(place.stillOnServer(elsewhere), true);
    assert.equal(place.homeConn(), null);
    assert.equal(place.serverHomeId(), null);
    assert.equal(place.serverHomeRev(), null);
  } finally {
    setHome("none");
    documentLocation().setConnection({});
    documentLocation().markWrittenOut(false);
    stop();
  }
});

test("document place forwards server facts and subscriptions synchronously in the owners' listener order", () => {
  const place: DocumentPlace = sharedPorts().place;
  const stop = startLocation({ storage: () => null });
  const location = documentLocation();
  const status = serverStatus();
  const order: string[] = [];
  const offLocationBefore = location.onChange((change) => { order.push("before:" + change); });
  const offLocation = place.onChange((change) => { order.push("place:" + change); });
  const offLocationAfter = location.onChange((change) => { order.push("after:" + change); });
  const offStatusBefore = status.onChange((change) => { order.push("before:" + change); });
  const offStatus = place.onServerStatusChange((change) => { order.push("place:" + change); });
  const offStatusAfter = status.onChange((change) => { order.push("after:" + change); });
  try {
    assert.equal(place.serverMode(), status.mode());
    assert.deepEqual(place.serverMode(), {
      available: false, readOnly: false, checked: false, authRequired: false,
      reviewAvailable: false, version: null, links: false, linksPersist: false
    });
    assert.equal(place.linkTurnedOff(), false);
    assert.equal(place.sessionExpired(), false);
    assert.equal(place.bookmarks(), status.bookmarks());
    assert.deepEqual(place.bookmarks(), []);
    assert.equal(place.bookmarkById("missing"), null);
    assert.deepEqual(order, []);

    location.setConnection({ serverUrl: "https://server.example/" });
    setHome("server", { id: "doc-2" });
    location.markWrittenOut(true);
    status.applyHealth({ ok: true, readOnly: true, authRequired: true, reviewAvailable: true, version: "4.1.0", links: 1, linksPersist: true });
    assert.equal(place.serverMode(), status.mode());
    assert.deepEqual(place.serverMode(), {
      available: true, readOnly: true, checked: true, authRequired: true,
      reviewAvailable: true, version: "4.1.0", links: true, linksPersist: true
    });
    const bookmark = { id: "server-1", name: "Server", url: "https://server.example/" };
    status.addBookmarks([bookmark]);
    assert.equal(place.bookmarks(), status.bookmarks());
    assert.deepEqual(place.bookmarks(), [bookmark]);
    assert.equal(place.bookmarkById("server-1"), bookmark);
    assert.equal(place.bookmarkById("missing"), null);
    status.turnLinkOff();
    status.expireSession();
    assert.equal(place.linkTurnedOff(), true);
    assert.equal(place.sessionExpired(), true);
    assert.deepEqual(order, [
      "before:connection", "place:connection", "after:connection",
      "before:home", "place:home", "after:home",
      "before:writtenOut", "place:writtenOut", "after:writtenOut",
      "before:mode", "place:mode", "after:mode",
      "before:bookmarks", "place:bookmarks", "after:bookmarks",
      "before:link", "place:link", "after:link",
      "before:session", "place:session", "after:session"
    ]);

    offLocation();
    offLocation();
    offStatus();
    offStatus();
    order.length = 0;
    location.amendHome(place.home(), { rev: 2 });
    status.forgetMode();
    assert.equal(place.serverMode(), status.mode());
    assert.deepEqual(place.serverMode(), {
      available: false, readOnly: false, checked: false, authRequired: false,
      reviewAvailable: false, version: null, links: false, linksPersist: false
    });
    assert.deepEqual(order, ["before:home", "after:home", "before:mode", "after:mode"]);
  } finally {
    offLocation();
    offLocationBefore();
    offLocationAfter();
    offStatus();
    offStatusBefore();
    offStatusAfter();
    status.removeBookmark("server-1");
    status.forgetMode();
    setHome("none");
    location.setConnection({});
    location.markWrittenOut(false);
    stop();
  }
});
