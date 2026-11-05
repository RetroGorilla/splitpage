import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backspaceAt,
  beatPos,
  caretAt,
  deleteForwardAt,
  enterAt,
  flowOf,
  headingPos,
  joinWithPrevious,
  replaceRange
} from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowRow } from "../../../src/core/flow/flow.ts";

function makePorts(): FlowPorts {
  let made = 0;
  return {
    cells: html => (html ? [{ text: html, marks: {} }] : []),
    newId: () => "new" + String(++made),
    hasVisual: row => !!row.visualText
  };
}

const beat = (id: string, audioText = "", extra: Partial<FlowRow> = {}): FlowRow => ({ id, audioText, visualText: "", ...extra });

const script = (rows: readonly FlowRow[], sections?: unknown): FlowDoc => ({ rows, sections, comments: [] });

const SCENES = [{ id: "s1", name: "Opening", firstSceneId: "a" }, { id: "s2", name: "Middle", firstSceneId: "c" }];

function edited(outcome: FlowOutcome): FlowEdit {
  assert.ok(outcome && "rows" in outcome, "expected an edit, got " + JSON.stringify(outcome));
  return outcome;
}

const ids = (edit: FlowEdit): string[] => edit.rows.map(row => row.id);
const words = (edit: FlowEdit): (string | null | undefined)[] => edit.rows.map(row => row.audioText);
const flagged = (edit: FlowEdit): string[] => edit.rows.filter(row => row.paragraphStart).map(row => row.id);

function layout(doc: FlowDoc): string[] {
  return flowOf(doc).map(block => block.kind === "heading" ? "#" + block.scene.name : block.beats.map(row => row.id).join(","));
}

test("a script with no flags reads as one paragraph per scene", () => {
  const doc = script([beat("a"), beat("b"), beat("c"), beat("d")], SCENES);
  assert.deepEqual(layout(doc), ["#Opening", "a,b", "#Middle", "c,d"]);
});

test("a flag starts a paragraph, and the first beat of a script needs none", () => {
  const doc = script([beat("a"), beat("b", "", { paragraphStart: true }), beat("c")]);
  assert.deepEqual(layout(doc), ["a", "b,c"]);
});

test("Enter at the end of a beat makes a new beat in the same paragraph", () => {
  const edit = edited(enterAt(script([beat("a", "One."), beat("b", "Two.")]), caretAt(beatPos("a", 4)), makePorts()));
  assert.deepEqual(ids(edit), ["a", "new1", "b"]);
  assert.deepEqual(flagged(edit), []);
  assert.deepEqual(edit.selection.head, beatPos("new1", 0));
});

test("Enter inside a beat splits it and keeps both halves in the paragraph", () => {
  const edit = edited(enterAt(script([beat("a", "One two")]), caretAt(beatPos("a", 3)), makePorts()));
  assert.deepEqual(words(edit), ["One", " two"]);
  assert.deepEqual(flagged(edit), []);
});

test("Enter twice between two beats starts a paragraph and leaves no empty beat", () => {
  const ports = makePorts();
  const first = edited(enterAt(script([beat("a", "One."), beat("b", "Two.")]), caretAt(beatPos("a", 4)), ports));
  const second = edited(enterAt(script(first.rows), first.selection, ports));
  assert.deepEqual(ids(second), ["a", "b"]);
  assert.deepEqual(flagged(second), ["b"]);
  assert.deepEqual(second.selection.head, beatPos("b", 0));
});

test("Enter twice at the end of the script leaves a blank beat that starts a paragraph", () => {
  const ports = makePorts();
  const first = edited(enterAt(script([beat("a", "One.")]), caretAt(beatPos("a", 4)), ports));
  const second = edited(enterAt(script(first.rows), first.selection, ports));
  assert.deepEqual(ids(second), ["a", "new1"]);
  assert.deepEqual(flagged(second), ["new1"]);
  assert.equal(enterAt(script(second.rows), second.selection, ports), null);
});

test("Enter at the start of a run-on beat starts a paragraph there", () => {
  const edit = edited(enterAt(script([beat("a", "One."), beat("b", "Two.")]), caretAt(beatPos("b", 0)), makePorts()));
  assert.deepEqual(ids(edit), ["a", "b"]);
  assert.deepEqual(flagged(edit), ["b"]);
});

test("Enter on a visual with no narration adds a beat after it", () => {
  const doc = script([beat("a", "", { visualText: "Street b-roll" })]);
  const edit = edited(enterAt(doc, caretAt(beatPos("a", 0)), makePorts()));
  assert.deepEqual(ids(edit), ["a", "new1"]);
});

test("Backspace at a tick deletes a character and keeps both beats", () => {
  const edit = edited(backspaceAt(script([beat("a", "One."), beat("b", "Two.")]), beatPos("b", 0), makePorts(), { tick: "delete" }));
  assert.deepEqual(words(edit), ["One", "Two."]);
  assert.deepEqual(edit.selection.head, beatPos("a", 3));
});

test("Backspace at a tick joins instead when asked to", () => {
  const edit = edited(backspaceAt(script([beat("a", "One."), beat("b", "Two.")]), beatPos("b", 0), makePorts(), { tick: "join" }));
  assert.deepEqual(words(edit), ["One. Two."]);
  assert.deepEqual(edit.selection.head, beatPos("a", 5));
});

test("Joining two beats with visuals combines them and says so", () => {
  const doc = script([beat("a", "One.", { visualText: "Desk" }), beat("b", "Two.", { visualText: "Street" })]);
  const edit = edited(joinWithPrevious(doc, "b", makePorts()));
  assert.deepEqual(ids(edit), ["a"]);
  assert.equal(edit.rows[0]?.visualText, "Desk<br>Street");
  assert.equal(edit.notice, "Joined the beats and kept both visuals.");
});

test("Joining keeps the more finished status", () => {
  const doc = script([beat("a", "One.", { status: "todo" }), beat("b", "Two.", { status: "shot" })]);
  assert.equal(edited(joinWithPrevious(doc, "b", makePorts())).rows[0]?.status, "shot");
});

test("A beat can't join across a scene header", () => {
  const doc = script([beat("a", "One."), beat("b", "Two."), beat("c", "Three.")], SCENES);
  assert.deepEqual(joinWithPrevious(doc, "c", makePorts()), { refused: "A beat can't join across a scene header." });
});

test("Backspace at the start of a paragraph only removes the paragraph break", () => {
  const edit = edited(backspaceAt(script([beat("a", "One."), beat("b", "Two.", { paragraphStart: true })]), beatPos("b", 0), makePorts(), { tick: "delete" }));
  assert.deepEqual(words(edit), ["One.", "Two."]);
  assert.deepEqual(flagged(edit), []);
  assert.deepEqual(edit.selection.head, beatPos("b", 0));
});

test("Backspace on a blank beat removes it, and its paragraph break passes to the next beat", () => {
  const doc = script([beat("a", "One."), beat("n", "", { paragraphStart: true }), beat("b", "Two.")]);
  const edit = edited(backspaceAt(doc, beatPos("n", 0), makePorts(), { tick: "delete" }));
  assert.deepEqual(ids(edit), ["a", "b"]);
  assert.deepEqual(flagged(edit), ["b"]);
  assert.deepEqual(edit.selection.head, beatPos("a", 4));
});

test("Backspace at the first beat of a scene moves into the heading and deletes nothing", () => {
  const doc = script([beat("a", "One."), beat("b", "Two."), beat("c", "Three.")], SCENES);
  assert.deepEqual(backspaceAt(doc, beatPos("c", 0), makePorts(), { tick: "delete" }), { move: headingPos("s2", 6) });
});

test("Backspace at the very start of a script with no scenes does nothing", () => {
  assert.equal(backspaceAt(script([beat("a", "One.")]), beatPos("a", 0), makePorts(), { tick: "delete" }), null);
});

test("Backspace after a visual with no narration lands on it and keeps the visual", () => {
  const doc = script([beat("a", "", { visualText: "Street b-roll" }), beat("b", "Two.")]);
  assert.deepEqual(backspaceAt(doc, beatPos("b", 0), makePorts(), { tick: "delete" }), { move: beatPos("a", 0) });
});

test("Delete at the end of a paragraph only removes the break after it", () => {
  const edit = edited(deleteForwardAt(script([beat("a", "One."), beat("b", "Two.", { paragraphStart: true })]), beatPos("a", 4), makePorts()));
  assert.deepEqual(words(edit), ["One.", "Two."]);
  assert.deepEqual(flagged(edit), []);
});

test("Deleting across beats removes the whole beats between and keeps the outer words", () => {
  const doc = script([beat("a", "Alpha"), beat("b", "Bravo"), beat("c", "Charlie")]);
  const edit = edited(replaceRange(doc, { anchor: beatPos("c", 3), head: beatPos("a", 2) }, [], makePorts()));
  assert.deepEqual(ids(edit), ["a", "c"]);
  assert.deepEqual(words(edit), ["Al", "rlie"]);
});
