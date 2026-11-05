import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCommand } from "../../src/application/commands/flow.ts";
import { beatPos, caretAt, joinWithPrevious, renameHeading, replaceRange } from "../../src/core/flow/flow.ts";
import type { FlowPorts } from "../../src/core/flow/flow.ts";
import { migratedThenSet } from "../core/migrate-ports.ts";
import { harness, runConfined } from "./session-fakes.ts";

const ports: FlowPorts = { cells: text => text ? [{ text, marks: {} }] : [], newId: () => "new", hasVisual: row => !!row.visualText };
const stamps = { clock: { nowIso: () => "2026-11-04T12:00:00.000Z" }, editor: { name: () => "Editor" } };
const original = { rows: [{ id: "a", audioText: "Alpha", visualText: "" }, { id: "b", audioText: "Bravo", visualText: "" }],
  sections: [{ id: "s", name: "Scene", firstSceneId: "b" }], comments: [{ id: "c", rowId: "b", field: "audioText", body: "Keep" }] };

test("flow operations plan against the current document and publish one command including comments", () => {
  const h = harness(undefined, { entry: () => migratedThenSet(original) });
  h.session.adopt({});
  const command = flowCommand("flow-replace", current => replaceRange(current, caretAt(beatPos("a", 0)), [{ text: "Q", marks: {} }], ports), stamps);
  assert.equal(runConfined(h.session, command).kind, "applied");
  assert.equal(runConfined(h.session, command).kind, "applied");
  assert.equal(h.session.held()?.rows[0]?.audioText, "QQAlpha");
  assert.equal(h.session.generation(), 2);
  assert.equal(h.log.filter(entry => entry === "undo.record").length, 2);
  assert.ok(h.published.filter(change => change.kind === "edit").every(change => change.changes.docFields.includes("comments")));
  h.session.dispose();
});

test("refused flow commands leave content, generation, undo and effects untouched", () => {
  const h = harness(undefined, { entry: () => migratedThenSet(original) });
  h.session.adopt({});
  h.log.length = 0;
  const before = JSON.stringify(h.session.held());
  const join = flowCommand("flow-join", current => joinWithPrevious(current, "b", ports), stamps);
  const heading = flowCommand("flow-heading", current => renameHeading(current, "s", "x".repeat(201), 0), stamps);
  assert.equal(runConfined(h.session, join).kind, "rejected");
  assert.equal(runConfined(h.session, heading).kind, "rejected");
  assert.equal(JSON.stringify(h.session.held()), before);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, []);
  h.session.dispose();
});

test("a failed flow timestamp rolls back rows, sections and comment deletion", () => {
  const h = harness(undefined, { entry: () => migratedThenSet(original) });
  h.session.adopt({});
  const before = JSON.stringify(h.session.held());
  const command = flowCommand("flow-delete", current => replaceRange(current,
    { anchor: beatPos("a", 0), head: beatPos("b", 5) }, [{ text: "Q", marks: {} }], ports),
  { ...stamps, clock: { nowIso: () => { throw new Error("clock stopped"); } } });
  assert.equal(runConfined(h.session, command).kind, "failed");
  assert.equal(JSON.stringify(h.session.held()), before);
  assert.equal(h.session.generation(), 0);
  h.session.dispose();
});
