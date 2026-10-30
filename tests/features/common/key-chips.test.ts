import test from "node:test";
import assert from "node:assert/strict";
import { IS_MAC, keyChipWords, keyChipsHtml } from "../../../src/features/common/key-chips.js";

type KeyChips = { IS_MAC: boolean; keyChipWords: (spec: string) => string[] };

const MOD =IS_MAC ? "⌘" : "Ctrl";
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

test("key chips: Apple platforms get symbols and everything else gets words", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const load = async (platform: string, tag: string): Promise<KeyChips> => {
    Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true, writable: true });
    return (await import(`../../../src/features/common/key-chips.js?${tag}`)) as KeyChips;
  };
  try {
    const mac = await load("MacIntel", "mac");
    assert.equal(mac.IS_MAC, true);
    assert.deepEqual(mac.keyChipWords("mod+shift+alt+k"), ["⌘", "⇧", "⌥", "K"]);
    const win = await load("Win32", "win");
    assert.equal(win.IS_MAC, false);
    assert.deepEqual(win.keyChipWords("mod+shift+alt+k"), ["Ctrl", "Shift", "Alt", "K"]);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
