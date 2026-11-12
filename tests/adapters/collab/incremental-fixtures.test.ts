import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../src/test/_dom.mjs";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { projectionReferences } from "./projection-roundtrip-support.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { destroySharedDocument, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { assertIncremental, incrementalReports } from "./incremental-support.ts";

after(() => { dom.window.close(); });

test("all 291 reference documents agree incrementally after hydration and scripted edits at every publication", t => {
  let fixtures = 0, checkpoints = 0, texts = 0;
  const reported = incrementalReports.compared;
  for (const fixture of projectionReferences) {
    const handle = createMonitoredSharedDocument(), projector = createSharedIncrementalProjector(handle);
    const stop = projector.observe(() => { assertIncremental(handle, projector); checkpoints++; });
    try {
      assertIncremental(handle, projector);
      hydrateSharedDocument(handle, migrateRows(structuredClone(fixture.document)));
      const roots = collabState(handle).roots;
      transactSharedDocument(handle, "local-command", () => roots.meta.set("wordsPerMinute", 141));
      transactSharedDocument(handle, "local-command", () => { const title: unknown = roots.meta.get("title"); assert.ok(title instanceof Y.Text); title.insert(0, "Edited "); });
      transactSharedDocument(handle, "local-command", () => {
        const person = new Y.Map<unknown>(); person.set("id", "incremental-person"); person.set("name", "Ada"); roots.people.set("incremental-person", person);
      });
      const key = roots.order.toArray().find(key => { const segment: unknown = roots.segments.get(key); return segment instanceof Y.Map && segment.get("text") instanceof Y.Text; });
      if (key) transactSharedDocument(handle, "local-command", () => {
        const segment: unknown = roots.segments.get(key); assert.ok(segment instanceof Y.Map); const text: unknown = segment.get("text"); assert.ok(text instanceof Y.Text);
        text.insert(0, "x"); texts++;
      });
      else transactSharedDocument(handle, "local-command", () => {
        const segment = new Y.Map<unknown>(); segment.set("text", new Y.Text("x"));
        roots.segments.set("incremental-empty", segment); roots.order.push(["incremental-empty"]); texts++;
      });
      assertIncremental(handle, projector); fixtures++;
    } finally { stop(); projector.dispose(); destroySharedDocument(handle); }
  }
  assert.equal(fixtures, 291); assert.equal(texts, 291); assert.equal(checkpoints, 1455);
  assert.equal(incrementalReports.compared - reported, 1455);
  t.diagnostic(JSON.stringify({ fixtures, checkpoints, texts }));
});
