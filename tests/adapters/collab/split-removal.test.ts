import test from "node:test";
import assert from "node:assert/strict";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertIncremental, captureIncrementalReplica, identityLetters } from "./incremental-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedJoinHandlers } from "../../../src/adapters/collab/join-executor.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { readSharedTextHistory } from "../../../src/adapters/collab/text-history.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

const runtime = createFlowLoadRuntime();
const hex = (value: string) => value.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const native = (client: number, id: string, role: string) => "structure_" + client + "_" + hex(id) + "_" + role + "_0";
const REMOVAL = native(1, "gone", "removal"), RB = native(2, "cut", "beat"), RC = native(2, "cut2", "beat");
const names = new Map([[RB, "Rb"], [RC, "Rc"]]), shown = (id: string) => names.get(id) ?? id;
const source = { rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] };
const remove = { kind: "remove", id: "gone", by: "Alice", removalKind: "beat", targets: ["R1"], observed: [flowBaseReference("R1", "audioText", 0, 4)],
  boundaries: ["R1"], components: [], gallery: [], at: 1 };
const split = (owner: string, offset: number, beat: string, id = "cut", kind: "split" | "split-before" = "split") => ({ kind, id, by: "Bob",
  target: { owner, segment: owner, field: "audioText" }, at: { left: flowBaseReference(owner, "audioText", offset - 1), right: null, affinity: "after" },
  observed: [], boundary: beat, beat, fields: {} });
const type = (owner: string, offset: number, value: string) => ({ kind: "text-insert", id: "type" + value, by: "Bob", target: { owner, segment: owner, field: "audioText" },
  at: offset ? { left: flowBaseReference(owner, "audioText", offset - 1), right: null, affinity: "after" } : { left: null, right: flowBaseReference(owner, "audioText", 0), affinity: "before" },
  content: [{ value, marks: [] }] });

function send(handle: SharedDocumentHandle, ...ops: unknown[]): void {
  assert.deepEqual(executeSharedOperations(handle, ops.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function setup() {
  const set = replicas(3, source), handles = [set.a, set.b, set.c];
  for (const handle of handles) {
    registerSharedRemovalHandlers(handle); registerSharedSplitHandlers(handle, runtime); registerSharedTextOperationHandlers(handle);
    registerSharedJoinHandlers(handle); registerSharedUndoOperationHandlers(handle);
  }
  return { set, handles };
}
function visible(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle), known = identityLetters(handle);
  return { rows: document.rows.map(row => [shown(row.id), row.audioText]), recovery: recovery.map(entry => {
    assert.ok(entry.kind === "removed-beat");
    return { id: shown(String(entry.row.id)), text: entry.row.audioText, members: entry.members.map(shown), ...entry.splitBy ? { splitBy: entry.splitBy } : {},
      by: entry.removal?.by, ids: entry.removal?.ids, edited: entry.removal?.edited.map(identity => known.get(identity.client + ":" + identity.clock) ?? "?").join("") };
  }) };
}
const entry = (id: string, text: string, options: { edited?: string; splitBy?: string; members?: string[] } = {}) => ({ id, text, members: options.members ?? [id],
  ...options.splitBy ? { splitBy: options.splitBy } : {}, by: "Alice", ids: [REMOVAL], edited: options.edited ?? "" });

for (const order of ["D1", "rev", "dup"] as const) test(`T11 rows: a beat split off a removed beat by a writer who had not seen the removal is removed with it and restored in place: ${order}`, () => {
  const { set, handles } = setup();
  try {
    const { projector } = captureIncrementalReplica(set.c);
    send(set.a, remove); send(set.b, split("R1", 2, "Rb")); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("split removed", order, handles, visible, { rows: [["R0", "x"], ["R2", "ef"]], recovery: [entry("R1", "ab"), entry("Rb", "cd", { splitBy: "Bob" })] });
    send(set.c, { kind: "restore", id: "back", by: "Carol", removals: [REMOVAL] }); set.queue.flush(order); assertIncremental(set.c, projector);
    agree("split restored", order, handles, visible, { rows: [["R0", "x"], ["R1", "ab"], ["Rb", "cd"], ["R2", "ef"]], recovery: [] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a split-before part is removed with its source, whichever side holds the flag: ${order}`, () => {
  const { set, handles } = setup();
  try {
    send(set.a, remove); send(set.b, split("R1", 2, "Rb", "cut", "split-before")); set.queue.flush(order);
    agree("split-before", order, handles, visible, { rows: [["R0", "x"], ["R2", "ef"]], recovery: [entry("Rb", "ab", { splitBy: "Bob" }), entry("R1", "cd")] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a part split off the split-off part, with typing in it, is removed with the source and the typing is edited: ${order}`, () => {
  const { set, handles } = setup();
  try {
    send(set.a, remove); send(set.b, split("R1", 2, "Rb")); send(set.b, split(RB, 1, "Rc", "cut2")); send(set.b, type(RC, 1, "Y"));
    set.queue.flush(order);
    agree("chain", order, handles, visible, { rows: [["R0", "x"], ["R2", "ef"]],
      recovery: [entry("R1", "ab"), entry("Rb", "c", { splitBy: "Bob" }), entry("Rc", "dY", { edited: "Y", splitBy: "Bob" })] });
  } finally { set.close(); }
});

test("assumed rule 44: a beat split off at the end holds nothing the remover observed and stays in the script", () => {
  const { set, handles } = setup();
  try {
    send(set.a, remove); send(set.b, split("R1", 4, "Rb")); send(set.b, type(RB, 0, "Y")); set.queue.flush("dup");
    agree("tail", "dup", handles, visible, { rows: [["R0", "x"], ["Rb", "Y"], ["R2", "ef"]], recovery: [entry("R1", "abcd")] });
  } finally { set.close(); }
});

test("a beat removed with its source refuses typing, a split and a join exactly as its flagged source does, and the refusals change nothing", () => {
  const { set } = setup();
  try {
    send(set.a, remove); send(set.b, split("R1", 2, "Rb")); set.queue.flush("D1");
    const refusal = (op: unknown) => {
      const bytes = encodeSharedState(set.b), vector = encodeSharedStateVector(set.b), revision = readSharedRevision(set.b);
      const result = executeSharedOperations(set.b, [operation(op)], { base: revision }); assert.ok(!result.ok);
      assert.deepEqual([encodeSharedState(set.b), encodeSharedStateVector(set.b), readSharedRevision(set.b)], [bytes, vector, revision]);
      return result.reason;
    };
    const join = (from: string, into: string) => ({ kind: "join", id: "glue", by: "Bob", from, into, glue: " " });
    assert.deepEqual([refusal(type(RB, 1, "Z")), refusal(split(RB, 1, "Rc", "cut2")), refusal(join("R2", RB))],
      [refusal(type("R1", 1, "Z")), refusal(split("R1", 1, "Rc", "cut2")), refusal(join("R2", "R1"))]);
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a removed split-off part joined into a live beat leaves it as a flagged beat would: ${order}`, () => {
  const { set, handles } = setup();
  try {
    send(set.a, remove); send(set.b, split("R1", 2, "Rb", "cut", "split-before")); send(set.b, { kind: "join", id: "glue", by: "Bob", from: RB, into: "R0", glue: " " });
    set.queue.flush(order);
    agree("joined out", order, handles, visible, { rows: [["R0", "x"], ["R2", "ef"]], recovery: [entry("Rb", "ab", { splitBy: "Bob" }), entry("R1", "cd")] });
  } finally { set.close(); }
});

for (const order of ["D1", "rev", "dup"] as const) test(`a live beat joined into a removed split-off part goes to recovery with it as with a flagged beat: ${order}`, () => {
  const { set, handles } = setup();
  try {
    send(set.a, remove); send(set.b, split("R1", 2, "Rb")); send(set.b, { kind: "join", id: "glue", by: "Bob", from: "R2", into: RB, glue: " " });
    set.queue.flush(order);
    agree("joined in", order, handles, visible, { rows: [["R0", "x"]],
      recovery: [entry("R1", "ab"), entry("Rb", "cd ef", { edited: "ef", splitBy: "Bob", members: ["Rb", "R2"] })] });
  } finally { set.close(); }
});

test("seeded splits against a removal of their source, typing and restore agree with a literal model on every copy, a late joiner and the incremental reader", t => {
  let seed = 0x5c3b, histories = 0, checkpoints = 0, before = 0, early = 0;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 16) % n; };
  for (let sample = 0; sample < 12; sample++) for (const order of ["D1", "rev", "dup"] as const) {
    const { set, handles } = setup(), { projector } = captureIncrementalReplica(set.c);
    const at = 1 + random(3), kind = random(2) ? "split-before" as const : "split" as const, spots = [0, 1, 2, 3, 4].filter(spot => spot !== at);
    const typed = spots[random(spots.length)] ?? 0, restoreEarly = random(2) === 0;
    const text = "abcd".slice(0, typed) + "Y" + "abcd".slice(typed), cut = at + (typed < at ? 1 : 0), left = text.slice(0, cut), right = text.slice(cut);
    const parts = kind === "split" ? [["R1", left], ["Rb", right]] : [["Rb", left], ["R1", right]];
    try {
      send(set.a, remove); send(set.b, split("R1", at, "Rb", "cut", kind));
      send(set.c, { ...type("R1", typed, "Y"), by: "Carol" });
      if (restoreEarly) { send(set.a, { kind: "restore", id: "back", by: "Alice", removals: [REMOVAL] }); early++; }
      const check = (removed: boolean) => {
        set.queue.flush(order); assertIncremental(set.c, projector); checkpoints++;
        agree("seed=" + seed, order, handles, visible, removed
          ? { rows: [["R0", "x"], ["R2", "ef"]], recovery: parts.map(([id = "", value = ""]) => entry(id, value, { edited: value.includes("Y") ? "Y" : "", ...id === "Rb" ? { splitBy: "Bob" } : {} })) }
          : { rows: [["R0", "x"], ...parts, ["R2", "ef"]], recovery: [] });
      };
      if (!restoreEarly) { check(true); send(set.b, { kind: "restore", id: "back", by: "Bob", removals: [REMOVAL] }); }
      check(false);
      histories++; if (kind === "split-before") before++;
    } finally { set.close(); }
  }
  assert.deepEqual({ histories, checkpoints, before, early }, { histories: 36, checkpoints: 58, before: 18, early: 14 });
  t.diagnostic(JSON.stringify({ seed: "0x5c3b", histories, checkpoints, before, early }));
});

test("declared limit: characters brought back by undo of a deletion are new, so a part split off holding only them stays in the script", () => {
  const { set, handles } = setup();
  try {
    const text: SharedTextAddress = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" };
    const units = (readSharedTextHistory(set.b, text)?.units ?? []).slice(2, 4).map(unit => unit.identity); assert.equal(units.length, 2);
    const cut = executeSharedCommand(set.b, [operation({ kind: "text-delete", id: "cut", by: "Bob", target: text, observed: units })], { label: "command", selection: null, typing: null });
    assert.ok(cut.record);
    let serial = 0;
    assert.ok(reverseSharedUndoRecord(set.b, cut.record, { by: "Bob", nextId: () => "undo:" + ++serial }).ok);
    send(set.b, split("R1", 2, "Rb")); send(set.a, remove); set.queue.flush("D1");
    agree("undone", "D1", handles, visible, { rows: [["R0", "x"], ["Rb", "cd"], ["R2", "ef"]], recovery: [entry("R1", "ab")] });
  } finally { set.close(); }
});
