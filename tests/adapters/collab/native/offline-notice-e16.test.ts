import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { tagStack } from "../../../../src/core/text/runs.ts";
import { readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import { declareNativeRoots } from "../../../../src/adapters/collab/native/roots.ts";
import { base, generatedHistory, namedHistories, need, tagSweepCases, tagSweepRemovals } from "./notice-histories.ts";
import type { NoticeHistory, NoticeHistoryCommand } from "./notice-histories.ts";
import { NoticeHistoryLedger } from "./notice-history-model.ts";
import type { NoticeHistoryLoss } from "./notice-history-model.ts";
import { noticeCommandWitness, noticeCopy, noticeDeliver, noticeRange, noticeSeed, playNoticeCommand } from "./notice-harness.ts";

function retainedByUndo(loss: NoticeHistoryLoss): boolean {
  return loss.cause === "cut-undo" &&
    (loss.kind === "visual" || loss.kind === "record" || loss.kind === "marks" && loss.column === "visual");
}

const scoreKey = (id: string, kind: string) => id + "/" + kind;

function scoreHistory(history: NoticeHistory, play = playNoticeCommand) {
  const state = noticeSeed(history.initial), ids = new Map<string, string>();
  const copies = Array.from({ length: history.copies }, (_, person) => noticeCopy(state, 101 + person, true));
  const checked = copies.map(() => noticeCommandWitness());
  const ledger = new NoticeHistoryLedger(copies.length), outcomes = new Set<string>(), failures: string[] = [];
  let issued = 0, deliveries = 0;
  try {
    for (const { offline, steps, order = copies.map((_, index) => index) } of history.stretches) {
      const send = (from: number, to: number) => {
        noticeDeliver(need(copies[from], "sender"), need(copies[to], "receiver"));
        ledger.deliver(from, to);
        deliveries++;
      };
      for (const step of steps) {
        if ("from" in step) {
          send(step.from, step.to);
          if (step.ack) {
            const journal = need(copies[step.from]?.pendingEdits ?? undefined, "sender journal");
            journal.clearThrough(journal.data().through);
          }
        } else {
          ledger.write(step.person, step.effect);
          const copy = need(copies[step.person], "writer");
          const before = copy.encodeState();
          {
            const outcome = need(checked[step.person], "writer witness")(copy, step.command, ids, play);
            if (outcome.kind !== "written") {
              assert.deepEqual(copy.encodeState(), before);
              if (outcome.kind !== "unchanged") failures.push(JSON.stringify([step.command, outcome.kind]));
            }
          }
          issued++;
        }
      }
      for (const from of order) for (const to of order) if (from !== to) send(from, to);
      const first = need(copies[0], "settled copy"), reading = first.document();
      const fresh = noticeCopy(first.encodeState(), 200);
      try {
        for (const copy of [...copies.slice(1), fresh]) assert.deepEqual(copy.document(), reading, history.name);
      } finally { fresh.close(); }
      const losses = ledger.losses().filter(loss => !retainedByUndo(loss));
      const named = new Map([...ids].map(([label, id]) => [id, label]));
      for (const [person, copy] of copies.entries()) {
        const notices = copy.offlineNotice(offline.includes(person) ? "returning" : "online");
        if (!offline.includes(person)) {
          assert.deepEqual(notices, [], history.name);
          continue;
        }
        const personal = losses.filter(loss => loss.person === person);
        const expected = new Map(personal.map(loss => [scoreKey(loss.id, loss.kind), loss.kind]));
        const found = new Map(notices.flatMap(clash => clash.kinds.map(kind => {
          const landing = kind === "displaced" && personal.find(loss => loss.kind === kind && loss.near === clash.near);
          return [scoreKey(landing ? landing.id : named.get(clash.id) ?? clash.id, kind), kind] as const;
        })));
        if (found.size) {
          outcomes.add("banner");
          if (!expected.size) outcomes.add("false banner");
        }
        for (const [key, kind] of expected) outcomes.add((found.has(key) ? "hit/" : "miss/") + kind);
        for (const [key, kind] of found) if (!expected.has(key)) outcomes.add("false/" + kind);
      }
      for (const copy of copies) {
        const journal = need(copy.pendingEdits ?? undefined, "journal");
        journal.clearThrough(journal.data().through);
      }
      ledger.inSyncNow();
    }
    return { issued, deliveries, outcomes: [...outcomes], failures };
  } finally { copies.forEach(copy => copy.close()); }
}

test("E16's 85 named and 240 generated histories use the product offline notice", t => {
  const groups = [namedHistories(), ...[2, 3].map(copies =>
    Array.from({ length: 120 }, (_, seed) => generatedHistory(seed, copies)))];
  assert.deepEqual(groups.map(group => group.length), [85, 120, 120]);
  const differed = new Set(["text erase / offline 1", "sole segment narration / offline 0", "scene head / offline 0"]);
  const summaries = groups.map(group => {
    let commands = 0, deliveries = 0, banners = 0, falseBanners = 0, hits = 0, misses = 0;
    for (const history of group) {
      const result = scoreHistory(history);
      commands += result.issued;
      deliveries += result.deliveries;
      banners += Number(result.outcomes.includes("banner"));
      falseBanners += Number(result.outcomes.includes("false banner"));
      hits += result.outcomes.filter(outcome => outcome.startsWith("hit/")).length;
      misses += result.outcomes.filter(outcome => outcome.startsWith("miss/")).length;
      assert.deepEqual(result.failures, [], history.name);
      if (differed.has(history.name)) t.diagnostic(JSON.stringify([history.name, result.outcomes]));
    }
    return { commands, deliveries, banners, falseBanners, hits, misses };
  });
  assert.deepEqual(summaries, [
    { commands: 202, deliveries: 174, banners: 31, falseBanners: 1, hits: 34, misses: 10 },
    { commands: 6352, deliveries: 544, banners: 78, falseBanners: 23, hits: 89, misses: 8 },
    { commands: 6376, deliveries: 1504, banners: 78, falseBanners: 23, hits: 89, misses: 8 }
  ]);
  t.diagnostic(JSON.stringify(summaries));
});

test("the E16 witness catches a muted text write when seed 10 issues it", t => {
  const history = generatedHistory(10, 2), insert = Y.Text.prototype.insert;
  let muted = 0;
  assert.throws(() => scoreHistory(history, (copy, command, ids) => {
    if (command.op !== "type" || command.field === "name" || muted) return playNoticeCommand(copy, command, ids);
    const mock = t.mock.method(Y.Text.prototype, "insert", function (this: Y.Text, at: number, value: string, attrs?: Record<string, unknown>) {
      if (!muted && value === command.value) muted++;
      else insert.call(this, at, value, attrs);
    });
    try { return playNoticeCommand(copy, command, ids); } finally { mock.mock.restore(); }
  }), { code: "ERR_ASSERTION", message: /issued type/ });
  assert.equal(muted, 1);
});

test("E16's tag sweep distinguishes loss through an unseen delete and undo from retained tags", t => {
  const state = noticeSeed(base), tag = "t:prop:tag";
  let seenTrials = 0, unseenTrials = 0, lost = 0, flagged = 0;
  for (const op of tagSweepRemovals) for (const { field, range: [from, to] } of tagSweepCases) for (const seen of [false, true]) {
    const writer = noticeCopy(state, 101, true), cutter = noticeCopy(state, 102, true), ids = new Map<string, string>();
    const label = [op, field, from, to, seen].join("/");
    try {
      const column = field === "audio" ? "narration" : "visual";
      assert.equal(writer.commands.formatText(noticeRange(writer, "B", column, from, to), { kind: "tag", id: tag, on: true }).kind, "written");
      if (seen) noticeDeliver(writer, cutter);
      const removal: NoticeHistoryCommand = op === "cut" ? { op: "rows", ids: ["B"] } : {
        op: "erase", id: "B", field, from: op === "same" ? from : 0,
        to: op === "same" ? to : op === "first" || field === "visual" ? 1 : 3
      };
      assert.equal(playNoticeCommand(cutter, removal, ids).kind, "written");
      assert.equal(cutter.commands.undo().kind, "written");
      noticeDeliver(cutter, writer);
      noticeDeliver(writer, cutter);
      assert.deepEqual(writer.document(), cutter.document(), label);
      const returned = readNativeOnce(declareNativeRoots(writer.ydoc), reader => reader.noticeBeat("B"));
      assert.ok(returned, label);
      const expected = !seen && field === "audio" && from > 0 && (op === "cut" || op === "all");
      const missing = !returned[column].some(run => tagStack(run.marks).includes(tag));
      const notice = writer.offlineNotice("returning").some(entry => entry.id === "B" && entry.kinds.includes("marks"));
      assert.deepEqual([missing, notice], [expected, expected], label);
      if (seen) seenTrials++;
      else { unseenTrials++; lost += Number(missing); flagged += Number(notice); }
    } finally {
      writer.close();
      cutter.close();
    }
  }
  assert.deepEqual({ seenTrials, unseenTrials, lost, flagged }, { seenTrials: 28, unseenTrials: 28, lost: 6, flagged: 6 });
  t.diagnostic(`${lost} of ${unseenTrials} unseen tags lost, all ${flagged} flagged`);
});
