import { calls, cellOf, enter, errors, hook, pending, select, setWatching, snapshot, tick, warningCalls } from "./_shared-split-refusals.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { encodeSharedState } from "../adapters/collab/document.ts";

const GUARDS = [
  { name: "Enter{}/pending", type: "keydown", key: "Enter", state: "pending" },
  { name: "paste/caret", type: "paste", state: "caret" }
];

test("legacy Split Audio refusal guards prevent plain Enter and unserved native routes from reaching standalone handlers", async () => {
  for (const guard of GUARDS) {
    await enter("forward", false);
    const cell = cellOf("audioText");
    try {
      select(cell, 3, 3);
      if (guard.state === "pending") pending(cell, false);
      const before = snapshot(cell), access = [];
      const data = { files: [], types: ["text/plain"], getData: format => { access.push(format); return format === "text/plain" ? "pasted" : ""; },
        setData: (...args) => { access.push(args); } };
      const e = guard.type === "keydown"
        ? new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: guard.key })
        : new window.Event(guard.type, { bubbles: true, cancelable: true });
      if (guard.type === "paste") Object.defineProperty(e, "clipboardData", { value: data });
      warningCalls.length = 0; errors.length = 0; calls.length = 0;
      setWatching(true);
      assert.doesNotThrow(() => { cell.dispatchEvent(e); });
      await tick(); setWatching(false);
      assert.deepEqual([errors, calls, access], [[], [], []], guard.name);
      assert.equal(e.defaultPrevented, true, guard.name);
      assert.deepEqual(warningCalls, [["This is not available in a shared session yet.", "warn"]], guard.name);
      assert.deepEqual(hook.read(), before.doc, guard.name);
      assert.deepEqual(encodeSharedState(sharedSessionParts().handle), before.encoded, guard.name);
      assert.deepEqual(hook.peer.appliedUpdates(), before.updates, guard.name);
      assert.equal(cell.innerHTML, before.html, guard.name);
      assert.equal(document.activeElement, before.active, guard.name);
      assert.equal(document.getSelection().anchorNode, before.anchor, guard.name);
      assert.equal(document.getSelection().focusNode, before.head, guard.name);
      assert.deepEqual([document.getSelection().anchorOffset, document.getSelection().focusOffset], before.offsets, guard.name);
    } finally {
      setWatching(false);
      assert.deepEqual(hook.leave(), { ok: true });
    }
  }
});
