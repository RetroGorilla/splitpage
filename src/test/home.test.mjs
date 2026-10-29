import "./_identity-started.mjs";
import { documentIdentityOwner } from "../bootstrap/wiring/document-identity.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { setHome } from "../bootstrap/wiring/location-owner.ts";
import "./_location-started.mjs";

test("autoSaveTarget answers file or null off the home", async () => {
  await import("./_dom.mjs");
  const { autoSaveTarget, saveDestinations, startSaves } = await import("../bootstrap/wiring/save-owners.ts");
  const { wireFileSaving } = await import("../bootstrap/wiring/file-saving.ts");
  const copyDocHistorySafe = (...args) => documentIdentityOwner().copyDocHistorySafe(...args);
  const syncDocIdentity = (...args) => documentIdentityOwner().syncDocIdentity(...args);
  const { setBaseState } = await import("../bootstrap/wiring/session-merge.ts");
  const fileSaving = wireFileSaving({ copyHistory: copyDocHistorySafe, syncIdentity: syncDocIdentity, setBaseline: setBaseState });
  const stopSaves = startSaves(fileSaving.savePorts({ capture: () => Object.freeze({}), stillOwns: () => true }), { start: () => null, stop: () => {} });
  const drops = [saveDestinations().register(fileSaving.destination())];

  setHome("none");
  assert.equal(autoSaveTarget(), null);

  setHome("file", { handle: { name: "a.md" }, format: "md", name: "a.md" });
  assert.equal(autoSaveTarget(), "file");

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
