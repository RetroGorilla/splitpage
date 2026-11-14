import { test } from "node:test";
import assert from "node:assert/strict";
import { beatStatusCommand, setBeatFilmedCommand } from "../../../src/application/commands/beat-status.ts";
import { beatLengthCommand } from "../../../src/application/commands/beat-length.ts";
import { targetLengthCommand, wordsPerMinuteCommand } from "../../../src/application/commands/document-settings.ts";
import type { SharedListPorts } from "../../../src/application/commands/shared-list.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { Command, Plan } from "../../../src/application/session/document-session.ts";
import type { StampPorts } from "../../../src/application/session/ports.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { sharedAuthorPort, sharedListPorts } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { bufferStamps } from "../../collab/buffer-readers.ts";
import { agree, replicas } from "./executor-support.ts";

const ORDERS = ["D1", "rev", "dup"] as const;
const at = (second: number): string => "2026-11-13T10:00:0" + second + ".000Z";
const SOURCE = { title: "Title", targetSeconds: 60, wordsPerMinute: 150,
  rows: [{ id: "R1", audioText: "ab", status: "todo", lengthSeconds: 5, updatedAt: at(0), updatedBy: "Ann" }, { id: "R2", audioText: "cd", status: "todo" }] };
const CAN = createSessionCapabilities("shared", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });

interface Shown { status: unknown; lengthSeconds: unknown; updatedAt: unknown; updatedBy: unknown; targetSeconds: unknown; wordsPerMinute: unknown }

function shown(handle: SharedDocumentHandle): Shown {
  const doc = projectSharedDocumentWithRecovery(handle).document, row = doc.rows.find(entry => entry.id === "R1");
  return { status: row?.["status"], lengthSeconds: row?.["lengthSeconds"], updatedAt: row?.["updatedAt"], updatedBy: row?.["updatedBy"],
    targetSeconds: doc["targetSeconds"], wordsPerMinute: doc["wordsPerMinute"] };
}

function planned(handle: SharedDocumentHandle, command: Command): Plan | null {
  const harness = sharedHarness(adapterReplica(handle));
  try {
    const plan = harness.session.read(doc => doc ? command.plan(doc, CAN) : null);
    assert.ok(plan === null || !("refused" in plan));
    return plan;
  } finally { harness.session.dispose(); }
}

const START: Shown = { status: "todo", lengthSeconds: 5, updatedAt: at(0), updatedBy: "Ann", targetSeconds: 60, wordsPerMinute: 150 };
const STAMPED = { updatedAt: at(5), updatedBy: "Alice" };

function ports(handle: SharedDocumentHandle, stamps: StampPorts): SharedListPorts {
  return sharedListPorts(handle, sharedAuthorPort({ handle: () => handle, name: () => stamps.editor.name() }), stamps);
}

interface Builder {
  readonly name: string;
  readonly make: (stamps: StampPorts, shared?: SharedListPorts) => Command;
  readonly kinds: readonly string[];
  readonly after: Partial<Shown>;
}

const BUILDERS: readonly Builder[] = [
  { name: "beatStatusCommand", make: (stamps, shared) => beatStatusCommand("R1", stamps, shared), kinds: ["status", "scalar"], after: { status: "ready", ...STAMPED } },
  { name: "setBeatFilmedCommand", make: (stamps, shared) => setBeatFilmedCommand("R1", true, stamps, shared), kinds: ["status", "scalar"], after: { status: "shot", ...STAMPED } },
  { name: "beatLengthCommand", make: (stamps, shared) => beatLengthCommand("R1", 7, stamps, shared), kinds: ["scalar", "scalar"], after: { lengthSeconds: 7, ...STAMPED } },
  { name: "beatLengthCommand clearing", make: (stamps, shared) => beatLengthCommand("R1", null, stamps, shared), kinds: ["scalar", "scalar"], after: { lengthSeconds: undefined, ...STAMPED } },
  { name: "targetLengthCommand", make: (_stamps, shared) => targetLengthCommand(90, shared), kinds: ["scalar"], after: { targetSeconds: 90 } },
  { name: "targetLengthCommand clearing", make: (_stamps, shared) => targetLengthCommand(null, shared), kinds: ["scalar"], after: { targetSeconds: undefined } },
  { name: "wordsPerMinuteCommand", make: (_stamps, shared) => wordsPerMinuteCommand(180, shared), kinds: ["scalar"], after: { wordsPerMinute: 180 } }
];

for (const builder of BUILDERS) {
  test(`${builder.name} on a shared session sends its shared list and both copies show it`, () => {
    for (const order of ORDERS) {
      const set = replicas(2, SOURCE), stamps = bufferStamps("Alice", () => at(5)), harness = sharedHarness(adapterReplica(set.a));
      try {
        agree("start", order, [set.a, set.b], shown, START);
        assert.equal(harness.session.run(builder.make(stamps, ports(set.a, stamps))).kind, "applied");
        assert.deepEqual(harness.executed.map(entry => entry.operations.map(item => item.kind)), [builder.kinds]);
        set.queue.flush(order);
        agree("after", order, [set.a, set.b], shown, { ...START, ...builder.after });
      } finally { harness.session.dispose(); set.close(); }
    }
  });

  test(`${builder.name} through the undo owner: undo puts the value back and leaves the stamp, redo writes it again`, () => {
    for (const order of ORDERS) {
      const set = replicas(2, SOURCE), stamps = bufferStamps("Alice", () => at(5));
      [set.a, set.b].forEach(registerSharedUndoOperationHandlers);
      try {
        const plan = planned(set.a, builder.make(stamps, ports(set.a, stamps)));
        assert.ok(plan?.shared);
        const operations = plan.shared.operations;
        let count = 0;
        const owner = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
          reverse: record => reverseSharedUndoRecord(set.a, record, { by: "Alice", nextId: () => "u" + ++count }) });
        owner.perform(() => {
          const done = executeSharedCommand(set.a, operations, { label: builder.name, selection: null, typing: null }, { base: readSharedRevision(set.a) });
          assert.deepEqual(done.result, { ok: true });
          return done.record;
        });
        set.queue.flush(order);
        assert.deepEqual(owner.undo(), { ok: true, effective: true, label: builder.name, selection: null });
        set.queue.flush(order);
        const stampKept = "updatedAt" in builder.after ? STAMPED : {};
        agree("undone", order, [set.a, set.b], shown, { ...START, ...stampKept });
        assert.deepEqual(owner.redo(), { ok: true, effective: true, label: builder.name, selection: null });
        set.queue.flush(order);
        agree("redone", order, [set.a, set.b], shown, { ...START, ...builder.after });
      } finally { set.close(); }
    }
  });
}

test("without shared ports each builder plans exactly as before, with no shared list", () => {
  const set = replicas(1, SOURCE), stamps = bufferStamps("Alice", () => at(5));
  try {
    for (const builder of BUILDERS) {
      const plan = planned(set.a, builder.make(stamps));
      assert.ok(plan, builder.name);
      assert.equal("shared" in plan, false, builder.name);
    }
  } finally { set.close(); }
});
