import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { DELIVERIES, study } from "../../src/native-undo/chosen-report.ts";
import { runHistory } from "../../src/native-undo/generator.ts";
import { CheckFailure } from "../../src/native-undo/harness.ts";
import type { Copy, ProbedWrite } from "../../src/native-undo/harness.ts";
import { narration, settled, world } from "./kit.ts";

const options = { steps: 40, modes: DELIVERIES, scheme: "chosen", onExtraPressUpdates: () => undefined } as const;

test("the chosen scheme uses one attribute for each simple kind and comment, and a writer-clock key for each tag", () => {
  const w = world([{ id: "R1", audioText: "abc" }], { scheme: "chosen" });
  const { replica } = w.copy("A");
  replica.format("R1", "audioText", 0, 3, { b: true, i: true, u: true, s: true, hl: true, dir: true, cue: true, "c:C1": true, "c:C2": true });
  const keySet = (offset: number): string[] => {
    const attributes = replica.cell("R1", "audioText").text.toDelta()[offset].attributes as Record<string, unknown>;
    return Object.keys(attributes).sort();
  };
  assert.deepEqual(keySet(0), ["b", "c:C1", "c:C2", "cue", "dir", "hl", "i", "s", "u"]);
  replica.format("R1", "audioText", 0, 2, { "t:T1": true });
  replica.format("R1", "audioText", 1, 3, { "t:T1": true });
  const [first, second] = keySet(1).filter(key => key.startsWith("t:"));
  for (const key of [first, second]) {
    const [name, clock, ...rest] = (key ?? "").split("\u001f");
    assert.equal(name, "t:T1");
    assert.match(clock ?? "", /^1\.[0-9a-z]+$/);
    assert.deepEqual(rest, []);
  }
  assert.notEqual(first, second);
  assert.deepEqual(keySet(0).filter(key => key.startsWith("t:")), [first]);
  assert.deepEqual(keySet(2).filter(key => key.startsWith("t:")), [second]);
});

test("tagged typing inside a seen tag keeps its own tag when the other person undoes their typing", () => {
  const w = world([{ id: "R1", audioText: "xy" }], { scheme: "chosen", auditTags: true });
  w.type("C", "R1", "audioText", 1, "run", ["t:T1"]);
  settled(w, "C typed");
  w.type("A", "R1", "audioText", 3, "s", ["t:T1"]);
  settled(w, "A typed");
  assert.ok(w.undo("C"));
  assert.deepEqual(settled(w, "C undid"), ["R1: x[s|t:T1]y (todo)"]);
  assert.equal(w.stats.tagDifferences.length, 0);
});

test("chosen keys, continuous seed 254 emits the manager update followed by null-origin cleanup", () => {
  const history = { seed: 254, steps: 40, modes: DELIVERIES, scheme: "chosen", pace: "continuous" } as const;
  assert.throws(() => runHistory(history), (error: Error) =>
    error instanceof CheckFailure && /C undo: 2 Yjs update events/.test(error.message));
  const origins: unknown[] = [], extra: unknown[][] = [];
  const run = runHistory({
    ...history,
    prepare: w => {
      for (const copy of w.copies) copy.replica.doc.on("update", (_update, origin) => {
        if (copy.current) origins.push(origin === copy.layer.manager ? "UndoManager" : origin);
      });
    },
    onExtraPressUpdates: count => { extra.push(origins.slice(-count)); }
  });
  assert.deepEqual(extra, [["UndoManager", null]]);
  assert.equal(run.stats.pressUpdates[2], 1);
  assert.deepEqual(run.losses, []);
  assert.equal(run.stats.checks, 3);
});

for (const scheme of ["act", "name", "chosen"] as const) {
  test(`${scheme} keys, reversed tag undo and redo clean up the original start marker`, () => {
    for (const mode of ["reverse", "forward", "merged"] as const) {
      const w = world([{ id: "R1", audioText: "", visualText: "vr" }], { scheme, auditTags: true });
      const b = w.copy("B"), c = w.copy("C");
      const tagged = ["R1:  / [vr|t:T1] (todo)"];
      w.command("B", [{ do: "format", beat: "R1", field: "visualText", from: 0, to: 2, mark: "t:T1", on: true }]);
      assert.deepEqual(settled(w, "tag"), tagged);
      const tagStart = (update: Uint8Array) => Y.decodeUpdate(update).structs.find(item =>
        item instanceof Y.Item && item.content instanceof Y.ContentFormat && item.content.value === true);
      const original = b.log[0] && tagStart(b.log[0].update);
      assert.ok(original);
      assert.ok(w.undo("B"));
      assert.ok(w.redo("B"));
      const updates = b.log.slice(1).map(entry => entry.update);
      assert.equal(updates.length, 2);
      const restored = updates[1] && tagStart(updates[1]);
      assert.ok(restored);
      assert.notEqual(restored.id.clock, original.id.clock);
      const cleanup: Uint8Array[] = [];
      c.replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin === null) cleanup.push(update); });
      if (mode === "merged") Y.applyUpdate(c.replica.doc, Y.mergeUpdates(updates), "remote");
      else w.deliver("B", "C", mode);
      assert.deepEqual(cleanup.map(update => [...Y.decodeUpdate(update).ds.clients].map(([client, ranges]) =>
        [client, ranges.map(range => [range.clock, range.len])])),
      mode === "reverse" ? [[[b.client, [[original.id.clock, 1]]]]] : []);
      assert.deepEqual(settled(w, mode), tagged);
      assert.equal(w.stats.tagDifferences.length, 0);
      for (const { replica } of w.copies) replica.destroy();
    }
  });
}

test("undoing a plain insertion can clear the space someone else typed with a tag", () => {
  const w = world([{ id: "R1", audioText: "xy" }], { clients: [3, 2, 1], scheme: "chosen", auditTags: true });
  w.type("C", "R1", "audioText", 1, "run ", ["t:T1"]);
  assert.deepEqual(settled(w, "tagged typing"), ["R1: x[run |t:T1]y (todo)"]);
  w.type("A", "R1", "audioText", 4, "U");
  w.deliver("A", "B");
  assert.ok(w.undo("A"));
  w.type("B", "R1", "audioText", 3, "Z");
  assert.deepEqual(settled(w, "merge"), ["R1: x[ru|t:T1]Z[n|t:T1] y (todo)"]);
  assert.deepEqual(w.stats.tagDifferences.map(({ copy, value, kind, requests }) => [copy, value, kind, requests]), [
    ["settled", " ", "t:T1", [1]]
  ]);
});

test("a tag on one letter can pick up unseen plain typing just before its range", () => {
  const w = world([{ id: "R1", audioText: "vw" }], { scheme: "chosen", auditTags: true });
  w.command("A", [{ do: "format", beat: "R1", field: "audioText", from: 1, to: 2, mark: "t:T1", on: true }]);
  w.type("B", "R1", "audioText", 1, "mm");
  assert.deepEqual(settled(w, "merge"), ["R1: v[mmw|t:T1] (todo)"]);
  const extra = w.stats.tagDifferences.filter(item => item.copy === "settled");
  assert.deepEqual(extra.map(({ value, requests }) => [value, requests]), [["m", []], ["m", []]]);
  w.command("B", [{ do: "format", beat: "R1", field: "audioText", from: 1, to: 3, mark: "t:T1", on: false }]);
  assert.deepEqual(settled(w, "untagged the insertion"), ["R1: vmm[w|t:T1] (todo)"]);
});

test("all E3 command disagreements under plain and chosen keys are classified", () => {
  const shared = {
    "A: redundant simple on": 102, "A: format pending integration": 1, "A: restored tagged text": 1, "A: restored bold text": 1,
    "B: simple mark outside expected range": 2, "C: tag on never-requested text": 1
  };
  const plain = study("name", "mixed"), chosen = study("chosen", "mixed");
  assert.deepEqual(plain.failures, []);
  assert.deepEqual(chosen.failures, []);
  assert.equal(plain.counters.uncertainCommands, 131);
  assert.equal(chosen.counters.uncertainCommands, 108);
  assert.equal(plain.correctedCommandDisagreements, 0);
  assert.equal(chosen.correctedCommandDisagreements, 0);
  assert.deepEqual(plain.commands, { ...shared, "A: redundant tag on": 23, "marker-only on": 6, "marker-only off": 1 });
  assert.deepEqual(chosen.commands, { ...shared, "marker-only on": 3, "marker-only off": 1 });
});

for (const mode of DELIVERIES) {
  test(`chosen keys, ${mode}: all 600 histories agree, with the measured tag differences`, () => {
    const result = study("chosen", mode);
    assert.deepEqual(result.failures, []);
    assert.equal(result.completed, 600);
    assert.equal(result.counters.checks, 1800);
    assert.equal(result.textOrFieldLosses, 0);
    assert.equal(result.counters.uncertainPresses, 282);
    assert.equal(result.counters.skippedToOlder, 43);
    assert.equal(result.counters.differentStep, 51);
    assert.deepEqual(result.updates, { 0: 1745, 1: 3040, 2: 1 });
    assert.deepEqual(result.multiUpdate, [{ pace: "continuous", seed: 254, count: 2 }]);
    assert.equal(result.missing.settledHistories, 4);
    assert.equal(result.missing.settledCharacters, 4);
  });
}

test("tagging a letter while someone else deletes and restores it can leave the restored letter plain", () => {
  const w = world([{ id: "R1", audioText: "abc" }], { scheme: "chosen", auditTags: true });
  w.erase("B", "R1", "audioText", 2, 3);
  assert.ok(w.undo("B"));
  w.command("A", [{ do: "format", beat: "R1", field: "audioText", from: 2, to: 3, mark: "t:T1", on: true }]);
  assert.equal(narration(w, "R1"), "ab[c|t:T1]");
  assert.deepEqual(settled(w, "merge"), ["R1: abc (todo)"]);
  assert.deepEqual(w.stats.tagDifferences.map(({ copy, value, kind, requests }) => [copy, value, kind, requests]), [
    ["settled", "c", "t:T1", [3]]
  ]);
});

const histories = (["batched", "continuous"] as const).flatMap(pace =>
  Array.from({ length: 300 }, (_, seed) => ({ ...options, pace, seed })));
const baseline = histories.map(history => runHistory(history).stats);

const muteFormat = (copy: Copy, omit: (mark: string, value: true | null) => boolean): void => {
  const { replica } = copy, format = replica.format.bind(replica);
  replica.format = (beat, field, from, to, marks) => {
    const kept = Object.fromEntries(Object.entries(marks).filter(([kind, value]) => !omit(kind, value)));
    if (Object.keys(kept).length) format(beat, field, from, to, kept);
  };
};

function muteFreshTypingTag({ replica }: Copy): void {
  const splice = replica.splice.bind(replica);
  replica.splice = (beat, field, from, to, insert) => {
    const { text } = replica.cell(beat, field), format = text.format;
    text.format = (index, length, attrs) => {
      const kept = Object.fromEntries(Object.entries(attrs).filter(([key, value]) =>
        !(value === true && key.startsWith("t:"))));
      if (Object.keys(kept).length) format.call(text, index, length, kept);
    };
    try { splice(beat, field, from, to, insert); } finally { text.format = format; }
  };
}

const muted: Record<ProbedWrite, (copy: Copy) => void> = {
  type: ({ layer }) => { layer.type = () => undefined; },
  freshTypingTag: muteFreshTypingTag,
  erase: ({ layer }) => { layer.erase = () => undefined; },
  format: copy => { muteFormat(copy, kind => !kind.startsWith("t:")); },
  tag: copy => { muteFormat(copy, (kind, value) => kind.startsWith("t:") && value === true); },
  untag: copy => { muteFormat(copy, (kind, value) => kind.startsWith("t:") && value === null); },
  split: ({ replica }) => { replica.split = () => undefined; },
  join: ({ replica }) => {
    const setField = replica.setField.bind(replica);
    replica.setField = (beat, key, value) => { if (key !== "joined") setField(beat, key, value); };
    replica.unjoin = () => undefined;
  },
  field: ({ layer }) => { layer.setRecordField = () => undefined; },
  undo: ({ layer }) => { layer.undo = () => null; },
  redo: ({ layer }) => { layer.redo = () => null; }
};

for (const [command, mute] of Object.entries(muted) as [ProbedWrite, (copy: Copy) => void][]) {
  test(`chosen keys, ${command} no-op fails every history with an effective write`, t => {
    let used = 0, effective = 0, failed = 0, other = 0;
    const missed: string[] = [];
    for (const [index, history] of histories.entries()) {
      const stats = baseline[index];
      if (stats?.used.has(command)) used++;
      const changes = stats?.effective.has(command);
      if (changes) effective++;
      try {
        runHistory({ ...history, prepare: w => { w.copies.forEach(mute); } });
        if (changes) missed.push(`${history.pace}/${history.seed}`);
      } catch (error) {
        assert.ok(error instanceof CheckFailure, String(error));
        if (changes) failed++; else other++;
      }
    }
    t.diagnostic(`${command}: ${used} used, ${effective} effective, ${failed} failed, ${other} other failures`);
    if (command === "freshTypingTag") assert.deepEqual({ used, effective }, { used: 422, effective: 422 });
    assert.ok(effective > 0);
    assert.deepEqual(missed, []);
    assert.equal(failed, effective);
  });
}
