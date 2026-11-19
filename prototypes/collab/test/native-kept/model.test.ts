import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { KeptReplica } from "../../src/native-kept/replica.ts";
import { nativeMarkName } from "../../src/native/variant.ts";
import type { NativeDeltaItem } from "../../src/native/variant.ts";
import { neverAcceptable, reachability } from "../native-chosen/check.ts";
import { deliver, MODES, readStyles, watch } from "../native-chosen/engine.ts";
import type { Mode } from "../native-chosen/engine.ts";
import { b, h, outline, seed } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { need } from "../native-delete/model.ts";
import { KeptProbeModel, probeHistory } from "./model.ts";
import type { KeepHistory, KeepProbe, ProbeState } from "./model.ts";
import { openCopy, runCommand } from "./replay.ts";
import type { KeptCommand } from "./replay.ts";

export const probeSpec: Spec = {
  order: ["S", "T"],
  segments: { S: { head: b("A"), units: ["abc", b("B"), "def", b("C"), "ghi"] }, T: { head: h("H"), units: ["title"] } },
  beats: { A: {}, B: { status: "todo", lens: "normal" }, C: {} },
  visuals: { A: "1", B: "2", C: "3" },
  headings: { H: {} }
};

function command(history: KeepHistory, op: KeepProbe): KeptCommand {
  switch (op) {
    case "cut": return { op: "delete", rows: ["B"] };
    case "undoCut": case "undoCreate": return { op: "undo" };
    case "redoCut": return { op: "redo" };
    case "visual": return { op: "type", id: "B", field: "visual", at: 1, text: history.glyph };
    case "status": return { op: "field", id: "B", key: "status", value: "ready" };
    case "lens": return { op: "field", id: "B", key: "lens", value: "wide" };
    case "visualTag": case "audioTag": return { op: "format", id: "B", field: op === "visualTag" ? "visual" : "audio", from: 0, to: 1, key: "t:prop", on: true };
    case "move": return { op: "move", drop: { unit: "row", first: "B", target: null, after: false, intoScene: "H" } };
    case "create":
      if (history.shape === "heading undo") return { op: "heading", above: "C", id: "J", text: "draft" };
      if (history.shape === "insert undo") return { op: "insert", before: "A", id: "N", text: "qr" };
      return { op: "split", id: "A", at: 1, created: "N" };
    case "newAudio": return { op: "type", id: "N", field: "audio", at: 1, text: "Z" };
    case "newVisual": return { op: "type", id: "N", field: "visual", at: 0, text: history.glyph };
    case "newStatus": return { op: "field", id: "N", key: "status", value: "ready" };
    case "rename": return { op: "type", id: "J", field: "name", at: 5, text: history.glyph };
    case "typeA": return { op: "type", id: "A", field: "audio", at: 1, text: "β" };
    case "typeC": return { op: "type", id: "C", field: "audio", at: 1, text: "γ" };
  }
}

const tag = (items: readonly NativeDeltaItem[]): boolean =>
  items.some(item => Object.entries(item.attributes ?? {}).some(([key, value]) => value === true && nativeMarkName(key) === "t:prop"));

function check(replica: ChosenReplica, expected: ProbeState, context: string): void {
  assert.deepEqual(outline(replica), expected.rows, context);
  const bRow = replica.rows().find(row => row.id === "B"), record = replica.beats.get("B");
  const fields = Object.fromEntries(["status", "lens"].flatMap(key => record?.has(key) ? [[key, record.get(key)]] : []));
  assert.deepEqual(fields, expected.fields, context);
  assert.equal(typeof record?.get("e10Rank") === "string", expected.rank, context);
  assert.equal(replica.visuals.get("B")?.toString() ?? null, expected.visual, context);
  assert.equal(tag((replica.visuals.get("B")?.toDelta() ?? []) as NativeDeltaItem[]), expected.visualTag, context);
  if (expected.audioTag !== null) assert.equal(tag(bRow?.audio ?? []), expected.audioTag, context);
  assert.equal(replica.visuals.get("N")?.toString() ?? null, expected.createdVisual, context);
  assert.equal(replica.beats.get("N")?.get("status") ?? null, expected.createdStatus, context);
  assert.deepEqual([...replica.beats.keys()].filter(id => !replica.rows().some(row => row.members.includes(id))), expected.removed, context);
  if (replica instanceof KeptReplica) {
    const before = Y.snapshot(replica.doc);
    const notice = replica.readOrphan("B");
    if (expected.removed.length) {
      assert.ok(notice, context);
      assert.deepEqual(Object.fromEntries(Object.entries(notice.fields).filter(([key]) => key !== "e10Rank")), expected.fields, context);
      assert.equal(typeof notice.fields.e10Rank, "string", context);
      assert.equal(notice.visual.map(item => item.insert).join(""), expected.visual, context);
      assert.equal(tag(notice.visual), expected.visualTag, context);
    } else assert.equal(notice, null, context);
    assert.ok(Y.equalSnapshots(Y.snapshot(replica.doc), before), context);
  }
  assert.deepEqual(neverAcceptable(reachability(replica)), [], context);
}

interface Trial {
  step: number;
  callIndex: number;
  call: string;
}

const initial = seed(probeSpec, undefined, "cells");

function run(history: KeepHistory, keep: boolean, mode: Mode, number: number, trial?: Trial, introduce?: (trial: Trial) => void): ProbeState | null {
  const model = new KeptProbeModel(history, keep), copies = [openCopy(initial, 1, keep), openCopy(initial, 2, keep)] as const;
  const sent = [new Set<number>(), new Set<number>()] as const, packets: Uint8Array[] = [];
  for (const [i, copy] of copies.entries()) copy.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") need(sent[i], "update set").add(packets.push(update) - 1);
  });
  const send = (from: number, to: number): void => {
    const known = need(sent[to], "receiving update set");
    const missing = [...need(sent[from], "sending update set")].filter(key => !known.has(key)).sort((a, b) => a - b);
    for (const key of missing) known.add(key);
    const [source, target] = [need(copies[from], "source copy"), need(copies[to], "target copy")];
    if (mode === "state") Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
    else deliver(target, missing.map(key => need(packets[key], "packet")), mode, number);
  };
  try {
    for (const [index, step] of history.steps.entries()) {
      const actor = "to" in step ? step.to : step.by, copy = need(copies[actor], "acting copy");
      const before = model.expected(actor);
      model.step(step, index);
      const expected = model.expected(actor), label = `${history.shape} seed ${number} ${mode} keep=${keep} step ${index}`;
      if ("to" in step) send(step.from, step.to);
      else {
        const action = (): void => runCommand(copy, command(history, step.op));
        const control = keep && ["cut", "undoCut", "redoCut"].includes(step.op);
        if (control && (introduce || trial?.step === index)) {
          const muted = trial?.step === index;
          const calls = watch(copy, action, muted ? trial.callIndex : -1);
          assert.equal(calls.length, 1, "control covers the complete command call sequence");
          if (muted) {
            assert.equal(calls[trial.callIndex], trial.call, "control reached the selected Yjs call");
            assert.notDeepEqual(before, expected, "control command must have an expected effect");
            assert.throws(() => check(copy, expected, label), { code: "ERR_ASSERTION" }, `${label} mute ${trial.call}`);
            return null;
          }
          calls.forEach((call, callIndex) => introduce?.({ step: index, callIndex, call }));
        } else action();
      }
      check(copy, expected, label);
    }
    for (let round = 0; round < 4; round++) { send(0, 1); send(1, 0); }
    const late = openCopy(copies[0].encode(), 3, keep);
    try {
      const expected = model.expected();
      for (const copy of [...copies, late]) {
        check(copy, expected, `${history.shape} seed ${number} ${mode} keep=${keep} settled`);
        assert.deepEqual(readStyles(copy), readStyles(copies[0]));
      }
      return { ...expected, audioTag: tag(copies[0].rows().find(row => row.id === "B")?.audio ?? []) };
    } finally { late.destroy(); }
  } finally {
    for (const copy of copies) copy.destroy();
  }
}

test("E14 model comparisons after each command, delivery and late load", t => {
  const totals = { built: {} as Record<string, number>, kept: {} as Record<string, number> };
  for (let n = 0; n < 360; n++) {
    const history = probeHistory(n);
    for (const keep of [false, true]) for (const mode of MODES) {
      const expected = run(history, keep, mode, n);
      assert.ok(expected);
      if (mode !== "forward") continue;
      const count = keep ? totals.kept : totals.built;
      const add = (key: string): void => { count[key] = (count[key] ?? 0) + 1; };
      add(history.shape);
      if (["never undone", "undo offline", "undo after move", "redo"].includes(history.shape)) {
        if (expected.visual?.endsWith(history.glyph)) add(`${history.shape}: latest visual`);
        if (expected.visualTag) add(`${history.shape}: visual tag`);
        if (expected.audioTag) add(`${history.shape}: narration tag`);
        if (expected.fields.status === "ready") add(`${history.shape}: latest status`);
        if (expected.fields.lens === "wide") add(`${history.shape}: latest lens`);
        if (expected.rows.at(-1)?.startsWith("B:")) add(`${history.shape}: unseen move shown`);
        if (!expected.rank && expected.rows.some(row => row.startsWith("B:"))) add(`${history.shape}: missing rank`);
      }
    }
  }
  t.diagnostic(JSON.stringify(totals));
});

test("E14 silent Yjs call controls fail the command assertion", t => {
  const counts: Record<string, { used: number; effective: number; failed: number }> = {};
  for (let n = 0; n < 360; n++) {
    const history = probeHistory(n), trials: Trial[] = [];
    run(history, true, "forward", n, undefined, trial => trials.push(trial));
    for (const trial of trials) {
      const step = need(history.steps[trial.step], "controlled step");
      assert.ok("op" in step);
      const key = `${step.op} / ${trial.call}`, count = counts[key] ??= { used: 0, effective: 0, failed: 0 };
      count.used++;
      assert.equal(run(history, true, "forward", n, trial), null, "control ended at the muted command");
      count.effective++;
      count.failed++;
    }
  }
  t.diagnostic(JSON.stringify(counts));
  assert.ok(Object.values(counts).every(count => count.used > 0 && count.used === count.effective && count.effective === count.failed));
});
