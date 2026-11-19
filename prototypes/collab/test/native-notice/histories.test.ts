import assert, { AssertionError } from "node:assert/strict";
import { test } from "node:test";
import type * as Y from "yjs";
import { compareNotices, plainNoticeText, remoteRemoved, type ClashKind } from "../../src/native-notice/compare.ts";
import { inSyncNow, observeRemoteBeatIds, observeRemoteRemoval, readNotice } from "../../src/native-notice/yjs.ts";
import { generatedHistory, namedHistories, type NoticeHistory } from "./histories.ts";
import { assertConverged, deliver, rankedSeed, replicaFrom, write } from "./kit.ts";
import { need } from "../native-delete/model.ts";
import { Ledger, type Loss, type LossKind } from "./model.ts";

const kinds = ["narration", "visual", "marks", "record", "join", "split-text", "split-move", "double-undo", "displaced"] as const;
type Side = "offline" | "online";
type Score = { hit: number; false: number; miss: number };
type Scores = Record<Side, Record<LossKind, Score>>;
type Control = { used: number; effective: number; failed: number };
type Report = {
  histories: number; commands: number; deliveries: number; stretches: number;
  falseNotices: Record<Side, number>; notices: Record<Side, number>;
  scores: Scores; controls: Record<ClashKind, Control>; outcomes: Record<string, number>;
};
const empty = <T,>(make: () => T) => Object.fromEntries(kinds.map(kind => [kind, make()])) as Record<LossKind, T>;
const key = (loss: Pick<Loss, "id" | "kind">) => loss.id + "/" + loss.kind;
const prefix = (entry: string) => entry.slice(entry.lastIndexOf("/") + 1) as LossKind;

function report(): Report {
  const scores = () => empty(() => ({ hit: 0, false: 0, miss: 0 }));
  return {
    histories: 0, commands: 0, deliveries: 0, stretches: 0,
    falseNotices: { offline: 0, online: 0 }, notices: { offline: 0, online: 0 },
    scores: { offline: scores(), online: scores() },
    controls: empty(() => ({ used: 0, effective: 0, failed: 0 })), outcomes: {}
  };
}

function caseRun(history: NoticeHistory, totals: Report): void {
  const start = rankedSeed(history.initial);
  const copies = Array.from({ length: history.copies }, (_, index) => replicaFrom(start.encode(), 101 + index));
  start.destroy();
  const model = new Ledger(history.copies);
  const edits = copies.map(() => new Map<string, Set<LossKind>>());
  const historyScores = { offline: { hit: new Set<string>(), false: new Set<string>(), miss: new Set<string>() },
    online: { hit: new Set<string>(), false: new Set<string>(), miss: new Set<string>() } };
  const historyOutcomes = new Set<string>();
  const controlResults = empty(() => ({ used: 0, effective: 0, failed: 0 }));
  let bases = copies.map(inSyncNow);
  model.inSyncNow();
  totals.histories++;
  try {
    for (const { offline, steps, order = copies.map((_, index) => index) } of history.stretches) {
      totals.stretches++;
      for (const step of steps) {
        if ("from" in step) {
          deliver(need(copies[step.from], "copies"), need(copies[step.to], "copies"));
          model.deliver(step.from, step.to);
          totals.deliveries++;
        } else {
          model.write(step.person, step.effect);
          write(need(copies[step.person], "copies"), step.command);
          totals.commands++;
          if (step.effect.action === "edit") {
            const { id, kind } = step.effect;
            const set = need(edits[step.person], "edits").get(id) ?? new Set<LossKind>();
            set.add(kind);
            need(edits[step.person], "edits").set(id, set);
          }
        }
      }
      const editedIds = edits.map(ledger => new Set(ledger.keys()));
      const before = copies.map(readNotice);
      const remote = copies.map(() => new Set<string>());
      const removed = copies.map(() => new Set<string>());
      const stopIds = copies.map((copy, person) => observeRemoteBeatIds(copy, ids => {
        const touched = need(editedIds[person], "edited ids"), notices = need(removed[person], "removed");
        for (const id of ids) if (touched.has(id)) notices.add(id);
      }));
      const stop = copies.map((copy, person) => observeRemoteRemoval(copy, (prior, after) => {
        const touched = need(editedIds[person], "edited ids"), notices = need(remote[person], "remote");
        for (const id of remoteRemoved(prior, after, touched)) notices.add(id);
      }));
      try {
        for (const from of order) {
          for (const to of order) {
            if (from === to) continue;
            deliver(need(copies[from], "copies"), need(copies[to], "copies"));
            model.deliver(from, to);
            totals.deliveries++;
          }
        }
      } finally {
        stop.forEach(close => close());
        stopIds.forEach(close => close());
      }
      assert.deepEqual(removed, remote, "the public beat map event gives the same signal as reading before and after");
      const settled = assertConverged(copies), losses = model.losses();
      const rawAudio = [...need(copies[0], "copies").segments.values()].map(segment => (segment.get("text") as Y.Text).toString()).join("|");
      for (const loss of losses) {
        const live = settled.find(beat => beat.id === loss.id);
        if (loss.token && loss.kind === "narration") {
          assert.ok(!live, "the command selected the beat with the edit");
          const token = loss.token;
          const stored = rawAudio.includes(token);
          if (loss.cause === "cut") assert.ok(stored, "real deletion keeps unseen narration in storage");
          const placed = settled.some(beat => plainNoticeText(beat.narration).includes(token));
          historyOutcomes.add(placed ? "narration elsewhere" : stored ? "narration hidden" : "narration erased");
        } else if (loss.kind === "visual") {
          assert.equal(need(copies[0], "copies").visuals.has(loss.id), false);
          historyOutcomes.add("visual container removed");
        } else if (loss.kind === "split-text") {
          assert.ok(live, "the split boundary and record survive");
          assert.match(plainNoticeText(live.narration), /^(?:Ω)?$/);
          historyOutcomes.add("split suffix cut");
        } else if (loss.kind === "split-move") {
          const index = settled.findIndex(beat => beat.id === loss.id);
          assert.ok(index >= 0 && !["B0", "B1"].includes(settled[index - 1]?.id ?? ""));
          historyOutcomes.add("split half stayed behind");
        } else if (loss.kind === "double-undo") {
          assert.equal(plainNoticeText(need(live, "restored beat").narration), "");
          assert.ok(rawAudio.includes("defdef"));
          historyOutcomes.add("double undo hides both copies");
        } else if (loss.kind !== "displaced" && loss.kind !== "join") {
          assert.ok(!live, "the affected beat's record is absent");
          historyOutcomes.add(loss.kind + " gone with beat");
        } else if (loss.kind === "join") {
          assert.ok(!live || live.row !== need(before[loss.person], "before").find(beat => beat.id === loss.id)?.row);
          historyOutcomes.add(live ? "join shown under a different beat" : "join gone with beat");
        }
      }
      for (const [person, mine] of before.entries()) {
        const side: Side = offline.includes(person) ? "offline" : "online";
        const truth = new Set(losses.filter(loss => loss.person === person).map(key));
        const { base } = need(bases[person], "base");
        const patch = compareNotices(base, mine, settled);
        const found = side === "offline" ? new Set(patch.map(key)) : new Set([...need(remote[person], "remote")].flatMap(id => {
          const relevant = [...truth].filter(entry => entry.startsWith(id + "/"));
          return relevant.length ? relevant : [...(need(edits[person], "edits").get(id) ?? [])].map(kind => key({ id, kind }));
        }));
        const show = side === "offline" ? patch.length > 0 : need(remote[person], "remote").size > 0;
        if (show) {
          historyOutcomes.add("notice/" + side);
          if (!truth.size) historyOutcomes.add("false notice/" + side);
        }
        for (const entry of truth) historyScores[side][found.has(entry) ? "hit" : "miss"].add(prefix(entry));
        for (const entry of found) if (!truth.has(entry)) historyScores[side].false.add(prefix(entry));
        if (side === "online") continue;
        for (const kind of kinds) {
          const required = [...truth].filter(entry => prefix(entry) === kind && found.has(entry));
          if (!required.length) continue;
          const control = controlResults[kind];
          control.used = 1;
          let silenced;
          try {
            silenced = compareNotices(base, mine, settled, candidate => candidate !== kind);
            assert.deepEqual(silenced, patch.filter(entry => entry.kind !== kind), "the other kinds keep their coverage");
          } catch {
            control.failed = 1;
            continue;
          }
          const check = (entries: Set<string>) => {
            for (const entry of required) assert.ok(entries.has(entry), history.name + " missing " + entry);
          };
          check(found);
          try {
            check(new Set(silenced.map(key)));
            control.failed = 1;
          } catch (error) {
            if (error instanceof AssertionError) control.effective = 1;
            else control.failed = 1;
          }
        }
      }
      bases = copies.map(inSyncNow);
      model.inSyncNow();
      assert.deepEqual(need(bases[0], "bases").base, settled, "capture at the acknowledged in-sync point");
    }
    for (const side of ["offline", "online"] as const) {
      totals.notices[side] += Number(historyOutcomes.delete("notice/" + side));
      totals.falseNotices[side] += Number(historyOutcomes.delete("false notice/" + side));
      for (const score of ["hit", "false", "miss"] as const) {
        for (const kind of historyScores[side][score]) totals.scores[side][kind as LossKind][score]++;
      }
    }
    for (const kind of kinds) for (const measure of ["used", "effective", "failed"] as const) {
      totals.controls[kind][measure] += controlResults[kind][measure];
    }
    for (const outcome of historyOutcomes) totals.outcomes[outcome] = (totals.outcomes[outcome] ?? 0) + 1;
  } finally {
    copies.forEach(copy => copy.destroy());
  }
}

test("E9 races first, then generated two- and three-copy offline histories", () => {
  const groups = [namedHistories(), ...[2, 3].map(copies => Array.from({ length: 72 }, (_, seed) => generatedHistory(seed, copies)))];
  const reports = groups.map(group => {
    const totals = report();
    for (const history of group) {
      try { caseRun(history, totals); }
      catch (error) { throw new Error(history.name, { cause: error }); }
    }
    console.log(JSON.stringify(totals));
    return totals;
  });
  for (const kind of kinds) {
    assert.ok(reports.some(result => result.controls[kind].used > 0), kind);
    assert.ok(reports.every(result => result.controls[kind].failed === 0), kind);
  }
  assert.ok(reports.some(result => result.falseNotices.offline > 0), "the ambiguous pair must be counted");
  assert.ok(reports.some(result => result.falseNotices.online > 0), "the session rule must count seen deletions");
});
