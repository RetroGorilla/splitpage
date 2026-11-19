import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { KeptReplica } from "../../src/native-kept/replica.ts";
import type { MoveReplica } from "../../src/native-moves/ranks.ts";
import { compareLocalChanges, compareNotices, remoteRemoved } from "../../src/native-notice/compare.ts";
import { observeRemoteBeatIds, observeRemoteRemoval, readNotice } from "../../src/native-notice/yjs.ts";
import { retainedByCut, scoreNotice, scoreOffline } from "../../src/native-kept-recount/notice.ts";
import { nativeMarkName } from "../../src/native/variant.ts";
import { specOf, seed } from "../native-chosen/kit.ts";
import { neverAcceptable, reachability } from "../native-chosen/check.ts";
import { watch } from "../native-chosen/engine.ts";
import { need, base } from "../native-delete/model.ts";
import { openCopy, runCommand } from "../native-kept/replay.ts";
import { generatedHistory, namedHistories, tagSweepCases, tagSweepRemovals } from "../native-notice/histories.ts";
import type { NoticeHistory, Step } from "../native-notice/histories.ts";
import { assertConverged, deliver, rankedSeed, replicaFrom, write } from "../native-notice/kit.ts";
import { Ledger } from "../native-notice/model.ts";
import type { Loss, LossKind } from "../native-notice/model.ts";
import { missingContainers } from "./reachability.ts";

type Command = Extract<Step, { person: number }>["command"];

function writeKept(replica: KeptReplica, command: Command): void {
  if (command.op === "rows") runCommand(replica, { op: "delete", rows: [...command.ids] });
  else if (command.op === "scene") runCommand(replica, { op: "sceneDelete", id: command.id });
  else if (command.op === "heading") runCommand(replica, { op: "removeHeading", id: command.id });
  else if (command.op === "insert") replica.insertBeat(command.before, command.created, command.value, { status: "new" });
  else write(replica, command);
  replica.changes();
}

function openNotice(initial: NoticeHistory["initial"], kept: boolean) {
  if (kept) {
    const bytes = seed(specOf(initial), undefined, "cells");
    return (client: number) => openKept(bytes, client);
  }
  const start = rankedSeed(initial);
  const bytes = start.encode();
  start.destroy();
  return (client: number) => replicaFrom(bytes, client);
}

function openKept(bytes: Uint8Array, client: number): KeptReplica {
  const copy = new KeptReplica(client);
  Y.applyUpdate(copy.doc, bytes, "remote");
  return copy;
}

function matchesEdit(copy: MoveReplica, loss: Loss, command: Command): boolean {
  const record = copy.beats.get(loss.id), cell = copy.visuals.get(loss.id);
  switch (command.op) {
    case "field": return record?.get("status") === command.value;
    case "detail": return record?.get(command.key) === command.value;
    case "type": return cell?.toString().includes(command.value) === true;
    case "erase": return !!cell && !cell.toString().includes(need(loss.token, "erased token"));
    case "mark": return cell?.toDelta().some((part: { attributes?: Record<string, unknown> }) =>
      Object.entries(part.attributes ?? {}).some(([name, value]) => nativeMarkName(name) === command.key && value === true)) === true;
    default: throw new Error(`Unexpected retained edit ${command.op}`);
  }
}

function run(history: NoticeHistory, kept: boolean, pureStorage: boolean, totals: Record<string, number>): void {
  const open = openNotice(history.initial, kept);
  const copies = Array.from({ length: history.copies }, (_, index) => open(101 + index));
  const ledger = new Ledger(copies.length), outcomes = new Set<string>();
  const touched = copies.map(() => new Map<string, Set<LossKind>>());
  const commands: Extract<Step, { person: number }>[] = [];
  let bases = copies.map(readNotice);
  const check = (copy: MoveReplica) => {
    if (kept) assert.deepEqual(missingContainers(copy), [], history.name);
    if (copy instanceof KeptReplica) assert.deepEqual(neverAcceptable(reachability(copy)), [], history.name);
  };
  try {
    for (const { offline, steps, order = copies.map((_, index) => index) } of history.stretches) {
      const send = (from: number, to: number) => {
        const target = need(copies[to], "receiver");
        deliver(need(copies[from], "sender"), target);
        ledger.deliver(from, to);
        check(target);
      };
      for (const step of steps) {
        if ("from" in step) {
          send(step.from, step.to);
          if (step.ack) ledger.acknowledge(step.from);
        } else {
          ledger.write(step.person, step.effect);
          commands.push(step);
          const copy = need(copies[step.person], "writer");
          if (copy instanceof KeptReplica) writeKept(copy, step.command);
          else write(copy, step.command);
          check(copy);
          const { effect } = step;
          if (effect.action === "edit") {
            const edits = need(touched[step.person], "edits");
            const kinds = edits.get(effect.id) ?? new Set<LossKind>();
            kinds.add(effect.kind);
            edits.set(effect.id, kinds);
          }
        }
      }
      const before = copies.map(readNotice), mapEvents = copies.map(() => new Set<string>());
      const rowEvents = copies.map(() => new Set<string>());
      const stop = copies.flatMap((copy, person) => [
        observeRemoteBeatIds(copy, ids => ids.forEach(id => mapEvents[person]?.add(id))),
        observeRemoteRemoval(copy, (before, after) => {
          for (const id of remoteRemoved(before, after, new Set(touched[person]?.keys()))) rowEvents[person]?.add(id);
        })
      ]);
      try {
        for (const from of order) for (const to of order) if (from !== to) send(from, to);
      } finally { stop.forEach(close => close()); }
      const merged = kept ? readNotice(need(copies[0], "first copy")) : assertConverged(copies);
      if (kept) {
        const first = need(copies[0], "first copy");
        const late = openCopy(first.encode(), 999, true);
        try {
          for (const copy of [...copies.slice(1), late]) {
            check(copy);
            assert.deepEqual(readNotice(copy), merged, "settled readings");
            assert.deepEqual(copy.doc.toJSON(), first.doc.toJSON(), "settled storage");
          }
        } finally { late.destroy(); }
      }
      const losses = ledger.losses().filter(loss => {
        if (!kept || !retainedByCut(loss)) return true;
        const step = commands.findLast(({ person, effect }) => person === loss.person && effect.action === "edit"
          && effect.id === loss.id && effect.kind === loss.kind && effect.token === loss.token && effect.field === loss.field);
        const expected = need(step, "edit from the command ledger").command;
        assert.ok(matchesEdit(need(copies[0], "first copy"), loss, expected), `${history.name} ${loss.id} ${loss.kind} retained`);
        return !pureStorage && loss.cause === "cut";
      });
      for (const [person, mine] of before.entries()) {
        const personal = losses.filter(loss => loss.person === person);
        if (offline.includes(person)) {
          scoreOffline(need(bases[person], "base"), mine, merged, ledger, person, personal, outcomes);
        } else {
          const score = (ids: Set<string>, side: string) => {
            const found = new Set([...ids].flatMap(id => {
              const relevant = personal.filter(loss => loss.id === id).map(loss => loss.kind);
              const kinds = relevant.length ? relevant : [...(touched[person]?.get(id) ?? [])];
              return kinds.map(kind => id + "/" + kind);
            }));
            scoreNotice(found, personal, outcomes, side);
          };
          score(need(rowEvents[person], "row events"), "online");
          score(need(mapEvents[person], "map events"), "map");
        }
      }
      bases = copies.map(readNotice);
      ledger.inSyncNow();
    }
    for (const outcome of outcomes) totals[outcome] = (totals[outcome] ?? 0) + 1;
  } finally { copies.forEach(copy => copy.destroy()); }
}

test("E16 replays E12's notice histories", t => {
  const groups = [namedHistories(), ...[2, 3].map(copies => Array.from({ length: 120 }, (_, seed) => generatedHistory(seed, copies)))];
  const expected = [
    [[35, 0, 10, 36, 0, 9, 18, 0, 20], [93, 32, 8, 87, 23, 8, 50, 26, 50], [93, 32, 8, 87, 23, 8, 63, 26, 50]],
    [[31, 0, 9, 31, 0, 10, 18, 0, 20], [84, 32, 8, 78, 23, 8, 50, 26, 36], [84, 32, 8, 78, 23, 8, 63, 26, 36]],
    [[31, 3, 9, 31, 3, 10, 18, 3, 20], [84, 50, 8, 78, 42, 8, 50, 40, 36], [84, 50, 8, 78, 42, 8, 63, 46, 36]]
  ];
  let variant = 0;
  for (const [kept, storage] of [[false, false], [true, false], [true, true]] as const) {
    for (const [group, histories] of groups.entries()) {
      const totals: Record<string, number> = {};
      const problems: Record<string, string> = {};
      for (const history of histories) {
        try { run(history, kept, storage, totals); }
        catch (error) { problems[history.name] = (error as Error).message; }
      }
      t.diagnostic(JSON.stringify({ kept, storage, group, totals, problems }));
      assert.deepEqual(problems, {});
      const actual = ["base", "journal", "online"].flatMap(side => [
        totals[side + "/banner"] ?? 0, totals[side + "/false banner"] ?? 0,
        Object.entries(totals).filter(([key]) => key.startsWith(side + "/miss/")).reduce((sum, [, n]) => sum + n, 0)
      ]);
      assert.deepEqual(actual, expected[variant]?.[group]);
    }
    variant++;
  }
});

test("E16 seen and unseen visual, tag, status and other fields", t => {
  const examples = [
    ["visual", { op: "type", id: "B", field: "visual", at: 1, value: "x" }, { kind: "visual", id: "B", text: "x" }],
    ["marks", { op: "mark", id: "B", field: "visual", from: 0, to: 1, key: "t:TAG" },
      { kind: "marks", id: "B", column: "visual", mark: "t:TAG" }],
    ["record", { op: "field", id: "B", value: "ready" }, { kind: "record", id: "B", field: "status" }],
    ["record", { op: "detail", id: "B", key: "notes", value: "changed" }, { kind: "record", id: "B", field: "notes" }]
  ] as const;
  for (const [kind, command, pending] of examples) for (const undo of [false, true]) {
    const readings: unknown[] = [];
    for (const seen of [false, true]) {
      const bytes = seed(specOf(base), undefined, "cells");
      const writer = openKept(bytes, 101), cutter = openKept(bytes, 102);
      try {
        const common = readNotice(writer);
        writeKept(writer, command);
        const mine = readNotice(writer);
        if (seen) deliver(writer, cutter);
        writeKept(cutter, { op: "rows", ids: ["B"] });
        if (undo) writeKept(cutter, { op: "undo" });
        if (!seen) deliver(writer, cutter);
        const beforeVector = Y.encodeStateVector(writer.doc);
        const packets = [Y.encodeStateAsUpdate(cutter.doc, beforeVector), Y.encodeStateAsUpdateV2(cutter.doc, beforeVector)];
        const deletes: Uint8Array[] = [], mapEvents: string[] = [];
        const stop = observeRemoteRemoval(writer, (_before, _after, txn) => {
          deletes.push(Y.encodeSnapshot(Y.createSnapshot(txn.deleteSet, new Map())));
        });
        const stopIds = observeRemoteBeatIds(writer, ids => mapEvents.push(...ids));
        deliver(cutter, writer);
        stop();
        stopIds();
        const merged = readNotice(writer);
        assert.deepEqual(readNotice(cutter), merged);
        assert.deepEqual(writer.doc.toJSON(), cutter.doc.toJSON());
        assert.ok(matchesEdit(writer, { id: "B", kind, person: 0, cause: "cut" }, command));
        assert.deepEqual(compareNotices(common, mine, merged).map(entry => entry.kind), undo ? [] : [kind]);
        assert.deepEqual(compareLocalChanges(mine, merged, [pending]).map(entry => entry.kind), undo ? [] : [kind]);
        assert.deepEqual(mapEvents, []);
        readings.push({ merged, stored: writer.doc.toJSON(), update: writer.encode(), packets, deletes, mapEvents,
          vector: Y.encodeStateVector(writer.doc), snapshot: Y.encodeSnapshot(Y.snapshot(writer.doc)),
          snapshotV2: Y.encodeSnapshotV2(Y.snapshot(writer.doc)) });
        if (undo) {
          const wrong = merged.map(beat => beat.id === "B" ? need(common.find(old => old.id === "B"), "original B") : beat);
          assert.deepEqual(compareNotices(common, mine, wrong).map(entry => entry.kind), [kind]);
        }
      } finally { writer.destroy(); cutter.destroy(); }
    }
    assert.deepEqual(readings[0], readings[1], `${command.op}, undo ${undo}`);
  }
  t.diagnostic("8 of 8 seen/unseen pairs matched, and 8 of 8 wrong returned readings restored a warning");
});

test("E16 notice's storage check detects a no-op status write", () => {
  const bytes = seed(specOf(base), undefined, "cells");
  const command = { op: "field", id: "B", value: "ready" } as const;
  const loss = { id: "B", kind: "record", person: 0, cause: "cut-undo" } as const;
  for (const mute of [-1, 0]) {
    const writer = openKept(bytes, 101), cutter = openKept(bytes, 102);
    try {
      watch(writer, () => writeKept(writer, command), mute, true);
      writeKept(cutter, { op: "rows", ids: ["B"] });
      writeKept(cutter, { op: "undo" });
      deliver(writer, cutter);
      deliver(cutter, writer);
      assert.equal(matchesEdit(writer, loss, command), mute === -1);
    } finally { writer.destroy(); cutter.destroy(); }
  }
});

test("E16 repeats E12's 56 tag and undo trials", () => {
  const bytes = seed(specOf(base), undefined, "cells"), tag = "t:TAG";
  for (const op of tagSweepRemovals) for (const { field, range: [from, to] } of tagSweepCases) for (const seen of [false, true]) {
    const writer = openKept(bytes, 101), cutter = openKept(bytes, 102);
    const label = [op, field, from, to, seen].join("/");
    try {
      const common = readNotice(writer);
      writeKept(writer, { op: "mark", id: "B", field, from, to, key: tag });
      const mine = readNotice(writer);
      if (seen) deliver(writer, cutter);
      if (op === "cut") writeKept(cutter, { op: "rows", ids: ["B"] });
      else writeKept(cutter, { op: "erase", id: "B", field, from: op === "same" ? from : 0,
        to: op === "same" ? to : op === "first" || field === "visual" ? 1 : 3 });
      writeKept(cutter, { op: "undo" });
      deliver(cutter, writer);
      deliver(writer, cutter);
      const merged = readNotice(writer);
      assert.deepEqual(readNotice(cutter), merged, label);
      assert.deepEqual(cutter.doc.toJSON(), writer.doc.toJSON(), label);
      const restored = need(merged.find(beat => beat.id === "B"), label);
      const expected = !seen && field === "audio" && from > 0 && (op === "cut" || op === "all");
      const lost = !restored[field === "audio" ? "narration" : "visual"].some(part => part.marks?.[tag]);
      const flagged = compareNotices(common, mine, merged).some(entry => entry.kind === "marks" && entry.id === "B");
      assert.deepEqual([lost, flagged], [expected, expected], label);
    } finally { writer.destroy(); cutter.destroy(); }
  }
});
