import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { setNativeCommentBody } from "../../../../src/adapters/collab/native/comment-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import { clearNativeField, setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { edit } from "./helpers.ts";
import type { Delivery } from "./helpers.ts";
import {
  AUTHOR, COMMENT, REPLY, beatField, beatStep, checkRecordStep, fileKey, freshRecordRead, fullUpdate, headingStep, recordCopies,
  recordRead, recordSnapshot, recordUndo, replyId, threadSteps, unchangedRecord
} from "./record-harness.ts";
import type { RecordStep } from "./record-harness.ts";
import { caret, split } from "./structure-harness.ts";

const SEEDS = 24;
const WRITTEN = { kind: "written" };
type Write = "set" | "delete";
interface CapturedWrite {
  readonly state: Uint8Array;
  readonly step: RecordStep;
  readonly slot: number;
  readonly method: Write;
  readonly key: string;
}

function interceptWrites(onWrite: (slot: number, method: Write, key: string) => boolean, run: () => void): void {
  const { set, delete: remove } = Y.Map.prototype;
  let slot = 0;
  Y.Map.prototype.set = function <T>(this: Y.Map<T>, key: string, value: T): T {
    return onWrite(slot++, "set", key) ? value : set.call(this, key, value) as T;
  };
  Y.Map.prototype.delete = function (this: Y.Map<unknown>, key: string): void {
    if (!onWrite(slot++, "delete", key)) remove.call(this, key);
  };
  try { run(); } finally {
    Y.Map.prototype.set = set;
    Y.Map.prototype.delete = remove;
  }
}

function shuffled<T>(values: readonly T[], next: () => number): T[] {
  const pool = [...values], result: T[] = [];
  while (pool.length) result.push(...pool.splice(next() % pool.length, 1));
  return result;
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 8;
  };
}

function bodyStep(which: "comment" | "reply", body: string): RecordStep {
  const target = which === "comment" ? COMMENT : REPLY;
  return {
    name: "concurrent " + which + " body",
    run: script => setNativeCommentBody(script, target, AUTHOR, body),
    expect(snapshot, read) {
      const parent = read.document.comments.find(comment => comment.id === COMMENT.comment);
      const reply = which === "reply", entry = reply ? parent?.replies?.find(record => record.id === REPLY.reply) : parent;
      const stored = reply ? snapshot.replies?.[replyId(REPLY.comment, REPLY.reply)] : snapshot.comments?.[COMMENT.comment];
      assert.ok(entry && stored);
      entry.body = body;
      (stored as Record<string, unknown>)[fileKey("body")] = JSON.stringify(body);
    }
  };
}

function history(seed: number, writes?: CapturedWrite[]): Record<string, number> {
  const next = random(seed), { scripts, net } = recordCopies(shuffled([4, 9, 15], next));
  const counts: Record<string, number> = {};
  const count = (kind: string): void => { counts[kind] = (counts[kind] ?? 0) + 1; };
  const run = (actor: NativeScript, step: RecordStep): void => {
    if (writes) {
      const state = fullUpdate(actor);
      interceptWrites((slot, method, key) => { writes.push({ state, step, slot, method, key }); return false; }, () => checkRecordStep(actor, step));
    } else checkRecordStep(actor, step);
    count(step.name);
  };
  const delivery = (["forward", "reverse", "twice"] as const)[seed % 3] satisfies Delivery | undefined;
  assert.ok(delivery);
  const [first, second, third] = scripts;
  assert.ok(first && second && third);
  const undo = scripts.map(recordUndo), writtenLengths: number[] = [], writtenNotes: string[] = [], retained: string[] = [], removed: string[] = [];
  let splitId = "", splitOffset = 0, typed = "";
  try {
    for (const [index, actor] of scripts.entries()) {
      const manager = undo[index];
      assert.ok(manager);
      const length = 1 + next() % 200, note = "note " + actor.doc.clientID, suffix = seed + "-" + actor.doc.clientID;
      const surviving = "kept-" + suffix, temporary = "temporary-" + suffix;
      writtenLengths.push(length);
      writtenNotes.push(note);
      retained.push(surviving);
      removed.push(temporary);
      const paragraph = beatStep("paragraphStart", true, "E");
      const before = recordSnapshot(actor), beforeRead = recordRead(actor);
      run(actor, paragraph);
      const after = recordSnapshot(actor), afterRead = recordRead(actor);
      assert.ok(manager.undo());
      assert.deepEqual(recordSnapshot(actor), before);
      assert.deepEqual(recordRead(actor), beforeRead);
      count("undo");
      assert.ok(manager.redo());
      assert.deepEqual(recordSnapshot(actor), after);
      assert.deepEqual(recordRead(actor), afterRead);
      count("redo");
      unchangedRecord(actor, () => setNativeField(actor, beatField("E", "paragraphStart"), true));
      count("unchanged");
      run(actor, beatStep("paragraphStart", undefined, "E"));

      const groups = [
        [beatStep("lengthSeconds", length)],
        [headingStep(note + " draft"), headingStep(undefined), headingStep(note)],
        [bodyStep("comment", "comment " + suffix), bodyStep("reply", "reply " + suffix)],
        threadSteps(temporary, "000012V", "temporary edit " + suffix),
        [beatStep("status", "ready", "B")]
      ];
      for (const group of shuffled(groups, next)) for (const step of group) run(actor, step);
      for (const step of threadSteps(surviving, "000012V").slice(0, 2)) run(actor, step);
      unchangedRecord(actor, () => setNativeCommentBody(actor, COMMENT, "Bob", "foreign"), "author");
      count("refused");
      unchangedRecord(actor, () => clearNativeField(actor, beatField("missing", "status")), "missing");
      count("refused");

      if (index === seed % 3) {
        typed = String.fromCodePoint(0x4e00 + seed);
        const offset = next() % 5;
        assert.deepEqual(edit(actor, { beat: "F", cell: "narration" }, offset, offset, [{ text: typed, marks: {} }]), WRITTEN);
        assert.equal(actor.reader.row("F")?.audioText, "foxtrot".slice(0, offset) + typed + "foxtrot".slice(offset));
        count("type");
        splitOffset = 1 + next() % 4;
        splitId = split(actor, "D", splitOffset);
        assert.equal(actor.reader.row("D")?.audioText, "delta".slice(0, splitOffset));
        assert.equal(actor.reader.row(splitId)?.audioText, "delta".slice(splitOffset));
        assert.ok(actor.roots.beats.has(splitId) && actor.roots.visuals.has(splitId));
        count("split");
        assert.deepEqual(joinNativeRow(actor, "B", "A", " "), WRITTEN);
        assert.deepEqual(actor.reader.row("A")?.members, ["A", "B"]);
        assert.equal(actor.reader.row("A")?.fields.status, "ready");
        count("join");
        assert.deepEqual(unjoinNativeRow(actor, "B"), WRITTEN);
        assert.equal(actor.reader.row("B")?.audioText, "bravo");
        count("unjoin");
        assert.deepEqual(removeNativeRows(actor, ["B"]), WRITTEN);
        assert.equal(actor.reader.row("B"), null);
        assert.equal(actor.roots.beats.get("B")?.get("status"), '"ready"');
        count("remove");
        assert.deepEqual(moveNativeBlocks(actor, [{ kind: "beat", id: "E" }], { kind: "beat", id: "A" }), WRITTEN);
        assert.equal(actor.reader.rows()[0]?.id, "E");
        count("move");
        assert.deepEqual(createNativeHeading(actor, caret(actor, "C", 0), "new-heading", "Temporary"), WRITTEN);
        const name = anchorNativeText(actor, { beat: "new-heading", cell: "name" }, 0, 9);
        assert.equal(name.kind, "anchored");
        assert.ok(name.kind === "anchored");
        count("heading create");
        assert.deepEqual(renameNativeHeading(actor, name.range, "Renamed"), WRITTEN);
        assert.deepEqual(actor.reader.outline().find(entry => entry.id === "new-heading"), { id: "new-heading", kind: "heading", name: "Renamed" });
        count("heading rename");
        assert.deepEqual(removeNativeHeading(actor, "new-heading"), WRITTEN);
        assert.ok(!actor.reader.outline().some(entry => entry.id === "new-heading"));
        count("heading remove");
      }
    }
    net.settle(delivery);
    for (const actor of scripts) {
      assert.deepEqual(recordSnapshot(actor), recordSnapshot(first));
      assert.deepEqual(recordRead(actor), recordRead(first));
      assert.deepEqual(recordRead(actor), freshRecordRead(actor));
      assert.deepEqual([...actor.roots.beats.keys()].sort(), ["A", "B", "C", "D", "E", "F", splitId].sort());
      assert.deepEqual([...actor.roots.visuals.keys()].sort(), ["A", "B", "C", "D", "E", "F", splitId].sort());
      assert.deepEqual([...actor.roots.headings.keys()].sort(), ["H", "new-heading"]);
      assert.equal(actor.reader.row("B"), null);
      assert.equal(actor.roots.beats.get("B")?.get("status"), '"ready"');
      assert.equal(actor.reader.row("D")?.audioText, "delta".slice(0, splitOffset));
      assert.equal(actor.reader.row(splitId)?.audioText, "delta".slice(splitOffset));
      assert.equal(actor.reader.row("E")?.fields.paragraphStart, undefined);
      assert.equal(actor.reader.rows()[0]?.id, "E");
      const letters = actor.reader.row("F")?.audioText ?? "";
      assert.equal(letters.replace(typed, ""), "foxtrot");
      assert.ok(writtenLengths.includes(Number(actor.reader.row("A")?.fields.lengthSeconds)));
      assert.ok(writtenNotes.some(note => actor.roots.headings.get("H")?.get(fileKey("note")) === JSON.stringify(note)));
      const comments = actor.reader.document().comments;
      assert.deepEqual(comments.map(comment => comment.id).sort(), ["thread", ...retained].sort());
      for (const comment of comments) {
        if (comment.id === "thread") {
          assert.equal(comment.body, "comment " + seed + "-15");
          assert.equal(comment.replies?.[0]?.body, "reply " + seed + "-15");
        } else {
          assert.equal(comment.body, "original");
          assert.deepEqual(comment.replies?.map(reply => [reply.id, reply.body]), [["new-reply", "reply"]]);
        }
      }
      assert.deepEqual([...actor.roots.comments.keys()].sort(), ["thread", ...retained, ...removed].sort());
      assert.deepEqual([...actor.roots.replies.keys()].sort(), [replyId(REPLY.comment, REPLY.reply), ...[...retained, ...removed].map(id => replyId(id, "new-reply"))].sort());
      for (const id of removed) {
        assert.equal(actor.roots.comments.get(id)?.get("removed"), true);
        assert.equal(actor.roots.replies.get(replyId(id, "new-reply"))?.get("removed"), true);
      }
    }
    return counts;
  } finally { for (const actor of scripts) actor.doc.destroy(); }
}

test("generated three-copy histories check commands locally and account for settled records, comments and fields", t => {
  const totals: Record<string, number> = {};
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const [kind, count] of Object.entries(history(seed))) totals[kind] = (totals[kind] ?? 0) + count;
  }
  const floors = {
    "set beat lengthSeconds": 60, "set beat status": 60, "set beat paragraphStart": 60, "clear beat paragraphStart": 60,
    "set heading": 120, "clear heading": 60, "concurrent comment body": 60, "concurrent reply body": 60,
    "create comment": 120, "create reply": 120, "body comment": 60, "body reply": 60, "resolve comment": 60, "resolve reply": 60,
    "reopen comment": 60, "reopen reply": 60, "remove comment": 60, "remove reply": 60, undo: 60, redo: 60, unchanged: 60, refused: 120,
    type: 20, split: 20, join: 20, unjoin: 20, remove: 20, move: 20, "heading create": 20, "heading rename": 20, "heading remove": 20
  };
  t.diagnostic(JSON.stringify(totals));
  for (const [kind, floor] of Object.entries(floors)) assert.ok((totals[kind] ?? 0) >= floor, kind);
  assert.deepEqual(Object.keys(totals).sort(), Object.keys(floors).sort());
});

test("control: muting each individual record write in a generated history fails at its command", t => {
  const writes: CapturedWrite[] = [];
  history(3, writes);
  const methods = new Set<string>();
  for (const { state, step, slot, method, key } of writes) {
    const doc = new Y.Doc(), actor = openNativeScript(doc);
    Y.applyUpdate(doc, state);
    let reached = false;
    try {
      assert.throws(() => interceptWrites((at, operation, field) => {
        if (at !== slot) return false;
        assert.deepEqual([operation, field], [method, key]);
        reached = true;
        return true;
      }, () => checkRecordStep(actor, step)), error => error instanceof assert.AssertionError && error.message.startsWith(step.name + ": stored snapshot"));
      assert.ok(reached, step.name + " " + key);
    } finally { doc.destroy(); }
    methods.add(method);
  }
  assert.deepEqual([...methods].sort(), ["delete", "set"]);
  assert.ok(writes.length >= 120);
  t.diagnostic(writes.length + " individual writes muted and caught at their commands");
});

test("control: a delete after a refusal leaves the vector unchanged and fails the full-update check", () => {
  const { scripts: [script] } = recordCopies([5]);
  assert.ok(script);
  try {
    const vector = Y.encodeStateVector(script.doc);
    assert.throws(() => unchangedRecord(script, () => {
      const outcome = setNativeCommentBody(script, COMMENT, "Bob", "foreign");
      script.roots.comments.delete(COMMENT.comment);
      return outcome;
    }, "author"), assert.AssertionError);
    assert.deepEqual(Y.encodeStateVector(script.doc), vector);
    assert.equal(script.roots.comments.has(COMMENT.comment), false);
  } finally { script.doc.destroy(); }
});
