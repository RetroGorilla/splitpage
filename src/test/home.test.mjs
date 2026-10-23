import test from "node:test";
import assert from "node:assert/strict";
import { setHome } from "../legacy/location-bridge.ts";
import "./_location-started.mjs";

test("autoSaveTarget answers server, file or null off the home", async () => {
  await import("./_dom.mjs");
  const { autoSaveTarget, saveDestinations, startSaves } = await import("../legacy/save-bridge.ts");
  const { legacyFileDestination, legacySavePorts } = await import("../js/14-export.js");
  const { onServerDoc, serverSaveDestination } = await import("../js/13-hosted.js");
  const stopSaves = startSaves(legacySavePorts({ capture: () => Object.freeze({}), stillOwns: () => true }), { start: () => null, stop: () => {} });
  const drops = [saveDestinations().register(legacyFileDestination()), saveDestinations().register(serverSaveDestination())];

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
