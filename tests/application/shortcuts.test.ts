import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChord, chordMatches, actionForKey } from "../../src/application/shortcuts.ts";
import { createActionRegistry } from "../../src/application/actions.ts";

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; composing?: boolean } = {}) => ({
  key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt, isComposing: !!mods.composing
});

test("a chord parses its modifiers and key", () => {
  assert.deepEqual(parseChord("mod+alt+h"), { key: "h", mod: true, shift: false, alt: true });
  assert.deepEqual(parseChord("F1"), { key: "f1", mod: false, shift: false, alt: false });
  assert.deepEqual(parseChord("mod+shift+S"), { key: "s", mod: true, shift: true, alt: false });
});

test("a chord with no key or an unknown modifier is refused", () => {
  assert.throws(() => parseChord("mod+shift"), /names no key/);
  assert.throws(() => parseChord("hyper+k"), /unknown modifiers/);
});

test("mod is Control or Command, and every modifier must match exactly", () => {
  const chord = parseChord("mod+alt+h");
  assert.equal(chordMatches(chord, key("h", { ctrl: true, alt: true })), true);
  assert.equal(chordMatches(chord, key("H", { meta: true, alt: true })), true);
  assert.equal(chordMatches(chord, key("h", { ctrl: true })), false);
  assert.equal(chordMatches(chord, key("h", { ctrl: true, alt: true, shift: true })), false);
  assert.equal(chordMatches(chord, key("j", { ctrl: true, alt: true })), false);
});

test("a key pressed while composing never matches", () => {
  assert.equal(chordMatches(parseChord("mod+k"), key("k", { ctrl: true, composing: true })), false);
});

test("a key event finds the action that declares it", () => {
  const registry = createActionRegistry();
  registry.register({ id: "hide", label: "Hide", group: "G", keys: ["mod+alt+h"], run: () => {} });
  registry.register({ id: "find", label: "Find", group: "G", keys: ["mod+f"], run: () => {} });
  assert.equal(actionForKey(registry.shortcuts(), key("f", { ctrl: true }))?.id, "find");
  assert.equal(actionForKey(registry.shortcuts(), key("h", { meta: true, alt: true }))?.id, "hide");
  assert.equal(actionForKey(registry.shortcuts(), key("x", { ctrl: true })), null);
});
