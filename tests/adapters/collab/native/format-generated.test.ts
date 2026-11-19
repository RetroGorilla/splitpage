import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import type { NativeMarkChange } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeDeltaItem } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { RaceWorld, cellOf, deleteRange, deltaOf, firstDifference, formatRange, printCell, readCell, typeAt } from "./format-harness.ts";
import type { RaceChar, RaceWriter } from "./format-harness.ts";
import { shown } from "./helpers.ts";

after(() => { dom.window.close(); });

const SEEDS = 30, STEPS = 80, CONTROL_SEEDS = 3;
const TARGETS: readonly NativeTextTarget[] = [{ beat: "one", cell: "narration" }, { beat: "one", cell: "visual" }];
const TAGS = ["t_lamp", "t_rope"];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

type Fault = "format(value)" | "format(null)";
interface Call { readonly command: number; readonly slot: number; readonly fault: Fault }
interface Options { readonly immediate?: boolean; readonly mute?: Call; readonly calls?: Call[] }
interface Application { readonly seq: number; readonly by: number; readonly tag: string; readonly target: number; readonly letters: readonly string[] }
interface Untag { readonly tag: string; readonly target: number; readonly letters: readonly string[]; readonly seen: ReadonlySet<number> }

class LocalCheck extends Error {}

function intercept(text: Y.Text, command: number, options: Options): () => void {
  const { format } = text;
  let slot = 0;
  text.format = function (index, length, attributes) {
    const call: Call = { command, slot: slot++, fault: Object.values(attributes).includes(true) ? "format(value)" : "format(null)" };
    options.calls?.push(call);
    if (options.mute?.command === call.command && options.mute.slot === call.slot) { assert.equal(options.mute.fault, call.fault); return; }
    format.call(this, index, length, attributes);
  };
  return () => { text.format = format; };
}

const view = (writer: RaceWriter, target: NativeTextTarget): RaceChar[] => readCell(deltaOf(writer.script, target), true);
const named = (char: RaceChar, names: string[]): RaceChar => ({ ch: char.ch, names: names.sort() });

// why: the expected tags come from the commands issued and what each writer had received when it issued them; a
// requested letter is excused only when deleted, or when an untag of that tag covered it after seeing the application
function history(seed: number, options: Options = {}) {
  const chance = random(seed), pick = <T>(list: readonly T[]): T => list[Math.floor(chance() * list.length)] as T;
  const world = new RaceWorld({ one: { audioText: "abcdefghij", visualText: "klmnopqrst" } }, [1, 2, 3]);
  const applications: Application[] = [], untags: Untag[] = [], outcomes: Record<string, number> = {};
  const pulledAt = world.writers.map(() => 0);
  let seq = 0, fresh = 0;
  const seen = (by: number, application: Application): boolean => application.by === by || application.seq < (pulledAt[by] ?? 0);
  try {
    for (let step = 0; step < STEPS; step++) {
      const by = Math.floor(chance() * world.writers.length), writer = world.writers[by] as RaceWriter, target = Math.floor(chance() * TARGETS.length);
      const cell = TARGETS[target] as NativeTextTarget, before = view(writer, cell), roll = chance();
      if (roll < 0.15) { world.pull(writer); pulledAt[by] = seq; continue; }
      const from = Math.floor(chance() * before.length), to = from + 1 + Math.floor(chance() * Math.min(4, before.length - from)), tag = pick(TAGS);
      const command = seq++;
      let want: RaceChar[], act: () => string;
      if (roll < 0.5 && before.length) {
        applications.push({ seq: command, by, tag, target, letters: before.slice(from, to).map(char => char.ch) });
        want = before.map((char, index) => index >= from && index < to ? named(char, [...char.names, "t:" + tag]) : char);
        act = () => formatRange(writer, cell, from, to, { kind: "tag", id: tag, on: true });
      } else if (roll < 0.65 && before.length) {
        const sawApplications = new Set(applications.filter(application => application.tag === tag && seen(by, application)).map(application => application.seq));
        untags.push({ tag, target, letters: before.slice(from, to).map(char => char.ch), seen: sawApplications });
        want = before.map((char, index) => index >= from && index < to ? named(char, char.names.filter(name => name !== "t:" + tag)) : char);
        act = () => formatRange(writer, cell, from, to, { kind: "tag", id: tag, on: false });
      } else if (roll < 0.9 || !before.length) {
        const at = Math.floor(chance() * (before.length + 1)), letters = Array.from({ length: 1 + Math.floor(chance() * 2) }, () => String.fromCharCode(0x4e00 + fresh++));
        want = [...before.slice(0, at), ...letters.map(ch => ({ ch, names: [] })), ...before.slice(at)];
        act = () => typeAt(writer, cell, at, letters.join(""));
      } else {
        const end = Math.min(before.length, from + 1 + Math.floor(chance() * 2));
        want = [...before.slice(0, from), ...before.slice(end)];
        act = () => deleteRange(writer, cell, from, end);
      }
      const restore = intercept(cellOf(writer, cell), command, options);
      let outcome: string;
      try { outcome = act(); } finally { restore(); }
      writer.script.reader.refresh();
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      const got = view(writer, cell);
      if (options.immediate !== false && firstDifference(want, got) >= 0) throw new LocalCheck(`seed ${seed}, command ${command}: ${printCell(want)} vs ${printCell(got)}`);
    }
    world.pullAll(); world.pullAll();
    const [first] = world.writers;
    assert.ok(first);
    const fingerprint = (writer: RaceWriter): string => JSON.stringify([TARGETS.map(cell => deltaOf(writer.script, cell)), shown(writer.script)]);
    for (const writer of world.writers) {
      assert.equal(fingerprint(writer), fingerprint(first), `seed ${seed}: copies disagree`);
      assert.ok(world.lateAgrees(writer, TARGETS), `seed ${seed}: a late joiner disagrees`);
    }
    const settled = TARGETS.map(cell => new Map(readCell(deltaOf(first.script, cell), true).map(char => [char.ch, char.names])));
    const wanted = new Map<string, { target: number; letter: string; tag: string; count: number; muted: boolean }>();
    let requested = 0, excused = 0;
    for (const application of applications) for (const letter of application.letters) {
      requested++;
      const covered = untags.some(untag => untag.tag === application.tag && untag.target === application.target && untag.seen.has(application.seq) && untag.letters.includes(letter));
      if (!settled[application.target]?.has(letter) || covered) { excused++; continue; }
      const key = `${application.target}|${letter}|${application.tag}`, entry = wanted.get(key) ?? { target: application.target, letter, tag: application.tag, count: 0, muted: false };
      entry.count++;
      entry.muted ||= options.mute?.fault === "format(value)" && options.mute.command === application.seq;
      wanted.set(key, entry);
    }
    let kept = 0, missing = 0, shownMissing = 0, mutedExpected = 0;
    const short: string[] = [];
    for (const { target, letter, tag, count, muted } of wanted.values()) {
      const carried = (settled[target]?.get(letter) ?? []).filter(name => name === "t:" + tag).length;
      kept += Math.min(count, carried);
      missing += Math.max(0, count - carried);
      shownMissing += Number(carried === 0);
      mutedExpected += Number(muted);
      if (carried < count) short.push(`${letter} in cell ${target}: ${tag} ${carried} of ${count}`);
    }
    return { requested, kept, excused, missing, shownMissing, mutedExpected, outcomes, commands: seq, short };
  } finally { world.close(); }
}

// why: the one shortfall is the library's, reproduced on raw Yjs by the next test; the letters still show the tag
// through a second application, so no letter shows without a tag it was asked to carry
const KNOWN_SHORTFALLS = ["seed 6: q in cell 1: t_rope 1 of 2", "seed 6: r in cell 1: t_rope 1 of 2"];

test("generated tag histories on three copies: every command checks locally, copies agree, and no requested tag is missing", t => {
  const totals = { requested: 0, kept: 0, excused: 0, missing: 0, shownMissing: 0, commands: 0 }, outcomes: Record<string, number> = {}, shortfalls: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const result = history(seed);
    shortfalls.push(...result.short.map(entry => `seed ${seed}: ${entry}`));
    for (const key of ["requested", "kept", "excused", "missing", "shownMissing", "commands"] as const) totals[key] += result[key];
    for (const [kind, count] of Object.entries(result.outcomes)) outcomes[kind] = (outcomes[kind] ?? 0) + count;
  }
  t.diagnostic(JSON.stringify({ ...totals, outcomes }));
  assert.equal(totals.shownMissing, 0);
  assert.deepEqual(shortfalls, KNOWN_SHORTFALLS);
  assert.equal(totals.kept + totals.excused + totals.missing, totals.requested);
  assert.ok(totals.kept > totals.requested * 0.4, JSON.stringify(totals));
  assert.ok((outcomes.unchanged ?? 0) > 0 && (outcomes.written ?? 0) > totals.commands * 0.8, JSON.stringify(outcomes));
});

// why: Y.Text.delete removes the emptied null and restore pair around a deleted plain letter, while a concurrent
// format ending at that pair deleted its null and wrote no restore, relying on the pair; together nothing restores
test("found by the generated histories: a mark loses the letters after a deleted plain letter when the letters before it are unmarked at once", () => {
  const changes: [string, (on: boolean) => NativeMarkChange, string][] = [["tag", on => ({ kind: "tag", id: "t_rope", on }), "t:t_rope"], ["bold", on => ({ kind: "plain", mark: "b", on }), "b"]];
  const cell: NativeTextTarget = { beat: "one", cell: "narration" };
  for (const [kind, change, name] of changes) for (const clients of [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]]) {
    const world = new RaceWorld({ one: { audioText: "opqr", visualText: "" } }, clients);
    try {
      const [a, b, c] = world.writers as [RaceWriter, RaceWriter, RaceWriter];
      const text = (writer: RaceWriter): string => printCell(readCell(deltaOf(writer.script, cell)));
      assert.equal(formatRange(a, cell, 1, 4, change(true)), "written");
      assert.equal(typeAt(a, cell, 2, "X"), "written");
      world.pullAll();
      assert.equal(text(b), `o[p|${name}]X[qr|${name}]`);
      assert.equal(deleteRange(b, cell, 2, 3), "written");
      assert.equal(formatRange(c, cell, 0, 2, change(false)), "written");
      assert.deepEqual([text(b), text(c)], [`o[pqr|${name}]`, `opX[qr|${name}]`]);
      world.pullAll(); world.pullAll();
      for (const writer of world.writers) assert.equal(text(writer), "opqr", `${kind}, clients ${clients.join(",")}: asked for op[qr|${name}]`);
    } finally { world.close(); }
  }
  // why: on raw Yjs too, but only where an observer reads each change's delta, as an editor binding does
  for (const [observed, settled] of [[true, "opqr"], [false, "op[qr|b]"]] as const) for (const clients of [[1, 2, 3], [3, 2, 1]]) {
    const docs = clients.map(client => { const doc = new Y.Doc(); doc.clientID = client; return doc; });
    if (observed) for (const doc of docs) doc.getText("t").observe(event => { void event.delta; });
    const [a, b, c] = docs as [Y.Doc, Y.Doc, Y.Doc];
    const sync = (): void => { for (const from of docs) for (const to of docs) if (from !== to) Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "remote"); };
    a.getText("t").insert(0, "opqr", {});
    a.getText("t").format(1, 3, { b: true });
    a.getText("t").insert(2, "X", {});
    sync();
    b.getText("t").delete(2, 1);
    c.getText("t").format(0, 2, { b: null });
    sync(); sync();
    for (const doc of docs) assert.equal(printCell(readCell(doc.getText("t").toDelta() as NativeDeltaItem[])), settled, `raw Yjs, observed ${observed}, clients ${clients.join(",")}`);
    for (const doc of docs) doc.destroy();
  }
});

test("control: a no-op at any tag or untag write fails the local check, and a muted tag shows as missing letters", t => {
  let reached = 0, failed = 0, possible = 0, settledLosses = 0;
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    const calls: Call[] = [];
    history(seed, { calls });
    for (const call of calls) {
      reached++;
      assert.throws(() => history(seed, { mute: call }), (error: unknown) => error instanceof LocalCheck && error.message.startsWith(`seed ${seed}, command ${call.command}:`));
      failed++;
      if (call.fault !== "format(value)") continue;
      const blind = history(seed, { mute: call, immediate: false });
      // why: a letter typed unseen inside another application of the tag inherits its key, which can stand in for
      // the muted one; so the count never exceeds the muted letters, and reaches them in nearly every history
      assert.ok(blind.missing <= blind.mutedExpected, `seed ${seed}, command ${call.command}: ${blind.short.join("; ")}`);
      possible += Number(blind.mutedExpected > 0);
      settledLosses += Number(blind.missing > 0);
    }
  }
  t.diagnostic(`${reached} writes muted, ${failed} failed the local check; of ${possible} muted tags with letters left, ${settledLosses} showed missing`);
  assert.ok(reached > 30 && possible > 10 && settledLosses >= possible * 0.9, JSON.stringify({ reached, possible, settledLosses }));
});
