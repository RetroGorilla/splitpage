import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as Y from "yjs";
import { fixtures, open, writer } from "./run.mjs";
import { retainedBytes } from "./retained-bytes.mjs";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { isMain } from "../../../tools/main-module.mjs";

export function keyRates() {
  const rows = [];
  for (const fixture of fixtures().slice(0, 2)) for (const peer of [false, true]) {
    const handle = open(), edit = writer(handle);
    try {
      hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(fixture.document)));
      if (peer) collabState(handle).doc.clientID = 0x81234569;
      const target = { owner: fixture.document.rows[0].id, segment: "b:" + fixture.document.rows[0].id, field: "audioText" };
      const before = retainedBytes(collabState(handle).doc);
      for (let key = 0; key < 1000; key++) edit.type(target, "x", false);
      const after = retainedBytes(collabState(handle).doc), categories = Object.fromEntries(Object.keys(before.categories)
        .map(category => [category, after.categories[category] - before.categories[category]]));
      const addedBytes = after.encodedBytes - before.encodedBytes;
      assert.equal(Object.values(categories).reduce((sum, value) => sum + value, 0), addedBytes);
      rows.push({ fixture: fixture.name, freshPeer: peer, typed: 1000, addedBytes, categories });
    } finally { destroySharedDocument(handle); }
  }
  {
    const fixture = fixtures()[0], handle = open(), edit = writer(handle);
    try {
      hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(fixture.document)));
      const target = { owner: fixture.document.rows[0].id, segment: "b:" + fixture.document.rows[0].id, field: "audioText" };
      for (let mark = 0; mark < 100; mark++) edit.reverse(edit.command({ kind: "mark", target,
        observed: edit.history(target).units.slice(0, 2).map(unit => unit.identity), mark: { kind: "b", value: true } }));
      const before = retainedBytes(collabState(handle).doc); edit.type(target, "x", false);
      const after = retainedBytes(collabState(handle).doc);
      const addedReferences = after.observationReferences.range.count - before.observationReferences.range.count;
      assert.equal(addedReferences, 100);
      rows.push({ fixture: "short after 100 range additions and retractions", freshPeer: false, typed: 1,
        addedBytes: after.encodedBytes - before.encodedBytes,
        categories: Object.fromEntries(Object.keys(before.categories).map(category => [category, after.categories[category] - before.categories[category]])),
        observedRangeReferences: addedReferences, note: "small-state control; operation names differ from the earlier edited-workload checkpoint" });
    } finally { destroySharedDocument(handle); }
  }
  const doc = new Y.Doc(); doc.clientID = 0x81234569;
  try {
    const text = doc.getText("text"), before = Y.encodeStateAsUpdate(doc).length;
    for (let key = 0; key < 1000; key++) doc.transact(() => text.insert(text.length, "x"));
    rows.push({ fixture: "native coalescing control", typed: 1000, addedBytes: Y.encodeStateAsUpdate(doc).length - before,
      ledger: retainedBytes(doc), note: "one native transaction per key, no application birth records or scaffold" });
  } finally { doc.destroy(); }
  return rows;
}

if (isMain(import.meta.url)) writeFileSync("docs/collaboration/stage-2-key-rates.json", JSON.stringify(keyRates(), null, 2) + "\n");
