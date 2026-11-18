import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { freshKey } from "../../src/format-keys/keys.ts";
import { firstDifference, printCell, readCell, visibleName } from "../../src/format-keys/model.ts";
import type { ModelChar, ReadableItem } from "../../src/format-keys/model.ts";
import { TAG_T, TAG_U, TagCommandModel } from "../../src/format-keys/tag-model.ts";
import type { TagEdit } from "../../src/format-keys/tag-model.ts";
import { TagReplica, nestedTags, pullTags } from "../../src/format-keys/tag-replica.ts";
import { measureUndo } from "../../src/format-keys/world.ts";

const initial = { one: "abcdefgh", two: "abcdefgh" };
const add = (from: number, to: number, name = TAG_T, cell = "one"): TagEdit => ({ cell, op: "add", name, from, to });
const remove = (from: number, to: number): TagEdit => ({ cell: "one", op: "remove", name: TAG_T, from, to });
const insert = (at: number, letter: string): TagEdit => ({ cell: "one", op: "insert", at, letter });
const ranges = [["Separated", 0, 1], ["Touching", 0, 2], ["Overlapping", 4, 7], ["Nested", 3, 5], ["Identical", 2, 6]] as const;
const schemes = ["name", "act"] as const;
const orders = [true, false];

interface TagRace {
  label: string;
  b: TagEdit;
  seed?: TagEdit;
  seen?: boolean;
  solo?: "A" | "B";
}

const mixed: TagRace = { label: "B bolds overlapping", b: add(4, 7, "b") };
const races: TagRace[] = [
  ...ranges.flatMap(([label, from, to]) => [
    { label: `B adds T · ${label}`, b: add(from, to) },
    { label: `B removes T · ${label}`, seed: add(from, to), b: remove(from, to) }
  ]),
  { label: "B adds crossing U", b: add(4, 7, TAG_U) },
  { label: "B types inside", b: insert(4, "X") },
  { label: "B types at left edge", b: insert(2, "X") },
  { label: "B types at right edge", b: insert(6, "X") },
  mixed,
  { label: "B adds same word in beat two", b: add(2, 6, TAG_T, "two") },
  { label: "B deletes cd while A extends cd to cdef", seed: add(2, 4), b: { cell: "one", op: "delete", from: 2, to: 4 } },
  { label: "B sees T, then types plain X inside", b: insert(3, "X"), seen: true },
  { label: "B sees T, then removes it all", b: remove(2, 6), seen: true },
  { label: "B sees T, then removes its middle", b: remove(3, 5), seen: true },
  { label: "B sees T, then applies T again", b: add(2, 6), seen: true }
];

type StackItem = Y.UndoManager["undoStack"][number];
type Fault = "format(value)" | "format(null)" | "insert" | "delete";
const faults: Fault[] = ["format(value)", "format(null)", "insert", "delete"];
interface Call { command: number; slot: number; fault: Fault }
interface CommandCheck {
  before?: (text: Y.Text, command: number) => () => void;
  after?: (actual: ModelChar[], command: number) => void;
  writeOther?: (copy: TagReplica, edit: TagEdit) => void;
}

class LocalTagCheck extends Error {}

function intercept(text: Y.Text, command: number, reached: (call: Call) => boolean): () => void {
  const { format, insert: type, delete: cut } = text;
  let slot = 0;
  const mute = (fault: Fault) => reached({ command, slot: slot++, fault });
  text.format = function (index, length, attrs) {
    if (!mute(Object.values(attrs).includes(true) ? "format(value)" : "format(null)")) format.call(this, index, length, attrs);
  };
  text.insert = function (index, value, attrs) {
    if (!mute("insert")) type.call(this, index, value, attrs);
  };
  text.delete = function (index, length) {
    if (!mute("delete")) cut.call(this, index, length);
  };
  return () => { text.format = format; text.insert = type; text.delete = cut; };
}

function differences(want: readonly ModelChar[], got: readonly ModelChar[]) {
  const tags = (chars: readonly ModelChar[]) => chars.flatMap(({ ch, names }) =>
    names.filter(name => name.startsWith("t:")).map(name => `${ch}:${name}`));
  const expected = tags(want), actual = tags(got);
  return {
    missing: expected.filter(mark => !actual.includes(mark)).length,
    extra: actual.filter(mark => !expected.includes(mark)).length,
    lost: want.filter(char => !got.some(other => other.ch === char.ch)).map(char => char.ch).join(""),
    leftover: got.filter(char => !want.some(other => other.ch === char.ch)).map(char => char.ch).join(""),
    text: want.map(char => char.ch).join("") === got.map(char => char.ch).join(""),
    order: want.filter(char => got.some(other => other.ch === char.ch)).map(char => char.ch).join("") === got.map(char => char.ch).join("")
  };
}

function countUpdates(copy: TagReplica, edit: () => void): number {
  let updates = 0;
  const count = () => { updates++; };
  copy.doc.on("update", count);
  try { edit(); } finally { copy.doc.off("update", count); }
  return updates;
}

function measure(race: TagRace, scheme: typeof schemes[number], low: boolean, checks: CommandCheck = {}) {
  const server = new Y.Doc(), fixture = new TagReplica(900, scheme), a = new TagReplica(low ? 1 : 2, scheme), b = new TagReplica(low ? 2 : 1, scheme);
  const model = new TagCommandModel(initial), cells = Object.keys(initial);
  const active = new Set<number>(), presses: { target: number; redo: boolean }[] = [];
  const frames: { raw: ModelChar[][]; shown: ModelChar[][]; rejected: string[]; misses: number; extras: number;
    altMisses: number; altExtras: number; lost: string; leftover: string; textDifferences: number; textOrderChanges: number }[] = [];
  const updates: number[] = [], steps: string[] = [];
  let command = 0, disagreements = 0;

  function execute(copy: TagReplica, edit: TagEdit, seen = [...active],
    write = (writer: TagReplica, command: TagEdit) => writer.editTagCell(command)) {
    const target = model.record(edit, seen), before = copy.undo.undoStack.at(-1), index = command++;
    const restore = checks.before?.(copy.tagText(edit.cell), index);
    let sent;
    try { sent = countUpdates(copy, () => write(copy, edit)); } finally { restore?.(); }
    const includeApplications = scheme === "act";
    const got = copy.tagView(edit.cell, includeApplications), want = model.view(edit.cell, [...seen, target], { includeApplications });
    checks.after?.(got, index);
    if (firstDifference(want, got) >= 0) throw new LocalTagCheck(`${race.label}, ${scheme}, command ${index}: ${printCell(want)} vs ${printCell(got)}`);
    active.add(target);
    const item = copy.undo.undoStack.at(-1);
    return { target, sent, item: item === before ? undefined : item };
  }

  function sync(): void {
    for (let pass = 0; pass < 2; pass++) for (const copy of [a, b]) pullTags(copy, server);
  }

  function record(): void {
    sync();
    const raw = cells.map(cell => a.tagView(cell)), projections = raw.map(nestedTags);
    const frame = { raw, shown: projections.map(projection => projection.chars),
      rejected: projections.flatMap(projection => projection.rejected.map(extent => `${extent.name}@${extent.from}..${extent.to}`)),
      misses: 0, extras: 0, altMisses: 0, altExtras: 0, lost: "", leftover: "", textDifferences: 0, textOrderChanges: 0 };
    for (const [index, cell] of cells.entries()) {
      const got = raw[index] ?? [], own = differences(model.view(cell, [...active]), got);
      const alternate = differences(model.view(cell, [...active], { presses }), got);
      frame.misses += own.missing;
      frame.extras += own.extra;
      frame.altMisses += alternate.missing;
      frame.altExtras += alternate.extra;
      frame.lost += own.lost;
      frame.leftover += own.leftover;
      frame.textDifferences += Number(!own.text);
      frame.textOrderChanges += Number(!own.order);
    }
    const fingerprint = (copy: TagReplica) => JSON.stringify(cells.map(cell => {
      const rawKeys = copy.tagDelta(cell).flatMap(run => [...String(run.insert)].map(ch => [ch, Object.keys(run.attributes ?? {}).sort()]));
      return [rawKeys, nestedTags(copy.tagView(cell))];
    }));
    const expected = fingerprint(a);
    disagreements += Number(expected !== fingerprint(b));
    for (const writer of [a, b]) {
      const late = new TagReplica(901, scheme);
      try {
        pullTags(late, writer.doc);
        disagreements += Number(expected !== fingerprint(late));
      } finally { late.destroy(); }
    }
    frames.push(frame);
  }

  function press(copy: TagReplica, entry: ReturnType<typeof execute> | undefined, redo: boolean, redoItem?: StackItem): StackItem | undefined {
    if (!entry) return undefined;
    const expected = redo ? redoItem : entry.item;
    let took: StackItem | null = null;
    if (redo) updates.push(countUpdates(copy, () => { took = copy.undo.redo(); }));
    else {
      const result = measureUndo(copy);
      took = result.item;
      updates.push(result.updates);
    }
    steps.push(took === null ? "–" : took === expected ? "r" : "o");
    if (redo) active.add(entry.target); else active.delete(entry.target);
    presses.push({ target: entry.target, redo });
    return took === null || took !== expected ? undefined : copy.undo.redoStack.at(-1);
  }

  try {
    fixture.hydrate({ rows: cells.map(id => ({ id, visualText: initial[id as keyof typeof initial] })),
      productionTags: [{ id: TAG_T.slice(2), cat: "prop", name: "T" }, { id: TAG_U.slice(2), cat: "sound", name: "U" }] });
    if (race.seed) execute(fixture, race.seed);
    Y.applyUpdate(server, fixture.encode());
    for (const copy of [a, b]) {
      pullTags(copy, server);
      copy.doc.on("update", (update, origin) => { if (origin !== "remote") Y.applyUpdate(server, update); });
    }
    execute(a, insert(8, "Q"));
    sync();
    execute(b, insert(9, "R"));
    sync();
    const before = [...active];
    const aEntry = race.solo === "B" ? undefined : execute(a, add(2, 6));
    if (race.seen) sync();
    const bEntry = race.solo === "A" ? undefined : execute(b, race.b, race.seen ? [...active] : before, checks.writeOther);
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
  } finally {
    for (const copy of [fixture, a, b]) copy.destroy();
    server.destroy();
  }
}

type TagMeasurement = ReturnType<typeof measure>;

function tableCell(low: TagMeasurement, high: TagMeasurement): string {
  const counts = (missing: "misses" | "altMisses", extra: "extras" | "altExtras") => low.frames.map((frame, index) => {
    const other = high.frames[index];
    assert.ok(other);
    return `${frame[missing] + other[missing]}:${frame[extra] + other[extra]}`;
  }).join("/");
  const paired = (left: readonly (number | string)[], right: readonly (number | string)[]) =>
    left.map((value, index) => `${value},${right[index]}`).join("/");
  const shownText = (result: TagMeasurement) => result.frames.map(frame =>
    [frame.lost, frame.leftover && `+${frame.leftover}`].filter(Boolean).join("") || "–").join("/");
  const text = low.frames.concat(high.frames).some(frame => frame.lost || frame.leftover) ? `${shownText(low)};${shownText(high)}` : "–";
  const own = counts("misses", "extras"), alternate = counts("altMisses", "altExtras");
  const steps = paired(low.steps, high.steps), updates = paired(low.updates, high.updates);
  return [own === "0:0/0:0/0:0/0:0/0:0" ? "0" : own, alternate === own ? "=" : alternate,
    steps === "r,r/r,r/r,r/r,r" ? "r" : steps, updates === "1,1/1,1/1,1/1,1/1,1/1,1" ? "1" : updates, text].join(" · ");
}

test("tag races replay both orders and check the command model and convergence at each checkpoint", t => {
  const lines: string[] = [];
  for (const race of races) {
    const byScheme = schemes.map(scheme => {
      const low = measure(race, scheme, true), high = measure(race, scheme, false);
      for (const result of [low, high]) {
        assert.equal(result.disagreements, 0, race.label);
        assert.ok(result.frames.every(frame => frame.textOrderChanges === 0), race.label);
        assert.ok(result.frames.every(frame => /^[QR]*$/.test(frame.lost)), race.label);
      }
      if (process.env.E6_TRACE === "1") for (const [index, result] of [low, high].entries()) {
        t.diagnostic(`${race.label}, ${scheme}, A ${index === 0 ? "low" : "high"}: ${result.frames.map(frame =>
          printCell(frame.raw[0] ?? []).replaceAll(TAG_T, "T").replaceAll(TAG_U, "U")).join(" → ")}`);
      }
      return tableCell(low, high);
    });
    lines.push(`| ${race.label} | ${byScheme.join(" | ")} |`);
  }
  if (process.env.E6_TABLE === "1") t.diagnostic(lines.join("\n"));
});

test("plain keys lose applied tags, while both schemes can leave tags or skip undo steps", () => {
  const run = (label: string, scheme: typeof schemes[number], low: boolean) => {
    const race = races.find(entry => entry.label === label);
    assert.ok(race);
    const { frames, steps } = measure(race, scheme, low);
    const tagged = frames.map(frame => frame.raw[0]?.filter(char => char.names.includes(TAG_T)).map(char => char.ch).join(""));
    return { tagged, steps };
  };
  for (const low of orders) {
    assert.deepEqual(run("B adds T · Overlapping", "name", low).tagged.slice(0, 2), ["cdef", ""]);
    assert.deepEqual(run("B adds T · Overlapping", "act", low).tagged.slice(0, 2), ["cdefg", "efg"]);
    assert.deepEqual(run("B deletes cd while A extends cd to cdef", "name", low).tagged.slice(0, 2), ["", ""]);
    assert.deepEqual(run("B deletes cd while A extends cd to cdef", "act", low).tagged.slice(0, 2), ["ef", ""]);
    assert.equal(run("B sees T, then removes its middle", "act", low).tagged[1], "f");
    for (const scheme of schemes) {
      const afterRemoval = run("B sees T, then removes it all", scheme, low);
      assert.equal(afterRemoval.steps[0], "o");
      assert.equal(afterRemoval.tagged[2], "cdef");
    }
  }
});

test("plain insert and range clear leave a per-application tag on the rest of the cell after the author's undo", () => {
  const writeOther = (copy: TagReplica, edit: TagEdit): void => {
    const text = copy.tagText(edit.cell);
    copy.transact(() => {
      if (edit.op === "insert") text.insert(edit.at, edit.letter, {});
      else if (edit.op === "remove") {
        const keys = new Set(copy.tagDelta(edit.cell).flatMap(run => Object.keys(run.attributes ?? {})));
        const key = [...keys].find(key => visibleName(key) === edit.name);
        assert.ok(key);
        text.format(edit.from, edit.to - edit.from, { [key]: null });
      } else assert.fail("The standard-write comparison only splits a tag");
    });
  };
  for (const [label, plainText, standardTail, rekeyedTail] of [
    ["B sees T, then types plain X inside", "abcX", "defghQR", "def"],
    ["B sees T, then removes its middle", "abcde", "fghQR", "f"]
  ] as const) {
    const race = races.find(entry => entry.label === label);
    assert.ok(race);
    for (const low of orders) {
      const standard = measure(race, "act", low, { writeOther });
      assert.equal(standard.disagreements, 0, label);
      const comparisons: [TagMeasurement, string][] = [
        [measure(race, "name", low), standardTail],
        [standard, standardTail],
        [measure(race, "act", low), rekeyedTail]
      ];
      for (const [result, tail] of comparisons) {
        const undo = result.frames[1];
        assert.ok(undo);
        assert.equal(undo.extras, tail.length);
        assert.equal(printCell(undo.raw[0] ?? []), `${plainText}[${tail}|${TAG_T}]${tail === rekeyedTail ? "ghQR" : ""}`);
      }
    }
  }
});

test("omitting insert attributes at a tag's right edge makes the inserted letter keep the tag through deletion and reload", () => {
  for (const scheme of schemes) for (const explicit of [false, true]) {
    for (const at of [4, 5, 6, 7, 8]) {
      const doc = new Y.Doc(), late = new Y.Doc();
      try {
        const text = doc.getText("script");
        text.insert(0, "abcdefgh", {});
        const key = scheme === "act" ? freshKey(doc, TAG_T) : TAG_T;
        text.format(2, 2, { [key]: true });
        if (explicit) text.insert(at, "R", {}); else text.insert(at, "R");
        text.delete(2, 2);
        Y.applyUpdate(late, Y.encodeStateAsUpdate(doc));
        const tail = `${"abcdefgh".slice(4, at)}R${"abcdefgh".slice(at)}`;
        const expected = !explicit && at === 4 ? `ab[R|${TAG_T}]efgh` : `ab${tail}`;
        for (const copy of [text, late.getText("script")]) {
          assert.equal(printCell(readCell(copy.toDelta() as ReadableItem[])), expected, `${scheme}, explicit=${explicit}, at=${at}`);
        }
      } finally { doc.destroy(); late.destroy(); }
    }
  }
});

test("tag marks across beats are independent, and crossing storage and display agree for all readers", () => {
  for (const scheme of schemes) for (const low of orders) {
    const crossing = races.find(race => race.b.op === "add" && race.b.name === TAG_U);
    const separate = races.find(race => race.b.cell === "two");
    assert.ok(crossing && separate);
    const [merge, afterA] = measure(crossing, scheme, low).frames;
    assert.ok(merge && afterA);
    assert.equal(printCell(merge.raw[0] ?? []), `ab[cd|${TAG_T}][ef|${TAG_T},${TAG_U}][g|${TAG_U}]hQR`);
    assert.equal(printCell(merge.shown[0] ?? []), `ab[cdef|${TAG_T}]ghQR`);
    assert.deepEqual(merge.rejected, [`${TAG_U}@4..7`]);
    assert.equal(printCell(afterA.shown[0] ?? []), `abcd[efg|${TAG_U}]hQR`);
    const independent = measure(separate, scheme, low).frames;
    assert.ok(independent.every(frame => frame.misses === 0 && frame.extras === 0 && frame.textDifferences === 0));
    assert.equal(printCell(independent[1]?.raw[1] ?? []), `ab[cdef|${TAG_T}]gh`);
  }
});

test("the mixed tag and bold results equal the two edits run separately", () => {
  for (const scheme of schemes) for (const low of orders) {
    const both = measure(mixed, scheme, low), tags = measure({ ...mixed, solo: "A" }, scheme, low), bold = measure({ ...mixed, solo: "B" }, scheme, low);
    assert.deepEqual(both.frames.map(frame => frame.raw[0]?.map(char => char.names)), tags.frames.map((frame, check) =>
      frame.raw[0]?.map((char, index) => [...char.names, ...(bold.frames[check]?.raw[0]?.[index]?.names ?? [])].sort())));
    assert.deepEqual(both.updates, [tags.updates[0], bold.updates[1], tags.updates[2], bold.updates[2], tags.updates[3], bold.updates[3]]);
    assert.deepEqual(both.steps, [tags.steps[0], bold.steps[0], tags.steps[1], bold.steps[1]]);
  }
});

test("a no-op at each effective Y.Text write fails the immediate command check", t => {
  const counts = new Map(faults.map(fault => [fault, { reached: 0, effective: 0, failed: 0 }]));
  for (const race of races) for (const scheme of schemes) for (const low of orders) {
    const calls: Call[] = [], snapshots: ModelChar[][] = [];
    measure(race, scheme, low, {
      before: (text, command) => intercept(text, command, call => { calls.push(call); return false; }),
      after: (actual, command) => { snapshots[command] = actual; }
    });
    for (const target of calls) {
      const count = counts.get(target.fault);
      assert.ok(count);
      let reached = false, effective = false, failed = false;
      try {
        measure(race, scheme, low, {
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
        assert.ok(error instanceof LocalTagCheck);
        assert.match(error.message, new RegExp(`command ${target.command}:`));
        failed = true;
      }
      assert.ok(reached);
      assert.equal(failed, effective);
      count.reached++;
      count.effective += Number(effective);
      count.failed += Number(failed);
    }
  }
  for (const [fault, count] of counts) {
    t.diagnostic(`${fault}: ${count.reached} reached, ${count.effective} effective, ${count.failed} failed`);
    assert.ok(count.effective > 0);
    assert.equal(count.failed, count.effective);
  }
});
