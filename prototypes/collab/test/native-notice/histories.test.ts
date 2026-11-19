import assert, { AssertionError } from "node:assert/strict";
import { test } from "node:test";
import type * as Y from "yjs";
import { compareLocalChanges, compareNotices, plainNoticeText, remoteRemoved,
  type ClashKind, type NoticeClash, type NoticeLocalChange } from "../../src/native-notice/compare.ts";
import { inSyncNow, observeRemoteBeatIds, observeRemoteRemoval, readNotice } from "../../src/native-notice/yjs.ts";
import { generatedHistory, namedHistories, type NoticeHistory } from "./histories.ts";
import { assertConverged, deliver, rankedSeed, replicaFrom, write } from "./kit.ts";
import { need } from "../native-delete/model.ts";
import { Ledger, type Loss, type LossKind } from "./model.ts";

const kinds = ["narration", "visual", "marks", "record", "join", "split-text", "split-move", "double-undo", "displaced"] as const;
const sides = ["offline", "journal", "online"] as const;
type Side = typeof sides[number];
type Score = { hit: number; false: number; miss: number };
type Scores = Record<Side, Record<LossKind, Score>>;
type Control = { used: number; effective: number; failed: number };
type Report = {
  histories: number; commands: number; deliveries: number; stretches: number;
  falseNotices: Record<Side, number>; notices: Record<Side, number>;
  scores: Scores; controls: Record<ClashKind, Control>; aspects: Record<"visual-marks" | "record-fields", Control>;
  outcomes: Record<string, number>;
};
const empty = <T,>(make: () => T) => Object.fromEntries(kinds.map(kind => [kind, make()])) as Record<LossKind, T>;
const key = (loss: Pick<Loss, "id" | "kind">) => loss.id + "/" + loss.kind;
const prefix = (entry: string) => entry.slice(entry.lastIndexOf("/") + 1) as LossKind;

function report(): Report {
  const scores = () => empty(() => ({ hit: 0, false: 0, miss: 0 }));
  const counters = () => ({ used: 0, effective: 0, failed: 0 });
  return {
    histories: 0, commands: 0, deliveries: 0, stretches: 0,
    falseNotices: { offline: 0, journal: 0, online: 0 }, notices: { offline: 0, journal: 0, online: 0 },
    scores: { offline: scores(), journal: scores(), online: scores() },
    controls: empty(counters), aspects: { "visual-marks": counters(), "record-fields": counters() }, outcomes: {}
  };
}

function localChanges(model: Ledger, person: number): NoticeLocalChange[] {
  return model.pending(person).flatMap<NoticeLocalChange>(({ effect, undone }) => {
    if (effect.action === "create" && effect.from) return [{ kind: "split", id: effect.id, parent: effect.from }];
    if (effect.action === "delete" && effect.above) {
      return effect.ids.slice(0, 1).map(id => ({ kind: "displaced", id, above: need(effect.above, "old neighbour") }));
    }
    if (undone?.action === "delete") return undone.ids.map(id => ({ kind: "double-undo", id }));
    if (effect.action !== "edit") return [];
    const { kind, id } = effect;
    switch (kind) {
      case "narration":
      case "visual": return effect.token ? [{ kind, id, text: effect.token, ...(effect.erased ? { erased: true } : {}) }] : [];
      case "marks": return effect.column && effect.mark ? [{ kind, id, column: effect.column, mark: effect.mark }] : [];
      case "record": return [{ kind, id, field: effect.field ?? "status" }];
      case "join": return [{ kind, id }];
    }
  });
}

function detectedKeys(clashes: readonly NoticeClash[], losses: readonly Loss[]): Set<string> {
  return new Set(clashes.map(clash => {
    const landing = clash.kind === "displaced" && clash.near &&
      losses.find(loss => loss.kind === "displaced" && loss.near === clash.near);
    return key(landing || clash);
  }));
}

const expectedNamed = {
  offline: [[11, 0, 3], [5, 0, 0], [5, 0, 0], [5, 0, 0], [3, 0, 0], [4, 0, 0], [0, 0, 0], [1, 0, 0], [5, 0, 7]],
  journal: [[11, 0, 3], [5, 0, 0], [5, 0, 0], [5, 0, 0], [3, 0, 0], [4, 0, 0], [0, 0, 0], [1, 0, 0], [6, 0, 6]],
  online: [[11, 0, 3], [3, 0, 0], [3, 0, 0], [3, 0, 0], [2, 0, 1], [0, 0, 4], [0, 0, 0], [0, 0, 0], [0, 0, 12]]
};
const expectedGenerated = {
  offline: [[7, 11, 0], [18, 7, 0], [15, 4, 0], [22, 4, 0], [7, 0, 0], [7, 0, 0], [7, 8, 8], [12, 8, 0], [8, 0, 0]],
  journal: [[7, 4, 0], [18, 7, 0], [15, 4, 0], [22, 4, 0], [7, 0, 0], [7, 0, 0], [7, 4, 8], [12, 0, 0], [8, 0, 0]]
};
const expectedOnline = (three: boolean) => [
  [three ? 12 : 5, 13, 0], [three ? 17 : 10, 5, 4], [5, 4, 8], [12, 8, 6], [0, 0, 5], [0, 0, 5], [0, 0, 9], [0, 0, 9], [0, 0, 4]
];

function assertCounts(result: Report, group: number): void {
  const expected = group === 0 ? expectedNamed : { ...expectedGenerated, online: expectedOnline(group === 2) };
  for (const side of sides) {
    const actual = kinds.map(kind => {
      const { hit, false: falseEntry, miss } = result.scores[side][kind];
      return [hit, falseEntry, miss];
    });
    assert.deepEqual(actual, expected[side], `${group} ${side} hit / false / missed counts`);
  }
  assert.deepEqual(result.notices, group === 0 ? { offline: 35, journal: 36, online: 18 } :
    { offline: 93, journal: 87, online: group === 1 ? 50 : 63 });
  assert.deepEqual(result.falseNotices, group === 0 ? { offline: 0, journal: 0, online: 0 } :
    { offline: 32, journal: 23, online: 26 });
  assert.deepEqual([result.aspects["visual-marks"].used, result.aspects["record-fields"].used], group === 0 ? [2, 1] : [11, 4]);
}

function caseRun(history: NoticeHistory, totals: Report): void {
  const start = rankedSeed(history.initial);
  const copies = Array.from({ length: history.copies }, (_, index) => replicaFrom(start.encode(), 101 + index));
  start.destroy();
  const model = new Ledger(history.copies);
  const edits = copies.map(() => new Map<string, Set<LossKind>>());
  const categories = () => ({ hit: new Set<LossKind>(), false: new Set<LossKind>(), miss: new Set<LossKind>() });
  const historyScores = { offline: categories(), journal: categories(), online: categories() };
  const historyOutcomes = new Set<string>();
  const controlResults = empty(() => ({ used: 0, effective: 0, failed: 0 }));
  const partResults = { "visual-marks": { used: 0, effective: 0, failed: 0 }, "record-fields": { used: 0, effective: 0, failed: 0 } };
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
          if (step.ack) model.acknowledge(step.from);
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
        if (loss.cause === "cut-undo") {
          assert.ok(live, "the cut beat came back");
          if (loss.kind === "visual") assert.equal(plainNoticeText(live.visual).includes(need(loss.token, "visual token")), loss.erased === true);
          if (loss.kind === "record") {
            if (loss.field === "notes") assert.equal(live.fields.notes, undefined);
            else assert.equal(live.status, "todo");
          }
          if (loss.kind === "marks") assert.ok(!live[need(loss.column, "marked column")].some(run => run.marks?.[loss.mark ?? ""]));
          historyOutcomes.add(loss.kind + " lost on returned beat");
        } else if (loss.token && loss.kind === "narration") {
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
        } else if (loss.kind === "displaced" && loss.near) {
          const destination = need(settled.find(beat => beat.id === loss.near), "displaced destination");
          assert.ok(plainNoticeText(destination.narration).includes(need(loss.token, "displaced token")));
        }
      }
      for (const [person, mine] of before.entries()) {
        const side: Side = offline.includes(person) ? "offline" : "online";
        const personal = losses.filter(loss => loss.person === person);
        const truth = new Set(personal.map(key));
        const { base } = need(bases[person], "base");
        const patch = compareNotices(base, mine, settled);
        const found = side === "offline" ? detectedKeys(patch, personal) : new Set([...need(remote[person], "remote")].flatMap(id => {
          const relevant = [...truth].filter(entry => entry.startsWith(id + "/"));
          return relevant.length ? relevant : [...(need(edits[person], "edits").get(id) ?? [])].map(kind => key({ id, kind }));
        }));
        const score = (side: Side, entries: Set<string>) => {
          if (entries.size) {
            historyOutcomes.add("notice/" + side);
            if (!truth.size) historyOutcomes.add("false notice/" + side);
          }
          for (const entry of truth) historyScores[side][entries.has(entry) ? "hit" : "miss"].add(prefix(entry));
          for (const entry of entries) if (!truth.has(entry)) historyScores[side].false.add(prefix(entry));
        };
        score(side, found);
        if (side === "offline") {
          const journal = compareLocalChanges(mine, settled, localChanges(model, person));
          score("journal", detectedKeys(journal, personal));
        }
        if (side === "online") continue;
        const check = (entries: Set<string>, required: readonly string[]) => {
          for (const entry of required) assert.ok(entries.has(entry), history.name + " missing " + entry);
        };
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
          check(found, required);
          try {
            check(detectedKeys(silenced, personal), required);
            control.failed = 1;
          } catch (error) {
            if (error instanceof AssertionError) control.effective = 1;
            else control.failed = 1;
          }
        }
        for (const part of ["visual-marks", "record-fields"] as const) {
          const kind = part === "visual-marks" ? "marks" : "record";
          const required = personal.filter(loss => found.has(key(loss)) && loss.kind === kind &&
            (part === "visual-marks" ? loss.column === "visual" :
              loss.field !== undefined && loss.field !== "status" && base.some(beat => beat.id === loss.id))).map(key);
          if (!required.length) continue;
          const result = partResults[part];
          result.used = 1;
          let muted;
          try {
            muted = compareNotices(base, mine, settled, undefined, candidate => candidate !== part);
            assert.deepEqual(muted.filter(entry => entry.kind !== kind), patch.filter(entry => entry.kind !== kind));
          } catch {
            result.failed = 1;
            continue;
          }
          try {
            check(detectedKeys(muted, personal), required);
            result.failed = 1;
          } catch (error) {
            if (error instanceof AssertionError) result.effective = 1;
            else result.failed = 1;
          }
        }
      }
      bases = copies.map(inSyncNow);
      model.inSyncNow();
      assert.deepEqual(need(bases[0], "bases").base, settled, "capture at the acknowledged in-sync point");
    }
    for (const side of sides) {
      totals.notices[side] += Number(historyOutcomes.delete("notice/" + side));
      totals.falseNotices[side] += Number(historyOutcomes.delete("false notice/" + side));
      for (const score of ["hit", "false", "miss"] as const) {
        for (const kind of historyScores[side][score]) totals.scores[side][kind][score]++;
      }
    }
    for (const kind of kinds) for (const measure of ["used", "effective", "failed"] as const) {
      totals.controls[kind][measure] += controlResults[kind][measure];
    }
    for (const part of ["visual-marks", "record-fields"] as const) for (const measure of ["used", "effective", "failed"] as const) {
      totals.aspects[part][measure] += partResults[part][measure];
    }
    for (const outcome of historyOutcomes) totals.outcomes[outcome] = (totals.outcomes[outcome] ?? 0) + 1;
  } finally {
    copies.forEach(copy => copy.destroy());
  }
}

test("E9 races first, then generated two- and three-copy offline histories", () => {
  const groups = [namedHistories(), ...[2, 3].map(copies => Array.from({ length: 120 }, (_, seed) => generatedHistory(seed, copies)))];
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
  for (const part of ["visual-marks", "record-fields"] as const) {
    assert.ok(reports.slice(1).every(result => result.aspects[part].used > 0));
    assert.ok(reports.every(result => result.aspects[part].failed === 0));
  }
  reports.forEach(assertCounts);
});
