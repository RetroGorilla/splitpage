import assert from "node:assert/strict";
import { ReplicaHarness } from "../../src/delivery.ts";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { checkModel } from "../../src/model.ts";
import type { CollabModel, ScriptOracle } from "../../src/model.ts";
import type { ReplicaCaretAnchor } from "../../src/reader.ts";
import { mapValue } from "../../src/schema.ts";
import type { SchemaReplica, SeedBeat } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { structuralCaret } from "../../src/structure-selection.ts";
import { addComment, changeStatus, deleteRange, formatRange, insertText, join, removeBeat, split, tagRange } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import type { UndoDefect, UndoOutcome } from "../../src/undo-records/history.ts";
import { chainOracles, doubleDeleteOracles, endpointOracles, heldSelectionOracle, identicalRemovalOracles, identicalTagOracles, insideRangeOracles, joinRedoOracles, laterFormatOracles, longChainOracle, positionControlOracle, redoneAtGapOracle, redoneMarkOracles, redoneRecoveryOracle, redoOracles, rejoinOracles, reRemovalOracles, statusOracles, statusRedoObserved, throwingUndoOracles } from "./oracles.ts";
import { bindRestores, countUpdates } from "./runner.ts";

export type Writer = "Alice" | "Bob";

export interface CaseResult {
  name: string;
  failure: string | null;
  history: string[];
  checks: number;
  observation?: string;
}

export class Scenario {
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

  drainReversed(): void {
    const queue = this.harness.queue;
    for (let round = 0; queue.pending.length > 0; round++) {
      const batch = [...queue.pending];
      if (round === 0) batch.reverse();
      else this.note(`forward ${batch.length} update(s) the receivers wrote while integrating`);
      for (const message of batch) queue.deliver(message.id, 1);
    }
  }

  agree(phase: string): void {
    this.deliver();
    this.note(`compare replicas ${phase}`);
    const models = this.models();
    const full = new Set(models.map(model => JSON.stringify({ rows: model.rows, recovery: model.recovery })));
    if (full.size === 1) return;
    const summary = models.map((model, index) => {
      const rows = model.rows.map(row => `${row.id}[${row.characters.map(character => character.notation).join(" ")}]`).join(" ");
      const recovery = model.recovery.map(entry => `${entry.row.id} by ${entry.by} edited=${JSON.stringify(entry.edited)}${entry.splitBy ? ` splitBy=${entry.splitBy}` : ""}`).join(", ");
      return `client${this.harness.replicas[index]?.doc.clientID ?? -1}: ${rows}; recovery ${recovery || "none"}`;
    });
    throw new Error(`${phase}: replicas differ: ${summary.join(" | ")}`);
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

export function runIdenticalRemovalRedo(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, { id: "R3", text: "ef" }], order, false);
  return scenario.run("identical removal; Bob undoes and redoes", () => {
    insertText(scenario.histories.Alice, "R1", 2, "?", ["a1"]);
    insertText(scenario.histories.Bob, "R3", 2, "!", ["b1"]);
    scenario.harness.queue.flush("D2");
    removeBeat(scenario.histories.Alice, "R2", "rA", "Alice");
    removeBeat(scenario.histories.Bob, "R2", "rB", "Bob");
    const either = (model: CollabModel): void => { for (const entry of model.recovery) entry.by = "<either writer>"; };
    scenario.check("removed", identicalRemovalOracles.removed ?? fail(), either);
    assert.equal(scenario.undo("Bob").effective, true);
    scenario.check("restored", identicalRemovalOracles.restored ?? fail());
    assert.equal(scenario.redo("Bob").effective, true);
    scenario.check("redone", identicalRemovalOracles.removed ?? fail(), either);
    for (const replica of scenario.harness.replicas) {
      assert.deepEqual([...mapValue(mapValue(replica.doc.getMap("beats").get("R2")).get("removals")).keys()].sort(), ["rA", "rB"], "redo restored only its own removal entry");
    }
    return undefined;
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
    scenario.check("redone at the gap", redoneAtGapOracle);
    return `R1 = ${scenario.row("R1")}`;
  });
}

export function runSplitAtEnd(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "abcd" }], order, false);
  return scenario.run("split at the end of a beat, then undo", () => {
    split(scenario.histories.Alice, "R1", 4, "Ra", "a1");
    scenario.check("split at end", endpointOracles["split at end"] ?? fail());
    const undone = scenario.undo("Alice");
    if (!undone.selection) throw new Error("Split undo restored no caret");
    scenario.carets.set("A", undone.selection);
    scenario.check("split at end undone", endpointOracles["split at end undone"] ?? fail());
    return undefined;
  });
}

export function runEmptyBeatInsert(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "" }], order, false);
  return scenario.run("insert into an empty beat, then undo", () => {
    insertText(scenario.histories.Alice, "R2", 0, "x", ["a1"]);
    scenario.check("empty beat typed", endpointOracles["empty beat typed"] ?? fail());
    const undone = scenario.undo("Alice");
    if (!undone.selection) throw new Error("Insert undo restored no caret");
    scenario.carets.set("A", undone.selection);
    scenario.check("empty beat undone", endpointOracles["empty beat undone"] ?? fail());
    return undefined;
  });
}

export function runLongChain(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], order, false);
  return scenario.run("bold one character, delete and undo it 64 times, then undo the bold", () => {
    const alice = scenario.histories.Alice;
    formatRange(alice, "R1", 1, 2, { b: true });
    for (let round = 0; round < 64; round++) {
      deleteRange(alice, "R1", 1, 2);
      assert.equal(scenario.undo("Alice").effective, true, `delete undo ${round + 1} changed nothing`);
    }
    scenario.deliver();
    assert.equal(alice.undoStack.length, 1);
    assert.equal(scenario.undo("Alice").effective, true, "bold undo changed nothing");
    scenario.check("bold undone", longChainOracle);
    return undefined;
  });
}

export function runThrowingUndo(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], "D1", false);
  return scenario.run("an undo whose record cannot be resolved throws and keeps its entry", () => {
    const alice = scenario.histories.Alice;
    insertText(alice, "R1", 2, "x", ["a1"]);
    const missing = { client: 99, clock: 0 };
    alice.undoStack.push({ label: "broken", parts: [{ kind: "format", key: "b", first: missing, last: missing, prior: [] }] });
    assert.throws(() => alice.undo(), /Format span is not in one text/);
    assert.equal(alice.undoStack.length, 2);
    assert.equal(alice.undoStack.at(-1)?.label, "broken");
    scenario.check("after the throw", throwingUndoOracles.thrown ?? fail());
    alice.undoStack.pop();
    assert.equal(scenario.undo("Alice").effective, true);
    scenario.check("insert undone", throwingUndoOracles["insert undone"] ?? fail());
    return undefined;
  });
}

export function runRedoneMarkReversed(mark: "tag" | "comment"): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], "rev", true);
  return scenario.run(`Alice ${mark === "tag" ? "tags" : "comments on"} ab while Bob bolds a; Alice undoes and redoes; her two updates arrive in reverse`, () => {
    const alice = scenario.replicas.Alice;
    alice.doc.transact(() => alice.doc.getMap("tags").set("P", { kind: "Prop" }), "fixture");
    scenario.harness.queue.flush("D2");
    if (mark === "tag") tagRange(scenario.histories.Alice, "R1", 0, 2, "P");
    else addComment(scenario.histories.Alice, "C1", "R1", 0, 2, "Alice");
    formatRange(scenario.histories.Bob, "R1", 0, 1, { b: true });
    scenario.check("marked", redoneMarkOracles[mark] ?? fail());
    assert.equal(scenario.undo("Alice").effective, true);
    assert.equal(scenario.redo("Alice").effective, true);
    scenario.drainReversed();
    scenario.check("redone", redoneMarkOracles[mark] ?? fail());
    return undefined;
  });
}

export function runRemovedAfterInsert(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "a" }, { id: "R2", text: "z" }], "D1", false);
  return scenario.run("Alice inserts x and removes R1; Bob removes R1 without seeing x", () => {
    insertText(scenario.histories.Alice, "R1", 1, "x", ["a1"]);
    removeBeat(scenario.histories.Alice, "R1", "rA", "Alice");
    removeBeat(scenario.histories.Bob, "R1", "rB", "Bob");
    scenario.agree("both removed");
    return undefined;
  });
}

export function runRemovedSplit(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "abcd" }], "D1", false);
  return scenario.run("Alice splits at 2 into Ra; Bob splits at 1 into Rb and removes Rb; then Bob removes Ra", () => {
    split(scenario.histories.Alice, "R1", 2, "Ra", "a1", "Alice");
    split(scenario.histories.Bob, "R1", 1, "Rb", "b1", "Bob");
    removeBeat(scenario.histories.Bob, "Rb", "rB", "Bob");
    scenario.deliver();
    removeBeat(scenario.histories.Bob, "Ra", "rB2", "Bob");
    scenario.agree("Ra removed");
    return undefined;
  });
}

export function runJoinTargetRemoved(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], "D1", false);
  return scenario.run("Alice joins R2 into R1; Bob removes R1", () => {
    join(scenario.histories.Alice, "R2", "R1", "jA");
    scenario.deliver();
    removeBeat(scenario.histories.Bob, "R1", "rB", "Bob");
    scenario.agree("join target removed");
    return undefined;
  });
}

export function recordTiming(): { listenerSaw: number[]; after: number } {
  const harness = new ReplicaHarness("B", [{ id: "R1", text: "ab" }]);
  try {
    const history = new CommandHistory(harness.alice);
    const listenerSaw: number[] = [];
    harness.alice.doc.on("afterTransaction", (transaction: { local: boolean }) => {
      if (transaction.local) listenerSaw.push(history.undoStack.length);
    });
    insertText(history, "R1", 2, "x", ["a1"]);
    return { listenerSaw, after: history.undoStack.length };
  } finally {
    harness.destroy();
  }
}

export function runHeldSelection(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "abcd" }], order, false);
  return scenario.run("a selection held outside the history over bc, after delete and undo of bc", () => {
    const alice = scenario.replicas.Alice;
    const held = { position: structuralCaret(alice, "R1", 1), selectionEnd: structuralCaret(alice, "R1", 3, -1) };
    deleteRange(scenario.histories.Alice, "R1", 1, 3);
    scenario.undo("Alice");
    scenario.deliver();
    scenario.carets.set("held", held);
    const unmapped = scenario.models().map(model => JSON.stringify(model.carets.held ?? null));
    scenario.carets.delete("held");
    scenario.note(`held selection without mapping: ${[...new Set(unmapped)].join(" | ")}`);
    scenario.carets.set("A", scenario.histories.Alice.mapAnchor(held));
    scenario.check("held selection mapped", heldSelectionOracle);
    return [...new Set(unmapped)].join(" | ");
  });
}

export function runRedoneRecovery(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], order, false);
  return scenario.run("Alice's undone and redone insert inside a beat Bob removed", () => {
    insertText(scenario.histories.Alice, "R2", 1, "x", ["a1"]);
    scenario.deliver();
    removeBeat(scenario.histories.Bob, "R2", "rB", "Bob");
    scenario.deliver();
    scenario.undo("Alice");
    scenario.redo("Alice");
    scenario.check("recovery after undo and redo", redoneRecoveryOracle);
    return undefined;
  });
}

export function runJoinRedo(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, { id: "R3", text: "ef" }], order, false);
  return scenario.run("join redo after a concurrent join of the same beat elsewhere", () => {
    join(scenario.histories.Alice, "R3", "R1", "j");
    join(scenario.histories.Bob, "R3", "R2", "jB");
    scenario.check("joined", joinRedoOracles["into R1"] ?? fail());
    assert.equal(scenario.undo("Alice").effective, true);
    scenario.check("Alice's join undone", joinRedoOracles["into R2"] ?? fail());
    assert.equal(scenario.redo("Alice").effective, true);
    scenario.check("Alice's join redone", joinRedoOracles["into R1"] ?? fail());
    return undefined;
  });
}

export function runLaterFormat(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "abcd" }], order, false);
  return scenario.run("Alice bolds ab; Bob unbolds then bolds bc; Alice undoes", () => {
    formatRange(scenario.histories.Alice, "R1", 0, 2, { b: true });
    scenario.deliver();
    const bob = scenario.replicas.Bob;
    bob.doc.transact(() => {
      const { text, start } = bob.locate("R1");
      text.format(start + 1, 2, { b: null });
    }, bob.localOrigin);
    formatRange(scenario.histories.Bob, "R1", 1, 3, { b: true });
    scenario.check("Bob bolded", laterFormatOracles["Bob bolded"] ?? fail());
    assert.equal(scenario.undo("Alice").effective, true);
    scenario.check("Alice undone", laterFormatOracles["Alice undone"] ?? fail());
    return undefined;
  });
}

export function runStatusRedo(order: DeliveryOrder): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], order, false);
  return scenario.run("concurrent statuses converge; Alice undoes and redoes hers", () => {
    scenario.replicas.Alice.doc.transact(() => mapValue(scenario.replicas.Alice.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
    scenario.harness.queue.flush("D2");
    changeStatus(scenario.histories.Alice, "R1", "sA", "ready", "Alice");
    changeStatus(scenario.histories.Bob, "R1", "sB", "shot", "Bob");
    scenario.check("concurrent", statusRedoObserved.todo ?? fail());
    const undone = scenario.undo("Alice");
    scenario.check("Alice undone", statusRedoObserved.todo ?? fail());
    const redone = scenario.redo("Alice");
    scenario.check("Alice redone", statusRedoObserved.ready ?? fail());
    return `undo effective=${String(undone.effective)}, redo effective=${String(redone.effective)}`;
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
