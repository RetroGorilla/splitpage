import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCommand } from "../../src/application/commands/flow.ts";
import { beatPos } from "../../src/core/flow/flow.ts";
import { pasteFlowRange } from "../../src/core/flow/flow.ts";
import type { FlowPorts, FlowSelectionPair } from "../../src/core/flow/flow.ts";
import { migratedThenSet } from "../core/migrate-ports.ts";
import { harness, runConfined } from "./session-fakes.ts";

for (const backward of [false, true]) {
  test(`flow paste declares metadata writes and rolls them back with its rows (${backward})`, () => {
    let fail = false;
    const selections: (FlowSelectionPair | undefined)[] = [];
    const h = harness(undefined, { entry: () => migratedThenSet({ rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo" }] }),
      reconcile: () => { if (fail) throw new Error("anchor failure"); return 0; }, record: selection => { selections.push(selection); } });
    h.session.adopt({});
    const source = migratedThenSet({ rows: [{ id: "pasted", audioText: "Pasted", status: "shot" }],
      comments: [{ id: "c", rowId: "pasted", field: "audioText", body: "Thread" }], people: [{ id: "p", name: "Crew" }],
      productionTags: [{ cat: "prop", name: "Camera", owner: "p", notes: "Keep details", status: "have" }],
      brollShots: [{ id: "shot", name: "Dawn", owner: "p", notes: "Keep take", status: "shot" }] });
    const ports: FlowPorts = { cells: html => html ? [{ text: html, marks: {} }] : [], newId: () => "new", hasVisual: () => false };
    const a = beatPos("a", 2), b = beatPos("b", 2);
    const range = backward ? { anchor: b, head: a } : { anchor: a, head: b };
    const command = flowCommand("paste", doc => {
      const pasted = pasteFlowRange(doc, range, { text: "Pasted", rows: source.rows, headers: [], wholeIds: ["pasted"] }, ports);
      assert.ok(pasted && "rows" in pasted);
      return { ...pasted, clipboard: { comments: source.comments, people: source.people, productionTags: source.productionTags, brollShots: source.brollShots } };
    }, { clock: { nowIso: () => "2026-11-05T12:00:00Z" }, editor: { name: () => "Editor" } }, range);
    const before = JSON.stringify(h.session.held());
    fail = true;
    assert.equal(h.session.run(command).kind, "failed");
    assert.equal(JSON.stringify(h.session.held()), before);
    assert.equal(selections.length, 0);
    fail = false;
    assert.equal(runConfined(h.session, command).kind, "applied");
    assert.deepEqual(h.session.held()?.rows.map(row => row.audioText), ["Al", "Pasted", "avo"]);
    assert.equal(h.session.held()?.comments[0]?.body, "Thread");
    assert.equal(h.session.held()?.people[0]?.name, "Crew");
    assert.equal(h.session.held()?.productionTags[0]?.notes, "Keep details");
    assert.equal(h.session.held()?.brollShots[0]?.notes, "Keep take");
    assert.equal(selections.length, 1);
    assert.deepEqual(selections[0]?.before, range);
    h.session.dispose();
  });
}
