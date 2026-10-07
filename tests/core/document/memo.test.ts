import { test } from "node:test";
import assert from "node:assert/strict";
import { deepFreeze, noFreeze } from "../../../src/core/document/freeze.ts";
import { contentMemo } from "../../../src/core/document/memo.ts";

test("a memo computes once per content and hands back the same value", () => {
  const seen: string[] = [];
  const lengthOf = contentMemo((html) => { seen.push(html); return { length: html.length }; }, noFreeze);
  const first = lengthOf("<b>x</b>");
  assert.equal(lengthOf("<b>x</b>"), first);
  assert.deepEqual(first, { length: 8 });
  lengthOf("other");
  assert.deepEqual(seen, ["<b>x</b>", "other"]);
});

test("missing content is the empty string", () => {
  const seen: string[] = [];
  const echo = contentMemo((html) => { seen.push(html); return html; }, noFreeze);
  assert.equal(echo(null), "");
  assert.equal(echo(undefined), "");
  assert.equal(echo(""), "");
  assert.deepEqual(seen, [""]);
});

test("an undefined result is not kept", () => {
  let calls = 0;
  const nothing = contentMemo(() => { calls++; return undefined; }, deepFreeze);
  nothing("a");
  nothing("a");
  assert.equal(calls, 2);
});

test("the cache empties before storing once it holds more than two million characters, not at two million", () => {
  let calls = 0;
  const memo = contentMemo((html) => { calls++; return html.length; }, deepFreeze);
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

test("with freezing on, the memo hands out its value deep-frozen, and a write into it throws a TypeError", () => {
  const read = contentMemo((html) => ({ html: html, parts: [{ text: html }] }), deepFreeze);
  const value = read("<b>x</b>") as { html: string; parts: { text: string }[] };
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.parts) && Object.isFrozen(value.parts[0]));
  assert.throws(() => { value.html = "y"; }, TypeError);
  assert.throws(() => { value.parts.push({ text: "y" }); }, TypeError);
  assert.throws(() => { (value.parts[0] as { text: string }).text = "y"; }, TypeError);
  assert.deepEqual(read("<b>x</b>"), { html: "<b>x</b>", parts: [{ text: "<b>x</b>" }] });
});

test("with freezing off, the memo hands out its value as computed, unfrozen", () => {
  const made: object[] = [];
  const read = contentMemo((html) => { const v = { html: html }; made.push(v); return v; }, noFreeze);
  assert.equal(read("a"), made[0]);
  assert.equal(Object.isFrozen(read("a")), false);
});
