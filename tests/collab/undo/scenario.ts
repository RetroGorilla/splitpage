import assert from "node:assert/strict";
import type { SharedContentRef, SharedJsonValue, SharedMarkValue, SharedRecordCollection } from "../../../src/core/collab/operations.ts";
import type { SharedUndoSelection } from "../../../src/core/collab/undo-record.ts";
import type { SharedUndo, SharedUndoOutcome } from "../../../src/application/editing/undo/shared-undo.ts";
import { checkModel } from "../checker.ts";
import type { CollabModel, IdentityBook, ScriptOracle } from "../checker.ts";
import { assertReplicasAgree } from "../agreement.ts";
import type { DeliveryOrder, ReplicaName } from "../delivery.ts";
import type { SeedBeat } from "../oracles/seed-beat.ts";
import { ModelWorld } from "./model-world.ts";
import type { ModelObservation, ModelSnapshot } from "./model-world.ts";
import { AdapterWorld } from "./adapter-world.ts";

export const BOLD: SharedMarkValue = { kind: "b", value: true };
export const UNBOLD: SharedMarkValue = { kind: "b", value: null };
export const TAG_P: SharedMarkValue = { kind: "tag", id: "P" as SharedContentRef, value: "P" as SharedContentRef };

export interface ScenarioCheck { readonly carets?: Readonly<Record<string, SharedUndoSelection>>; readonly status?: boolean }

export interface UndoReplica {
  readonly name: ReplicaName;
  readonly undo: SharedUndo;
  readonly written: { readonly length: number };
  typing: boolean;
  failNextReversal: string | null;
  readonly observe: (beat: string, from: number, to: number) => ModelObservation;
  readonly caretAfter: (character: string) => SharedUndoSelection;
  readonly edit: (input: { readonly at: ModelObservation; readonly remove?: ModelObservation; readonly text?: string; readonly marks?: readonly SharedMarkValue[];
    readonly caret?: ModelObservation; readonly command?: string }) => string[];
  readonly mark: (observed: ModelObservation, mark: SharedMarkValue) => readonly string[];
  readonly length: (beat: string) => number;
  readonly rootOf: (id: string) => string;
  readonly spot: (id: string) => number | undefined;
  readonly knows: (mark: string) => boolean;
  readonly status: (beat: string, value: string) => void;
  readonly scalar: (beat: string, field: string, value: SharedJsonValue | undefined) => void;
  readonly snapshot: () => ModelSnapshot;
  readonly record?: (action: UndoRecordAction, collection: SharedRecordCollection, key: string, value: string) => string | null;
}

export type UndoRecordAction = "create" | "set" | "delete" | "status";

export interface UndoWorld {
  readonly queue: { readonly flush: (order: DeliveryOrder) => void; readonly deliverFrom: (from: ReplicaName, order: DeliveryOrder) => void;
    readonly pending: readonly { readonly id: string; readonly to: ReplicaName }[]; readonly deliver: (id: string, copies?: number) => void };
  readonly beats: readonly string[];
  readonly sync: () => void;
  readonly replicas: ReadonlyMap<ReplicaName, UndoReplica>;
  readonly book: IdentityBook;
  readonly replica: (name: ReplicaName) => UndoReplica;
  readonly join: (name: ReplicaName, source: ReplicaName) => UndoReplica;
  readonly fresh: (source: ReplicaName) => UndoReplica;
  readonly name: (ids: readonly string[], names: readonly string[]) => void;
  readonly model: (replica: UndoReplica, options?: ScenarioCheck) => CollabModel;
}

export interface UndoWorldKind {
  readonly suffix: string;
  readonly make: (seed: readonly SeedBeat[], writers?: readonly ReplicaName[]) => UndoWorld;
}

// why: the same literal cases run on the model executor and on the adapter executor writing a shared document.
export const MODEL_WORLD: UndoWorldKind = { suffix: "", make: (seed, writers) => new ModelWorld(seed, writers) };
export const ADAPTER_WORLD: UndoWorldKind = { suffix: " (shared document)", make: (seed, writers) => new AdapterWorld(seed, writers) };
export const UNDO_WORLDS: readonly UndoWorldKind[] = [MODEL_WORLD, ADAPTER_WORLD];

export class UndoScenario {
  readonly world: UndoWorld;
  readonly order: DeliveryOrder;
  readonly a: UndoReplica;
  readonly b: UndoReplica;
  checks = 0;

  constructor(seed: readonly SeedBeat[], order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD) {
    this.world = kind.make(seed);
    this.order = order;
    this.a = this.world.replica("A");
    this.b = this.world.replica("B");
  }

  deliver(): void {
    this.world.queue.flush(this.order);
    if (this.order === "late-C" && !this.world.replicas.has("C")) this.world.join("C", "A");
  }

  check(phase: string, oracle: ScriptOracle | undefined, options: ScenarioCheck = {}): void {
    assert.ok(oracle, "missing oracle for " + phase);
    this.deliver();
    const names: ReplicaName[] = this.world.replicas.has("C") ? ["A", "B", "C"] : ["A", "B"];
    const readings = names.map(name => ({ order: name === "C" || this.order !== "late-C" ? this.order : "D1" as const, replica: name,
      output: this.world.model(this.world.replica(name), options) }));
    readings.push({ order: "late-C", replica: "C", output: this.world.model(this.world.fresh("A"), options) });
    for (const reading of readings) checkModel(reading.output, oracle, this.world.book, `${phase}/${reading.replica}`);
    assertReplicasAgree(phase, readings);
    this.checks++;
  }

  type(replica: UndoReplica, beat: string, at: number, text: string, names: readonly string[]): void {
    this.world.name(replica.edit({ at: replica.observe(beat, at, at), text }), names);
  }

  erase(replica: UndoReplica, beat: string, from: number, to: number): void {
    replica.edit({ at: replica.observe(beat, from, to) });
  }

  format(replica: UndoReplica, beat: string, from: number, to: number, mark: SharedMarkValue): void {
    replica.mark(replica.observe(beat, from, to), mark);
  }

  effective(outcome: SharedUndoOutcome, expected = true): SharedUndoSelection | null {
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) throw new Error("refused");
    assert.equal(outcome.effective, expected);
    return outcome.selection;
  }

  usedUp(replica: UndoReplica): void {
    const before = replica.undo.sizes(), written = replica.written.length;
    this.effective(replica.undo.undo(), false);
    assert.deepEqual(replica.undo.sizes(), { ...before, undo: before.undo - 1 });
    assert.equal(replica.written.length, written);
  }
}
