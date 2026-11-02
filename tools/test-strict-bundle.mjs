import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { buildPublishHtml, capturePageShell } from "../src/adapters/page/page-shell.ts";
import { REPO } from "./source-scan.mjs";

const probe = `throw {
  receiver: (function () { return this; })(),
  frozenWrite: (function () {
    try { Object.freeze({ value: 1 }).value = 2; return false; }
    catch (error) { return error instanceof TypeError; }
  })(),
  frozenDelete: (function () {
    try { delete Object.freeze({ value: 1 }).value; return false; }
    catch (error) { return error instanceof TypeError; }
  })(),
  getterWrite: (function () {
    try { ({ get value() { return 1; } }).value = 2; return false; }
    catch (error) { return error instanceof TypeError; }
  })(),
  undeclaredWrite: (function () {
    try { splitpageStrictProbeUndeclared = 1; return false; }
    catch (error) { return error instanceof ReferenceError; }
  })(),
  unaliasedArguments: (function (value) { value = 2; return arguments[0] === 1; })(1)
};`;

function unwrap(expression) {
  return ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;
}

function assertStrict(script) {
  const parsed = ts.createSourceFile("app.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statement = parsed.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(unwrap(s.expression)));
  assert.ok(statement, "the bundled app has an immediately invoked wrapper");
  const wrapper = unwrap(unwrap(statement.expression).expression);
  assert.ok(ts.isArrowFunction(wrapper) || ts.isFunctionExpression(wrapper));
  assert.ok(ts.isBlock(wrapper.body));
  const start = wrapper.body.statements.find((s) => !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)));
  assert.ok(start, "the wrapper contains the app");
  const at = start.getStart(parsed);
  let result;
  try {
    runInNewContext(script.slice(0, at) + probe + script.slice(at), {}, { timeout: 1000 });
    assert.fail("the runtime probe did not execute inside the bundle");
  } catch (error) {
    result = error;
  }
  assert.equal(result.receiver, undefined, "a plain bundled function keeps undefined this");
  for (const key of ["frozenWrite", "frozenDelete", "getterWrite", "undeclaredWrite", "unaliasedArguments"]) {
    assert.equal(result[key], true, key + " uses strict semantics inside the built wrapper");
  }
  const first = parsed.statements[0];
  assert.ok(ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression));
  assert.equal(first.expression.text, "use strict");
}

function checkPage(html) {
  const dom = new JSDOM(html);
  try {
    const scripts = [...dom.window.document.scripts];
    assert.equal(scripts.length, 2);
    assert.equal(scripts.filter((s) => s.type === "application/json").length, 1);
    const app = dom.window.document.getElementById("app-logic");
    assertStrict(app.textContent);
    const hash = createHash("sha256").update(app.textContent, "utf8").digest("base64");
    assert.ok(dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("'sha256-" + hash + "'"));
    return app.textContent;
  } finally {
    dom.window.close();
  }
}

const output = join(REPO, "index.html");
const previous = existsSync(output) ? readFileSync(output) : null;
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
try {
  for (const flags of [[], ["--test"]]) {
    execFileSync(process.execPath, ["build.mjs", ...flags], { cwd: REPO, stdio: "pipe", timeout: 60000 });
    const html = readFileSync(output, "utf8");
    const script = checkPage(html);
    const dom = new JSDOM(html);
    try {
      globalThis.document = dom.window.document;
      capturePageShell();
      const exported = buildPublishHtml(JSON.stringify({ title: "Strict SplitShare", rows: [] }));
      assert.equal(checkPage(exported), script, "SplitShare keeps the exact script and its CSP hash");
    } finally {
      dom.window.close();
    }
    console.log("  ok   " + (flags.length ? "test" : "release") + " bundle and SplitShare: runtime strictness and CSP hash");
  }
} finally {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  if (previous) writeFileSync(output, previous);
  else if (existsSync(output)) unlinkSync(output);
}
console.log("2 passed, 0 failed");
