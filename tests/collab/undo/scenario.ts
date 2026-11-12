import assert from "node:assert/strict";
import type { SharedContentRef, SharedMarkValue } from "../../../src/core/collab/operations.ts";
import type { SharedUndoSelection } from "../../../src/core/collab/undo-record.ts";
import type { SharedUndoOutcome } from "../../../src/application/editing/undo/shared-undo.ts";
import { checkModel } from "../checker.ts";
import type { ScriptOracle } from "../checker.ts";
import { assertReplicasAgree } from "../agreement.ts";
import type { DeliveryOrder, ReplicaName } from "../delivery.ts";
import type { SeedBeat } from "../oracles/seed-beat.ts";
import { ModelWorld } from "./model-world.ts";
import type { ModelReplica } from "./model-world.ts";

export const BOLD: SharedMarkValue = { kind: "b", value: true };
export const UNBOLD: SharedMarkValue = { kind: "b", value: null };
export const TAG_P: SharedMarkValue = { kind: "tag", id: "P" as SharedContentRef, value: "P" as SharedContentRef };

export interface ScenarioCheck { readonly carets?: Readonly<Record<string, SharedUndoSelection>>; readonly status?: boolean }

export class UndoScenario {
  readonly world: ModelWorld;
  readonly order: DeliveryOrder;
  readonly a: ModelReplica;
  readonly b: ModelReplica;
  checks = 0;

  constructor(seed: readonly SeedBeat[], order: DeliveryOrder) {
    this.world = new ModelWorld(seed);
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

  type(replica: ModelReplica, beat: string, at: number, text: string, names: readonly string[]): void {
    this.world.name(replica.edit({ at: replica.observe(beat, at, at), text }), names);
  }

  erase(replica: ModelReplica, beat: string, from: number, to: number): void {
    replica.edit({ at: replica.observe(beat, from, to) });
  }

  format(replica: ModelReplica, beat: string, from: number, to: number, mark: SharedMarkValue): void {
    replica.mark(replica.observe(beat, from, to), mark);
  }

  effective(outcome: SharedUndoOutcome, expected = true): SharedUndoSelection | null {
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) throw new Error("refused");
    assert.equal(outcome.effective, expected);
    return outcome.selection;
  }

  usedUp(replica: ModelReplica): void {
    const before = replica.undo.sizes(), written = replica.written.length;
    this.effective(replica.undo.undo(), false);
    assert.deepEqual(replica.undo.sizes(), { ...before, undo: before.undo - 1 });
    assert.equal(replica.written.length, written);
  }
}
