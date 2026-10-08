import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBrollProps } from "../../../src/core/document/broll.ts";
import { normalizePictureName, normalizeVideoLink } from "../../../src/core/document/gallery.ts";
import { PERSON_COLORS, normalizePersonColors } from "../../../src/core/document/person-colors.ts";
import {
  brokenCutOf,
  cappedName,
  cappedText,
  codePointPrefix,
  plainName,
  settledNames,
  unitCutName,
  withoutLoneSurrogates
} from "../../../src/core/document/text-policy.ts";

const GRIN = "\u{1F600}";
const HIGH = "\uD83D";
const LOW = "\uDE00";
const BLUE = PERSON_COLORS[0] as string;
const x = (n: number): string => "x".repeat(n);

test("codePointPrefix keeps the first max code points, so an astral character is never halved (#344)", () => {
  assert.equal(codePointPrefix(x(79) + GRIN + "y", 80), x(79) + GRIN);
  assert.equal(codePointPrefix(GRIN.repeat(81), 80), GRIN.repeat(80));
  assert.equal(codePointPrefix(x(80) + "y", 80), x(80));
  assert.equal(codePointPrefix(x(3), 80), x(3));
  assert.equal(codePointPrefix("", 80), "");
  assert.equal(codePointPrefix("ab" + GRIN, 2), "ab");
  assert.equal(codePointPrefix("a" + HIGH + "b", 2), "a" + HIGH, "a lone half is one code point");
  assert.equal(codePointPrefix(GRIN, 0), "");
});

test("withoutLoneSurrogates drops each half that has no partner and keeps every pair (#344)", () => {
  assert.equal(withoutLoneSurrogates("a" + HIGH + "b" + LOW + "c" + GRIN), "abc" + GRIN);
  assert.equal(withoutLoneSurrogates(LOW + HIGH), "");
  assert.equal(withoutLoneSurrogates(HIGH + GRIN + LOW), GRIN);
  assert.equal(withoutLoneSurrogates(GRIN + GRIN), GRIN + GRIN);
  assert.equal(withoutLoneSurrogates("plain"), "plain");
});

test("cappedName trims, cuts by code point and trims again, and takes the text as it is (#344, #419)", () => {
  assert.equal(cappedName(x(79) + GRIN + " tail", 80), x(79) + GRIN);
  assert.equal(cappedName(x(79) + " y", 80), x(79), "a cut that lands after a space keeps no space");
  assert.equal(cappedName("  " + x(80) + " tail", 80), x(80), "leading spaces don't count toward the cap");
  assert.equal(cappedName(x(79) + HIGH, 80), x(79), "a half left by an earlier cut is dropped");
  assert.equal(cappedName("a<b>c", 80), "a<b>c", "markup is not stripped here");
  assert.equal(cappedName("   ", 80), "");
});

test("a capped plain-text name keeps an emoji across its cap whole (#344)", () => {
  assert.equal(cappedText(x(79) + GRIN + "y", 80), x(79) + GRIN);
  assert.equal(cappedText(x(59) + GRIN, 60), x(59) + GRIN);
  assert.equal(cappedText("<b>" + x(79) + "</b>" + GRIN + " z", 80), x(79) + GRIN);
  assert.equal(plainName(x(79) + GRIN + "y"), x(79) + GRIN);
  assert.equal(plainName(GRIN.repeat(90)), GRIN.repeat(80));
});

test("a capped plain-text name holds no lone surrogate (#344)", () => {
  assert.equal(cappedText(x(79) + HIGH, 80), x(79));
  assert.equal(cappedText("a" + LOW + "b " + HIGH, 80), "ab");
  assert.equal(plainName(HIGH), "Anonymous");
  assert.equal(plainName(" " + LOW + " "), "Anonymous");
});

test("person-colour names are cut by code point and hold no lone surrogate (#344, #419)", () => {
  assert.deepEqual(normalizePersonColors({ [x(79) + GRIN + "y"]: BLUE }), { [x(79) + GRIN]: BLUE });
  assert.deepEqual(normalizePersonColors({ [x(79) + HIGH]: BLUE }), { [x(79)]: BLUE });
  assert.deepEqual(normalizePersonColors({ [x(79) + " y"]: BLUE }), { [x(79)]: BLUE });
});

test("settledNames heals a broken name only into a free, non-empty name, and keeps it as stored otherwise (#344)", () => {
  const key = (name: string): string => name.toLowerCase();
  assert.deepEqual(settledNames([x(79) + HIGH, "b " + HIGH], 80, key), [x(79), "b"]);
  assert.deepEqual(settledNames([HIGH, " " + LOW + " " + HIGH + " "], 60, key), [HIGH, LOW + " " + HIGH]);
  assert.deepEqual(settledNames(["Ann" + HIGH, "ann"], 60, key), ["Ann" + HIGH, "ann"], "a later clean name still wins");
  assert.deepEqual(settledNames(["cup" + HIGH, "cup" + LOW], 80, key), ["cup", "cup" + LOW], "the first to heal takes the name");
  assert.deepEqual(settledNames(["Bo " + HIGH + " ", "bo"], 60, key), ["Bo " + HIGH, "bo"]);
  assert.deepEqual(settledNames([HIGH + "  a" + LOW + "b " + HIGH + " ", "ab"], 80, key), [HIGH + "  a" + LOW + "b " + HIGH, "ab"]);
  assert.deepEqual(settledNames(["aaaa" + HIGH + "b", "aaaa"], 4, key), ["aaaa" + HIGH, "aaaa"], "the stored form keeps no more than its heal needs");
  assert.deepEqual(settledNames(["a", "a"], 80, key), ["a", "a"], "clean duplicates are left as they were");
  assert.deepEqual(settledNames(["x" + HIGH, " X" + HIGH + " "], 80, key), ["x", "X"], "names already alike when stored heal alike");
  assert.deepEqual(settledNames(["x", "x" + HIGH, "X" + HIGH], 80, key), ["x", "x" + HIGH, "X" + HIGH]);
  assert.deepEqual(settledNames(["mug", "x"], 80, (n, at) => at + key(n)), ["mug", "x"]);
});

test("settledNames takes a wanted name when it is free, and a broken one falls back to its stored form (#344)", () => {
  const key = (name: string): string => name.toLowerCase();
  assert.deepEqual(settledNames([x(79) + HIGH, "y"], 80, key, [x(79) + GRIN, undefined]), [x(79) + GRIN, "y"]);
  assert.deepEqual(settledNames([GRIN.repeat(40)], 80, key, [GRIN.repeat(50)]), [GRIN.repeat(50)]);
  assert.deepEqual(settledNames([x(79) + HIGH, x(79) + GRIN], 80, key, [x(79) + GRIN, undefined]), [x(79) + HIGH, x(79) + GRIN]);
  assert.deepEqual(settledNames([GRIN.repeat(40), GRIN.repeat(50)], 80, key, [GRIN.repeat(50), undefined]), [GRIN.repeat(40), GRIN.repeat(50)]);
  assert.deepEqual(settledNames(["x" + GRIN + LOW, "x" + HIGH], 80, key, [undefined, "x" + GRIN]), ["x" + GRIN + LOW, "x" + GRIN], "a heal never takes a wanted name");
  assert.deepEqual(settledNames(["x" + HIGH, "x" + HIGH], 80, key, ["x" + GRIN, "x" + GRIN]), ["x" + GRIN, "x" + GRIN], "wanted names may share a name");
});

test("settledNames is a fixed point: settling its own output changes nothing (#344)", () => {
  const key = (name: string): string => name.toLowerCase();
  const parts = ["a", "A", " ", HIGH, LOW, GRIN, "b"];
  let seed = 344;
  const next = (n: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n; };
  for (let round = 0; round < 400; round++) {
    const texts: string[] = [];
    for (let i = 1 + next(5); i > 0; i--) {
      let s = "";
      for (let k = next(9); k > 0; k--) s += parts[next(parts.length)];
      texts.push(s);
    }
    const once = settledNames(texts, 4, key);
    assert.deepEqual(settledNames(once, 4, key), once, JSON.stringify(texts));
    once.forEach((name, at) => {
      if (cappedName(name, 4) !== cappedName(texts[at] as string, 4)) assert.fail("a kept name heals to the same name: " + JSON.stringify(texts));
    });
  }
});

test("brokenCutOf finds a stored name an older build cut from text that held a lone half (#344)", () => {
  assert.equal(brokenCutOf(x(78) + HIGH, x(78) + " y", 80), true);
  assert.equal(brokenCutOf(HIGH + x(79), x(79) + "z", 80), true);
  assert.equal(brokenCutOf(x(78) + HIGH, x(78), 80), false, "the heal already matches");
  assert.equal(brokenCutOf(x(78) + "y", x(78) + "yz", 80), false, "a clean name is not a broken cut");
  assert.equal(brokenCutOf(x(70) + HIGH, x(70) + " more", 80), false, "too short to be a cut at the cap");
  assert.equal(brokenCutOf(x(78) + HIGH, "y" + x(78), 80), false);
});

test("unitCutName is the cut older builds made: trimmed, cut at max UTF-16 units, trimmed again (#344)", () => {
  assert.equal(unitCutName(" " + x(79) + GRIN + " tail", 80), x(79) + HIGH);
  assert.equal(unitCutName(GRIN.repeat(50), 80), GRIN.repeat(40));
  assert.equal(unitCutName(x(79) + " y", 80), x(79));
});

test("picture and file-link names are cut by code point at 200 (#344)", () => {
  assert.equal(normalizePictureName(x(199) + GRIN + "y"), x(199) + GRIN);
  assert.equal(normalizePictureName(x(199) + HIGH), x(199));
  assert.equal(normalizePictureName(" " + HIGH + " "), HIGH, "a name of only half an emoji is kept as stored, not lost");
  assert.equal(normalizePictureName(x(199) + " y"), x(199));
  assert.deepEqual(normalizeVideoLink({ name: x(199) + GRIN + "y" }), { name: x(199) + GRIN });
});

test("b-roll prop names are cut by code point at 80, before the registry lookup (#344)", () => {
  const registry = [{ id: "t_mug", cat: "prop", name: x(79) + GRIN, owner: "", notes: "", status: "needed" }];
  assert.deepEqual(normalizeBrollProps([x(79) + GRIN + " more"], registry), [{ id: "t_mug", name: x(79) + GRIN }]);
  assert.deepEqual(normalizeBrollProps([x(79) + HIGH], []), [{ id: "", name: x(79) }]);
});
