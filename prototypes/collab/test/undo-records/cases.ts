import assert from "node:assert/strict";
import { ReplicaHarness } from "../../src/delivery.ts";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { checkModel } from "../../src/model.ts";
import type { CollabModel, ScriptOracle } from "../../src/model.ts";
import type { ReplicaCaretAnchor } from "../../src/reader.ts";
import { mapValue } from "../../src/schema.ts";
import type { SchemaReplica, SeedBeat } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { changeStatus, deleteRange, formatRange, insertText, join, removeBeat, tagRange } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import type { UndoDefect, UndoOutcome } from "../../src/undo-records/history.ts";
import { chainOracles, doubleDeleteOracles, identicalRemovalOracles, identicalTagOracles, insideRangeOracles, positionControlOracle, redoOracles, rejoinOracles, reRemovalOracles, statusOracles } from "./oracles.ts";
import { bindRestores, countUpdates } from "./runner.ts";

export type Writer = "Alice" | "Bob";

export interface CaseResult {
  name: string;
  failure: string | null;
  history: string[];
  checks: number;
  observation?: string;
}

class Scenario {
  readonly harness: ReplicaHarness;
  readonly histories: Record<Writer, CommandHistory>;
  readonly replicas: Record<Writer, SchemaReplica>;
  readonly carets = new Map<string, ReplicaCaretAnchor>();
  readonly order: DeliveryOrder;
  checks = 0;

  constructor(seed: readonly SeedBeat[], order: DeliveryOrder, swapped: boolean, defect?: UndoDefect) {
    this.harness = new ReplicaHarness("B", seed, swapped);
    this.order = order;
    this.replicas = { Alice: this.harness.alice, Bob: this.harness.bob };
    const options = defect ? { defect } : {};
    this.histories = { Alice: new CommandHistory(this.harness.alice, options), Bob: new CommandHistory(this.harness.bob, options) };
    this.harness.queue.history.push(`fixture B ${JSON.stringify(seed)}, order ${order}${swapped ? ", swapped client ids" : ""}${defect ? `, defect ${defect}` : ""}`);
  }

  note(line: string): void {
    this.harness.queue.history.push(line);
  }

  deliver(): void {
    this.harness.queue.flush(this.order);
    if (this.order === "late-C" && this.harness.replicas.length === 2) this.harness.lateJoin(this.harness.bob);
  }

  models(): CollabModel[] {
    return this.harness.replicas.map(replica => readStructure(replica.doc, "B", this.harness.identities, this.carets));
  }

  check(phase: string, oracle: ScriptOracle, normalize?: (model: CollabModel, replica: number) => void): void {
    this.deliver();
    this.note(`check ${phase}`);
    this.models().forEach((model, index) => {
      normalize?.(model, this.harness.replicas[index]?.doc.clientID ?? -1);
      checkModel(model, oracle, this.harness.identities, `${phase}/client${this.harness.replicas[index]?.doc.clientID ?? -1}`);
      this.checks++;
    });
  }

  undo(writer: Writer): UndoOutcome {
    const outcome = this.histories[writer].undo();
    this.note(`${writer} undo ${outcome.label ?? "none"} effective=${String(outcome.effective)} consumed=${outcome.consumed}`);
    bindRestores(this.harness, outcome);
    return outcome;
  }

  redo(writer: Writer): UndoOutcome {
    const outcome = this.histories[writer].redo();
    this.note(`${writer} redo ${outcome.label ?? "none"} effective=${String(outcome.effective)}`);
    bindRestores(this.harness, outcome);
    return outcome;
  }

  consumed(writer: Writer): void {
    const { outcome, updates } = countUpdates(this.replicas[writer], () => this.undo(writer));
    assert.ok(!outcome.effective && outcome.consumed === 1 && updates === 0, `${writer}'s consumed identical undo reached an older step or wrote state (effective=${String(outcome.effective)}, consumed=${outcome.consumed}, updates=${updates})`);
  }

  row(beat: string): string {
    const rows = this.models().map(model => model.rows.find(row => row.id === beat)?.characters.map(character => character.notation).join(" ") ?? "<absent>");
    return [...new Set(rows)].join(" | ");
  }

  run(name: string, body: () => string | undefined): CaseResult {
    try {
      const observation = body();
      return { name, failure: null, history: [...this.harness.queue.history], checks: this.checks, ...(observation ? { observation } : {}) };
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      return { name, failure, history: [...this.harness.queue.history, `FAIL ${failure}`], checks: this.checks };
    } finally {
      this.harness.destroy();
    }
  }
}

function other(writer: Writer): Writer {
  return writer === "Alice" ? "Bob" : "Alice";
}

export function runIdenticalRemoval(order: DeliveryOrder, swapped: boolean, first: Writer, defect?: UndoDefect): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, { id: "R3", text: "ef" }], order, swapped, defect);
  const named = new Set<string>();
  return scenario.run(`identical removal, ${first} undoes first`, () => {
    insertText(scenario.histories.Alice, "R1", 2, "?", ["a1"]);
    insertText(scenario.histories.Bob, "R3", 2, "!", ["b1"]);
    scenario.harness.queue.flush("D2");
    removeBeat(scenario.histories.Alice, "R2", "rA", "Alice");
    removeBeat(scenario.histories.Bob, "R2", "rB", "Bob");
    scenario.check("removed", identicalRemovalOracles.removed ?? fail(), (model, client) => {
      for (const entry of model.recovery) {
        assert.ok(entry.by === "Alice" || entry.by === "Bob", `unexpected remover ${entry.by}`);
        named.add(`client${client}: ${entry.by}`);
        entry.by = "<either writer>";
      }
    });
    scenario.note(`recovery names ${[...named].join(", ")}`);
    assert.equal(scenario.undo(first).effective, true);
    scenario.check("restored", identicalRemovalOracles.restored ?? fail());
    scenario.consumed(other(first));
    scenario.check("other undo consumed", identicalRemovalOracles.restored ?? fail());
    assert.equal(scenario.undo(other(first)).effective, true);
    scenario.check(`${other(first)} older undone`, identicalRemovalOracles[`${other(first)} older undone`] ?? fail());
    return [...named].join(", ");
  });
}

export function runIdenticalTag(order: DeliveryOrder, swapped: boolean, first: Writer, defect?: UndoDefect, perWriterKeys = false): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "the red mug" }, { id: "R2", text: "ok" }], order, swapped, defect);
  return scenario.run(`identical tag, ${first} undoes first${perWriterKeys ? ", per-writer occurrence keys" : ""}`, () => {
    scenario.replicas.Alice.doc.transact(() => scenario.replicas.Alice.doc.getMap("tags").set("P", { kind: "Prop" }), "fixture");
    insertText(scenario.histories.Alice, "R2", 2, "?", ["a1"]);
    insertText(scenario.histories.Bob, "R2", 0, "!", ["b1"]);
    scenario.harness.queue.flush("D2");
    const keys = [tagRange(scenario.histories.Alice, "R1", 4, 11, "P", perWriterKeys ? "oA" : undefined), tagRange(scenario.histories.Bob, "R1", 4, 11, "P", perWriterKeys ? "oB" : undefined)];
    scenario.note(`tag occurrence keys ${keys.join(", ")}`);
    scenario.check("tagged", identicalTagOracles.tagged ?? fail());
    assert.equal(scenario.undo(first).effective, true);
    scenario.check("untagged", identicalTagOracles.untagged ?? fail());
    scenario.consumed(other(first));
    scenario.check("other undo consumed", identicalTagOracles.untagged ?? fail());
    assert.equal(scenario.undo(other(first)).effective, true);
    scenario.check(`${other(first)} older undone`, identicalTagOracles[`${other(first)} older undone`] ?? fail());
    return undefined;
  });
}

export function runRejoin(order: DeliveryOrder, defect?: UndoDefect): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], order, false, defect);
  return scenario.run("intentional rejoin after both joins were retired", () => {
    join(scenario.histories.Alice, "R2", "R1", "jA");
    join(scenario.histories.Bob, "R2", "R1", "jB");
    scenario.check("both joined", rejoinOracles.joined ?? fail());
    assert.equal(scenario.undo("Alice").effective, true);
    scenario.check("both retired", rejoinOracles.separate ?? fail());
    join(scenario.histories.Alice, "R2", "R1", "jA2");
    scenario.check("Alice rejoined", rejoinOracles.joined ?? fail());
    scenario.consumed("Bob");
    scenario.check("Bob's stale join undo consumed", rejoinOracles.joined ?? fail());
    assert.equal(scenario.undo("Alice").effective, true);
    scenario.check("rejoin undone", rejoinOracles.separate ?? fail());
    return undefined;
  });
}

export function runReRemoval(order: DeliveryOrder, defect?: UndoDefect): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, { id: "R3", text: "ef" }], order, false, defect);
  return scenario.run("intentional re-removal after both removals were undone", () => {
    removeBeat(scenario.histories.Alice, "R2", "rA", "Alice");
    removeBeat(scenario.histories.Bob, "R2", "rB", "Bob");
    scenario.check("both removed", reRemovalOracles.removed ?? fail(), model => {
      for (const entry of model.recovery) entry.by = entry.by === "Alice" || entry.by === "Bob" ? "<either writer>" : entry.by;
    });
    assert.equal(scenario.undo("Alice").effective, true);
    scenario.check("both undone", reRemovalOracles.restored ?? fail());
    removeBeat(scenario.histories.Alice, "R2", "rA2", "Alice");
    scenario.check("Alice removed again", reRemovalOracles["removed by Alice"] ?? fail());
    scenario.consumed("Bob");
    scenario.check("Bob's stale removal undo consumed", reRemovalOracles["removed by Alice"] ?? fail());
    assert.equal(scenario.undo("Alice").effective, true);
    scenario.check("re-removal undone", reRemovalOracles.restored ?? fail());
    return undefined;
  });
}

export function runInsideRange(order: DeliveryOrder, defect?: UndoDefect): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], order, false, defect);
  return scenario.run("undo after the other writer typed inside the undone insertion", () => {
    insertText(scenario.histories.Alice, "R1", 2, "xyz", ["a1", "a2", "a3"]);
    scenario.deliver();
    insertText(scenario.histories.Bob, "R1", 3, "Q", ["b1"]);
    scenario.check("typed", insideRangeOracles.typed ?? fail());
    const outcome = scenario.undo("Alice");
    if (!outcome.selection) throw new Error("Insert undo restored no caret");
    scenario.carets.set("A", outcome.selection);
    scenario.check("undone", insideRangeOracles.undone ?? fail());
    return undefined;
  });
}

export function runDoubleDelete(order: DeliveryOrder, first: Writer, concurrent: boolean, defect?: UndoDefect): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "abcd" }], order, false, defect);
  return scenario.run(`delete also made by the other writer, ${first} undoes first${concurrent ? ", undos concurrent" : ""}`, () => {
    deleteRange(scenario.histories.Alice, "R1", 1, 3);
    deleteRange(scenario.histories.Bob, "R1", 2, 3);
    scenario.check("deleted", doubleDeleteOracles.deleted ?? fail());
    assert.equal(scenario.undo(first).effective, true);
    if (!concurrent) scenario.deliver();
    const intermediate = concurrent ? "not delivered" : scenario.row("R1");
    scenario.note(`after ${first}'s undo R1 = ${intermediate}`);
    const second = scenario.undo(other(first));
    scenario.note(`${other(first)}'s undo effective=${String(second.effective)}`);
    scenario.check("both undone", doubleDeleteOracles["both undone"] ?? fail());
    return `after ${first}'s undo: ${intermediate}; ${other(first)}'s undo effective=${String(second.effective)}`;
  });
}

export function runRedoAfterRemote(order: DeliveryOrder, sameGap: boolean): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], order, false);
  return scenario.run(`redo after undo with a remote insertion ${sameGap ? "at the undone gap" : "elsewhere"}`, () => {
    insertText(scenario.histories.Alice, "R1", 2, "xy", ["a1", "a2"]);
    scenario.check("typed", redoOracles.typed ?? fail());
    assert.equal(scenario.undo("Alice").effective, true);
    scenario.check("undone", redoOracles.undone ?? fail());
    insertText(scenario.histories.Bob, sameGap ? "R1" : "R2", sameGap ? 2 : 1, "Z", ["b1"]);
    if (!sameGap) scenario.check("remote elsewhere", redoOracles["remote elsewhere"] ?? fail());
    assert.equal(scenario.redo("Alice").effective, true);
    if (!sameGap) {
      scenario.check("redone", redoOracles.redone ?? fail());
      return undefined;
    }
    scenario.deliver();
    const rows = scenario.models().map(model => JSON.stringify(model.rows.map(row => [row.id, row.characters.map(character => character.notation)])));
    assert.equal(new Set(rows).size, 1, "replicas disagree after redo");
    const r1 = scenario.row("R1");
    assert.deepEqual(r1.split(" ").sort(), ["a1*", "a2*", "b1", "s1", "s2"]);
    return `R1 = ${r1}`;
  });
}

export function runRestoredChain(order: DeliveryOrder, defect?: UndoDefect): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], order, false, defect);
  return scenario.run("insert, bold and delete one character; three undos and three redos", () => {
    insertText(scenario.histories.Bob, "R1", 0, "Q", ["b1"]);
    scenario.deliver();
    const alice = scenario.histories.Alice;
    insertText(alice, "R1", 3, "x", ["a1"]);
    formatRange(alice, "R1", 3, 4, { b: true });
    deleteRange(alice, "R1", 3, 4);
    scenario.check("commands", chainOracles.commands ?? fail());
    for (const phase of ["delete undone", "format undone", "insert undone"]) {
      assert.equal(scenario.undo("Alice").effective, true, `${phase} changed nothing`);
      scenario.check(phase, chainOracles[phase] ?? fail());
    }
    for (const phase of ["insert redone", "format redone", "delete redone"]) {
      assert.equal(scenario.redo("Alice").effective, true, `${phase} changed nothing`);
      scenario.check(phase, chainOracles[phase] ?? fail());
    }
    return undefined;
  });
}

export function runSequentialStatus(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], order, false);
  return scenario.run("one writer changes a status twice, then undoes both", () => {
    scenario.replicas.Alice.doc.transact(() => mapValue(scenario.replicas.Alice.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
    scenario.harness.queue.flush("D2");
    changeStatus(scenario.histories.Alice, "R1", "sA1", "ready", "Alice");
    changeStatus(scenario.histories.Alice, "R1", "sA2", "shot", "Alice");
    scenario.check("shot", statusOracles.shot ?? fail());
    scenario.undo("Alice");
    scenario.check("first undo", statusOracles.ready ?? fail());
    const second = scenario.undo("Alice");
    scenario.note(`second undo effective=${String(second.effective)}`);
    scenario.check("second undo", statusOracles.todo ?? fail());
    return undefined;
  });
}

export function runPositionControl(defect?: UndoDefect): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], "D1", false, defect);
  return scenario.run("undo after a remote insertion before the undone text", () => {
    insertText(scenario.histories.Alice, "R1", 2, "xy", ["a1", "a2"]);
    insertText(scenario.histories.Bob, "R1", 0, "Q", ["b1"]);
    scenario.deliver();
    scenario.undo("Alice");
    scenario.check("undone", positionControlOracle);
    return undefined;
  });
}

function fail(): never {
  throw new Error("Missing literal oracle");
}
