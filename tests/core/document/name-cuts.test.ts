import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBrollProps } from "../../../src/core/document/broll.ts";
import { normalizePictureName, normalizeVideoLink } from "../../../src/core/document/gallery.ts";
import { PERSON_COLORS, normalizePersonColors } from "../../../src/core/document/person-colors.ts";
import {
  cappedName,
  cappedText,
  codePointPrefix,
  plainName,
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

test("picture and file-link names are cut by code point at 200 (#344)", () => {
  assert.equal(normalizePictureName(x(199) + GRIN + "y"), x(199) + GRIN);
  assert.equal(normalizePictureName(x(199) + HIGH), x(199));
  assert.equal(normalizePictureName(x(199) + " y"), x(199));
  assert.deepEqual(normalizeVideoLink({ name: x(199) + GRIN + "y" }), { name: x(199) + GRIN });
});

test("b-roll prop names are cut by code point at 80, before the registry lookup (#344)", () => {
  const registry = [{ id: "t_mug", cat: "prop", name: x(79) + GRIN, owner: "", notes: "", status: "needed" }];
  assert.deepEqual(normalizeBrollProps([x(79) + GRIN + " more"], registry), [{ id: "t_mug", name: x(79) + GRIN }]);
  assert.deepEqual(normalizeBrollProps([x(79) + HIGH], []), [{ id: "", name: x(79) }]);
});
