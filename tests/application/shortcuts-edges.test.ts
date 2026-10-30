import { test } from "node:test";
import assert from "node:assert/strict";
import { canBeShortcut, chordMatches, createChordReader, parseChord } from "../../src/application/shortcuts.ts";
import type { KeyChord, KeyInput, KeyedAction } from "../../src/application/shortcuts.ts";

function key(name: string | undefined, down: Partial<KeyInput> = {}): KeyInput {
  return { key: name, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...down };
}

test("function keys F1 to F24 are shortcuts on their own, in either case, and nothing around them is", () => {
  ["f1", "F1", "f9", "f10", "F12", "f19", "f20", "f23", "f24", "F24"].forEach(function (name) {
    assert.equal(canBeShortcut(key(name)), true, name);
    assert.equal(parseChord(name).key, name.toLowerCase(), name);
  });
  ["f0", "f25", "f30", "f100", "xf1", "f1x", "f", "fn1", "ff1", "f01", "1"].forEach(function (name) {
    assert.equal(canBeShortcut(key(name)), false, name);
    assert.throws(() => parseChord(name), /needs mod or alt, or a function key/, name);
  });
});

test("a chord with no key, or only modifiers, names no key", () => {
  ["", "+", "mod+", "mod++", "mod+shift", "Mod+Shift", "ALT", "shift"].forEach(function (text) {
    assert.throws(() => parseChord(text), /names no key/, JSON.stringify(text));
  });
});

test("empty parts between plus signs are ignored, and modifiers and keys read in any case", () => {
  assert.deepEqual(parseChord("mod++s"), { key: "s", mod: true, shift: false, alt: false });
  assert.deepEqual(parseChord(" Mod + Shift + S "), { key: "s", mod: true, shift: true, alt: false });
  assert.deepEqual(parseChord("ALT+Mod+K"), { key: "k", mod: true, shift: false, alt: true });
  assert.throws(() => parseChord("hyper+s"), /unknown modifiers hyper/);
});

test("a key event with no usable key never matches, even a chord that was built with an empty key", () => {
  const letter: KeyChord = { key: "x", mod: true, shift: false, alt: false };
  assert.equal(chordMatches(letter, key(undefined, { ctrlKey: true })), false);
  assert.equal(chordMatches(letter, key("", { ctrlKey: true })), false);
  const blank: KeyChord = { key: "", mod: true, shift: false, alt: false };
  assert.equal(chordMatches(blank, key("", { ctrlKey: true })), false);
  assert.equal(chordMatches(blank, key(undefined, { ctrlKey: true })), false);
});

test("a chord matches only when the modifier keys are exactly the ones it names", () => {
  const alt: KeyChord = { key: "x", mod: false, shift: false, alt: true };
  assert.equal(chordMatches(alt, key("x", { altKey: true })), true);
  assert.equal(chordMatches(alt, key("x", { altKey: true, ctrlKey: true })), false, "ctrl is not asked for");
  assert.equal(chordMatches(alt, key("x", { altKey: true, metaKey: true })), false, "meta is not asked for");
  const mod: KeyChord = { key: "x", mod: true, shift: false, alt: false };
  assert.equal(chordMatches(mod, key("X", { metaKey: true })), true);
  assert.equal(chordMatches(mod, key("x", { ctrlKey: true, altKey: true })), false);
  assert.equal(chordMatches(mod, key("x", { ctrlKey: true, shiftKey: true })), false);
  assert.equal(chordMatches(mod, key("x")), false);
  assert.equal(chordMatches(mod, key("x", { ctrlKey: true, isComposing: true })), false);
});

test("a chord is written one way however it was typed: mod, alt, shift, then the key", () => {
  const reader = createChordReader();
  assert.equal(reader.chordKey("alt+x"), "alt+x");
  assert.equal(reader.chordKey("mod+x"), "mod+x");
  assert.equal(reader.chordKey("shift+alt+x"), "alt+shift+x");
  assert.equal(reader.chordKey("shift+mod+alt+K"), "mod+alt+shift+k");
  assert.equal(reader.chordKey("F5"), "f5");
  assert.equal(reader.chordKey("shift+F5"), "shift+f5");
});

test("when two actions share a key the first listed wins, and an action matches on any one of its keys", () => {
  const reader = createChordReader();
  const first: KeyedAction = { id: "first", keys: ["mod+k", "alt+j"], claim: true };
  const second: KeyedAction = { id: "second", keys: ["mod+k"], claim: true };
  assert.equal(reader.actionForKey([first, second], key("k", { ctrlKey: true }))?.id, "first");
  assert.equal(reader.actionForKey([second, first], key("k", { ctrlKey: true }))?.id, "second");
  assert.equal(reader.actionForKey([first, second], key("j", { altKey: true }))?.id, "first");
  assert.equal(reader.actionForKey([first, second], key("z", { ctrlKey: true })), null);
  assert.equal(reader.actionForKey([], key("k", { ctrlKey: true })), null);
});
