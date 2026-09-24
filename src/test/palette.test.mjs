/* The tag palette and the faint-text token (#143), read straight out of
 * src/app.css: every category's colour and tint defined in the light
 * block and in both dark blocks, TAG_CATEGORIES naming them, each one's
 * script rule present (HANDOFF invariant 14 — before this it was guarded by
 * one browser assertion on Gear alone), the hues kept off the Visual blue
 * and the Audio amber (#169; teal and orange before it), and the contrast
 * figures #143 set actually met.
 *
 * WCAG 2 relative luminance and contrast ratio, computed here rather than
 * pulled in: it is ten lines, and the numbers are the point of the test.
 *
 * Needs a DOM only because 07-production-tags.js pulls in modules that do.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TAG_CATEGORIES } from "../js/07-production-tags.js";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

/* The custom properties declared directly in the rule whose selector is
   `selector` — the first such rule, which for these three is the only one. */
function tokens(selector) {
  const at = css.indexOf(selector + " {");
  assert.notEqual(at, -1, "no rule for " + selector + " in app.css");
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at));
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)) out[m[1]] = m[2].toUpperCase();
  return out;
}
const LIGHT = tokens(":root");
const DARK_MEDIA = tokens(':root:not([data-theme="light"])');
const DARK = tokens(':root[data-theme="dark"], .prompter-line');

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function hue(hex) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return NaN;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };

test("the palette tests read the three token blocks they mean to", () => {
  assert.equal(LIGHT["--bg"], "#F1F0ED");
  assert.equal(DARK["--surface"], "#171614");
  assert.deepEqual(DARK_MEDIA, DARK, "the two dark blocks have drifted apart");
});

test("every category names its own colour token, defined in every theme, and has a script rule", () => {
  for (const cat of TAG_CATEGORIES) {
    assert.equal(cat.color, "var(--tag-" + cat.id + ")", cat.id + ": TAG_CATEGORIES should name the CSS token");
    for (const [name, block] of [["light", LIGHT], ["dark", DARK]]) {
      assert.ok(block["--tag-" + cat.id], cat.id + ": no --tag-" + cat.id + " in the " + name + " block");
      assert.ok(block["--tag-" + cat.id + "-tint"], cat.id + ": no --tag-" + cat.id + "-tint in the " + name + " block");
    }
    const rule = new RegExp('\\.tag-anchor\\[data-tag-cat="' + cat.id + '"\\]\\s*\\{[^}]*--tag-color:\\s*var\\(--tag-' + cat.id + '\\)');
    assert.match(css, rule, cat.id + ": no .tag-anchor rule drawing it in the script (HANDOFF invariant 14)");
  }
});

test("no category is drawn in the Visual blue or the Audio amber, or in another category's hue", () => {
  for (const [name, block] of [["light", LIGHT], ["dark", DARK]]) {
    const cats = TAG_CATEGORIES.map((c) => [c.id, block["--tag-" + c.id]]);
    for (const [id, hex] of cats) {
      for (const col of ["--visual", "--audio"]) {
        assert.ok(hueGap(hex, block[col]) >= 25,
          name + " " + id + " " + hex + " is within " + hueGap(hex, block[col]).toFixed(0) + "° of " + col);
      }
    }
    assert.equal(new Set(cats.map((c) => c[1])).size, cats.length, name + ": two categories share a colour");
  }
});

test("each category colour is readable as text: 4.5:1 on its theme's surfaces", () => {
  for (const cat of TAG_CATEGORIES) {
    const light = LIGHT["--tag-" + cat.id], dark = DARK["--tag-" + cat.id];
    for (const bg of ["--bg", "--surface"]) {
      assert.ok(contrast(light, LIGHT[bg]) >= 4.5, cat.id + " light " + light + " on " + bg + ": " + contrast(light, LIGHT[bg]).toFixed(2));
      assert.ok(contrast(dark, DARK[bg]) >= 4.5, cat.id + " dark " + dark + " on " + bg + ": " + contrast(dark, DARK[bg]).toFixed(2));
    }
  }
});

test("tagged words stay readable on their tint, and the rule stands out from it", () => {
  for (const cat of TAG_CATEGORIES) {
    for (const [name, block] of [["light", LIGHT], ["dark", DARK]]) {
      const tint = block["--tag-" + cat.id + "-tint"];
      assert.ok(contrast(block["--text"], tint) >= 7, name + " " + cat.id + ": text on tint " + contrast(block["--text"], tint).toFixed(2));
      assert.ok(contrast(block["--tag-" + cat.id], tint) >= 3, name + " " + cat.id + ": rule against tint " + contrast(block["--tag-" + cat.id], tint).toFixed(2));
    }
  }
});

test("--text-faint is 4.5:1 on the page in both themes", () => {
  assert.ok(contrast(LIGHT["--text-faint"], LIGHT["--bg"]) >= 4.5, "light: " + contrast(LIGHT["--text-faint"], LIGHT["--bg"]).toFixed(2));
  assert.ok(contrast(DARK["--text-faint"], DARK["--bg"]) >= 4.5, "dark: " + contrast(DARK["--text-faint"], DARK["--bg"]).toFixed(2));
});

/* --broll (#142): the header badge and the script's "B-roll:" marker read it,
   and for a while nothing defined it — the badge drew with no fill. */
test("--broll is defined in every theme, off every other hue, and readable as text and as a fill", () => {
  const badge = css.match(/\.broll-badge\s*\{([^}]*)\}/);
  assert.ok(badge, "no .broll-badge rule");
  assert.match(badge[1], /background:\s*var\(--broll\)/);
  const on = badge[1].match(/(?:^|;)\s*color:\s*var\((--[\w-]+)\)/);
  assert.ok(on, ".broll-badge sets no text colour of its own, so it inherits .comments-badge's white");
  for (const [name, block] of [["light", LIGHT], ["dark", DARK]]) {
    const broll = block["--broll"];
    assert.ok(broll, "no --broll in the " + name + " block");
    for (const bg of ["--bg", "--surface"]) {
      assert.ok(contrast(broll, block[bg]) >= 4.5, name + " --broll " + broll + " on " + bg + ": " + contrast(broll, block[bg]).toFixed(2));
    }
    assert.ok(contrast(block[on[1]], broll) >= 4.5, name + " badge text " + on[1] + " on --broll: " + contrast(block[on[1]], broll).toFixed(2));
    const others = ["--visual", "--audio", ...TAG_CATEGORIES.map((c) => "--tag-" + c.id)];
    for (const other of others) {
      assert.ok(hueGap(broll, block[other]) >= 25, name + " --broll " + broll + " is within " + hueGap(broll, block[other]).toFixed(0) + "° of " + other);
    }
  }
});
