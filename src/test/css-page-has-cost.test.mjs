import test from "node:test";
import assert from "node:assert/strict";
import { readBuiltCss, cssRules } from "../../tools/css-colours.mjs";

function topLevel(text, separator) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && separator.test(ch)) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

function pageWideHas(selector) {
  const match = /(?:^|[\s>+~])(?:html|body):has\(\s*([^)]?)/.exec(selector);
  return match !== null && match[1] !== ">";
}

function guardedSubject(selector) {
  const subject = topLevel(selector, /[\s>+~]/).at(-1) ?? "";
  return /:has\(>\s*\*\)|:not\(\[hidden\]\)/.test(subject);
}

test("a page-wide :has() over the whole page is reached only through a subject that is usually absent", () => {
  const offenders = [];
  for (const rule of cssRules(readBuiltCss().css)) {
    for (const selector of topLevel(rule.selector, /,/)) {
      if (pageWideHas(selector) && !guardedSubject(selector)) offenders.push(selector);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the page-wide :has() check accepts child-only and guarded rules and rejects an unguarded one", () => {
  assert.equal(pageWideHas("body:has(> .writer:not([hidden])) .presence-carets"), false);
  assert.equal(pageWideHas("html:has(> body.panel-open)"), false);
  assert.equal(pageWideHas('body:has([role="menu"]:not([hidden])) #toast-host'), true);
  assert.equal(guardedSubject('body:has([role="menu"]:not([hidden])) #toast-host'), false);
  assert.equal(guardedSubject("body:has(.a) #toast-host:has(> *)"), true);
  assert.equal(guardedSubject("body:has(.a) .tag-edit-action:not([hidden])"), true);
});
