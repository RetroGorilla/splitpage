import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument, onSessionChange, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const hook = window.__sharedTest;
const render = window.__renderTest;
const cell = (rowId, field) => document.querySelector(`#rows .cell-editable[data-id="${rowId}"][data-field="${field}"]`);

function payload(target, type) {
  target.focus();
  setCellSelection(target, 0, 5);
  const data = {}, event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "dragstart" ? "dataTransfer" : "clipboardData", {
    value: { setData: (kind, value) => { data[kind] = value; } }
  });
  target.dispatchEvent(event);
  return { data, prevented: event.defaultPrevented };
}

for (const field of ["audioText", "visualText"]) {
  test(`native Split ${field} uses the standalone copy payload before, during and after sharing`, async t => {
    adoptReplacement(migrateRows({ title: "Spaces", rows: [{ id: "r0", audioText: "Word\u00a0", visualText: "Word\u00a0" }] }));
    const target = cell("r0", field);
    const copy = { data: { "text/html": "Word&nbsp;", "text/plain": "Word " }, prevented: true };
    const drag = { data: {}, prevented: false };
    assert.deepEqual(payload(target, "copy"), copy);
    assert.deepEqual(payload(target, "dragstart"), drag);
    assert.deepEqual(await hook.enter(), { ok: true });
    t.after(() => { if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true }); });
    assert.deepEqual(payload(cell("r0", field), "copy"), copy);
    assert.deepEqual(payload(cell("r0", field), "dragstart"), drag);
    assert.deepEqual(hook.leave(), { ok: true });
    assert.deepEqual(payload(cell("r0", field), "copy"), copy);
    assert.deepEqual(payload(cell("r0", field), "dragstart"), drag);
  });
}

function press(target, key, ctrlKey = false) {
  const options = { key, ctrlKey, bubbles: true, cancelable: true };
  target.dispatchEvent(new window.KeyboardEvent("keydown", options));
  target.dispatchEvent(new window.KeyboardEvent("keyup", options));
}

for (const { size, original, field, offset, label } of [
  { size: 2, original: "Word ", field: "audioText", offset: 4, label: "a short script" },
  { size: 100, original: "Word ", field: "audioText", offset: 4, label: "a script with 100 beats" },
  { size: 2, original: "Look ", field: "visualText", offset: 4, label: "a Visual cell with trailing space" },
  { size: 2, original: "x".repeat(130_000), field: "audioText", offset: 130_000, label: "a beat with 130,000 characters" }
]) {
  test(`one native Split keystroke changes only its cell in ${label}`, async t => {
    const typed = original.slice(0, offset) + "Y" + original.slice(offset);
    const rows = Array.from({ length: size }, (_, index) => ({
      id: "r" + index, audioText: "After", visualText: "Look", ...index === 0 && { [field]: original }
    }));
    adoptReplacement(migrateRows({ title: "Typing work", rows: structuredClone(rows) }));
    assert.deepEqual(await hook.enter(), { ok: true });
    t.after(() => { if (sharedSession()) assert.deepEqual(hook.leave(), { ok: true }); });
    const target = cell("r0", field);
    assert.equal(target.textContent, original);
    target.focus();
    setCellSelection(target, offset);

    const changes = [];
    const stop = onSessionChange(change => changes.push(change));
    t.after(stop);
    const watched = [...document.querySelectorAll("#rows .cell-editable")];
    assert.equal(watched.length, size * 2);
    const observer = new window.MutationObserver(() => {});
    for (const editable of watched) observer.observe(editable, { childList: true, characterData: true, subtree: true });
    t.after(() => observer.disconnect());
    render.reset();
    const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "Y" });
    assert.equal(target.dispatchEvent(before), false);
    window.dispatchEvent(new window.Event("pagehide"));
    const touched = new Set(observer.takeRecords().map(({ target }) =>
      (target.nodeType === window.Node.ELEMENT_NODE ? target : target.parentElement)?.closest(".cell-editable")));
    assert.deepEqual([...touched], [target]);
    stop();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].changes.whole, false);
    const published = changes[0].changes.cells;
    assert.ok(published.every(({ rowId }) => rowId === "r0"));
    assert.deepEqual(published.filter(({ field }) => field === "audioText" || field === "visualText"),
      [{ rowId: "r0", field }]);
    const counts = render.counts();
    assert.ok(counts.render <= 1 && counts.rowsPainted <= 1 && counts.cellsPainted <= 1, JSON.stringify(counts));
    assert.ok(watched.every(editable => editable.isConnected));
    assert.equal(target.textContent, typed);
    await Promise.resolve();
    for (const copy of Object.values(hook.read())) assert.deepEqual(copy.rows.map(({ id, audioText, visualText }) => ({
      id, audioText, visualText
    })), [{ ...rows[0], [field]: typed }, ...rows.slice(1)]);

    press(target, "z", true);
    assert.equal(currentDocument().rows[0][field], original);
    assert.deepEqual(hook.leave(), { ok: true });
    assert.deepEqual(currentDocument().rows.map(({ id, audioText, visualText }) => ({ id, audioText, visualText })), rows);
  });
}
