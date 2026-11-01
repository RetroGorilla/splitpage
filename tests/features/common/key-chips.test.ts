import test from "node:test";
import assert from "node:assert/strict";
import { IS_MAC, keyChipWords, keyChipsHtml } from "../../../src/features/common/key-chips.ts";

const MOD = IS_MAC ? "⌘" : "Ctrl";
const SHIFT = IS_MAC ? "⇧" : "Shift";
const ALT = IS_MAC ? "⌥" : "Alt";

test("keyChipWords: names modifier keys for the platform and upper-cases single letters", () => {
  assert.deepEqual(keyChipWords("mod+shift+k"), [MOD, SHIFT, "K"]);
  assert.deepEqual(keyChipWords("Alt+Mod+z"), [ALT, MOD, "Z"]);
});

test("keyChipWords: keeps longer key names as written", () => {
  assert.deepEqual(keyChipWords("mod+Enter"), [MOD, "Enter"]);
  assert.deepEqual(keyChipWords("F2"), ["F2"]);
});

test("keyChipWords: ignores empty parts and empty specs", () => {
  assert.deepEqual(keyChipWords("mod++k"), [MOD, "K"]);
  assert.deepEqual(keyChipWords(""), []);
  assert.deepEqual(keyChipWords(undefined), []);
  assert.deepEqual(keyChipWords(null), []);
});

test("keyChipsHtml: wraps each word in a kbd element and escapes markup", () => {
  assert.equal(keyChipsHtml("mod+k"), `<kbd>${MOD}</kbd><kbd>K</kbd>`);
  assert.equal(keyChipsHtml("<"), "<kbd>&lt;</kbd>");
  assert.equal(keyChipsHtml("&Tab"), "<kbd>&amp;Tab</kbd>");
  assert.equal(keyChipsHtml(""), "");
});
