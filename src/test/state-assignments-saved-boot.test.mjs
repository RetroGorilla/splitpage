import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { cloneState } from "../core/document/clone.ts";

const SAVED = {
  schema: 2,
  rev: 4,
  lastEditedBy: "Kim",
  title: "Saved in the file",
  rows: [
    { id: "r1", visualText: "Wide on the <b>harbour</b>", audioText: "Every morning.", status: "ready" },
    { id: "r2", visualText: "Close", audioText: "Mara mends nets.", status: "bogus", lengthSeconds: 90 }
  ],
  comments: [{ id: "c1", rowId: "r1", field: "audioText", text: "Tighter", replies: [] }]
};

const atBoot = await bootApp("\n" + JSON.stringify(SAVED, null, 2) + "\n");

const { migrateRows } = await import("../js/02-state.js");
const { seedCheckPasses } = await import("../legacy/seed-check.ts");

after(closeApp);

test("boot from a saved file's state-data: init assigns the file's script through migrateDocument, a migrateRows fixed point", () => {
  assert.equal(seedCheckPasses(), false, "a saved file is not the pristine seed");
  assert.deepEqual(atBoot.map((r) => r.site), ["00-prelude.js#(anonymous)", "02b-doc-id.js#loadInitialDocument", "02b-doc-id.js#assign"]);
  const loaded = atBoot[2].value;
  assert.equal(loaded.title, "Saved in the file");
  assert.equal(loaded.rows[1].status, "todo", "an unknown status was normalised on the way in");
  assert.match(loaded.docId, /^d[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(migrateRows(cloneState(loaded))), JSON.stringify(loaded));
  assert.equal(S.docIdWrittenOut, true);
});
