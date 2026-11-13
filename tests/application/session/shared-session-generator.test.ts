import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command } from "../../../src/application/session/document-session.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { collabTextTarget } from "../../../src/adapters/collab/text-target.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { agree, operation, ref } from "../../adapters/collab/executor-support.ts";
import { createMonitoredSharedDocument, deliveryReplica } from "../../adapters/collab/helpers.ts";
import { recordReplicas } from "../../adapters/collab/record-support.ts";
import { writesOutside } from "../session-fakes.ts";
import { namesUnchanged } from "./change-set-checks.ts";
import { adapterReplica, registerSplits, sharedCommand, sharedHarness } from "./shared-session-support.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import type { SharedHarness } from "./shared-session-support.ts";

const DECLARED_LIMITS: readonly { readonly name: string; readonly violation: RegExp }[] = [];

const SOURCE = {
  title: "Title",
  rows: [{ id: "R1", audioText: "abZ", status: "todo" }, { id: "R2", audioText: "cd", status: "todo" }],
  sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }]
};

const KINDS = ["length", "status", "type", "erase", "bold", "split", "heading", "person", "rename", "dismiss", "pace"] as const;

type Bag = Record<string, unknown>;

interface Seat {
  name: string;
  handle: SharedDocumentHandle;
  h: SharedHarness;
  updates: number;
  edits: number;
  checked: number;
}

function snapshot(h: SharedHarness): Bag | null {
  return h.session.read(doc => doc ? JSON.parse(JSON.stringify(doc)) as Bag : null);
}

function seat(name: string, handle: SharedDocumentHandle, violations: string[]): Seat {
  registerSharedTextOperationHandlers(handle);
  registerSplits(handle);
  const made: Seat = { name, handle, h: sharedHarness(adapterReplica(handle)), updates: 0, edits: 0, checked: 0 };
  collabState(handle).doc.on("update", () => { made.updates++; });
  let last = snapshot(made.h);
  made.h.session.subscribe(change => {
    const now = snapshot(made.h), at = `${name} change ${made.h.published.length} (${change.kind})`;
    if (!now) violations.push(`${at}: no document`);
    else if (last && !change.changes.whole) {
      for (const place of writesOutside(last, now, change.changes)) violations.push(`${at}: unreported ${place}`);
      for (const place of namesUnchanged(last, now, change.changes)) violations.push(`${at}: reported unchanged ${place}`);
    } else if (change.kind !== "adopt") violations.push(`${at}: whole document`);
    if (change.kind === "edit") made.edits++;
    if (made.h.undo.length !== made.edits) violations.push(`${at}: undo depth ${made.h.undo.length} after ${made.edits} edits`);
    if (made.h.log.filter(entry => entry.startsWith("save:")).length !== made.edits) violations.push(`${at}: save effects differ from ${made.edits} edits`);
    if (change.generation !== made.edits) violations.push(`${at}: generation ${change.generation} after ${made.edits} edits`);
    last = now;
    made.checked++;
  });
  return made;
}

function narration(row: string) {
  return { segment: ref(`b:${row}`), owner: ref(row), field: "audioText" as const };
}

function build(kind: typeof KINDS[number], who: Seat, id: string, next: (below: number) => number): Command | null {
  const by = who.name, row = next(2) ? "R1" : "R2", handle = who.handle;
  const lengthOf = (target: ReturnType<typeof narration> | { segment: ReturnType<typeof ref>; owner: ReturnType<typeof ref>; field: "heading" }): number =>
    collabTextTarget(handle, target)?.text.toString().length ?? 0;
  const insert = (target: Parameters<typeof lengthOf>[0], text: string): Command | null => {
    const right = createSharedAnchor(handle, target, next(lengthOf(target) + 1), "after");
    return right && sharedCommand(kind, [operation({ kind: "text-insert", id, by, target, at: { left: null, right, affinity: "before" }, content: [{ value: text, marks: [] }] })]);
  };
  const ranged = (make: (target: ReturnType<typeof narration>, observed: string) => unknown): Command | null => {
    const target = narration(row), size = lengthOf(target);
    if (!size) return null;
    const from = next(size), observed = captureSharedTextRange(handle, target, from, from + 1 + next(size - from));
    return observed && sharedCommand(kind, [operation(make(target, observed))]);
  };
  const people = who.h.session.read(doc => doc ? doc.people.map(person => person.id) : []);
  const someone = people[next(people.length || 1)];
  if (kind === "length") return sharedCommand(kind, [operation({ kind: "scalar", id, by, target: { scope: "beat", record: row }, field: "lengthSeconds", value: next(20) })]);
  if (kind === "status") return sharedCommand(kind, [operation({ kind: "status", id, by, target: { scope: "beat", record: row }, value: ["todo", "ready", "shot"][next(3)],
    parents: readSharedStatusHeads(handle, { scope: "beat", record: ref(row) }) })]);
  if (kind === "type") return insert(narration(row), ["x", "y", "z"][next(3)] ?? "x");
  if (kind === "erase") return ranged((target, observed) => ({ kind: "text-delete", id, by, target, observed: [observed] }));
  if (kind === "bold") return ranged((target, observed) => ({ kind: "mark", id, by, target, observed: [observed], mark: { kind: "b", value: true } }));
  if (kind === "split") {
    const target = narration(row), at = 1 + next(lengthOf(target) || 1);
    const right = createSharedAnchor(handle, target, at, "after"), observed = captureSharedTextRange(handle, target, at - 1, at);
    return right && observed && sharedCommand(kind, [operation({ kind: "split", id, by, target, at: { left: null, right, affinity: "before" }, observed: [observed],
      boundary: "same-boundary", beat: "same-beat", fields: { status: "todo" } })]);
  }
  if (kind === "heading") return insert({ segment: ref("h:H1"), owner: ref("H1"), field: "heading" }, "!");
  if (kind === "person") return sharedCommand(kind, [operation({ kind: "record-create", id, by, target: { collection: "people", record: `P${id}` }, fields: { id: `P${id}`, name: `Name ${id}` } })]);
  if (kind === "rename") return someone ? sharedCommand(kind, [operation({ kind: "record-set", id, by, target: { collection: "people", record: someone }, field: "name", value: `Renamed ${id}` })]) : null;
  if (kind === "dismiss") return someone ? sharedCommand(kind, [operation({ kind: "record-delete", id, by, target: { collection: "people", record: someone } })]) : null;
  return sharedCommand(kind, [operation({ kind: "scalar", id, by, target: { scope: "document", record: "d00000000000000000000000000000000" }, field: "wordsPerMinute", value: 100 + next(100) })]);
}

for (const [writers, order] of [[2, "D1"], [2, "rev"], [2, "dup"], [2, "late-C"], [3, "D1"], [3, "rev"], [3, "dup"]] as const) {
  test(`seeded: ${writers} owners, every command kind, ${order} delivery: one precise change per applied transaction, remote changes never undoable`, () => {
    let random = 0x7b1414 + writers;
    const next = (below: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % below; };
    const violations: string[] = [], applied = new Set<string>();
    const run = recordReplicas(writers, SOURCE), late = createMonitoredSharedDocument();
    const seats = [seat("A", run.a, violations), seat("B", run.b, violations), ...(writers === 3 ? [seat("C", run.c, violations)] : [])];
    let joined: Seat | null = null, commands = 0;
    try {
      for (let step = 0; step < 120; step++) {
        const who = seats[next(seats.length)], kind = KINDS[next(KINDS.length)];
        assert.ok(who && kind);
        const command = build(kind, who, `${who.name}${step}`, next);
        if (command) {
          const heard = who.h.published.length, outcome = who.h.session.run(command);
          const told = who.h.published.length - heard;
          if (outcome.kind === "applied") { applied.add(kind); commands++; }
          if (outcome.kind === "failed" || outcome.kind === "committed") violations.push(`${who.name} step ${step} ${kind}: ${outcome.kind}`);
          if (told !== (outcome.kind === "applied" ? 1 : 0)) violations.push(`${who.name} step ${step} ${kind}: ${outcome.kind} published ${told} changes`);
        }
        if (order === "D1" || order === "late-C") run.queue.flush("D1");
        else if (step % 5 === 4) run.queue.flush(order);
        if (order === "late-C" && step === 59) {
          joined = seat("C", late, violations);
          run.queue.lateJoin("C", deliveryReplica(late), "A", encodeSharedState(run.a));
        }
      }
      run.queue.flush(order === "late-C" ? "D1" : order);
      const all = joined ? [...seats, joined] : seats;
      for (const made of all) {
        const held = snapshot(made.h);
        assert.ok(held);
        assert.deepEqual(held, JSON.parse(JSON.stringify(enterSharedDocument(projectSharedDocument(made.handle)))), `${made.name} holds its replica's projection as the entry port returns it`);
        const ids = (held.rows as Bag[]).map(row => row.id);
        assert.equal(ids.length, new Set(ids).size, `${made.name} holds each beat id once`);
        assert.equal(made.h.published.length, made.updates, `${made.name}: one change per applied transaction`);
        assert.equal(made.checked, made.h.published.length);
        assert.deepEqual([made.h.undo.length, made.h.session.generation(), made.h.executed.length >= made.edits], [made.edits, made.edits, true], made.name);
        assert.deepEqual(made.h.reported, []);
      }
      agree("generated shared session projection", order, all.map(made => made.handle), projectSharedDocument);
      assert.deepEqual(violations.filter(violation => !DECLARED_LIMITS.some(limit => limit.violation.test(violation))), []);
      assert.deepEqual(DECLARED_LIMITS.filter(limit => !violations.some(violation => limit.violation.test(violation))).map(limit => limit.name), [], "a declared limit no run reached");
      assert.deepEqual([...applied].sort(), [...KINDS].sort());
      assert.equal(commands, seats.reduce((sum, made) => sum + made.edits, 0));
      assert.ok(commands >= 60, `only ${commands} commands applied`);
      if (joined) assert.deepEqual([joined.edits, joined.h.published[0]?.kind, joined.h.published.length > 1], [0, "adopt", true]);
    } finally {
      for (const made of joined ? [...seats, joined] : seats) made.h.session.dispose();
      run.close();
      destroySharedDocument(late);
    }
  });
}
