import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startEmptyScript } from "../../../src/features/empty-script/empty-script.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { fakeEmptyScriptPorts } from "../fakes.ts";
import { emptyScriptDocument, emptyScriptRow } from "./literals.ts";

function page(rows: readonly Record<string, unknown>[] = [], prepare?: (fake: ReturnType<typeof fakeEmptyScriptPorts>) => void) {
  document.body.innerHTML = "";
  const fake = fakeEmptyScriptPorts(enterSharedDocument(emptyScriptDocument(rows))); prepare?.(fake);
  const control = startEmptyScript(fake.ports), area = fake.ports.host.previousElementSibling;
  assert.ok(area instanceof HTMLElement);
  const input = area.querySelector("textarea"); assert.ok(input);
  return { ...fake, control, input, area };
}

function before(input: HTMLTextAreaElement) {
  return input.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true }));
}

function input(input: HTMLTextAreaElement, text: string) {
  input.value = text;
  return input.dispatchEvent(new window.InputEvent("input", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
}

test("an empty-script target is hidden and rejects native input once a beat exists", () => {
  const p = page([emptyScriptRow("R1", "already here")]);
  try {
    assert.equal(p.area.hidden, true); assert.equal(before(p.input), false); assert.equal(input(p.input, "late"), false);
    assert.deepEqual([p.created, p.state.held], [[], 0]);
    p.input.value = "";
  } finally { assert.equal(p.control.dispose(), true); }
});

test("an empty-script target also admits an input event without beforeinput as one held creation", () => {
  const p = page();
  try {
    assert.equal(input(p.input, "autofill"), true); assert.deepEqual(p.created, ["autofill"]);
    assert.equal(p.state.held, 0); assert.deepEqual(p.placed, [{ rowId: "created", offset: 8 }]);
  } finally { assert.equal(p.control.dispose(), true); }
});

test("an empty-script target respects read-only admission for beforeinput and input", () => {
  const p = page([], fake => { fake.state.allowed = false; });
  try {
    assert.equal(p.input.disabled, true); assert.equal(before(p.input), false); assert.equal(input(p.input, "denied"), false);
    assert.deepEqual([p.created, p.state.held], [[], 0]); p.input.value = "";
  } finally { assert.equal(p.control.dispose(), true); }
});

test("an empty-script target keeps an old epoch's native text without writing into the next document", () => {
  const p = page();
  try {
    assert.equal(before(p.input), true); p.state.epoch++;
    assert.equal(input(p.input, "kept"), false); assert.equal(p.control.finish(), false); assert.equal(before(p.input), false);
    assert.deepEqual(p.created, []); assert.equal(p.input.value, "kept");
    assert.deepEqual(p.notices.shown.map(notice => notice.message), ["empty-script-stale"]);
    p.state.epoch--; assert.equal(input(p.input, "kept"), true);
    assert.deepEqual(p.created, ["kept"]); assert.equal(p.state.held, 0);
  } finally { assert.equal(p.control.dispose(), true); }
});

test("an empty-script target refuses a second buffer and keeps no hold of its own", () => {
  const p = page([], fake => { fake.state.holdRefusal = "buffer-pending"; });
  try {
    assert.equal(before(p.input), false); assert.equal(p.state.held, 0); assert.deepEqual(p.created, []);
    assert.deepEqual(p.notices.shown.map(notice => notice.message), ["buffer-pending"]);
  } finally { assert.equal(p.control.dispose(), true); }
});

test("an empty-script target keeps refused creation text available for retry", () => {
  const p = page([], fake => { fake.state.createRefusal = "empty-script-no-author"; });
  try {
    assert.equal(before(p.input), true); input(p.input, "kept");
    assert.equal(p.input.value, "kept"); assert.equal(p.state.held, 1);
    assert.deepEqual(p.placed, []); assert.deepEqual(p.notices.shown.map(notice => notice.message), ["empty-script-no-author"]);
    p.state.createRefusal = null; assert.equal(p.control.finish(), true);
    assert.deepEqual(p.created, ["kept", "kept"]); assert.equal(p.input.value, ""); assert.equal(p.state.held, 0);
    assert.deepEqual(p.placed, [{ rowId: "created", offset: 4 }]);
  } finally { assert.equal(p.control.dispose(), true); }
});

test("an empty-script target cannot retry an uncommitted draft into another epoch", () => {
  const p = page([], fake => { fake.state.createRefusal = "empty-script-no-author"; });
  try {
    assert.equal(before(p.input), true); input(p.input, "kept");
    p.state.epoch++; p.state.createRefusal = null;
    assert.equal(p.control.finish(), false); assert.deepEqual(p.created, ["kept"]); assert.equal(p.input.value, "kept");
    p.state.epoch--; assert.equal(p.control.finish(), true); assert.deepEqual(p.created, ["kept", "kept"]);
  } finally { assert.equal(p.control.dispose(), true); }
});

test("an empty-script target ignores a compositionend without its compositionstart", () => {
  const p = page();
  try {
    assert.equal(before(p.input), true); p.input.value = "pending";
    p.input.dispatchEvent(new window.CompositionEvent("compositionend", { data: "unrelated", bubbles: true }));
    assert.deepEqual(p.created, []); assert.equal(p.control.finish(), false); assert.equal(p.state.held, 1);
    input(p.input, "pending"); assert.deepEqual(p.created, ["pending"]);
  } finally { assert.equal(p.control.dispose(), true); }
});

test("an empty-script target cannot unmount pending native input and removes its hooks after cancellation", () => {
  const p = page();
  assert.equal(before(p.input), true); assert.equal(p.control.dispose(), false); assert.equal(p.state.held, 1);
  assert.deepEqual([...p.commands].map(finish => finish()), [false]);
  p.input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "x", bubbles: true }));
  assert.equal(p.control.dispose(), true); assert.equal(p.control.dispose(), true);
  assert.equal(p.area.isConnected, false); assert.equal(p.commands.size, 0); assert.equal(p.reader.listenerCount(), 0);
  assert.equal(p.state.held, 0); input(p.input, "late"); assert.deepEqual(p.created, []);
});

test("an empty-script target regains focus if its created beat cannot be painted and the projection remains empty", () => {
  const p = page([], fake => { fake.state.placeable = false; });
  try {
    assert.equal(before(p.input), true); input(p.input, "x");
    assert.equal(document.activeElement, p.input); assert.deepEqual(p.created, ["x"]); assert.equal(p.state.held, 0);
  } finally { assert.equal(p.control.dispose(), true); }
});
