import { cellOf, enter, hook, pending, select, tick, warningCalls } from "./_shared-split-refusals.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { createSharedDocument, destroySharedDocument, applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { registerSharedOperationFamilies } from "../adapters/collab/operation-families.ts";
import { projectSharedDocumentWithRecovery } from "../adapters/collab/project.ts";
import { fromHtml } from "../bootstrap/richtext.ts";
import { assertReplicasAgree } from "../../tests/collab/agreement.ts";
for (const field of ["audioText", "visualText"]) for (const order of ["forward", "reverse"]) {
  test(`rule 29 drained removal: ${field}, ${order}, one recovery entry and one announcement`, async () => {
    await enter(order);
    const cell = cellOf(field); select(cell, 3); pending(cell, true);
    hook.peer.hold(); hook.peer.remove("r1"); hook.peer.type("r2", 0, "Z"); hook.peer.release(order);
    assert.equal(currentDocument().rows[0].id, "r1");
    hook.peer.hold();
    warningCalls.length = 0;
    const count = hook.counters().recovered;
    try {
      cell.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: "X" }));
      cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "X", isComposing: true }));
      cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "X" }));
      await tick(); assert.equal(hook.peer.deliver("duplicate"), 1);
      assert.equal(hook.counters().recovered, count + 1);
      assert.deepEqual(warningCalls, [["Your writing was kept in recovery.", "warn"]]);
      assert.deepEqual(hook.read().app, hook.read().peer);
      assert.deepEqual(hook.read().app.rows.map(row => [row.id, row.audioText, row.visualText]), [["r2", "ZPQother", "other"]]);
      const kept = hook.recovery();
      assert.deepEqual(kept.app, kept.peer);
      assert.equal(kept.app.length, 1);
      assert.equal(kept.app[0].kind, "removed-beat");
      assert.deepEqual([kept.app[0].row.id, kept.app[0].row.audioText, kept.app[0].row.visualText],
        ["r1", field === "audioText" ? "abcXdef" : "abcdef", field === "visualText" ? "abcXdef" : "abcdef"]);
      const late = createSharedDocument(); registerSharedOperationFamilies(late, { cells: fromHtml });
      try {
        assert.equal(applySharedUpdate(late, encodeSharedState(sharedSessionParts().handle)).ok, true);
        assertReplicasAgree("drained removal recovery", [{ order, replica: "A", output: kept.app }, { order, replica: "B", output: kept.peer },
          { order: "late-C", replica: "C", output: projectSharedDocumentWithRecovery(late).recovery }]);
      } finally { destroySharedDocument(late); }
      hook.peer.deliver("duplicate");
      assert.equal(hook.counters().recovered, count + 1);
      assert.equal(warningCalls.length, 1);
    } finally { assert.deepEqual(hook.leave(), { ok: true }); }
  });
}
