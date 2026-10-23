import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readBuiltCss, repoUrl, cssRules, colourLiterals, resolveTokens, compareCssColours } from "../../tools/css-colours.mjs";

const { css } = readBuiltCss();
const tokenBlocks = new Set([
  ":root",
  ':root:not([data-theme="light"])',
  ':root[data-theme="dark"], .prompter, .prompter-line',
  ".prompter",
  ".prompter-scroll",
  ".broll-panel, .broll-page",
  ':root:not([data-theme="light"]) .broll-panel, :root:not([data-theme="light"]) .broll-page',
  ':root[data-theme="dark"] .broll-panel, :root[data-theme="dark"] .broll-page'
]);
const literalExceptions = [];

function rawColours(text) {
  const failures = [];
  for (const rule of cssRules(text)) {
    for (const { property, value } of rule.declarations) {
      if (property.startsWith("--") && tokenBlocks.has(rule.selector)) continue;
      for (const literal of colourLiterals(value)) {
        const exception = literalExceptions.find((e) => e.selector === rule.selector && e.property === property && e.literal === literal && e.reason);
        if (!exception) failures.push(`${rule.context.join(" | ")} ${rule.selector} | ${property}: ${literal}`);
      }
    }
  }
  return failures;
}

function addRuntimeDefinitions(url, definitions) {
  const source = readFileSync(url, "utf8");
  for (const match of source.matchAll(/\.setProperty\(\s*["'](--[\w-]+)["']\s*,|(--[\w-]+)\s*:/g)) definitions.add(match[1] || match[2]);
}

function runtimeDefinitions(directory) {
  const definitions = new Set();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      for (const name of runtimeDefinitions(url)) definitions.add(name);
    } else if (/\.(?:js|ts)$/.test(entry.name)) {
      addRuntimeDefinitions(url, definitions);
    }
  }
  return definitions;
}

test("the build's CSS has colour literals only in its token definition blocks", () => {
  assert.deepEqual(rawColours(css), []);
});

test("the literal guard checks fallbacks, gradients, shadows and media blocks", () => {
  for (const value of ["#abc", "#12345678", "rgb(1 2 3)", "rgba(1,2,3,.5)", "hsl(1 2% 3%)", "hsla(1,2%,3%,.5)", "var(--x, #fff)", "linear-gradient(#000, #fff)", "0 1px 2px #000"]) {
    assert.ok(rawColours(`@media (prefers-reduced-motion: reduce) { .sample { color: ${value}; } }`).length, value);
  }
  assert.equal(rawColours(".sample { --unapproved: #fff; }").length, 1);
});

test("every CSS variable has a CSS definition or a runtime assignment", () => {
  const rules = cssRules(css);
  const definitions = runtimeDefinitions(new URL("src/js/", repoUrl));
  for (const file of [
    "src/features/rows/row-motion.js",
    "src/features/title/topbar.ts",
    "src/features/notices/busy.js",
    "src/features/editing/cell-reach.js",
    "src/features/comments/comments.js",
    "src/features/notices/phone-bar.ts",
    "src/features/panels/side-panels.ts"
  ]) addRuntimeDefinitions(new URL(file, repoUrl), definitions);
  for (const rule of rules) {
    for (const { property } of rule.declarations) if (property.startsWith("--")) definitions.add(property);
  }
  const failures = [];
  for (const rule of rules) {
    for (const { value } of rule.declarations) {
      for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const name = match[1];
        const inactiveProgress = name === "--p" && value.slice(match.index).startsWith("var(--p, 0%)");
        if (!definitions.has(name) && !inactiveProgress) failures.push(`${rule.selector}: ${name}`);
      }
    }
  }
  assert.deepEqual(failures, [], "--p intentionally uses its 0% fallback for inactive prompter progress; other inputs must have definitions");
});

test("token resolution follows chains and nested fallbacks and refuses cycles", () => {
  const definitions = new Map([["--a", "var(--b)"], ["--b", "#fff"]]);
  assert.equal(resolveTokens("var(--missing, var(--a))", definitions), "#fff");
  assert.equal(resolveTokens("var(--runtime)", definitions), "var(--runtime)");
  definitions.set("--b", "var(--a)");
  assert.throws(() => resolveTokens("var(--a)", definitions), /Cyclic token/);
});

test("colour evidence detects theme, selector, media and fallback colour changes", () => {
  const before = ':root { --text: #111111; } @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --text: #eeeeee; } } :root[data-theme="dark"], .prompter, .prompter-line { --text: #eeeeee; } .preview { color: #fff; background: var(--text); border-color: var(--runtime, #fff); } @media (prefers-reduced-motion: reduce) { .preview { color: #fff; } }';
  const after = before.replace(":root {", ":root { --white: #FFFFFF; --alias: var(--white);").replaceAll("#fff", "var(--alias)");
  assert.deepEqual(compareCssColours(before, after), []);
  assert.ok(compareCssColours(before, after.replace("--white: #FFFFFF", "--white: #FFFFFE")).some((d) => d.includes(".preview")));
  assert.ok(compareCssColours(before, after.replaceAll("#eeeeee", "#dddddd")).some((d) => d.startsWith("dark")));
  assert.ok(compareCssColours(before, after.replace(".preview {", ".changed {")).some((d) => d.includes("selector")));
  assert.ok(compareCssColours(before, after.replace("prefers-reduced-motion: reduce", "max-width: 600px")).some((d) => d.includes("media context")));
  assert.ok(compareCssColours(before, after.replace("var(--runtime, var(--alias))", "var(--runtime, #000)")).some((d) => d.includes("border-color")));
});
