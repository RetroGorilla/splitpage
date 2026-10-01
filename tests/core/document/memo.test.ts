import { test } from "node:test";
import assert from "node:assert/strict";
import { contentMemo } from "../../../src/core/document/memo.ts";

test("a memo computes once per content and hands back the same value", () => {
  const seen: string[] = [];
  const lengthOf = contentMemo((html) => { seen.push(html); return { length: html.length }; });
  const first = lengthOf("<b>x</b>");
  assert.equal(lengthOf("<b>x</b>"), first);
  assert.deepEqual(first, { length: 8 });
  lengthOf("other");
  assert.deepEqual(seen, ["<b>x</b>", "other"]);
});

test("missing content is the empty string", () => {
  const seen: string[] = [];
  const echo = contentMemo((html) => { seen.push(html); return html; });
  assert.equal(echo(null), "");
  assert.equal(echo(undefined), "");
  assert.equal(echo(""), "");
  assert.deepEqual(seen, [""]);
});

test("an undefined result is not kept", () => {
  let calls = 0;
  const nothing = contentMemo(() => { calls++; return undefined; });
  nothing("a");
  nothing("a");
  assert.equal(calls, 2);
});

test("the cache empties before storing once it holds more than two million characters, not at two million", () => {
  let calls = 0;
  const memo = contentMemo((html) => { calls++; return html.length; });
  const budget = "x".repeat(2000000);
  memo(budget);
  memo("a");
  assert.equal(calls, 2);
  memo(budget);
  memo("a");
  assert.equal(calls, 2, "holding exactly two million characters, storing one more cleared nothing");
  memo("b");
  memo("b");
  assert.equal(calls, 3, "holding one past the budget, storing cleared the cache first and kept the new value");
  memo(budget);
  assert.equal(calls, 4, "what was there before is gone");
});
