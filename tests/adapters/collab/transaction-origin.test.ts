import test from "node:test";
import assert from "node:assert/strict";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument, destroySharedDocument } from "../../../src/adapters/collab/document.ts";

test("declared transaction purpose follows the actual outer origin and ends before observer delivery", () => {
  const handle = createMonitoredSharedDocument(), state = collabState(handle), observed: unknown[] = [];
  const receive = () => { observed.push(state.activeOrigin); }; state.doc.on("afterTransaction", receive);
  try {
    assert.equal(state.activeOrigin, null);
    transactSharedDocument(handle, "hydration", () => {
      assert.equal(state.activeOrigin, "hydration"); assert.equal(state.hydrating, true);
      state.roots.meta.set("one", 1);
      transactSharedDocument(handle, "local-command", () => { assert.equal(state.activeOrigin, "hydration"); });
      assert.equal(state.activeOrigin, "hydration");
    });
    transactSharedDocument(handle, "hydration", () => { assert.equal(state.activeOrigin, "hydration"); assert.equal(state.hydrating, false); state.roots.meta.set("two", 2); });
    transactSharedDocument(handle, "local-command", () => {
      transactSharedDocument(handle, "hydration", () => { assert.equal(state.activeOrigin, "local-command"); assert.equal(state.hydrating, false); });
    });
    assert.equal(state.activeOrigin, null); assert.deepEqual(observed, [null, null, null]);
    assert.throws(() => transactSharedDocument(handle, "hydration", () => { throw new Error("purpose failure"); }), /purpose failure/);
    assert.equal(state.activeOrigin, null); assert.equal(state.hydrating, false);
  } finally { state.doc.off("afterTransaction", receive); destroySharedDocument(handle); }
});
