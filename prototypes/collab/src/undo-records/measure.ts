import * as Y from "yjs";
import { ReplicaHarness } from "../delivery.ts";
import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { RecordBufferHarness } from "./buffer.ts";
import { addComment, changeStatus, deleteRange, formatRange, insertText, join, moveBeat, removeBeat, setScalar, split, tagRange } from "./commands.ts";
import { CommandHistory, restorationRoot } from "./history.ts";
import type { CommandRecord } from "./history.ts";
import { identityKey } from "./identity.ts";

export interface KindMeasurement {
  kind: string;
  recordBytes: number;
  undoUpdateBytes: number;
  stateGrowthBytes: number;
  durable: Record<string, number>;
}

const durableRoots = ["retiredJoins", "retiredStatus", restorationRoot] as const;

export function recordBytes(record: CommandRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).length;
}

function durableCounts(replica: SchemaReplica): Record<string, number> {
  return Object.fromEntries(durableRoots.map(root => [root, replica.doc.getMap(root).size]));
}

function measureUndo(kind: string, history: CommandHistory): KindMeasurement {
  const replica = history.replica;
  const record = history.undoStack.at(-1);
  if (!record) throw new Error(`${kind} recorded nothing`);
  const before = Y.encodeStateAsUpdate(replica.doc).length;
  const durableBefore = durableCounts(replica);
  let undoUpdateBytes = 0;
  const listener = (update: Uint8Array): void => { undoUpdateBytes += update.length; };
  replica.doc.on("update", listener);
  try {
    if (!history.undo().effective) throw new Error(`${kind} undo changed nothing`);
  } finally {
    replica.doc.off("update", listener);
  }
  const durableAfter = durableCounts(replica);
  const durable = Object.fromEntries(durableRoots.map(root => [root, (durableAfter[root] ?? 0) - (durableBefore[root] ?? 0)]).filter(([, count]) => count !== 0));
  return { kind, recordBytes: recordBytes(record), undoUpdateBytes, stateGrowthBytes: Y.encodeStateAsUpdate(replica.doc).length - before, durable };
}

function measureOne(kind: string, act: (history: CommandHistory, replica: SchemaReplica) => void): KindMeasurement {
  const harness = new ReplicaHarness("B", [{ id: "R1", text: "abcdefghijkl" }, { id: "R2", text: "mn" }, { id: "R3", text: "op" }]);
  try {
    const replica = harness.alice;
    replica.doc.transact(() => {
      mapValue(replica.doc.getMap("beats").get("R2")).set("status", "todo");
      replica.doc.getMap("tags").set("P", { kind: "Prop" });
    }, "fixture");
    const history = new CommandHistory(replica);
    act(history, replica);
    return measureUndo(kind, history);
  } finally {
    harness.destroy();
  }
}

function measureReplacement(): KindMeasurement {
  const harness = new RecordBufferHarness([{ id: "R1", text: "the the" }]);
  try {
    harness.alice.paint("R1", 4, 7);
    harness.alice.dispatch({ type: "beforeinput", from: 4, to: 7, data: "she", names: ["a1", "a2", "a3"] });
    harness.alice.commit(["a1", "a2", "a3"]);
    return measureUndo("replacement, 3 characters for 3", harness.alice.commands);
  } finally {
    harness.destroy();
  }
}

export function measureKinds(): KindMeasurement[] {
  return [
    measureOne("insert, 1 character", history => insertText(history, "R1", 2, "x", ["a1"])),
    measureOne("insert, 10 characters", history => insertText(history, "R1", 2, "xxxxxxxxxx", Array.from({ length: 10 }, (_, index) => `a${index + 1}`))),
    measureOne("range delete, 1 character", history => deleteRange(history, "R1", 2, 3)),
    measureOne("range delete, 10 characters", history => deleteRange(history, "R1", 1, 11)),
    measureReplacement(),
    measureOne("bold, 1 character", history => formatRange(history, "R1", 2, 3, { b: true })),
    measureOne("bold, 10 characters", history => formatRange(history, "R1", 1, 11, { b: true })),
    measureOne("tag, 7 characters", history => { tagRange(history, "R1", 2, 9, "P"); }),
    measureOne("link, 3 characters", history => formatRange(history, "R1", 2, 5, { "l:L1": "http://x" })),
    measureOne("comment, 2 characters", history => addComment(history, "C1", "R1", 2, 2, "Alice")),
    measureOne("split", history => { split(history, "R1", 6, "Ra", "a1"); }),
    measureOne("join", history => join(history, "R2", "R1", "jA")),
    measureOne("soft removal", history => removeBeat(history, "R2", "rA", "Alice")),
    measureOne("whole-segment move", history => { moveBeat(history, "R3", "R1"); }),
    measureOne("status change", history => changeStatus(history, "R2", "sA", "ready", "Alice")),
    measureOne("scalar (LWW) change", history => setScalar(history, "R2", "lengthSeconds", 12))
  ];
}

export interface BoundRun {
  harness: ReplicaHarness;
  history: CommandHistory;
  bobInserts: string[];
  dropInserts: string[];
  droppedLabels: string[];
  droppedBytes: number;
}

export function runBoundHistory(): BoundRun {
  const harness = new ReplicaHarness("B", [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, { id: "R3", text: "ef" }]);
  const { alice: a, queue } = harness;
  a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R2")).set("status", "todo"), "fixture");
  queue.flush("D2");
  const droppedLabels: string[] = [];
  let droppedBytes = 0;
  const history = new CommandHistory(a, { bound: 200, onDrop: record => { droppedLabels.push(record.label); droppedBytes += recordBytes(record); } });
  const bob = new CommandHistory(harness.bob);
  const bobInserts: string[] = [];
  const dropInserts: string[] = [];
  const end = (beat: string): number => a.characters().filter(character => character.beat === beat).length;
  for (let command = 1; command <= 250; command++) {
    if (command <= 50) {
      dropInserts.push(`p${command}`);
      insertText(history, "R1", end("R1"), "a", [`p${command}`]);
    } else if (command === 51) {
      changeStatus(history, "R2", "e51", "ready", "Alice");
    } else {
      const step = (command - 52) % 5;
      const last = end("R3");
      if (step === 0) insertText(history, "R3", last, "x", [`q${command}`]);
      else if (step === 1) formatRange(history, "R3", last - 1, last, { b: true });
      else if (step === 2) tagRange(history, "R3", last - 1, last, "P");
      else if (step === 3) moveBeat(history, "R1", (command - 52) % 10 === 3 ? null : "R2");
      else deleteRange(history, "R3", last - 1, last);
    }
    if (command % 20 === 0) {
      bobInserts.unshift(`r${command}`);
      insertText(bob, "R3", 0, "B", [`r${command}`]);
    }
    queue.flush("D2");
  }
  return { harness, history, bobInserts, dropInserts, droppedLabels, droppedBytes };
}

export interface BoundCounts {
  kept: number;
  dropped: number;
  keptBytes: number;
  droppedBytes: number;
  keptByKind: Record<string, number>;
  referencedIdentities: number;
  referencedStatusEvents: number;
}

export function boundCounts(run: BoundRun): BoundCounts {
  const history = run.history;
  const keptByKind: Record<string, number> = {};
  const identities = new Set<string>();
  const events = new Set<string>();
  for (const record of history.undoStack) {
    keptByKind[record.label] = (keptByKind[record.label] ?? 0) + 1;
    for (const part of record.parts) {
      if (part.kind === "sequence") for (const id of [...part.inserted, ...part.deleted.map(content => content.id)]) identities.add(identityKey(id));
      if (part.kind === "format") for (const id of [part.first, part.last, ...part.prior.map(entry => entry.id)]) identities.add(identityKey(id));
      if (part.kind === "status") events.add(part.event);
    }
  }
  return {
    kept: history.undoStack.length, dropped: history.dropped,
    keptBytes: history.undoStack.reduce((sum, record) => sum + recordBytes(record), 0),
    droppedBytes: run.droppedBytes,
    keptByKind, referencedIdentities: identities.size, referencedStatusEvents: events.size
  };
}
