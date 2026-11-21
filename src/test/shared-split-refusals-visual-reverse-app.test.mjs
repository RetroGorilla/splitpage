import { calls, cellOf, enter, errors, hook, pending, ROUTES, select, servedRow, setWatching, snapshot, tick, warningCalls } from "./_shared-split-refusals.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentWhoList } from "../bootstrap/wiring/who-list.ts";
import { sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { encodeSharedState } from "../adapters/collab/document.ts";

for (const field of ["visualText"]) for (const order of ["reverse"]) {
  test(`rule 55 refusal table: ${field}, encoded delivery ${order}, every unserved route and cell state`, async t => {
    let rows = 0, served = 0;
    for (const route of ROUTES) for (const state of ["caret", "selection", "pending", "composition"]) {
      if (route.mention && field === "audioText") continue;
      for (const elsewhere of route.type === "drop" ? [false, true] : [false]) {
        await enter(order, route.mention);
        const cell = cellOf(field), target = elsewhere ? cellOf(field, "r2") : cell;
        try {
          select(cell, 3);
          if (route.mention) {
            select(cell, 1);
            currentWhoList().maybeOpen({ inputType: "insertText", data: "@" }, cell);
            assert.equal(currentWhoList().isOpen(cell), true);
          }
          select(cell, state === "selection" ? 2 : 3, state === "selection" ? 4 : 3);
          if (state === "pending" || state === "composition") pending(cell, state === "composition");
          const before = snapshot(cell), access = [];
          const data = { files: [], types: ["text/plain"], getData: format => { access.push(format); return format === "text/plain" ? "pasted" : ""; },
            setData: (...args) => { access.push(args); } };
          const e = route.type === "keydown" ? new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: route.key, ...route.modifiers })
            : route.type === "beforeinput" ? new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: route.inputType, data: null })
              : new window.Event(route.type, { bubbles: true, cancelable: true });
          if (route.type === "drop") Object.defineProperty(e, "dataTransfer", { value: data });
          if (route.type === "paste" || route.type === "cut") Object.defineProperty(e, "clipboardData", { value: data });
          warningCalls.length = 0; errors.length = 0; calls.length = 0;
          setWatching(true);
          assert.doesNotThrow(() => { target.dispatchEvent(e); });
          await tick(); setWatching(false);
          const label = `${route.name}/${state}/other=${elsewhere}`;
          assert.deepEqual([errors, calls, access], [[], [], []], label);
          if (servedRow(route, field, state, before, e, label)) { rows++; served++; continue; }
          assert.equal(e.defaultPrevented, true, label);
          assert.deepEqual(warningCalls, [["This is not available in a shared session yet.", "warn"]], label);
          assert.deepEqual(hook.read(), before.doc, label);
          assert.deepEqual(encodeSharedState(sharedSessionParts().handle), before.encoded, label);
          assert.deepEqual(hook.peer.appliedUpdates(), before.updates, label);
          assert.equal(cell.innerHTML, before.html, label);
          assert.equal(document.activeElement, before.active, label);
          assert.equal(document.getSelection().anchorNode, before.anchor, label);
          assert.equal(document.getSelection().focusNode, before.head, label);
          assert.deepEqual([document.getSelection().anchorOffset, document.getSelection().focusOffset], before.offsets, label);
          rows++;
        } finally {
          setWatching(false); currentWhoList().cancel();
          if (state === "composition") cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
          assert.deepEqual(hook.leave(), { ok: true });
        }
      }
    }
    assert.deepEqual([rows, served], field === "audioText" ? [104, 6] : [108, 4]);
    t.diagnostic((rows - served) + " refusal rows and " + served + " served rows; standalone undo is instrumented on every event");
  });
}
