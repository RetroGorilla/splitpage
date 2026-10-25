import { test } from "node:test";
import assert from "node:assert/strict";
import { createDesktopDocumentState } from "../../src/application/desktop/document-state.ts";
import type { DesktopDocumentConnection, DesktopDocumentState } from "../../src/application/desktop/document-state.ts";
import { runMenuCommand, runMenuCommandsWith } from "../../src/application/desktop/menu-commands.ts";

interface World {
  running: boolean;
  doc: { title?: string; docId?: string | null } | null;
  restoring: boolean;
  connection: DesktopDocumentConnection | null;
  unsaved: boolean;
  pristine: boolean;
  fileId: string | null;
  serverKey: string | null;
}

function harness(start: Partial<World> = {}) {
  const world: World = {
    running: true, doc: { title: "Pilot", docId: "doc-1" }, restoring: false, connection: null,
    unsaved: false, pristine: false, fileId: null, serverKey: null, ...start
  };
  const sent: DesktopDocumentState[] = [];
  const owner = createDesktopDocumentState({
    facts: {
      running: () => world.running,
      document: () => world.doc,
      restoring: () => world.restoring,
      connection: () => world.connection,
      unsaved: () => world.unsaved,
      pristine: () => world.pristine,
      fileId: () => world.fileId,
      serverKey: () => world.serverKey
    },
    publish: (state) => { sent.push(state); }
  });
  return { world, sent, owner };
}

test("notify publishes the document's state, with defaults for a missing title and no home", () => {
  const h = harness({ doc: { title: "", docId: null } });
  h.owner.notify();
  assert.deepEqual(h.sent, [{
    title: "Untitled Script", dirty: false, pristine: false, docId: null, fileId: null,
    serverKey: null, serverUrl: null, tunnel: null, role: null
  }]);
});

test("restoring a draft reads as dirty and never pristine", () => {
  const h = harness({ restoring: true, pristine: true });
  h.owner.notify();
  assert.equal(h.sent[0]?.dirty, true);
  assert.equal(h.sent[0]?.pristine, false);
});

test("the connection, file and server key are reported as read", () => {
  const h = harness({ connection: { serverUrl: "http://team.test/", tunnel: null, role: "review" }, fileId: "file-2", serverKey: "key" });
  h.owner.notify();
  assert.equal(h.sent[0]?.serverUrl, "http://team.test/");
  assert.equal(h.sent[0]?.role, "review");
  assert.equal(h.sent[0]?.fileId, "file-2");
  assert.equal(h.sent[0]?.serverKey, "key");
});

test("nothing is published off the desktop or without a document", () => {
  const off = harness({ running: false });
  off.owner.notify();
  const empty = harness({ doc: null });
  empty.owner.notify();
  assert.deepEqual([off.sent, empty.sent], [[], []]);
});

test("a handed document holds the state back until it settles, and settling twice publishes once", () => {
  const h = harness();
  h.owner.awaitHanded("open-file");
  h.owner.notify();
  h.owner.listeners().session();
  assert.deepEqual(h.sent, []);
  h.owner.settled();
  h.owner.settled();
  assert.equal(h.sent.length, 1);
  h.owner.awaitHanded("open-server");
  h.owner.notify();
  assert.equal(h.sent.length, 1);
  h.owner.awaitHanded("blank");
  h.owner.notify();
  assert.equal(h.sent.length, 2);
});

test("listeners publish only changes, except a save change, which always publishes", () => {
  const h = harness();
  h.owner.notify();
  const on = h.owner.listeners();
  on.session();
  on.location();
  on.save("status");
  assert.equal(h.sent.length, 1);
  on.save("change");
  assert.equal(h.sent.length, 2);
  h.world.doc = { title: "Renamed", docId: "doc-1" };
  on.location();
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2]?.title, "Renamed");
});

test("the menu command runner answers only while it is the one installed", () => {
  const ran: string[] = [];
  assert.equal(runMenuCommand("save"), false);
  const first = runMenuCommandsWith((command) => { ran.push("first:" + command); return true; });
  const second = runMenuCommandsWith((command) => { ran.push("second:" + command); return false; });
  first();
  assert.equal(runMenuCommand("save"), false);
  second();
  assert.equal(runMenuCommand("save"), false);
  assert.deepEqual(ran, ["second:save"]);
});
