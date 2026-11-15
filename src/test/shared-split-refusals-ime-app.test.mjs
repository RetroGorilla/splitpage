import { calls, cellOf, enter, errors, hook, pending, select, setWatching, snapshot, tick, warningCalls } from "./_shared-split-refusals.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedSessionParts } from "../bootstrap/wiring/shared-session.ts";
import { encodeSharedState } from "../adapters/collab/document.ts";
for (const field of ["audioText", "visualText"]) for (const order of ["forward", "reverse"]) {
  test(`Split IME key table: ${field}, ${order}, composing keys never reach legacy handlers`, async t => {
    let rows = 0;
    for (const key of ["Enter", "Backspace", "Escape", "ArrowLeft"]) for (const signal of ["isComposing", "229"]) {
      await enter(order);
      const cell = cellOf(field); let committed = false;
      try {
        select(cell, 3); pending(cell, true);
        const before = snapshot(cell);
        const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key,
          isComposing: signal === "isComposing", keyCode: signal === "229" ? 229 : 0 });
        assert.equal(event.isComposing, signal === "isComposing");
        assert.equal(event.keyCode, signal === "229" ? 229 : 0);
        warningCalls.length = 0; calls.length = 0; errors.length = 0; setWatching(true);
        assert.doesNotThrow(() => { cell.dispatchEvent(event); });
        await tick(); setWatching(false);
        const label = key + "/" + signal;
        assert.equal(event.defaultPrevented, false, label);
        assert.deepEqual([warningCalls, calls, errors], [[], [], []], label);
        assert.deepEqual(hook.read(), before.doc, label);
        assert.deepEqual(encodeSharedState(sharedSessionParts().handle), before.encoded, label);
        assert.deepEqual(hook.peer.appliedUpdates(), before.updates, label);
        assert.equal(cell.innerHTML, before.html, label);
        assert.equal(document.activeElement, before.active, label);
        assert.equal(document.getSelection().anchorNode, before.anchor, label);
        assert.equal(document.getSelection().focusNode, before.head, label);
        assert.deepEqual([document.getSelection().anchorOffset, document.getSelection().focusOffset], before.offsets, label);
        cell.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: "X" }));
        cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "X", isComposing: true }));
        cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "X" }));
        committed = true;
        await tick(); hook.peer.deliver(order);
        assert.deepEqual([warningCalls, calls, errors], [[], [], []], label);
        assert.equal(hook.read().app.rows[0][field], "abcXdef", label);
        assert.deepEqual(hook.read().app, hook.read().peer, label);
        rows++;
      } finally {
        setWatching(false);
        if (!committed) cell.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
        assert.deepEqual(hook.leave(), { ok: true });
      }
    }
    assert.equal(rows, 8);
    t.diagnostic("8 composing rows: Enter, Backspace, Escape, ArrowLeft, each signal");
  });
}

for (const field of ["audioText", "visualText"]) for (const order of ["forward", "reverse"]) {
  test(`Split IME 229 precedes compositionstart: ${field}, ${order}, key bypass and paragraph refusal`, async t => {
    let rows = 0;
    for (const key of ["Enter", "Backspace", "Escape", "ArrowLeft"]) for (const inputType of ["insertParagraph", "insertLineBreak"]) {
      await enter(order);
      const cell = cellOf(field);
      try {
        select(cell, 3);
        const before = snapshot(cell);
        const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, keyCode: 229 });
        assert.equal(event.isComposing, false);
        assert.equal(event.keyCode, 229);
        warningCalls.length = 0; calls.length = 0; errors.length = 0; setWatching(true);
        assert.doesNotThrow(() => { cell.dispatchEvent(event); });
        await tick();
        const label = key + "/" + inputType;
        assert.equal(event.defaultPrevented, false, label);
        assert.deepEqual([warningCalls, calls, errors], [[], [], []], label);
        assert.deepEqual(snapshot(cell), before, label);
        const input = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType });
        assert.doesNotThrow(() => { cell.dispatchEvent(input); });
        await tick(); setWatching(false);
        assert.equal(input.defaultPrevented, true, label);
        assert.deepEqual(warningCalls, [["This is not available in a shared session yet.", "warn"]], label);
        assert.deepEqual([calls, errors], [[], []], label);
        assert.deepEqual(snapshot(cell), before, label);
        rows++;
      } finally {
        setWatching(false);
        assert.deepEqual(hook.leave(), { ok: true });
      }
    }
    assert.equal(rows, 8);
    t.diagnostic("8 pre-composition rows: 229 keydown bypass, then paragraph or line-break refusal");
  });
}
