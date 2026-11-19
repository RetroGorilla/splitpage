import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { nativeMarkName } from "../../src/native/variant.ts";
import type { NativeDeltaItem, NativeField } from "../../src/native/variant.ts";
import { joinUp } from "../../src/native/rows.ts";
import { generated, histories } from "../native-delete/histories.ts";
import type { DeleteHistory } from "../native-delete/histories.ts";
import { merge, need } from "../native-delete/model.ts";
import type { DeleteCommand, StoredReading, VisibleEntry } from "../native-delete/model.ts";
import { neverAcceptable, reachability } from "./check.ts";
import { MODES, deliver, readStored, readStyles, shuffled, watch } from "./engine.ts";
import type { Mode } from "./engine.ts";
import { load, seed, specOf } from "./kit.ts";
import { advanceChosen, ownership, ruleView } from "./model.ts";

const field = (name: "audio" | "visual"): NativeField => name === "audio" ? "audioText" : "visualText";

export function writeE9(replica: ChosenReplica, command: DeleteCommand): void {
  switch (command.op) {
    case "rows": replica.deleteRows(command.ids); break;
    case "scene": {
      const outline = replica.outline(), start = outline.findIndex(entry => entry.kind === "heading" && entry.id === command.id), rows: string[] = [];
      for (const entry of outline.slice(start + 1)) { if (entry.kind === "heading") break; rows.push(entry.row.id); }
      replica.transact(() => { replica.deleteRows(rows); replica.removeHeading(command.id); });
      break;
    }
    case "heading": replica.removeHeading(command.id); break;
    case "type":
      if (command.field === "name") replica.typeHeading(command.id, command.at, command.value);
      else replica.splice(command.id, field(command.field), command.at, command.at, [{ text: command.value, marks: {} }]);
      break;
    case "erase":
      if (command.field === "name") replica.deleteHeadingText(command.id, command.from, command.to);
      else replica.splice(command.id, field(command.field), command.from, command.to, []);
      break;
    case "mark": replica.format(command.id, field(command.field), command.from, command.to, { [command.key]: true }); break;
    case "field": replica.setField(command.id, "status", command.value); break;
    case "split": replica.split(command.id, command.at, command.created, { status: "new" }); break;
    case "insert": replica.insertBeat(command.before, command.created, command.value, { status: "new" }); break;
    case "join": assert.equal(joinUp(replica, command.id), true); break;
    case "unjoin": replica.unjoin(command.id); break;
    case "create": replica.createHeading(command.above, command.id, command.value); break;
  }
}

const plain = (delta: readonly NativeDeltaItem[]): string => delta.map(item => typeof item.insert === "string" ? item.insert : "□").join("");

export function readVisible(replica: ChosenReplica): VisibleEntry[] {
  return replica.outline().map(entry => {
    if (entry.kind === "heading") return { heading: entry.id, name: plain(entry.name) };
    const { id, members, audio, visual, fields } = entry.row, status = fields.status;
    return { id, members, audio: plain(audio), visual: plain(visual), ...typeof status === "string" && { status } };
  });
}

// why: the stored state must be one the model allows, the rows must be the model's rule reading of it, and nothing
// stored may be out of reach
function check(replica: ChosenReplica, alternatives: readonly StoredReading[]): StoredReading {
  const actual = readStored(replica), expected = alternatives.find(option => isDeepStrictEqual(actual, option));
  if (!expected) assert.deepEqual(actual, alternatives[0], "stored state");
  const accepted = need(expected, "expected state");
  assert.deepEqual(readVisible(replica), ruleView(accepted), "rows under the reading rules");
  assert.deepEqual(neverAcceptable(reachability(replica)), [], "reachability");
  return accepted;
}

function checkMark(replica: ChosenReplica, command: DeleteCommand): void {
  if (command.op !== "mark") return;
  const pieces = replica.spansOf(command.id, field(command.field));
  const marks = pieces.flatMap(span => (span.text.toDelta() as NativeDeltaItem[]).flatMap(part =>
    Array.from({ length: typeof part.insert === "string" ? part.insert.length : 1 }, () =>
      Object.entries(part.attributes ?? {}).some(([key, value]) => value === true && nativeMarkName(key) === command.key))).slice(span.start, span.end));
  assert.deepEqual(marks.slice(command.from, command.to), Array(command.to - command.from).fill(true), "marked characters");
}

interface ControlCount { used: number; effective: number; failed: number; throws: number; coverage: number }
export type Controls = Map<string, ControlCount>;

function control(baseline: Uint8Array, command: DeleteCommand, before: StoredReading, expected: StoredReading, calls: readonly string[], counts: Controls): void {
  assert.ok(calls.length, `write coverage for ${command.op}`);
  for (const [omit, key] of [[-2, `${command.op} / whole command`] as const, ...calls.map((name, index) => [index, `${command.op} / ${name}`] as const)]) {
    const replica = load(baseline, 55), count = counts.get(key) ?? { used: 0, effective: 0, failed: 0, throws: 0, coverage: 0 };
    counts.set(key, count);
    count.used++;
    if (command.op === "mark" || !isDeepStrictEqual(before, expected)) count.effective++;
    try {
      let replay: string[];
      try { replay = watch(replica, () => { writeE9(replica, command); }, omit); } catch { count.throws++; continue; }
      if (omit !== -2 && !isDeepStrictEqual(replay, calls)) { count.coverage++; continue; }
      try { check(replica, [expected]); checkMark(replica, command); } catch (error) {
        if (error instanceof assert.AssertionError) count.failed++; else count.throws++;
      }
    } finally { replica.destroy(); }
  }
}

export function runE9(history: DeleteHistory, mode: Mode, number: number, controls?: Controls): StoredReading {
  const bytes = seed(specOf(history.initial)), clients = shuffled([11, 22, 33], number);
  const replicas = history.forks.map((_, index) => load(bytes, need(clients[index], "client id")));
  const packets = replicas.map((): Uint8Array[] => []);
  const sends = replicas.map((_, index) => (packet: Uint8Array): void => { need(packets[index], "packets").push(packet); });
  try {
    replicas.forEach((replica, index) => { replica.doc.on("update", need(sends[index], "sender")); });
    const snapshots = history.forks.map((commands, index) => {
      const replica = need(replicas[index], "writer");
      let expected = history.initial;
      for (const command of commands) {
        const before = expected, saved = controls ? replica.encode() : undefined;
        expected = advanceChosen(before, command);
        const calls = controls ? watch(replica, () => { writeE9(replica, command); }) : [];
        if (!controls) writeE9(replica, command);
        check(replica, [expected]);
        checkMark(replica, command);
        if (controls && saved) control(saved, command, before, expected, calls, controls);
      }
      return expected;
    });
    replicas.forEach((replica, index) => { replica.doc.off("update", need(sends[index], "sender")); });
    const full = replicas.map(replica => replica.encode()), alternatives = merge(history.initial, snapshots);
    if (replicas.length === 3) {
      const recipient = need(replicas[number % 2], "recipient");
      deliver(recipient, mode === "state" ? [need(full[2], "third state")] : need(packets[2], "third updates"), mode, number);
      check(recipient, merge(history.initial, [need(snapshots[number % 2], "local state"), need(snapshots[2], "third state")]));
    }
    replicas.forEach((replica, index) => {
      deliver(replica, (mode === "state" ? full.map(packet => [packet]) : packets).flatMap((updates, author) => author === index ? [] : updates), mode, number + index);
    });
    const first = need(replicas[0], "first copy"), settled = check(first, alternatives), late = load(first.encode(), 44);
    try {
      const styles = readStyles(first);
      for (const replica of [...replicas.slice(1), late]) {
        check(replica, [settled]);
        assert.deepEqual(readStyles(replica), styles, "copies agree");
      }
    } finally { late.destroy(); }
    return settled;
  } finally { for (const replica of replicas) replica.destroy(); }
}

export function located(reading: StoredReading, char: string): string {
  const entry = ownership(reading).entries.find(item => item.spans.some(span => span.text.includes(char)));
  if (entry) {
    if (entry.kind === "h") return reading.headings[entry.id]?.removed ? `hidden:${entry.id}` : `heading:${entry.id}`;
    const row = ruleView(reading).find(item => "id" in item && item.members.includes(entry.id));
    return row && "id" in row ? `audio:${entry.id}/${row.id}` : "stranded";
  }
  if (ownership(reading).stray.some(span => span.text.includes(char))) return "audio:~stray";
  const visual = Object.keys(reading.visuals).find(id => reading.visuals[id]?.includes(char));
  if (visual) return ownership(reading).entries.some(item => item.kind === "b" && item.id === visual) ? `visual:${visual}` : "stranded";
  return Object.values(reading.segments).some(segment => segment.units.includes(char)) ? "stranded" : "lost";
}

const counts: Controls = new Map();
const E9_KEEP: Record<string, string> = {
  "inline narration": "audio:A/A", "head narration": "stranded", "tail narration": "audio:B/B", "sole segment narration": "stranded",
  "only beat narration": "stranded", "visual typing": "lost", "inline split": "visual:N", "head split": "visual:N", "only beat split": "visual:N",
  "only beat split then narration": "audio:N/N", "join below to deleted": "audio:C/A", "embedded heading delete versus rename": "audio:D/D",
  "head heading delete versus rename": "stranded", "head heading flag versus rename": "hidden:I", "cross segment joined": "stranded", "scene beat": "audio:D/D"
};

for (const history of histories(1)) test(`E11 rerun of E9, two copies: ${history.name}`, () => { runE9(history, "forward", 1, counts); });

test("E11 rerun of E9: where the typed letter ends up, against E9's keep-segment result", t => {
  const rows: Record<string, string> = {};
  for (const history of histories(1)) {
    const now = located(runE9(history, "reverse", 1), "Ω");
    assert.notEqual(now, "stranded", history.name);
    if (E9_KEEP[history.name] !== undefined || now !== "lost") rows[history.name] = `${E9_KEEP[history.name] ?? "-"} -> ${now}`;
  }
  t.diagnostic(JSON.stringify(rows));
});

test("E11 rerun of E9: generated histories, five delivery modes, late joiners and silent-write controls", t => {
  const totals: Record<string, number> = {}, hiddenNarration = new Map<string, number>();
  let count = 0;
  for (const [index, mode] of MODES.entries()) for (let number = 0; number < 12; number++) {
    const seedNumber = 12 * index + number;
    for (const history of generated(seedNumber)) {
      const settled = runE9(history, mode, seedNumber, counts);
      count++;
      for (const commands of history.forks) for (const command of commands) {
        if (command.op !== "type") continue;
        const place = located(settled, command.value), kind = place.split(/[:/]/)[0] ?? place;
        totals[`${command.field} -> ${kind}`] = (totals[`${command.field} -> ${kind}`] ?? 0) + 1;
        assert.notEqual(place, "stranded", `${history.name}: ${command.value}`);
        if (command.field === "audio" && kind === "hidden") hiddenNarration.set(history.name, (hiddenNarration.get(history.name) ?? 0) + 1);
      }
      const ids = ownership(settled).entries.map(entry => entry.id);
      assert.equal(new Set(ids).size, ids.length, "each block once");
    }
  }
  t.diagnostic(JSON.stringify({ count, ...totals, narrationInRemovedHeading: Object.fromEntries(hiddenNarration) }));
  // why: the one never-acceptable result found here, reported in RESULT.md; pinned so a change to it is noticed
  assert.deepEqual([...hiddenNarration.keys()], ["scene beat"]);
  for (const [key, value] of counts) t.diagnostic(`${key}: used ${value.used}, effective ${value.effective}, failed ${value.failed}, throws ${value.throws}, coverage ${value.coverage}`);
  for (const [key, value] of counts) {
    assert.deepEqual([value.effective, value.failed + value.throws, value.coverage], [value.used, value.used, 0], key);
    if (value.throws) assert.match(key, /(e10Rank|:headings)$/, `${key}: only a missing rank or heading record may throw`);
  }
});
