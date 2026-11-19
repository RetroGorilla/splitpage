import assert from "node:assert/strict";
import { after, test } from "node:test";
import type * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import type { NativeMarkChange } from "../../../../src/adapters/collab/native/format-commands.ts";
import { RaceWorld, cellOf, countUpdates, deleteRange, deltaOf, firstDifference, formatRange, printCell, readCell, typeAt } from "./format-harness.ts";
import type { RaceChar, RaceStackItem, RaceWriter } from "./format-harness.ts";
import { shown } from "./helpers.ts";

after(() => { dom.window.close(); });

const T = "t_abcdefg", U = "t_bcdefgh", TAG_T = "t:" + T, TAG_U = "t:" + U;
const INITIAL: Readonly<Record<string, string>> = { one: "abcdefgh", two: "abcdefgh" };
const CELLS = Object.keys(INITIAL);

type TagEdit =
  | { readonly cell: string; readonly op: "add" | "remove"; readonly name: string; readonly from: number; readonly to: number }
  | { readonly cell: string; readonly op: "delete"; readonly from: number; readonly to: number }
  | { readonly cell: string; readonly op: "insert"; readonly at: number; readonly letter: string };

const add = (from: number, to: number, name = TAG_T, cell = "one"): TagEdit => ({ cell, op: "add", name, from, to });
const remove = (from: number, to: number): TagEdit => ({ cell: "one", op: "remove", name: TAG_T, from, to });
const insert = (at: number, letter: string): TagEdit => ({ cell: "one", op: "insert", at, letter });
const RANGES = [["Separated", 0, 1], ["Touching", 0, 2], ["Overlapping", 4, 7], ["Nested", 3, 5], ["Identical", 2, 6]] as const;

interface TagRace { readonly label: string; readonly b: TagEdit; readonly seed?: TagEdit; readonly seen?: boolean; readonly solo?: "A" | "B" }

const MIXED: TagRace = { label: "B bolds overlapping", b: add(4, 7, "b") };
const RACES: TagRace[] = [
  ...RANGES.flatMap(([label, from, to]): TagRace[] => [
    { label: `B adds T · ${label}`, b: add(from, to) },
    { label: `B removes T · ${label}`, seed: add(from, to), b: remove(from, to) }
  ]),
  { label: "B adds crossing U", b: add(4, 7, TAG_U) },
  { label: "B types inside", b: insert(4, "X") },
  { label: "B types at left edge", b: insert(2, "X") },
  { label: "B types at right edge", b: insert(6, "X") },
  MIXED,
  { label: "B adds same word in beat two", b: add(2, 6, TAG_T, "two") },
  { label: "B deletes cd while A extends cd to cdef", seed: add(2, 4), b: { cell: "one", op: "delete", from: 2, to: 4 } },
  { label: "B sees T, then types plain X inside", b: insert(3, "X"), seen: true },
  { label: "B sees T, then removes it all", b: remove(2, 6), seen: true },
  { label: "B sees T, then removes its middle", b: remove(3, 5), seen: true },
  { label: "B sees T, then applies T again", b: add(2, 6), seen: true }
];

// why: the per-application column of prototypes/collab/src/format-keys/E6-RESULT.md; its two seen split rows used
// tail re-keying, which design decision 3 does not carry, so they are checked against its standard-write runs
const E6_PER_APPLICATION: Readonly<Record<string, string>> = {
  "B adds T · Separated": "0 · = · r · 1 · –",
  "B removes T · Separated": "0 · = · r · 1 · –",
  "B adds T · Touching": "0 · = · r · 1 · –",
  "B removes T · Touching": "0 · = · r · 1 · –",
  "B adds T · Overlapping": "0 · 0:0/0:4/0:0/0:0/0:0 · r · 1 · –",
  "B removes T · Overlapping": "0 · 0:0/0:0/0:0/0:0/0:4 · r · 1 · –",
  "B adds T · Nested": "0 · 0:0/0:4/0:0/0:0/0:0 · r · 1 · –",
  "B removes T · Nested": "0 · 0:0/0:0/0:0/0:0/0:4 · r · 1 · –",
  "B adds T · Identical": "0 · 0:0/0:8/0:0/0:0/0:0 · r · 1 · –",
  "B removes T · Identical": "0 · 0:0/0:0/0:0/0:0/0:8 · r · 1 · –",
  "B adds crossing U": "0 · = · r · 1 · –",
  "B types inside": "0 · = · r · 1 · –",
  "B types at left edge": "0:1/0:0/0:0/0:0/0:1 · = · r · 1 · –",
  "B types at right edge": "0:1/0:0/0:0/0:0/0:1 · = · r · 1 · –",
  "B bolds overlapping": "0 · = · r · 1 · –",
  "B adds same word in beat two": "0 · = · r · 1 · –",
  "B deletes cd while A extends cd to cdef": "0 · 0:0/0:0/0:4/0:0/0:0 · r · 1 · –",
  "B sees T, then removes it all": "0:0/0:0/0:8/0:0/0:0 · 0:0/0:0/0:0/0:0/0:0 · o,o/r,r/o,o/r,r · 1 · –/Q/Q/–/–;–/Q/Q/–/–",
  "B sees T, then applies T again": "0 · 0:0/0:8/0:0/0:0/0:0 · r · 1 · –"
};
const STANDARD_SPLITS: Readonly<Record<string, string>> = {
  "B sees T, then types plain X inside": `abcX[defghQR|${TAG_T}]`,
  "B sees T, then removes its middle": `abcde[fghQR|${TAG_T}]`
};

interface Effect { readonly edit: TagEdit; readonly letters: string[]; readonly seen: readonly number[]; readonly left?: string | undefined; readonly right?: string | undefined }
interface Press { readonly target: number; readonly redo: boolean }

// why: after prototypes/collab/src/format-keys/tag-model.ts, the per-action reading: the expected tags come from the
// commands issued, the commands each writer had seen and the presses, never from a copy's state
class CommandModel {
  private readonly effects: Effect[] = [];

  record(edit: TagEdit, seen: readonly number[]): number {
    const chars = this.view(edit.cell, seen);
    this.effects.push(edit.op === "insert"
      ? { edit, letters: [edit.letter], left: chars[edit.at - 1]?.ch, right: chars[edit.at]?.ch, seen }
      : { edit, letters: chars.slice(edit.from, edit.to).map(char => char.ch), seen });
    return this.effects.length - 1;
  }

  view(cell: string, active: readonly number[], options: { presses?: readonly Press[]; applications?: boolean } = {}): RaceChar[] {
    const ordered = this.effects.flatMap((effect, id) => active.includes(id) && effect.edit.cell === cell ? [{ id, ...effect }] : []);
    const text = [...(INITIAL[cell] ?? "")], deleted = new Set<string>();
    for (const { edit, letters, right } of ordered) {
      if (edit.op === "delete") for (const letter of letters) deleted.add(letter);
      if (edit.op === "insert") text.splice(right === undefined ? text.length : text.indexOf(right), 0, edit.letter);
    }
    return text.filter(ch => !deleted.has(ch)).map(ch => {
      const inserted = ordered.find(item => item.edit.op === "insert" && item.letters[0] === ch);
      const inside = (id: number, letters: readonly string[]): boolean => !!inserted && !inserted.seen.includes(id) && inserted.left !== undefined
        && inserted.right !== undefined && letters.includes(inserted.left) && letters.includes(inserted.right);
      let names: string[] = [];
      for (const { id, edit, letters } of ordered) {
        if (edit.op !== "add" || (!letters.includes(ch) && !inside(id, letters))) continue;
        if (!ordered.some(other => other.edit.op === "remove" && other.edit.name === edit.name && other.seen.includes(id) && other.letters.includes(ch))) names.push(edit.name);
      }
      for (const { target, redo } of options.presses ?? []) {
        const effect = this.effects[target];
        if (!effect || effect.edit.cell !== cell || (effect.edit.op !== "add" && effect.edit.op !== "remove")) continue;
        if (!effect.letters.includes(ch) && !inside(target, effect.letters)) continue;
        const name = effect.edit.name;
        if (redo === (effect.edit.op === "add")) names.push(name); else names = names.filter(other => other !== name);
      }
      return { ch, names: (options.applications ? names : [...new Set(names)]).sort() };
    });
  }
}

type Fault = "format(value)" | "format(null)" | "insert" | "delete";
interface Call { readonly command: number; readonly slot: number; readonly fault: Fault }
interface Checks {
  readonly before?: (text: Y.Text, command: number) => () => void;
  readonly after?: (actual: RaceChar[], command: number) => void;
}

class LocalTagCheck extends Error {}

function intercept(text: Y.Text, command: number, reached: (call: Call) => boolean): () => void {
  const { format, insert: type, delete: cut } = text;
  let slot = 0;
  const mute = (fault: Fault): boolean => reached({ command, slot: slot++, fault });
  text.format = function (index, length, attributes) {
    if (!mute(Object.values(attributes).includes(true) ? "format(value)" : "format(null)")) format.call(this, index, length, attributes);
  };
  text.insert = function (index, value, attributes) { if (!mute("insert")) type.call(this, index, value, attributes); };
  text.delete = function (index, length) { if (!mute("delete")) cut.call(this, index, length); };
  return () => { text.format = format; text.insert = type; text.delete = cut; };
}

function write(writer: RaceWriter, edit: TagEdit): void {
  const cell = { beat: edit.cell, cell: "visual" } as const;
  if (edit.op === "insert") { typeAt(writer, cell, edit.at, edit.letter); return; }
  if (edit.op === "delete") { deleteRange(writer, cell, edit.from, edit.to); return; }
  const change: NativeMarkChange = edit.name.startsWith("t:")
    ? { kind: "tag", id: edit.name.slice(2), on: edit.op === "add" }
    : { kind: "plain", mark: "b", on: edit.op === "add" };
  formatRange(writer, cell, edit.from, edit.to, change);
}

function tagView(writer: RaceWriter, cell: string, applications = false): RaceChar[] {
  return readCell(deltaOf(writer.script, { beat: cell, cell: "visual" }), applications);
}

function differences(want: readonly RaceChar[], got: readonly RaceChar[]) {
  const tags = (chars: readonly RaceChar[]): string[] => chars.flatMap(({ ch, names }) => names.filter(name => name.startsWith("t:")).map(name => `${ch}:${name}`));
  const expected = tags(want), actual = tags(got);
  return {
    missing: expected.filter(mark => !actual.includes(mark)).length,
    extra: actual.filter(mark => !expected.includes(mark)).length,
    lost: want.filter(char => !got.some(other => other.ch === char.ch)).map(char => char.ch).join(""),
    leftover: got.filter(char => !want.some(other => other.ch === char.ch)).map(char => char.ch).join(""),
    order: want.filter(char => got.some(other => other.ch === char.ch)).map(char => char.ch).join("") === got.map(char => char.ch).join("")
  };
}

interface Frame {
  readonly raw: RaceChar[][]; readonly visual: string[];
  misses: number; extras: number; altMisses: number; altExtras: number; lost: string; leftover: string; orderChanges: number;
}

// why: after prototypes/collab/test/format-keys/tag-races.test.ts, on the adapter's own commands and standard writes
function measure(race: TagRace, low: boolean, checks: Checks = {}) {
  const model = new CommandModel(), active = new Set<number>(), presses: Press[] = [], frames: Frame[] = [], updates: number[] = [], steps: string[] = [];
  let command = 0, disagreements = 0;
  const execute = (writer: RaceWriter, edit: TagEdit, seen: readonly number[] = [...active]) => {
    const target = model.record(edit, seen), before = writer.undo.undoStack.at(-1), index = command++;
    const restore = checks.before?.(cellOf(writer, { beat: edit.cell, cell: "visual" }), index);
    let sent: number;
    try { sent = countUpdates(writer, () => { write(writer, edit); }); } finally { restore?.(); }
    const got = tagView(writer, edit.cell, true), want = model.view(edit.cell, [...seen, target], { applications: true });
    checks.after?.(got, index);
    if (firstDifference(want, got) >= 0) throw new LocalTagCheck(`${race.label}, command ${index}: ${printCell(want)} vs ${printCell(got)}`);
    active.add(target);
    const item = writer.undo.undoStack.at(-1);
    return { target, sent, item: item === before ? undefined : item };
  };
  const world = new RaceWorld(Object.fromEntries(CELLS.map(cell => [cell, { audioText: "", visualText: INITIAL[cell] ?? "" }])), low ? [1, 2] : [2, 1], 900,
    race.seed ? fixture => { if (race.seed) execute(fixture, race.seed); } : undefined);
  const [a, b] = world.writers as [RaceWriter, RaceWriter];
  const sync = (): void => { world.pullAll(); world.pullAll(); };
  const fingerprint = (writer: RaceWriter): string => JSON.stringify([CELLS.map(cell => deltaOf(writer.script, { beat: cell, cell: "visual" })), shown(writer.script)]);
  const record = (): void => {
    sync();
    const raw = CELLS.map(cell => tagView(a, cell));
    const frame: Frame = { raw, visual: CELLS.map(cell => (a.script.reader.row(cell)?.visual ?? [])
      .map(run => run.atom ? "￼" : run.marks.tag ? `[${run.text}|${run.marks.tag}]` : run.text).join("")),
      misses: 0, extras: 0, altMisses: 0, altExtras: 0, lost: "", leftover: "", orderChanges: 0 };
    for (const [index, cell] of CELLS.entries()) {
      const got = raw[index] ?? [], own = differences(model.view(cell, [...active]), got), alternate = differences(model.view(cell, [...active], { presses }), got);
      frame.misses += own.missing; frame.extras += own.extra; frame.altMisses += alternate.missing; frame.altExtras += alternate.extra;
      frame.lost += own.lost; frame.leftover += own.leftover; frame.orderChanges += Number(!own.order);
    }
    disagreements += Number(fingerprint(a) !== fingerprint(b));
    for (const writer of [a, b]) disagreements += Number(!world.lateAgrees(writer, CELLS.map(cell => ({ beat: cell, cell: "visual" }))));
    frames.push(frame);
  };
  const press = (writer: RaceWriter, entry: ReturnType<typeof execute> | undefined, redo: boolean, redoItem?: RaceStackItem): RaceStackItem | undefined => {
    if (!entry) return undefined;
    const expected = redo ? redoItem : entry.item;
    let took: RaceStackItem | null = null;
    updates.push(countUpdates(writer, () => { took = redo ? writer.undo.redo() : writer.undo.undo(); }));
    steps.push(took === null ? "–" : took === expected ? "r" : "o");
    if (redo) active.add(entry.target); else active.delete(entry.target);
    presses.push({ target: entry.target, redo });
    return took === null || took !== expected ? undefined : writer.undo.redoStack.at(-1);
  };
  try {
    execute(a, insert(8, "Q"));
    sync();
    execute(b, insert(9, "R"));
    sync();
    const before = [...active];
    const aEntry = race.solo === "B" ? undefined : execute(a, add(2, 6));
    if (race.seen) sync();
    const bEntry = race.solo === "A" ? undefined : execute(b, race.b, race.seen ? [...active] : before);
    updates.push(aEntry?.sent ?? 0, bEntry?.sent ?? 0);
    record();
    const redoA = press(a, aEntry, false);
    record();
    const redoB = press(b, bEntry, false);
    record();
    press(a, aEntry, true, redoA);
    record();
    press(b, bEntry, true, redoB);
    record();
    return { frames, steps, updates, disagreements };
  } finally { world.close(); }
}

type Measurement = ReturnType<typeof measure>;

function tableCell(low: Measurement, high: Measurement): string {
  const counts = (missing: "misses" | "altMisses", extra: "extras" | "altExtras"): string => low.frames.map((frame, index) => {
    const other = high.frames[index];
    assert.ok(other);
    return `${frame[missing] + other[missing]}:${frame[extra] + other[extra]}`;
  }).join("/");
  const paired = (left: readonly (number | string)[], right: readonly (number | string)[]): string => left.map((value, index) => `${value},${right[index]}`).join("/");
  const shownText = (result: Measurement): string => result.frames.map(frame => [frame.lost, frame.leftover && `+${frame.leftover}`].filter(Boolean).join("") || "–").join("/");
  const text = low.frames.concat(high.frames).some(frame => frame.lost || frame.leftover) ? `${shownText(low)};${shownText(high)}` : "–";
  const own = counts("misses", "extras"), alternate = counts("altMisses", "altExtras");
  const steps = paired(low.steps, high.steps), updates = paired(low.updates, high.updates);
  return [own === "0:0/0:0/0:0/0:0/0:0" ? "0" : own, alternate === own ? "=" : alternate,
    steps === "r,r/r,r/r,r/r,r" ? "r" : steps, updates === "1,1/1,1/1,1/1,1/1,1/1,1" ? "1" : updates, text].join(" · ");
}

const measured = new Map(RACES.map(race => {
  const low = measure(race, true), high = measure(race, false);
  return [race.label, { race, low, high, line: tableCell(low, high) }] as const;
}));
const entry = (label: string) => {
  const found = measured.get(label);
  assert.ok(found, label);
  return found;
};

test("E6 on the adapter: tag races in both client orders equal E6's per-application column, with standard writes on the split rows", t => {
  t.diagnostic([...measured.values()].map(({ race, line }) => `| ${race.label} | ${line} |`).join("\n"));
  for (const { race, low, high, line } of measured.values()) {
    for (const result of [low, high]) {
      assert.equal(result.disagreements, 0, race.label);
      assert.ok(result.frames.every(frame => frame.orderChanges === 0), race.label);
      assert.ok(result.frames.every(frame => /^[QR]*$/.test(frame.lost)), race.label);
    }
    const expected = E6_PER_APPLICATION[race.label];
    if (expected !== undefined) assert.equal(line, expected, race.label);
  }
  for (const [label, printed] of Object.entries(STANDARD_SPLITS)) for (const result of [entry(label).low, entry(label).high]) {
    const [merge, undo] = result.frames;
    assert.ok(merge && undo);
    assert.equal(merge.misses + merge.extras, 0, label);
    assert.equal(printCell(undo.raw[0] ?? []), printed, label);
  }
  const all = [...measured.values()].flatMap(({ low, high }) => [low, high]);
  const sum = (frame: number, field: "misses" | "extras"): number => all.reduce((total, result) => total + (result.frames[frame]?.[field] ?? 0), 0);
  const splitExtras = Object.keys(STANDARD_SPLITS).map(label => (entry(label).low.frames[1]?.extras ?? 0) + (entry(label).high.frames[1]?.extras ?? 0));
  t.diagnostic(`missing at first merge ${sum(0, "misses")} over ${all.length} trials; missing after A's undo ${sum(1, "misses")}; extra after A's undo ${sum(1, "extras")}`);
  assert.equal(all.length, 42);
  assert.deepEqual([sum(0, "misses"), sum(1, "misses"), sum(1, "extras")], [0, 0, 24]);
  assert.deepEqual(splitExtras, [14, 10]);
});

test("E6 rows the prototype pinned by letter: overlap, delete against extension, and a seen full removal undone out of order", () => {
  const tagged = (label: string, low: boolean) => {
    const result = low ? entry(label).low : entry(label).high;
    return { tagged: result.frames.map(frame => frame.raw[0]?.filter(char => char.names.includes(TAG_T)).map(char => char.ch).join("")), steps: result.steps };
  };
  for (const low of [true, false]) {
    assert.deepEqual(tagged("B adds T · Overlapping", low).tagged.slice(0, 2), ["cdefg", "efg"]);
    assert.deepEqual(tagged("B deletes cd while A extends cd to cdef", low).tagged.slice(0, 2), ["ef", ""]);
    const removal = tagged("B sees T, then removes it all", low);
    assert.equal(removal.steps[0], "o");
    assert.equal(removal.tagged[2], "cdef");
  }
});

test("E6 crossing U shows on its letters outside T, and on all its letters once T is undone; beats keep their own tags", () => {
  for (const result of [entry("B adds crossing U").low, entry("B adds crossing U").high]) {
    const [merge, afterA] = result.frames;
    assert.ok(merge && afterA);
    assert.equal(printCell(merge.raw[0] ?? []), `ab[cd|${TAG_T}][ef|${TAG_T},${TAG_U}][g|${TAG_U}]hQR`);
    assert.equal(merge.visual[0], `ab[cdef|${T}][g|${U}]hQR`);
    assert.equal(afterA.visual[0], `abcd[efg|${U}]hQR`);
  }
  for (const result of [entry("B adds same word in beat two").low, entry("B adds same word in beat two").high]) {
    assert.ok(result.frames.every(frame => frame.misses === 0 && frame.extras === 0 && frame.lost === "" && frame.leftover === ""));
    assert.equal(printCell(result.frames[1]?.raw[1] ?? []), `ab[cdef|${TAG_T}]gh`);
  }
});

test("E6 mixed tag and bold give the same result as the two edits run separately", () => {
  for (const low of [true, false]) {
    const both = low ? entry(MIXED.label).low : entry(MIXED.label).high;
    const tags = measure({ ...MIXED, solo: "A" }, low), bold = measure({ ...MIXED, solo: "B" }, low);
    assert.deepEqual(both.frames.map(frame => frame.raw[0]?.map(char => char.names)), tags.frames.map((frame, check) =>
      frame.raw[0]?.map((char, index) => [...char.names, ...(bold.frames[check]?.raw[0]?.[index]?.names ?? [])].sort())));
    assert.deepEqual(both.updates, [tags.updates[0], bold.updates[1], tags.updates[2], bold.updates[2], tags.updates[3], bold.updates[3]]);
    assert.deepEqual(both.steps, [tags.steps[0], bold.steps[0], tags.steps[1], bold.steps[1]]);
  }
});

test("E6 control: a no-op at each effective library write fails the immediate command check", t => {
  const faults: Fault[] = ["format(value)", "format(null)", "insert", "delete"];
  const counts = new Map(faults.map(fault => [fault, { reached: 0, effective: 0, failed: 0 }]));
  for (const race of RACES) for (const low of [true, false]) {
    const calls: Call[] = [], snapshots: RaceChar[][] = [];
    measure(race, low, {
      before: (text, command) => intercept(text, command, call => { calls.push(call); return false; }),
      after: (actual, command) => { snapshots[command] = actual; }
    });
    for (const target of calls) {
      const count = counts.get(target.fault);
      assert.ok(count);
      let reached = false, effective = false, failed = false;
      try {
        measure(race, low, {
          before: (text, command) => intercept(text, command, call => {
            if (call.command !== target.command || call.slot !== target.slot) return false;
            assert.equal(call.fault, target.fault);
            reached = true;
            return true;
          }),
          after: (actual, command) => {
            const baseline = snapshots[command];
            assert.ok(baseline);
            if (command === target.command) effective = firstDifference(baseline, actual) >= 0;
          }
        });
      } catch (error) {
        assert.ok(error instanceof LocalTagCheck, String(error));
        assert.match(error.message, new RegExp(`command ${target.command}:`));
        failed = true;
      }
      assert.ok(reached);
      assert.equal(failed, effective, `${race.label} ${target.fault} at command ${target.command}`);
      count.reached++; count.effective += Number(effective); count.failed += Number(failed);
    }
  }
  for (const [fault, count] of counts) {
    t.diagnostic(`${fault}: ${count.reached} reached, ${count.effective} effective, ${count.failed} failed`);
    if (fault !== "format(null)" && fault !== "delete") assert.ok(count.effective > 0, fault);
    assert.equal(count.failed, count.effective, fault);
  }
  const removals = counts.get("format(null)"), deletes = counts.get("delete");
  assert.ok(removals && deletes && removals.effective > 0 && deletes.effective > 0);
});
