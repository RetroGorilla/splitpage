import "./_identity-started.mjs";
import { documentIdentityOwner } from "../bootstrap/wiring/document-identity.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { setHome, onServerDoc } from "../legacy/location-bridge.ts";
import "./_location-started.mjs";

test("autoSaveTarget answers server, file or null off the home", async () => {
  await import("./_dom.mjs");
  const { autoSaveTarget, saveDestinations, startSaves } = await import("../legacy/save-bridge.ts");
  const { wireFileSaving } = await import("../bootstrap/wiring/file-saving.ts");
  const copyDocHistorySafe = (...args) => documentIdentityOwner().copyDocHistorySafe(...args);
  const syncDocIdentity = (...args) => documentIdentityOwner().syncDocIdentity(...args);
  const { setBaseState } = await import("../js/03-sync.js");
  const { serverSaveDestination } = await import("../js/13-hosted.js");
  const fileSaving = wireFileSaving({ copyHistory: copyDocHistorySafe, syncIdentity: syncDocIdentity, setBaseline: setBaseState });
  const stopSaves = startSaves(fileSaving.savePorts({ capture: () => Object.freeze({}), stillOwns: () => true }), { start: () => null, stop: () => {} });
  const drops = [saveDestinations().register(fileSaving.destination()), saveDestinations().register(serverSaveDestination())];

  setHome("none");
  assert.equal(autoSaveTarget(), null);
  assert.equal(onServerDoc(), false);

  setHome("server", { id: "doc-5", rev: 3 });
  assert.equal(autoSaveTarget(), "server");
  assert.equal(onServerDoc(), true);

  setHome("file", { handle: { name: "a.md" }, format: "md", name: "a.md" });
  assert.equal(autoSaveTarget(), "file");
  assert.equal(onServerDoc(), false);

  setHome("file", { handle: null, format: "md", name: "a.md" });
  assert.equal(autoSaveTarget(), null);

  setHome("file", { handle: { name: "old.html" }, format: "html", name: "old.html" });
  assert.equal(autoSaveTarget(), null);

  setHome("import", { handle: { name: "a.docx", createWritable() {} }, name: "a.docx", format: "docx" });
  assert.equal(autoSaveTarget(), null);

  setHome("none");
  drops.forEach((drop) => drop());
  stopSaves();
});
