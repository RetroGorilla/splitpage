import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { splitCaretPage } from "../../features/editing/split-caret-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument, applySharedUpdate, encodeSharedState, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { readSharedPaintedSelectionText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { projection } from "../../../src/core/text/runs.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";

test("caret visual readings use the existing record validator and wire rank order on the writer and encoded late joiner", () => {
  const cases = [
    { rank: "b", other: "a", beat: "R1", text: "tail\nWord" },
    { rank: "a", other: "b", beat: "R1", text: "Word\ntail" },
    { rank: "\ud800", other: "\ufffd", beat: "R1", text: "tail\nWord" },
    { rank: "\udfff", other: "z", beat: "R1", text: "tail\nWord" },
    { rank: "a", other: 17, beat: "R1", text: "Word" },
    { rank: "a", other: "b", beat: ["R1"], text: "Word" },
    { rank: "a", other: "b", beat: "missing", text: "Word" }
  ];
  let seed = 0x89f01;
  const visited = new Set<number>();
  for (let round = 0; round < 32; round++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const index = (seed >>> 8) % cases.length, scenario = cases[index]; assert.ok(scenario); visited.add(index);
    const p = splitCaretPage("Word"), late = createMonitoredSharedDocument();
    try {
      transactSharedDocument(p.h.a, "record-fixture", () => {
        const visuals = collabState(p.h.a).roots.visuals, first = visuals.get("R1"); assert.ok(first instanceof Y.Map);
        first.set("rank", scenario.rank);
        const second = new Y.Map<unknown>(); visuals.set("AA", second);
        second.set("beat", scenario.beat); second.set("rank", scenario.other); second.set("text", new Y.Text("tail")); second.set("markRecords", new Y.Map());
      });
      p.h.queue.flush("dup"); assert.equal(applySharedUpdate(late, encodeSharedState(p.h.a)).ok, true);
      let identity: readonly (string | null)[] | null = null;
      for (const handle of [p.h.a, p.h.b, late]) {
        const read = readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, p.key("visualText")));
        assert.equal(read?.text, scenario.text); assert.ok(read);
        assert.equal(projection(fromHtml(projectSharedDocumentWithRecovery(handle).document.rows[0]?.visualText ?? "", { media: true })), scenario.text);
        const actual = Array.from({ length: read.text.length }, (_, at) => read.identity(at));
        if (identity) assert.deepEqual(actual, identity); else identity = actual;
      }
      assert.deepEqual([p.a.executed, p.reports], [[], []]);
    } finally { destroySharedDocument(late); p.close(); }
  }
  assert.deepEqual([...visited].sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test("caret readings use the wire text form for a malformed unit without writing into the shared text", () => {
  const p = splitCaretPage("Word"), late = createMonitoredSharedDocument();
  try {
    transactSharedDocument(p.h.a, "text-fixture", () => {
      const visual = collabState(p.h.a).roots.visuals.get("R1"); assert.ok(visual instanceof Y.Map);
      const text = visual.get("text"); assert.ok(text instanceof Y.Text); text.insert(0, "\ud800");
    });
    assert.equal(applySharedUpdate(late, encodeSharedState(p.h.a)).ok, true);
    for (const handle of [p.h.a, late]) assert.equal(readSharedPaintedSelectionText(handle, sharedBufferedTarget(handle, p.key("visualText")))?.text, "\ufffdWord");
    assert.deepEqual([p.a.executed, p.reports], [[], []]);
  } finally { destroySharedDocument(late); p.close(); }
});
