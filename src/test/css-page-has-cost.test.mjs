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

function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && --depth === 0) return i;
  }
  return text.length;
}

function pageWideHas(selector) {
  for (const match of selector.matchAll(/(?:^|[\s>+~,(])(?:html|body):has\(/g)) {
    const open = match.index + match[0].length - 1;
    const argument = selector.slice(open + 1, closing(selector, open));
    if (topLevel(argument, /,/).some(arm => !childOnly(arm))) return true;
  }
  return false;
}

function childOnly(arm) {
  if (!arm.startsWith(">")) return false;
  const steps = arm.replace(/\s*>\s*/g, ">");
  let depth = 0;
  for (const ch of steps) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && /[\s+~]/.test(ch)) return false;
  }
  return true;
}

function guardedSubject(selector) {
  const subject = topLevel(selector, /[\s>+~]/).at(-1) ?? "";
  let depth = 0;
  for (let i = 0; i < subject.length; i++) {
    if (depth === 0 && /^(?::has\(>\s*\*\)|:not\(\[hidden\]\))/.test(subject.slice(i))) return true;
    const ch = subject[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
  }
  return false;
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
  assert.equal(pageWideHas("body:has(> .a, .b) #toast-host"), true);
  assert.equal(pageWideHas("body:has(> .a, > .b) #toast-host"), false);
  assert.equal(pageWideHas(":is(body:has(.a)) .x"), true);
  assert.equal(pageWideHas(":is(body:has(> .topbar .mini-toolbar)) .tag-edit-action"), true);
  assert.equal(pageWideHas("body:has(> .topbar ~ .panel) .x"), true);
  assert.equal(pageWideHas("body:has(> .topbar > .mini-toolbar:not([hidden])) .x"), false);
  assert.equal(guardedSubject("body:has(.a) :is(.x, .y:not([hidden]))"), false);
  assert.equal(guardedSubject("body:has(.a) :is(.x:has(> *))"), false);
  assert.equal(guardedSubject("body:has(.a) #toast-host:not([hidden]):hover"), true);
});
