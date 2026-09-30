import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChord, chordKey, chordMatches, actionForKey, canBeShortcut } from "../../src/application/shortcuts.ts";
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

test("a chord holds mod or alt unless its key is a function key, so typing is never taken", () => {
  assert.throws(() => parseChord("k"), /needs mod or alt/);
  assert.throws(() => parseChord("shift+k"), /needs mod or alt/);
  assert.throws(() => parseChord("Escape"), /needs mod or alt/);
  assert.deepEqual(parseChord("shift+F5"), { key: "f5", mod: false, shift: true, alt: false });
  assert.deepEqual(parseChord("F12"), { key: "f12", mod: false, shift: false, alt: false });
  assert.deepEqual(parseChord("alt+k"), { key: "k", mod: false, shift: false, alt: true });
});

test("only a key with mod or alt held, or a function key, can be a shortcut", () => {
  assert.equal(canBeShortcut(key("k", { ctrl: true })), true);
  assert.equal(canBeShortcut(key("k", { meta: true })), true);
  assert.equal(canBeShortcut(key("k", { alt: true })), true);
  assert.equal(canBeShortcut(key("F1")), true);
  assert.equal(canBeShortcut(key("F12", { shift: true })), true);
  assert.equal(canBeShortcut(key("k")), false);
  assert.equal(canBeShortcut(key("K", { shift: true })), false);
  assert.equal(canBeShortcut(key("Escape")), false);
  assert.equal(canBeShortcut(key("F")), false);
  assert.equal(canBeShortcut({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), false);
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

test("a key event without a key, as autofill sends, matches nothing and does not throw", () => {
  const registry = createActionRegistry();
  registry.register({ id: "find", label: "Find", group: "G", keys: ["mod+f"], run: () => {} });
  const noKey = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(chordMatches(parseChord("mod+f"), noKey), false);
  assert.equal(actionForKey(registry.shortcuts(), noKey), null);
  assert.equal(actionForKey(registry.shortcuts(), { ...noKey, key: undefined }), null);
});

test("chordKey names a chord the same way however it is written", () => {
  assert.equal(chordKey("mod+shift+S"), chordKey("shift + mod + s"));
  assert.equal(chordKey("alt+mod+h"), "mod+alt+h");
  assert.notEqual(chordKey("mod+f"), chordKey("mod+shift+f"));
});

test("a chord another action already declares is refused when registering", () => {
  const registry = createActionRegistry();
  registry.register({ id: "find", label: "Find", group: "G", keys: ["mod+f"], run: () => {} });
  assert.throws(() => registry.register({ id: "flip", label: "Flip", group: "G", keys: ["Mod+F"], run: () => {} }), /mod\+f is already bound to find/);
  assert.equal(registry.has("flip"), false);
  registry.register({ id: "flip", label: "Flip", group: "G", keys: ["mod+shift+f"], run: () => {} });
  assert.equal(actionForKey(registry.shortcuts(), key("F", { ctrl: true, shift: true }))?.id, "flip");
});

test("one action cannot declare a chord twice, and a malformed chord is refused when registering", () => {
  const registry = createActionRegistry();
  assert.throws(() => registry.register({ id: "a", label: "A", group: "G", keys: ["mod+k", "mod+K"], run: () => {} }), /mod\+k is already bound to a/);
  assert.throws(() => registry.register({ id: "b", label: "B", group: "G", keys: ["mod+shift"], run: () => {} }), /names no key/);
  assert.equal(registry.has("a"), false);
  assert.equal(registry.has("b"), false);
});

test("a chord declared through a function is checked against the others too", () => {
  const registry = createActionRegistry();
  registry.register({ id: "help", label: "Help", group: "G", keys: () => ["F1"], run: () => {} });
  assert.throws(() => registry.register({ id: "guide", label: "Guide", group: "G", keys: ["f1"], run: () => {} }), /f1 is already bound to help/);
});

test("a chord freed by unregistering can be declared again", () => {
  const registry = createActionRegistry();
  const off = registry.register({ id: "find", label: "Find", group: "G", keys: ["mod+f"], run: () => {} });
  off();
  registry.register({ id: "search", label: "Search", group: "G", keys: ["mod+f"], run: () => {} });
  assert.equal(actionForKey(registry.shortcuts(), key("f", { ctrl: true }))?.id, "search");
});
