import test from "node:test";
import assert from "node:assert/strict";
import { compareCssColours } from "../../tools/css-colours.mjs";

test("colour comparison keeps light pages, prompters and both dark themes scoped", () => {
  const before = `
    :root { --ink: #111111; }
    @media (prefers-color-scheme: dark) {
      :root { --ink: #222222; }
      :root:not([data-theme="light"]) { --ink: #222222; }
      :root:not([data-theme="light"]) .page { color: #222222; }
    }
    :root[data-theme="dark"], .prompter, .prompter-line { --ink: #333333; }
    :root[data-theme="light"] .page { color: #111111; }
    :root[data-theme="dark"] .page { color: #333333; }
    .prompter .caption, .prompter-line:is(.first, .second) { color: #333333; }
    @media (prefers-reduced-motion: reduce) {
      :root { --motion-ink: #444444; }
      .page { color: #444444; }
    }
    .page { background: var(--motion-ink, #555555); }
  `;
  const after = before.replace(/color: #[123]{6}/g, "color: var(--ink)")
    .replace("color: #444444", "color: var(--motion-ink)");
  assert.deepEqual(compareCssColours(before, after), []);
  const pageBleed = after.replace(':root[data-theme="light"] .page { color: var(--ink)', ':root[data-theme="light"] .page { color: #333333');
  assert.ok(compareCssColours(before, pageBleed).some((difference) => difference.startsWith("light") && difference.includes(".page")));
  const systemBleed = after.replace(':root:not([data-theme="light"]) .page { color: var(--ink)', ':root:not([data-theme="light"]) .page { color: #333333');
  assert.ok(compareCssColours(before, systemBleed).some((difference) => difference.startsWith("system-dark") && difference.includes(".page")));
  const mediaBleed = after.replace("background: var(--motion-ink, #555555)", "background: #444444");
  assert.ok(compareCssColours(before, mediaBleed).some((difference) => difference.includes("background")));
  const prompterBleed = after.replace(".prompter .caption, .prompter-line:is(.first, .second) { color: var(--ink)", ".prompter .caption, .prompter-line:is(.first, .second) { color: #111111");
  assert.ok(compareCssColours(before, prompterBleed).some((difference) => difference.includes(".prompter .caption")));
});

test("colour comparison preserves structural checks", () => {
  const css = ":root { --ink: #111; } .page { color: var(--ink); }";
  assert.deepEqual(compareCssColours(css, css + ".extra { color: red; }"), ["CSS rule count changed"]);
  assert.ok(compareCssColours(css, css.replace(".page", ".other")).some((difference) => difference.includes("selector or media context changed")));
  assert.ok(compareCssColours(css, css.replace(".page {", "@media print { .page {") + "}").some((difference) => difference.includes("selector or media context changed")));
  assert.ok(compareCssColours(css, css.replace("color: var(--ink);", "")).some((difference) => difference.includes("declaration count changed")));
});
