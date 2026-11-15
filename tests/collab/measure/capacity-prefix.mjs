import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fixtures, open, writer } from "./run.mjs";
import { retainedBytes } from "./retained-bytes.mjs";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";

const cap = 2 * 1024 ** 2, results = [];
for (const fixture of fixtures().slice(1)) {
  const handle = open(); collabState(handle).doc.clientID = 100;
  try {
    hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(fixture.document)));
    collabState(handle).doc.clientID = 1;
    const edit = writer(handle, { prefix: "d1p1k", by: "Writer1" });
    let previous = { typed: 0, bytes: encodeSharedState(handle).length }, crossed = null, corrections = 0;
    for (let key = 1; key <= 30000; key++) {
      const owner = fixture.document.rows[(2 + Math.floor((key - 1) / 55)) % fixture.document.rows.length].id;
      const target = { owner, segment: "b:" + owner, field: "audioText" };
      const value = "words "[(key - 1) % 6]; edit.type(target, value, false);
      if (key % 55 === 0) {
        edit.command({ kind: "text-delete", target, observed: edit.history(target).units.slice(-1).map(unit => unit.identity) });
        edit.type(target, value, false); corrections++;
      }
      if (key % 100 === 0) {
        const bytes = encodeSharedState(handle).length;
        if (bytes > cap) { crossed = { typed: key, corrections, bytes, previous, ledger: retainedBytes(collabState(handle).doc) }; break; }
        previous = { typed: key, bytes };
      }
    }
    results.push({ fixture: fixture.name, cap, groupSizes: [1, 2, 4], firstDayOverCap: crossed ? 1 : null, crossed,
      note: "measured first writer's typing phase of day 1, before the 30,000-key daily allocation and before structural/formatting tail; stop at first over-cap block" });
    if (crossed) assert.ok(crossed.previous.bytes <= cap && crossed.bytes > cap);
    writeFileSync("docs/collaboration/stage-2-capacity-prefix.json", JSON.stringify(results, null, 2) + "\n");
  } finally { destroySharedDocument(handle); }
}
writeFileSync("docs/collaboration/stage-2-capacity-prefix.json", JSON.stringify(results, null, 2) + "\n");
