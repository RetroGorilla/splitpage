import test from "node:test";
import assert from "node:assert/strict";
import { acceptGhostOnTab, dismissesTagGhost, plainTagKeydown } from "../../../src/features/common/tag-completion-keys.ts";

function setup(key: string, empty = true, cancelled = true, suggested = false) {
  const calls: string[] = [];
  const event = { key, preventDefault: () => { calls.push("prevent"); }, stopPropagation: () => { calls.push("stop"); } } as KeyboardEvent;
  const tag = {
    close: () => calls.push("close"), cancel: () => calls.push("cancel"),
    emptyAtCaret: () => { calls.push("empty"); return empty; },
    cancelOnBackspace: () => { calls.push("backspace"); return cancelled; },
    dismissSuggestion: () => { if (suggested) calls.push("dismiss"); return suggested; }
  };
  return { calls, event, tag };
}

test("Escape on an open tag with a suggestion hides only the suggestion; the next Escape cancels", () => {
  const first = setup("Escape", true, true, true);
  assert.equal(plainTagKeydown(first.event, first.tag, () => first.calls.push("hide")), true);
  assert.deepEqual(first.calls, ["prevent", "stop", "dismiss"]);
  const second = setup("Escape", true, true, false);
  assert.equal(plainTagKeydown(second.event, second.tag, () => second.calls.push("hide")), true);
  assert.deepEqual(second.calls, ["prevent", "stop", "hide", "cancel"]);
});

test("open tags consume Tab before completion and preserve Escape effect ordering", () => {
  for (const visual of [false, true]) {
    const { calls, event, tag } = setup("Escape");
    assert.equal(plainTagKeydown(event, tag, () => { if (!visual) calls.push("hide"); }), true);
    assert.deepEqual(calls, visual ? ["prevent", "stop", "cancel"] : ["prevent", "stop", "hide", "cancel"]);
  }
  const { calls, event, tag } = setup("Tab");
  assert.equal(plainTagKeydown(event, tag, () => calls.push("hide")), true);
  assert.deepEqual(calls, ["prevent", "close"]);
});

test("Backspace checks empty caret before cancellation and consumes only a successful cancellation", () => {
  for (const [empty, cancelled, expected] of [[false, true, false], [true, false, false], [true, true, true]]) {
    const { calls, event, tag } = setup("Backspace", empty, cancelled);
    assert.equal(plainTagKeydown(event, tag, () => calls.push("hide")), expected);
    assert.deepEqual(calls, !empty ? ["empty"] : cancelled ? ["empty", "backspace", "prevent"] : ["empty", "backspace"]);
  }
  const { calls, event, tag } = setup("Enter");
  assert.equal(plainTagKeydown(event, tag, () => calls.push("hide")), false);
  assert.deepEqual(calls, []);
});

test("ghost Tab accepts only for the owning cell and prevents default only after acceptance", () => {
  for (const key of ["Tab", "Escape"]) for (const owns of [false, true]) for (const accepted of [false, true]) {
    const { calls, event } = setup(key);
    assert.equal(acceptGhostOnTab(event, owns, () => { calls.push("accept"); return accepted; }), key === "Tab" && owns && accepted);
    assert.deepEqual(calls, key !== "Tab" || !owns ? [] : accepted ? ["accept", "prevent"] : ["accept"]);
  }
});

test("ghost dismissal keys leave typing, Tab and Backspace alone", () => {
  for (const key of ["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) assert.equal(dismissesTagGhost(key), true);
  for (const key of ["Tab", "Backspace", "Enter", "a", "Delete"]) assert.equal(dismissesTagGhost(key), false);
});
