import assert from "node:assert/strict";
import test from "node:test";
import { actCost } from "../../src/native/heavy.ts";
import type { NativeReplica, NativeScheme } from "../../src/native/variant.ts";
import { runMarks, surveyMarks } from "./marks-generator.ts";
import type { MarkDelivery, MarkStep } from "./marks-generator.ts";

const SCHEMES: NativeScheme[] = ["name", "act"], DELIVERIES: MarkDelivery[] = ["updates", "state"];

// why: each literal is [history, what main's rule gives, what the variant shows per key scheme and delivery]
const LITERALS: Record<string, { steps: MarkStep[]; model: string; shows: Record<string, string> }> = {
  "M-loss: italic on d, which nobody unformatted, after the other person deletes abc": {
    steps: [{ op: "add", by: 0, kind: "i", first: "b", last: "c" }, { op: "add", by: 0, kind: "i", first: "d", last: "d" },
      { op: "add", by: 1, kind: "i", first: "c", last: "c" }, { op: "delete", by: 1, first: "a", last: "c" }],
    model: "[d|i]", shows: { "name updates": "d", "name state": "[d|i]", "act updates": "[d|i]", "act state": "[d|i]" } },
  "two people make neighbouring words bold at the same moment": {
    steps: [{ op: "add", by: 1, kind: "b", first: "a", last: "b" }, { op: "add", by: 0, kind: "b", first: "c", last: "d" }],
    model: "[a|b][b|b][c|b][d|b]", shows: { "name updates": "[a|b][b|b]cd", "name state": "[a|b][b|b]cd", "act updates": "[a|b][b|b][c|b][d|b]", "act state": "[a|b][b|b][c|b][d|b]" } },
  "M-inside: text typed unseen inside an italic range whose letters are then all deleted": {
    steps: [{ op: "add", by: 0, kind: "i", first: "b", last: "c" }, { op: "delete", by: 0, first: "b", last: "c" }, { op: "insert", by: 1, after: "b", char: "X", mode: "plain" }],
    model: "a[X|i]d", shows: { "name updates": "aXd", "name state": "aXd", "act updates": "aXd", "act state": "aXd" } },
  "M-edge: text typed unseen just before a range someone makes bold": {
    steps: [{ op: "insert", by: 1, after: "a", char: "X", mode: "plain" }, { op: "add", by: 0, kind: "b", first: "b", last: "c" }],
    model: "aX[b|b][c|b]d", shows: { "name updates": "a[X|b][b|b][c|b]d", "name state": "a[X|b][b|b][c|b]d", "act updates": "a[X|b][b|b][c|b]d", "act state": "a[X|b][b|b][c|b]d" } },
  "plain text typed inside a bold range while its author unformats the range": {
    steps: [{ op: "add", by: 0, kind: "b", first: "b", last: "c" }, { op: "deliver", from: 0, to: 1 }, { op: "insert", by: 1, after: "b", char: "X", mode: "plain" },
      { op: "remove", by: 0, kind: "b", first: "b", last: "c" }],
    model: "abXcd", shows: { "name updates": "abX[c|b][d|b]", "name state": "abX[c|b][d|b]", "act updates": "abX[c|b]d", "act state": "abX[c|b]d" } }
};

for (const [name, literal] of Object.entries(LITERALS)) test(name, () => {
  for (const scheme of SCHEMES) for (const delivery of DELIVERIES) {
    const run = runMarks(literal.steps, 2, scheme, delivery, "abcd");
    assert.deepEqual([run.agree, run.textMatches, run.open], [true, true, 0]);
    assert.equal(run.text, run.expectedText);
    assert.equal(run.model, literal.model);
    assert.equal(run.native, literal.shows[`${scheme} ${delivery}`], `${scheme} keys, delivery by ${delivery}`);
  }
});

for (const scheme of SCHEMES) for (const [writers, delivery] of [[2, "updates"], [2, "shuffled"], [2, "state"], [3, "state"]] as const) {
  test(`generated mark histories, ${scheme} keys, ${writers} writers, delivery by ${delivery}: every copy and a late joiner agree and every reading holds the characters the commands say`, () => {
    const summary = surveyMarks(scheme, writers, delivery, 150, 14), count = (cause: string): number => summary.cases.find(item => item.cause === cause)?.histories ?? 0;
    assert.equal(summary.disagreements, 0);
    assert.equal(summary.textMismatches, 0);
    assert.ok(summary.executed > 1000);
    if (scheme === "act") assert.deepEqual([count("lost-selected"), count("lost-unformat-apart"), count("extra-nowhere")], [0, 0, 0]);
    else assert.ok(count("lost-selected") > 0);
  });
}

// why: negative controls. The text check must fail when the code under test drops, keeps or misplaces a character
const typesX: MarkStep[] = [{ op: "insert", by: 0, after: "b", char: "X", mode: "plain" }, { op: "add", by: 1, kind: "b", first: "c", last: "d" }];
const TAMPERED: Record<string, { steps: MarkStep[]; splice: (real: NativeReplica["splice"]) => NativeReplica["splice"] }> = {
  "a typed character is silently dropped": { steps: typesX,
    splice: real => (beat, field, from, to, insert) => { real(beat, field, from, to, insert.filter(run => run.text !== "X")); } },
  "a typed character lands one place to the left": { steps: typesX,
    splice: real => (beat, field, from, to, insert) => { real(beat, field, insert.length ? from - 1 : from, insert.length ? to - 1 : to, insert); } },
  "a deletion is silently ignored": { steps: [{ op: "delete", by: 0, first: "b", last: "c" }, { op: "add", by: 1, kind: "b", first: "c", last: "d" }],
    splice: real => (beat, field, from, to, insert) => { if (insert.length) real(beat, field, from, to, insert); } }
};

for (const [name, tampered] of Object.entries(TAMPERED)) test(`negative control: the generator's text check fails when ${name}`, () => {
  for (const scheme of SCHEMES) for (const delivery of [...DELIVERIES, "shuffled"] as const) {
    const honest = runMarks(tampered.steps, 2, scheme, delivery, "abcd");
    const run = runMarks(tampered.steps, 2, scheme, delivery, "abcd", copies => { for (const copy of copies) copy.splice = tampered.splice(copy.splice.bind(copy)); });
    assert.deepEqual([honest.textMatches, honest.agree], [true, true]);
    assert.deepEqual([run.textMatches, run.agree], [false, true], `${scheme} keys, delivery by ${delivery}`);
    assert.notEqual(run.text, run.expectedText);
  }
});

test("formatting that stays costs more with one key per act only where acts lie on top of each other", () => {
  const apart = [actCost("name", "apart", 100), actCost("act", "apart", 100)], stacked = [actCost("name", "stacked", 100), actCost("act", "stacked", 100)];
  assert.deepEqual(apart.map(row => row.keysOnBusiestCharacter), [1, 1]);
  assert.deepEqual(stacked.map(row => row.keysOnBusiestCharacter), [1, 100]);
  assert.ok((stacked[1]?.bytes ?? 0) > 50 * (stacked[0]?.bytes ?? 0));
});
