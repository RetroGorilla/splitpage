import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { generated, histories } from "./histories.ts";
import type { DeleteHistory } from "./histories.ts";
import { check, checkMark, load, readStored, readStyles, seed, write } from "./kit.ts";
import type { DeleteReplica } from "./kit.ts";
import { advance, base, blocks, merge, need, visible } from "./model.ts";
import type { DeleteCommand, StoredReading } from "./model.ts";

const modes = ["forward", "reverse", "twice", "shuffled", "state"] as const;
const policies = ["keep", "drop"] as const;
type Mode = typeof modes[number];
type Policy = typeof policies[number];

const methods = [
  [Y.Text.prototype, "insert"], [Y.Text.prototype, "insertEmbed"], [Y.Text.prototype, "delete"], [Y.Text.prototype, "format"],
  [Y.Map.prototype, "set"], [Y.Map.prototype, "delete"], [Y.Array.prototype, "insert"], [Y.Array.prototype, "delete"]
] as const;

function watch(replica: DeleteReplica, run: () => void, omit = -1): string[] {
  const calls: string[] = [];
  const roots = new Map<unknown, string>([[replica.beats, "beats"], [replica.visuals, "visuals"],
    [replica.segments, "segments"], [replica.headings, "headings"]]);
  const restore = methods.map(([parent, key]) => {
    const descriptor = need(Object.getOwnPropertyDescriptor(parent, key), key);
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(parent, key, { ...descriptor, value(this: unknown, ...args: unknown[]): unknown {
      const index = calls.length;
      const mapKey = parent === Y.Map.prototype ? `:${roots.get(this) ?? String(args[0])}` : "";
      calls.push(`${parent.constructor.name}.${key}${mapKey}`);
      return index === omit ? undefined : original.apply(this, args);
    } });
    return () => { Object.defineProperty(parent, key, descriptor); };
  });
  try {
    if (omit !== -2) run();
  } finally {
    for (const reset of restore) reset();
  }
  return calls;
}

interface ControlCount { used: number; effective: number; failed: number; throws: number; coverage: number }
type Controls = Map<string, ControlCount>;

function control(
  baseline: Uint8Array, command: DeleteCommand, before: StoredReading, expected: StoredReading,
  policy: Policy, calls: readonly string[], counts: Controls
): void {
  assert.ok(calls.length, `write coverage for ${command.op}`);
  for (const [omit, key] of [[-2, command.op] as const, ...calls.map((name, index) => [index, `${command.op} / ${name}`] as const)]) {
    const replica = load(baseline, 55);
    const count = counts.get(key) ?? { used: 0, effective: 0, failed: 0, throws: 0, coverage: 0 };
    counts.set(key, count);
    count.used++;
    const effective = command.op === "mark" || !isUnchanged(before, expected);
    if (effective) count.effective++;
    try {
      let replay: string[];
      try {
        replay = watch(replica, () => { write(replica, command, policy); }, omit);
      } catch {
        count.throws++;
        continue;
      }
      if (omit !== -2 && !isUnchangedCalls(replay, calls)) {
        count.coverage++;
        continue;
      }
      try {
        check(replica, [expected]);
        checkMark(replica, command);
      } catch (error) {
        if (error instanceof assert.AssertionError) count.failed++;
        else count.throws++;
      }
    } finally {
      replica.destroy();
    }
  }
}

function isUnchangedCalls(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((call, index) => call === right[index]);
}

function isUnchanged(before: StoredReading, after: StoredReading): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [result[i], result[j]] = [need(result[j], "shuffled item"), need(result[i], "shuffled item")];
  }
  return result;
}

function deliver(replica: DeleteReplica, packets: Uint8Array[], mode: Mode, seed: number): void {
  const queue = mode === "reverse" ? packets.toReversed() : mode === "twice" ? [...packets, ...packets]
    : mode === "shuffled" ? shuffled(packets, seed) : packets;
  for (const packet of queue) Y.applyUpdate(replica.doc, packet, "remote");
}

function run(history: DeleteHistory, policy: Policy, mode: Mode, number: number, controls?: Controls): StoredReading {
  const source = seed(history.initial), bytes = source.encode();
  source.destroy();
  const clients = shuffled([11, 22, 33], number);
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
        expected = advance(before, command, policy);
        const calls = controls ? watch(replica, () => { write(replica, command, policy); }) : [];
        if (!controls) write(replica, command, policy);
        check(replica, [expected]);
        checkMark(replica, command);
        if (controls && saved) control(saved, command, before, expected, policy, calls, controls);
      }
      return expected;
    });
    replicas.forEach((replica, index) => { replica.doc.off("update", need(sends[index], "sender")); });
    const full = replicas.map(replica => replica.encode());
    const alternatives = merge(history.initial, snapshots);
    if (replicas.length === 3) {
      const recipient = number % 2;
      deliver(need(replicas[recipient], "recipient"),
        mode === "state" ? [need(full[2], "third state")] : need(packets[2], "third updates"), mode, number);
      check(need(replicas[recipient], "recipient"), merge(history.initial, [
        need(snapshots[recipient], "local state"), need(snapshots[2], "third state")
      ]));
    }
    replicas.forEach((replica, index) => {
      const from = (mode === "state" ? full.map(packet => [packet]) : packets)
        .flatMap((updates, author) => author === index ? [] : updates);
      deliver(replica, from, mode, number + index);
    });
    const first = need(replicas[0], "first copy");
    const settled = check(first, alternatives);
    const late = load(first.encode(), 44);
    try {
      const styles = readStyles(first);
      for (const replica of [...replicas.slice(1), late]) {
        check(replica, [settled]);
        assert.deepEqual(readStyles(replica), styles, "formatted copies agree");
      }
    } finally {
      late.destroy();
    }
    return settled;
  } finally {
    for (const replica of replicas) replica.destroy();
  }
}

function location(reading: StoredReading, char: string): string {
  const spoken = blocks(reading).find(block => block.text.includes(char));
  if (spoken) {
    if (spoken.kind === "h") return reading.headings[spoken.id]?.removed ? `hidden:${spoken.id}` : `heading:${spoken.id}`;
    const row = visible(reading).find(entry => "id" in entry && entry.members.includes(spoken.id));
    return row && "id" in row ? `audio:${spoken.id}/${row.id}` : "stranded";
  }
  const visual = Object.keys(reading.visuals).find(id => reading.visuals[id]?.includes(char));
  if (visual) return blocks(reading).some(block => block.kind === "b" && block.id === visual) ? `visual:${visual}` : "stranded";
  return Object.values(reading.segments).some(segment => segment.units.includes(char)) ? "stranded" : "lost";
}

const counts: Controls = new Map();

for (const history of histories(1)) test(`E9 two copies: ${history.name}`, () => {
  for (const policy of policies) {
    const settled = run(history, policy, "forward", 1, counts);
    assert.equal(new Set(blocks(settled).map(block => block.id)).size, blocks(settled).length);
  }
});

test("E9 named counterexamples locate and edit surviving narration", () => {
  const expected = new Map([
    ["inline narration", ["audio:A/A", "audio:A/A"]],
    ["head narration", ["stranded", "stranded"]],
    ["tail narration", ["audio:B/B", "audio:B/B"]],
    ["sole segment narration", ["stranded", "lost"]],
    ["only beat narration", ["stranded", "lost"]],
    ["visual typing", ["lost", "lost"]],
    ["inline split", ["visual:N", "visual:N"]],
    ["head split", ["visual:N", "visual:N"]],
    ["only beat split", ["visual:N", "stranded"]],
    ["only beat split then narration", ["audio:N/N", "lost"]],
    ["join below to deleted", ["audio:C/A", "audio:C/A"]],
    ["embedded heading delete versus rename", ["audio:D/D", "audio:D/D"]],
    ["head heading delete versus rename", ["stranded", "lost"]],
    ["head heading flag versus rename", ["hidden:I", "hidden:I"]],
    ["cross segment joined", ["stranded", "stranded"]],
    ["scene beat", ["audio:D/D", "audio:D/D"]]
  ]);
  for (const history of histories(1)) {
    const outcomes = expected.get(history.name);
    if (!outcomes) continue;
    for (const [index, policy] of policies.entries()) {
      const reading = run(history, policy, "reverse", 1);
      assert.equal(location(reading, "Ω"), outcomes[index], history.name);
    }
  }
  const source = seed(need(histories(1).find(history => history.name === "inline narration"), "history").initial);
  const a = load(source.encode(), 1), b = load(source.encode(), 2);
  try {
    write(a, { op: "rows", ids: ["B"] }, "keep");
    write(b, { op: "type", id: "B", field: "audio", at: 1, value: "Ω" }, "keep");
    Y.applyUpdate(a.doc, b.encode(), "remote");
    assert.equal(location(readStored(a), "Ω"), "audio:A/A");
    write(a, { op: "erase", id: "A", field: "audio", from: 3, to: 4 }, "keep");
    assert.equal(location(readStored(a), "Ω"), "lost");
  } finally {
    source.destroy();
    a.destroy();
    b.destroy();
  }
});

test("E9 a joined row in display order is cut in storage order", () => {
  const replica = seed(base);
  try {
    replica.doc.transact(() => {
      replica.beat("C").set("place", { a: null, n: 1, u: null });
      replica.beat("A").set("joined", { into: "C", glue: " " });
    }, "hydration");
    assert.deepEqual(replica.rows().find(row => row.id === "C")?.members, ["C", "A"]);
    write(replica, { op: "rows", ids: ["C"] }, "keep");
    check(replica, [advance(base, { op: "rows", ids: ["A", "C"] }, "keep")]);
  } finally {
    replica.destroy();
  }
});

test("E9 generated histories, five delivery modes, late joiners and immediate silent-write controls", t => {
  for (const policy of policies) {
    const totals: Record<string, number> = {};
    let count = 0, ambiguous = 0;
    for (const [index, mode] of modes.entries()) for (let seed = 0; seed < 12; seed++) {
      const number = 12 * index + seed;
      for (const history of generated(number)) {
        const settled = run(history, policy, mode, number, counts);
        const forks = history.forks.map(commands => commands.reduce((state, command) => advance(state, command, policy), history.initial));
        if (merge(history.initial, forks).length > 1) ambiguous++;
        count++;
        for (const commands of history.forks) for (const command of commands) {
          if (command.op !== "type") continue;
          const place = location(settled, command.value);
          const intended = command.field === "name" ? `heading:${command.id}` : `${command.field}:${command.id}`;
          const physical = place.split("/")[0];
          const result = place === "lost" || place === "stranded" ? place
            : place.startsWith("hidden:") ? "in heading recovery"
            : physical !== intended ? "other block" : place.includes("/") && place !== `${intended}/${command.id}` ? "other row" : "same block";
          totals[result] = (totals[result] ?? 0) + 1;
        }
        const ids = blocks(settled).map(block => block.id);
        assert.equal(new Set(ids).size, ids.length, "stored block IDs unique");
      }
    }
    t.diagnostic(JSON.stringify({ policy, count, ambiguous, ...totals }));
  }
  assert.ok(counts.size > 0);
  for (const [key, count] of counts) {
    t.diagnostic(`${key}: ${count.used}/${count.effective}/${count.failed}, throws ${count.throws}, coverage gaps ${count.coverage}`);
  }
  for (const [key, count] of counts) {
    assert.deepEqual(count, { used: count.used, effective: count.used, failed: count.used, throws: 0, coverage: 0 }, key);
  }
});
