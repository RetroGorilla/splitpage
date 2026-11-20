import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeMarkChange } from "../../../../src/adapters/collab/native/format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading, restoreNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import { clearNativeField, setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { edit } from "./helpers.ts";
import type { Delivery } from "./helpers.ts";
import {
  AUTHOR, COMMENT, IMAGE, REPLY, beatField, beatStep, checkRecordStep, fileKey, freshRecordRead, fullUpdate, headingField, recordCopies,
  recordRead, recordSnapshot, recordUndo, replyId, setNativeCommentBody, threadSteps, unchangedRecord
} from "./record-harness.ts";
import type { RecordStep } from "./record-harness.ts";
import { caret, split } from "./structure-harness.ts";
import type { TestNativeUndo } from "./undo-harness.ts";

const SEEDS = 24;
const WRITTEN = { kind: "written" };
type Write = "set" | "delete";
interface CapturedWrite {
  readonly client: number;
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
      return undefined;
    }
  };
}

function mapSnapshot(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countMapWrites(before: Record<string, unknown>, expected: Record<string, unknown>): number {
  let count = 0;
  for (const key of new Set([...Object.keys(before), ...Object.keys(expected)])) {
    const previous = before[key], next = expected[key];
    if (mapSnapshot(next)) {
      if (!mapSnapshot(previous)) count++;
      count += countMapWrites(mapSnapshot(previous) ? previous : {}, next);
    } else if (!isDeepStrictEqual(previous, next)) count++;
  }
  return count;
}

function generatedBody(kind: string, suffix: string): string {
  return kind + " &amp; &lt; <strong>" + suffix + "</strong>\nline";
}

function history(seed: number, writes?: CapturedWrite[], muteUndo = false, extendFormat: "format on" | "tag off" | null = null): Record<string, number> {
  const next = random(seed), { scripts, net } = recordCopies(shuffled([4, 9, 15], next));
  const counts: Record<string, number> = {};
  const count = (kind: string): void => { counts[kind] = (counts[kind] ?? 0) + 1; };
  const run = (actor: NativeScript, step: RecordStep): void => {
    if (writes) {
      const state = fullUpdate(actor);
      const start = writes.length;
      interceptWrites((slot, method, key) => {
        writes.push({ client: actor.doc.clientID, state, step, slot, method, key });
        return false;
      }, () => {
        const { before, expected } = checkRecordStep(actor, step);
        assert.equal(writes.length - start, countMapWrites(before, expected), step.name + " must write every key in its expected snapshot diff");
      });
    } else checkRecordStep(actor, step);
    count(step.name);
  };
  const delivery = (["forward", "reverse", "twice"] as const)[seed % 3] satisfies Delivery | undefined;
  assert.ok(delivery);
  const [first, second, third] = scripts;
  assert.ok(first && second && third);
  const undo = scripts.map(recordUndo), retained: { comment: string; reply: string }[] = [], removed: typeof retained = [];
  let winningLength = 0;
  const winner = Math.max(...scripts.map(script => script.doc.clientID));
  let splitId = "", splitOffset = 0, typed = "";
  function reversibleChange(actor: NativeScript, manager: TestNativeUndo, name: string, command: () => void, checkRedo?: () => void): void {
    const before = recordSnapshot(actor), beforeRead = recordRead(actor);
    command();
    const after = recordSnapshot(actor), afterRead = recordRead(actor);
    if (!muteUndo) assert.ok(manager.undo(), name);
    assert.deepEqual(recordSnapshot(actor), before, name + ": undo snapshot");
    assert.deepEqual(recordRead(actor), beforeRead, name + ": undo reading");
    count("undo " + name);
    assert.ok(manager.redo(), name);
    checkRedo?.();
    assert.deepEqual(recordSnapshot(actor), after, name + ": redo snapshot");
    assert.deepEqual(recordRead(actor), afterRead, name + ": redo reading");
    count("redo " + name);
  }
  function reversible(actor: NativeScript, manager: TestNativeUndo, step: RecordStep): void {
    reversibleChange(actor, manager, step.name, () => run(actor, step));
  }
  try {
    for (const [index, actor] of scripts.entries()) {
      const manager = undo[index];
      assert.ok(manager);
      const length = 1 + next() % 200, suffix = seed + "-" + actor.doc.clientID;
      const surviving = { comment: "", reply: "" }, temporary = { comment: "", reply: "" };
      if (actor.doc.clientID === winner) winningLength = length;
      retained.push(surviving);
      removed.push(temporary);
      const paragraph = beatStep("paragraphStart", true, "E");
      reversible(actor, manager, paragraph);
      unchangedRecord(actor, () => setNativeField(actor, beatField("E", "paragraphStart"), true));
      count("unchanged");
      reversible(actor, manager, beatStep("paragraphStart", undefined, "E"));

      const groups = [
        [beatStep("lengthSeconds", length)],
        [bodyStep("comment", generatedBody("comment", suffix)), bodyStep("reply", generatedBody("reply", suffix))],
        threadSteps("temporary-" + suffix, "000012V", generatedBody("temporary edit", suffix), temporary),
        [beatStep("status", "ready", "B")],
        [beatStep("extra", { note: "extra " + actor.doc.clientID }), beatStep("imageRef", IMAGE)]
      ];
      for (const group of shuffled(groups, next)) for (const step of group) {
        reversible(actor, manager, step);
      }
      for (const step of threadSteps("kept-" + suffix, "000012V", "unused", surviving).slice(0, 2)) reversible(actor, manager, step);
      unchangedRecord(actor, () => setNativeCommentBody(actor, COMMENT, "Bob", "foreign"), "author");
      count("refused");
      unchangedRecord(actor, () => setNativeCommentBody(actor, COMMENT, AUTHOR, "a & b <b>bold</b>\u0000"), "value");
      count("refused malformed body");
      unchangedRecord(actor, () => clearNativeField(actor, beatField("missing", "status")), "missing");
      count("refused");
      unchangedRecord(actor, () => setNativeField(actor, headingField("note"), "unsupported"), "value");
      count("refused heading set");
      unchangedRecord(actor, () => clearNativeField(actor, headingField("note")), "value");
      count("refused heading clear");

      if (index === seed % 3) {
        typed = String.fromCodePoint(0x4e00 + seed);
        const offset = next() % 5;
        reversibleChange(actor, manager, "type", () => {
          assert.deepEqual(edit(actor, { beat: "F", cell: "narration" }, offset, offset, [{ text: typed, marks: {} }]), WRITTEN);
          assert.equal(actor.reader.row("F")?.audioText, "foxtrot".slice(0, offset) + typed + "foxtrot".slice(offset));
          count("type");
        });
        splitOffset = 1 + next() % 4;
        reversibleChange(actor, manager, "split", () => {
          splitId = split(actor, "D", splitOffset);
          assert.equal(actor.reader.row("D")?.audioText, "delta".slice(0, splitOffset));
          assert.equal(actor.reader.row(splitId)?.audioText, "delta".slice(splitOffset));
          assert.ok(actor.roots.beats.has(splitId) && actor.roots.visuals.has(splitId));
          count("split");
        });
        reversibleChange(actor, manager, "join", () => {
          assert.deepEqual(joinNativeRow(actor, "B", "A", " "), WRITTEN);
          assert.deepEqual(actor.reader.row("A")?.members, ["A", "B"]);
          assert.equal(actor.reader.row("A")?.fields.status, "ready");
          count("join");
        });
        reversibleChange(actor, manager, "unjoin", () => {
          assert.deepEqual(unjoinNativeRow(actor, "B"), WRITTEN);
          assert.equal(actor.reader.row("B")?.audioText, "bravo");
          count("unjoin");
        });
        reversibleChange(actor, manager, "remove", () => {
          assert.deepEqual(removeNativeRows(actor, ["B"]), WRITTEN);
          assert.equal(actor.reader.row("B"), null);
          assert.equal(actor.roots.beats.get("B")?.get("status"), '"ready"');
          count("remove");
        });
        reversibleChange(actor, manager, "move", () => {
          assert.deepEqual(moveNativeBlocks(actor, [{ kind: "beat", id: "E" }], { kind: "beat", id: "A" }), WRITTEN);
          assert.equal(actor.reader.rows()[0]?.id, "E");
          count("move");
        });
        reversibleChange(actor, manager, "heading create", () => {
          assert.deepEqual(createNativeHeading(actor, caret(actor, "C", 0), "new-heading", "Temporary"), WRITTEN);
          count("heading create");
        });
        const name = anchorNativeText(actor, { beat: "new-heading", cell: "name" }, 0, 9);
        assert.ok(name.kind === "anchored");
        reversibleChange(actor, manager, "heading rename", () => {
          assert.deepEqual(renameNativeHeading(actor, name.range, "Renamed"), WRITTEN);
          assert.deepEqual(actor.reader.outline().find(entry => entry.id === "new-heading"), { id: "new-heading", kind: "heading", name: "Renamed" });
          count("heading rename");
        });
        reversibleChange(actor, manager, "heading remove", () => {
          assert.deepEqual(removeNativeHeading(actor, "new-heading"), WRITTEN);
          assert.ok(!actor.reader.outline().some(entry => entry.id === "new-heading"));
          count("heading remove");
        });
        reversibleChange(actor, manager, "heading restore", () => {
          assert.deepEqual(restoreNativeHeading(actor, "new-heading"), WRITTEN);
          assert.ok(actor.reader.outline().some(entry => entry.id === "new-heading"));
          count("heading restore");
        });
        assert.deepEqual(removeNativeHeading(actor, "new-heading"), WRITTEN);
        const marks: readonly { name: string; change: NativeMarkChange; shown: object }[] = [
          { name: "format on", change: { kind: "plain", mark: "b", on: true }, shown: { b: true } },
          { name: "format off", change: { kind: "plain", mark: "b", on: false }, shown: {} },
          { name: "tag on", change: { kind: "tag", id: "t:prop:lamp", on: true }, shown: { tag: "t:prop:lamp" } },
          { name: "tag off", change: { kind: "tag", id: "t:prop:lamp", on: false }, shown: {} },
          { name: "comment mark on", change: { kind: "comment", id: "thread", on: true }, shown: { cmt: ["thread"] } },
          { name: "comment mark off", change: { kind: "comment", id: "thread", on: false }, shown: {} },
          { name: "link on", change: { kind: "link", href: "https://example.com/" }, shown: { href: "https://example.com/" } },
          { name: "link off", change: { kind: "link", href: null }, shown: {} }
        ];
        const tagNeighbour = (on: boolean) => {
          const neighbour = anchorNativeText(actor, { beat: "F", cell: "narration" }, 1, 2);
          assert.equal(neighbour.kind, "anchored");
          assert.deepEqual(formatNativeText(actor, neighbour.range, { kind: "tag", id: "t:prop:lamp", on }), WRITTEN);
        };
        for (const { name: kind, change, shown } of marks) {
          if (kind === "tag off") tagNeighbour(true);
          const row = actor.reader.row("F");
          assert.ok(row);
          const letters = (runs: typeof row.narration) => runs.flatMap(run => [...run.text].map(char => ({ char, marks: run.marks })));
          const before = letters(row.narration), from = 0, to = 1;
          const expected = before.map((letter, index) => index >= from && index < to ? { char: letter.char, marks: shown } : letter);
          const checkCell = () => {
            const read = actor.reader.row("F");
            assert.ok(read);
            assert.deepEqual(letters(read.narration), expected, kind + ": requested cell");
          };
          reversibleChange(actor, manager, kind, () => {
            const range = anchorNativeText(actor, { beat: "F", cell: "narration" }, from, extendFormat === kind ? to + 1 : to);
            assert.equal(range.kind, "anchored");
            assert.deepEqual(formatNativeText(actor, range.range, change), WRITTEN);
            checkCell();
            count(kind);
          }, checkCell);
          if (kind === "tag off") tagNeighbour(false);
        }
        reversibleChange(actor, manager, "visual type", () => {
          assert.deepEqual(edit(actor, { beat: "F", cell: "visual" }, 0, 0, [{ text: typed, marks: {} }]), WRITTEN);
          assert.equal(actor.roots.visuals.get("F")?.toString(), typed);
          count("visual type");
        });
        reversibleChange(actor, manager, "delete", () => {
          const visual = actor.roots.visuals.get("F");
          assert.ok(visual?.length);
          const before = visual.toString();
          assert.deepEqual(edit(actor, { beat: "F", cell: "visual" }, 0, 1, []), WRITTEN);
          assert.equal(visual.toString(), before.slice(1));
          count("delete");
        });
      }
    }
    net.settle(delivery);
    const across = { comment: "", reply: "" };
    removed.push(across);
    const acrossSteps = threadSteps("cross-device", "00001YV", "across devices", across, "Carol");
    for (const [index, step] of acrossSteps.entries()) {
      const actor = scripts[(index + seed) % scripts.length];
      assert.ok(actor);
      const manager = undo[(index + seed) % scripts.length];
      assert.ok(manager);
      reversible(actor, manager, step);
      net.settle(delivery);
    }
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
      assert.equal(letters.split(typed).length, 2);
      assert.equal(actor.reader.row("A")?.fields.lengthSeconds, winningLength);
      assert.equal(actor.roots.headings.get("H")?.has(fileKey("note")), false);
      assert.equal(actor.reader.row("A")?.fields.note, "extra " + winner);
      assert.deepEqual(actor.reader.row("A")?.fields.imageRef, IMAGE);
      const comments = actor.reader.document().comments;
      assert.deepEqual(comments.map(comment => comment.id).sort(), ["thread", ...retained.map(ids => ids.comment)].sort());
      for (const comment of comments) {
        if (comment.id === "thread") {
          assert.equal(comment.body, generatedBody("comment", seed + "-15"));
          assert.equal(comment.replies?.[0]?.body, generatedBody("reply", seed + "-15"));
        } else {
          assert.equal(comment.body, "original");
          const entry = retained.find(ids => ids.comment === comment.id);
          assert.ok(entry);
          assert.deepEqual(comment.replies?.map(reply => [reply.id, reply.body]), [[entry.reply, "reply"]]);
        }
      }
      const issued = [...retained, ...removed];
      assert.deepEqual([...actor.roots.comments.keys()].sort(), ["thread", ...issued.map(ids => ids.comment)].sort());
      assert.deepEqual([...actor.roots.replies.keys()].sort(), [replyId(REPLY.comment, REPLY.reply), ...issued.map(ids => replyId(ids.comment, ids.reply))].sort());
      for (const ids of removed) {
        assert.equal(actor.roots.comments.get(ids.comment)?.get("removed"), true);
        assert.equal(actor.roots.replies.get(replyId(ids.comment, ids.reply))?.get("removed"), true);
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
  const schedules = [
    { perHistory: 3, reason: "each of the three writers runs this once", kinds: [
      "set beat lengthSeconds", "set beat status", "set beat paragraphStart", "clear beat paragraphStart", "set beat extra",
      "set beat imageRef", "refused heading set", "refused heading clear", "refused malformed body", "concurrent comment body", "concurrent reply body", "unchanged",

    ] },
    { perHistory: 6, reason: "each of the three writers runs this twice", kinds: ["refused"] },
    { perHistory: 7, reason: "each writer starts two threads and the cross-device trace starts one", kinds: ["create comment", "create reply"] },
    { perHistory: 4, reason: "each writer runs this on a temporary thread and the cross-device trace runs it once", kinds: [
      "body comment", "body reply", "resolve comment", "resolve reply", "reopen comment", "reopen reply", "remove comment", "remove reply"
    ] },
    { perHistory: 1, reason: "one chosen writer runs the structural trace", kinds: [
      "type", "split", "join", "unjoin", "remove", "move", "heading create", "heading rename", "heading remove", "heading restore", "format on", "format off", "tag on", "tag off",
      "comment mark on", "comment mark off", "link on", "link off", "visual type", "delete"
    ] }
  ];
  t.diagnostic(JSON.stringify(totals));
  const irreversible = new Set(["refused", "refused heading set", "refused heading clear", "refused malformed body", "unchanged"]);
  for (const { perHistory, reason, kinds } of schedules) for (const kind of kinds) {
    assert.equal(totals[kind], SEEDS * perHistory, kind + ": " + reason);
    if (!irreversible.has(kind)) for (const direction of ["undo", "redo"]) {
      assert.equal(totals[direction + " " + kind], SEEDS * perHistory, direction + " " + kind);
    }
  }
  assert.deepEqual(Object.keys(totals).sort(), schedules.flatMap(group => group.kinds.flatMap(kind => irreversible.has(kind) ? [kind] : [kind, "undo " + kind, "redo " + kind])).sort());
});

test("control: extending bold one letter fails the whole-cell oracle", () => {
  assert.throws(() => history(3, undefined, false, "format on"), /format on: requested cell/);
});

test("control: extending untag one letter clears a tagged neighbour and fails the oracle", () => {
  assert.throws(() => history(3, undefined, false, "tag off"), /tag off: requested cell/);
});

test("control: a no-op undo fails the stored snapshot check", () => {
  assert.throws(() => history(3, undefined, true), /undo snapshot/);
});

test("control: muting each individual record write in a generated history fails at its command", t => {
  const writes: CapturedWrite[] = [];
  history(3, writes);
  const methods = new Set<string>();
  for (const { client, state, step, slot, method, key } of writes) {
    const doc = new Y.Doc(), actor = openNativeScript(doc);
    Y.applyUpdate(doc, state);
    doc.clientID = client;
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
