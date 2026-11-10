import * as Y from "yjs";
import { ReplicaHarness } from "../../src/delivery.ts";
import { changeStatus, statusValue, undoStatus } from "../../src/marks/commands.ts";
import { mapValue } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { structureManager } from "../../src/structure.ts";

export interface LibraryProbe {
  limit: string;
  observed: string;
}

function row(harness: ReplicaHarness): string {
  const rows = harness.replicas.map(replica => readStructure(replica.doc, "B", harness.identities).rows.map(entry => entry.characters.map(character => character.value).join("")).join("/"));
  return [...new Set(rows)].join(" | ");
}

function marks(harness: ReplicaHarness): string {
  const rows = harness.replicas.map(replica => readStructure(replica.doc, "B", harness.identities).rows.map(entry => entry.characters.map(character => `${character.value}${Object.keys(character.marks).length ? `{${Object.keys(character.marks).sort().join(",")}}` : ""}`).join("")).join("/"));
  return [...new Set(rows)].join(" | ");
}

export function probeDoubleRestore(): string {
  return [false, true].map(swapped => {
    const harness = new ReplicaHarness("B", [{ id: "R1", text: "abcd" }], swapped);
    const ua = structureManager(harness.alice);
    const ub = structureManager(harness.bob);
    try {
      harness.alice.deleteIdentities(["s3"]);
      harness.bob.deleteIdentities(["s3"]);
      harness.queue.flush("D1");
      ua.undo();
      ub.undo();
      harness.queue.flush("D1");
      return row(harness);
    } finally {
      ua.destroy();
      ub.destroy();
      harness.destroy();
    }
  }).join("; ");
}

export function probeSequentialStatus(): string {
  return (["library undo", "main's undoStatus"] as const).map(route => {
    const harness = new ReplicaHarness("B", [{ id: "R1", text: "ab" }]);
    const a = harness.alice;
    const manager = structureManager(a);
    try {
      a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
      changeStatus(a, manager, "R1", "sA1", "ready", "Alice");
      changeStatus(a, manager, "R1", "sA2", "shot", "Alice");
      const seen = [statusValue(a, "R1")];
      for (let step = 0; step < 2; step++) {
        if (route === "library undo") manager.undo();
        else undoStatus(a, manager);
        seen.push(statusValue(a, "R1"));
      }
      return `${route}: ${seen.join(" → ")}`;
    } finally {
      manager.destroy();
      harness.destroy();
    }
  }).join("; ");
}

export function probeLaterFormat(): string {
  const harness = new ReplicaHarness("B", [{ id: "R1", text: "abcd" }]);
  const ua = structureManager(harness.alice);
  try {
    harness.alice.format("R1", 0, 2, { b: true });
    harness.queue.flush("D1");
    const bob = harness.bob.locate("R1");
    harness.bob.doc.transact(() => bob.text.format(bob.start + 1, 2, { b: null }), harness.bob.localOrigin);
    harness.bob.format("R1", 1, 2, { b: true });
    harness.queue.flush("D1");
    ua.undo();
    harness.queue.flush("D1");
    return marks(harness);
  } finally {
    ua.destroy();
    harness.destroy();
  }
}

export function probeRedoneRecovery(): string {
  const harness = new ReplicaHarness("B", [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]);
  const ua = structureManager(harness.alice);
  try {
    harness.alice.insert("R2", 1, "x", ["a1"]);
    harness.queue.flush("D1");
    harness.bob.remove("R2", "rB", "Bob");
    harness.queue.flush("D1");
    ua.undo();
    ua.redo();
    harness.queue.flush("D1");
    const edited = harness.replicas.map(replica => JSON.stringify(readStructure(replica.doc, "B", harness.identities).recovery.map(entry => entry.edited.length)));
    return `edited characters per recovery entry: ${[...new Set(edited)].join(" | ")}`;
  } finally {
    ua.destroy();
    harness.destroy();
  }
}

function drainReversed(harness: ReplicaHarness): void {
  for (let round = 0; harness.queue.pending.length > 0; round++) {
    const batch = [...harness.queue.pending];
    if (round === 0) batch.reverse();
    for (const message of batch) harness.queue.deliver(message.id, 1);
  }
}

export function probeRedoneMark(): string {
  return (["library undo and redo", "plain remove then add, no undo"] as const).flatMap(route => [false, true].map(swapped => {
    const harness = new ReplicaHarness("B", [{ id: "R1", text: "ab" }], swapped);
    const { alice: a, bob: b } = harness;
    const located = a.locate("R1");
    const manager = new Y.UndoManager(located.text, { trackedOrigins: new Set([a.localOrigin]), captureTimeout: 0 });
    try {
      a.doc.transact(() => located.text.format(located.start, 2, { "c:C1": true }), a.localOrigin);
      manager.stopCapturing();
      b.format("R1", 0, 1, { b: true });
      harness.queue.flush("rev");
      if (route === "library undo and redo") {
        manager.undo();
        manager.redo();
      } else {
        a.doc.transact(() => located.text.format(located.start, 2, { "c:C1": null }), a.localOrigin);
        a.doc.transact(() => located.text.format(located.start, 2, { "c:C1": true }), a.localOrigin);
      }
      drainReversed(harness);
      return `${route}${swapped ? ", swapped ids" : ""}: ${marks(harness)}`;
    } finally {
      manager.destroy();
      harness.destroy();
    }
  })).join("; ");
}

export function libraryProbes(): Record<string, string> {
  return {
    "double restore": probeDoubleRestore(),
    "sequential status": probeSequentialStatus(),
    "later format": probeLaterFormat(),
    "redone recovery": probeRedoneRecovery(),
    "redone mark, reversed delivery": probeRedoneMark()
  };
}
