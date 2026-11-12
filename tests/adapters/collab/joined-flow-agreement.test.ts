import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation } from "./executor-support.ts";
import { validatedFixture } from "./helpers.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { startBeat, typeWithMarks, replaceRange, beatPos, joinWithPrevious, setMarkAcross } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";
import { explode } from "../../../src/core/text/edits.ts";
import { captureIncrementalReplica, assertIncremental, incrementalReports } from "./incremental-support.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";

test("seeded joined rows agree with app typing and Enter after joins and splits made apart", t => {
  const declaredLimits: readonly string[] = [], violations: string[] = [], runtime = createFlowLoadRuntime();
  let seed = 0x5c3601, histories = 0, commands = 0, operations = 0, checkpoints = 0, late = 0;
  const reports = incrementalReports.compared;
  const choose = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % n; };
  for (let sample = 0; sample < 12; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const source = validatedFixture({ rows: [
      { id: "R1", audioText: "abcd", visualText: "<b>Left</b>", status: ["todo", "ready", "shot"][choose(3)], lengthSeconds: 7,
        imageRef: { sha256: "1".repeat(64) }, imageName: "first" },
      { id: "R2", audioText: "ef", visualText: "<em>Right</em>", status: ["todo", "ready", "shot"][choose(3)], lengthSeconds: 19,
        imageRef: { sha256: "2".repeat(64) }, imageName: "second" }, { id: "R3", audioText: "gh" }
    ], sections: [{ id: "H1", name: "Before", firstSceneId: "R1" }, { id: "H2", name: "After", firstSceneId: "R3" }] });
    const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies);
    const incremental = handles.map(handle => captureIncrementalReplica(handle));
    const stops: (() => void)[] = [];
    const check = () => {
      checkpoints++;
      handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
      agree("seeded checkpoint", order, [set.a], handle => projectSharedDocumentWithRecovery(handle)); late++;
    };
    try {
      handles.forEach((handle, index) => {
        registerSharedJoinHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle);
        const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector);
        stops.push(value.projector.observe(() => assertIncremental(handle, value.projector)));
      });
      assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " })]), { ok: true }); commands++; operations++; check();
      for (const handle of handles.slice(1)) {
        const offset = choose(5), prefix = !!choose(2);
        assert.deepEqual(executeSharedOperations(handle, [operation({ kind: prefix ? "split-before" : "split", id: "apart", by: "Writer",
          target: { owner: "R1", segment: "R1", field: "audioText" }, at: { left: null, right: flowBaseReference("R1", "audioText", offset), affinity: "before" },
          observed: [flowBaseReference("R1", "audioText", 0, 4)], beat: "apart_beat", boundary: "apart_beat", fields: {} })], { base: readSharedRevision(handle) }), { ok: true });
        commands++; operations++; check();
      }
      set.queue.flush(order); check();
      agree("joined model text order", order, handles, handle => {
        const result = projectSharedDocumentWithRecovery(handle);
        if (result.document.rows.map(row => row.audioText).join("").replaceAll(" ", "") !== "abcdefgh") violations.push("reading-order");
        if (result.recovery.length) violations.push("unexpected-recovery");
        if (result.document.rows.find(row => row.id === "R1")?.visualText !== "<strong>Left</strong><br><em>Right</em>") violations.push("retained-fields");
        return result;
      }); late++;
      let editedOwner: string | null = null;
      for (const kind of ["type", "enter"] as const) {
        const current = projectSharedDocumentWithRecovery(set.b).document, doc: FlowDoc = { rows: current.rows, sections: current.sections, comments: [] };
        const row = current.rows.find(row => editedOwner ? row.id === editedOwner : row.audioText?.includes(" ef")); assert.ok(row && typeof row.audioText === "string"); editedOwner = row.id;
        const offset = kind === "type" ? row.audioText.indexOf(" ef") + 2 : Math.max(0, row.audioText.length - 1);
        const ports = { ...runtime.ports, newId: () => "structure_2_0065006e007400650072005f006f005f0030_beat_0", operations: { id: "enter", by: "Bob" } };
        const result = kind === "enter" ? startBeat(doc, beatPos(row.id, offset), ports)
          : sample % 2 ? replaceRange(doc, { anchor: beatPos(row.id, Math.max(0, offset - 2)), head: beatPos(row.id, offset) }, [{ text: "X", marks: {} }], ports)
          : typeWithMarks(doc, beatPos(row.id, offset), "X", {}, ports);
        assert.ok(result && "rows" in result && result.ops, JSON.stringify({ sample, copies, order, kind, row, offset, result }));
        const expected = applyFlowOperations(doc, result.ops, runtime.cells);
        assert.deepEqual(expected.rows, result.rows); assert.deepEqual(expected.sections, result.sections);
        assert.deepEqual(executeSharedOperations(set.b, result.ops, { base: readSharedRevision(set.b) }), { ok: true }); commands++; operations += result.ops.length;
        set.queue.flush(order); check();
        const loaded = runtime.load({ ...current, rows: expected.rows, sections: expected.sections });
        agree("app rows and headings after joined " + kind, order, handles, handle => {
          const result = projectSharedDocumentWithRecovery(handle), actual = runtime.load(result.document);
          assert.deepEqual(actual.rows, loaded.rows); assert.deepEqual(actual.sections, loaded.sections); assert.deepEqual(result.recovery, []);
          for (const value of actual.rows) assert.equal(readSharedPaintedText(handle, { owner: value.id, segment: value.id, field: "audioText" } as Parameters<typeof readSharedPaintedText>[1])?.text, value.audioText);
          return { rows: actual.rows, sections: actual.sections };
        }); late++;
      }
      histories++;
    } finally { stops.forEach(stop => stop()); incremental.forEach(value => value.projector.dispose()); set.close(); }
  }
  assert.deepEqual(violations, declaredLimits);
  const measured = { seed: 0x5c3601, histories, commands, operations, checkpoints, late, reports: incrementalReports.compared - reports, skipped: 0, deferred: 0, declaredLimits };
  assert.deepEqual(measured, { seed: 6043137, histories: 72, commands: 324, operations: 360, checkpoints: 396, late: 612, reports: 828, skipped: 0, deferred: 0, declaredLimits: [] });
  t.diagnostic(JSON.stringify(measured));
});

for (const order of ["D1", "rev", "dup"] as const) test("seen destination split retains complete app fields and headings: " + order, () => {
  const runtime = createFlowLoadRuntime(), source = validatedFixture({ rows: [
    { id: "R1", audioText: "ab", visualText: "<b>Left</b>", status: "todo", lengthSeconds: 7, imageRef: { sha256: "1".repeat(64) }, imageName: "first" },
    { id: "R2", audioText: "cd", visualText: "<em>Right</em>", status: "ready", lengthSeconds: 19, imageRef: { sha256: "2".repeat(64) }, imageName: "second" },
    { id: "R3", audioText: "end" }
  ], sections: [{ id: "H1", name: "Before", firstSceneId: "R1" }, { id: "H2", name: "After", firstSceneId: "R3" }] });
  const set = replicas(3, source), handles = [set.a, set.b, set.c];
  try {
    handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedSplitHandlers(handle, runtime); });
    const joined = joinWithPrevious({ rows: source.rows, sections: source.sections, comments: [] }, "R2", { ...runtime.ports, operations: { id: "join", by: "Alice" } });
    assert.ok(joined && "rows" in joined && joined.ops);
    assert.deepEqual(executeSharedOperations(set.a, joined.ops), { ok: true }); set.queue.flush(order);
    const doc = { rows: joined.rows, sections: joined.sections, comments: [] };
    const result = startBeat(doc, beatPos("R1", 1), { ...runtime.ports, newId: () => "structure_2_0065006e007400650072005f006f005f0030_beat_0", operations: { id: "enter", by: "Bob" } });
    assert.ok(result && "rows" in result && result.ops);
    const independent = applyFlowOperations(doc, result.ops, runtime.cells); assert.deepEqual(independent.rows, result.rows); assert.deepEqual(independent.sections, result.sections);
    assert.deepEqual(executeSharedOperations(set.b, result.ops, { base: readSharedRevision(set.b) }), { ok: true }); set.queue.flush(order);
    const expected = runtime.load({ ...source, rows: independent.rows, sections: independent.sections });
    agree("seen split full fields", order, handles, handle => {
      const actual = runtime.load(projectSharedDocumentWithRecovery(handle).document);
      assert.deepEqual(actual.rows, expected.rows); assert.deepEqual(actual.sections, expected.sections);
      return { rows: actual.rows, sections: actual.sections };
    });
  } finally { set.close(); }
});

test("seeded joined rows agree with app formatting across the join point while another writer types", t => {
  const declaredLimits = ["separator-keeps-no-inline-format"], violations = new Set<string>(), runtime = createFlowLoadRuntime();
  let seed = 0x5c3603, histories = 0, commands = 0, compared = 0, covering = 0;
  const choose = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % n; };
  const plain = (html: string) => html.replace(/<[^>]*>/g, "");
  for (let sample = 0; sample < 4; sample++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const source = validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }, { id: "R3", audioText: "gh" }] });
    const set = replicas(copies, source), handles = [set.a, set.b, set.c].slice(0, copies), incremental = handles.map(handle => captureIncrementalReplica(handle));
    const check = () => handles.forEach((handle, index) => { const value = incremental[index]; assert.ok(value); assertIncremental(handle, value.projector); });
    const ports = (id: string, by: string) => ({ ...runtime.ports, operations: { id, by } });
    try {
      handles.forEach(handle => { registerSharedJoinHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle); });
      assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "join", id: "join", by: "Alice", from: "R2", into: "R1", glue: " " })]), { ok: true }); commands++;
      if (copies === 3) {
        assert.deepEqual(executeSharedOperations(set.c, [operation({ kind: "split", id: "apart", by: "Carol", target: { owner: "R1", segment: "R1", field: "audioText" },
          at: { left: null, right: flowBaseReference("R1", "audioText", choose(4)), affinity: "before" }, observed: [], beat: "apart_beat", boundary: "apart_beat", fields: {} })],
          { base: readSharedRevision(set.c) }), { ok: true }); commands++;
      }
      set.queue.flush(order); check();
      const current = (handle = set.b) => { const document = projectSharedDocumentWithRecovery(handle).document; return { document, doc: { rows: document.rows, sections: document.sections, comments: [] } as FlowDoc }; };
      const owner = current().document.rows.find(row => row.audioText?.includes(" ef"))?.id; assert.ok(owner);
      const text = () => plain(current().document.rows.find(row => row.id === owner)?.audioText ?? "");
      const mark = choose(2) ? "i" as const : "b" as const, from = choose(text().length), to = from + 1 + choose(text().length - from);
      const marked = setMarkAcross(current().doc, { anchor: beatPos(owner, from), head: beatPos(owner, to) }, mark, ports("mark", "Bob"));
      const typedAt = choose(text().length + 1), typed = typeWithMarks(current(set.a).doc, beatPos(owner, typedAt), "X", {}, ports("typed", "Alice"));
      assert.ok(marked && "rows" in marked && marked.ops && typed && "rows" in typed && typed.ops);
      assert.deepEqual(executeSharedOperations(set.b, marked.ops, { base: readSharedRevision(set.b) }), { ok: true });
      assert.deepEqual(executeSharedOperations(set.a, typed.ops, { base: readSharedRevision(set.a) }), { ok: true }); commands += 2;
      check(); set.queue.flush(order); check();
      agree("concurrent joined mark and typing", order, handles, handle => {
        const result = projectSharedDocumentWithRecovery(handle);
        if (result.document.rows.map(row => plain(row.audioText ?? "")).join("").replaceAll(" ", "").replace("X", "") !== "abcdefgh") violations.add("reading-order");
        if (result.recovery.length) violations.add("unexpected-recovery");
        return result;
      });
      for (const step of ["again", "toggle"] as const) {
        const { document, doc } = current(), length = text().length, start = choose(length), end = start + 1 + choose(length - start);
        const result = setMarkAcross(doc, { anchor: beatPos(owner, start), head: beatPos(owner, end) }, mark, ports(step, "Bob"));
        assert.ok(result && "rows" in result && result.ops);
        const expected = applyFlowOperations(doc, result.ops, runtime.cells); assert.deepEqual(expected.rows, result.rows);
        assert.deepEqual(executeSharedOperations(set.b, result.ops, { base: readSharedRevision(set.b) }), { ok: true }); commands++;
        set.queue.flush(order); check();
        const separator = text().indexOf(" "), loaded = runtime.load({ ...document, rows: expected.rows, sections: expected.sections });
        if (separator >= start && separator < end) covering++;
        agree("app formatting on a joined row " + step, order, handles, handle => {
          const actual = runtime.load(projectSharedDocumentWithRecovery(handle).document);
          if (JSON.stringify(actual.rows) !== JSON.stringify(loaded.rows)) {
            const apart = (rows: typeof actual.rows) => rows.map(row => ({ ...row,
              audioText: explode(runtime.cells(row.audioText ?? "")).map((char, index) => row.id === owner && index === separator ? null : char) }));
            violations.add(separator >= start && separator < end && JSON.stringify(apart(actual.rows)) === JSON.stringify(apart(loaded.rows)) ? "separator-keeps-no-inline-format" : "app-formatting");
          }
          return actual.rows;
        }); compared++;
      }
      histories++;
    } finally { incremental.forEach(value => value.projector.dispose()); set.close(); }
  }
  assert.deepEqual([...violations], declaredLimits);
  const measured = { seed: 0x5c3603, histories, commands, compared, covering, declaredLimits };
  assert.deepEqual(measured, { seed: 6043139, histories: 24, commands: 132, compared: 48, covering: 18, declaredLimits: ["separator-keeps-no-inline-format"] });
  t.diagnostic(JSON.stringify(measured));
});
