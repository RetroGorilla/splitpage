import assert from "node:assert/strict";
import { test } from "node:test";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { readSharedDocumentFieldProjection } from "../../../src/adapters/collab/project.ts";

test("omitted field: lengthSeconds 12 survives transfer", () => {
  const a = createMonitoredSharedDocument(), b = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(a, validatedFixture({ title: "Length", rows: [{ id: "R1", audioText: "x", lengthSeconds: 12 }] }));
    assert.ok(applySharedUpdate(b, encodeSharedState(a)).ok);
    const rows = readSharedDocumentFieldProjection(b).document.rows as Record<string, unknown>[];
    assert.equal(rows[0]?.lengthSeconds, 12);
  } finally { destroySharedDocument(a); destroySharedDocument(b); }
});
