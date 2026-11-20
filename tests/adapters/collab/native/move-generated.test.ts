import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { createNativeHeading, removeNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { blockOrder, caret, copiesOf, stateOf, structureScript } from "./structure-harness.ts";
import type { Delivery } from "./helpers.ts";

after(() => { dom.window.close(); });

const ROWS = { A: "abc", B: "def", C: "ghi", D: "jkl", E: "mno", F: "pqr", Safe: "stu" };
const VISUALS = { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6", Safe: "7" };
const SOURCE = structureScript(ROWS, VISUALS, [{ id: "P", name: "P", before: "A" }, { id: "Q", name: "Q", before: "Safe" }]);
const SEEDS = 24, STEPS = 64, CONTROL_SEEDS = 4;
const DELIVERY: readonly Delivery[] = ["forward", "reverse", "twice"];

interface Write { readonly step: number; readonly slot: number; readonly selected: boolean }
interface Options { readonly writes?: Write[]; readonly mute?: Write; readonly spoil?: boolean }
interface Outcome { readonly kind: string; readonly created?: string }
interface Entry { readonly id: string; readonly text: string; readonly cell: string; readonly into: unknown }
interface Counts {
  commands: number; written: number; refused: number; unchanged: number; moves: number; rankWrites: number;
  letters: number; shown: number; deleted: number; records: number; visible: number; hidden: number; visual: number; names: number;
}

class LocalCheck extends Error {}

function sorted(letters: Iterable<string>): string {
  return [...letters].sort().join("");
}

function stored(script: NativeScript): string[] {
  return [...script.roots.segments.values()].flatMap(segment => {
    const text = segment.get("text");
    assert.ok(text instanceof Y.Text);
    return [...text.toString()];
  });
}

function entries(script: NativeScript): Entry[] {
  return blockOrder(script).flatMap(id => {
    if (id.startsWith("#")) return [];
    const places = script.reader.narrationSpans(id);
    const text = places.flatMap(place => nativeSegmentSpans(script.roots.segments.get(place.segment))?.[place.span]?.items ?? [])
      .map(item => typeof item.insert === "string" ? item.insert : "").join("");
    return [{ id, text, cell: script.roots.visuals.get(id)?.toString() ?? "", into: script.roots.beats.get(id)?.get("joined") }];
  });
}

function groups(order: readonly string[], rows: readonly Entry[]): string[][] {
  const result: string[][] = [], byId = new Map(rows.map(row => [row.id, row]));
  let row: string[] | undefined;
  for (const id of order) {
    if (id.startsWith("#")) { row = undefined; continue; }
    const into = byId.get(id)?.into;
    if (into && row && typeof into === "object" && "into" in into && into.into === row.at(-1)) row.push(id);
    else { row = [id]; result.push(row); }
  }
  return result;
}

function moveWrites(step: number, actor: NativeScript, ids: readonly string[], drop: string | null, options: Options): Outcome {
  const chosen = new Set(ids.flatMap(id => [actor.roots.beats.get(id), actor.roots.headings.get(id)])), original = Y.Map.prototype.set;
  let slot = 0;
  Y.Map.prototype.set = function <T>(this: Y.Map<T>, key: string, value: T): T {
    assert.equal(key, "rank");
    const write = { step, slot: slot++, selected: chosen.has(this as Y.Map<unknown>) };
    options.writes?.push(write);
    if (options.mute?.step === step && options.mute.slot === write.slot) return value;
    return original.call(this, key, value) as T;
  };
  try { return moveNativeBlocks(actor, ids, drop); }
  finally { Y.Map.prototype.set = original; }
}

function history(seed: number, options: Options = {}): Counts {
  let random = seed * 7919;
  const pick = <T>(values: readonly T[]): T => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const value = values[Math.floor((random / 0x100000000) * values.length)];
    assert.ok(value !== undefined);
    return value;
  };
  const { all, net } = copiesOf(SOURCE, seed % 2 ? [2, 3, 4] : [4, 3, 2]);
  const counts: Counts = { commands: 0, written: 0, refused: 0, unchanged: 0, moves: 0, rankWrites: 0, letters: 0, shown: 0, deleted: 0, records: 0, visible: 0, hidden: 0, visual: 0, names: 0 };
  const letters = new Set(Object.values(ROWS).join("")), deleted = new Set<string>(), removed = new Set<string>();
  const visual = new Set(Object.values(VISUALS).join("")), records = new Set(Object.keys(ROWS)), names = new Map([["P", "P"], ["Q", "Q"]]);
  const touched = new Set<string>();
  try {
    for (let step = 0; step < STEPS; step++) {
      if (step === 1 || step % 5 === 0) net.settle(pick(DELIVERY));
      const actor = pick(all), before = blockOrder(actor), rows = entries(actor);
      const editable = rows.filter(row => row.id !== "Safe"), row = pick(editable.length ? editable : rows);
      const target = (cell: NativeTextTarget["cell"], from: number) => {
        const anchored = anchorNativeText(actor, { beat: row.id, cell }, from);
        assert.ok(anchored.kind === "anchored", `seed ${seed}, command ${step}: ${row.id}/${cell}/${from}`);
        return anchored.range;
      };
      let expected = "written", order = before, afterRows = rows, narration = stored(actor), act: () => Outcome;
      let onSplit: (outcome: Outcome) => void = () => undefined;
      const actions = ["move", "move", "split", "join", "unjoin", "remove", "heading", "hide", "type", "visual", "refuse"] as const;
      const action = step === 0 ? "split" : step === 1 ? "move" : pick(actions);
      touched.add(action);
      if (action === "move" || action === "refuse") {
        const selected = step === 1 ? ["D", "E"] : before.filter(id => id !== "Safe" && (id === row.id || pick([false, false, true])));
        const rest = before.filter(id => !selected.includes(id));
        const created = [...records].find(id => !Object.hasOwn(ROWS, id));
        const drop = step === 1 ? created ?? null : pick([...rest, null]);
        if (action === "refuse") expected = "refused";
        else {
          const at = drop === null ? rest.length : rest.indexOf(drop);
          order = [...rest.slice(0, at), ...selected, ...rest.slice(at)];
          afterRows = order.flatMap(id => rows.filter(entry => entry.id === id));
          if (order.every((id, index) => id === before[index])) expected = "unchanged";
        }
        counts.moves++;
        const ids = selected.map(id => id.startsWith("#") ? id.slice(1) : id);
        const dropId = action === "refuse" ? "never-created" : drop?.replace(/^#/, "") ?? null;
        const oldRanks = ids.map(id => (actor.roots.beats.get(id) ?? actor.roots.headings.get(id))?.get("rank"));
        act = () => {
          const outcome = moveWrites(step, actor, ids, dropId, options);
          if (expected === "written") ids.forEach((id, index) => {
            const record = actor.roots.beats.get(id) ?? actor.roots.headings.get(id);
            if (record?.get("rank") === oldRanks[index]) throw new LocalCheck(`seed ${seed}, command ${step}: missing selected rank for ${id}`);
          });
          return outcome;
        };
      } else if (action === "split") {
        const picked = step === 0 ? rows.find(entry => entry.id === "B") ?? row : row;
        const own = actor.reader.beatBoundary(picked.id), spans = actor.reader.narrationSpans(picked.id);
        const pieces = spans.map(span => {
          const items = nativeSegmentSpans(actor.roots.segments.get(span.segment))?.[span.span]?.items ?? [];
          return items.map(item => typeof item.insert === "string" ? item.insert : "").join("");
        });
        const ownIndex = own ? spans.indexOf(own) : -1, body = pieces[ownIndex] ?? "";
        const prefix = pieces.slice(0, ownIndex).join(""), suffix = pieces.slice(ownIndex + 1).join("");
        const at = step === 0 ? 1 : Math.floor(body.length / 2);
        const head = prefix + body.slice(0, at), tail = body.slice(at) + suffix;
        const range = caret(actor, picked.id, prefix.length + at);
        const rank = actor.roots.beats.get(picked.id)?.get("rank");
        act = () => splitNativeRow(actor, range);
        onSplit = result => {
          const { created } = result, where = before.indexOf(picked.id);
          assert.ok(created && !records.has(created));
          const record = actor.roots.beats.get(created);
          assert.ok(record instanceof Y.Map && actor.roots.visuals.get(created) instanceof Y.Text);
          assert.equal(record.get("rank"), rank);
          records.add(created);
          order = [...before.slice(0, where + 1), created, ...before.slice(where + 1)];
          afterRows = rows.flatMap(entry => entry === picked ? [{ ...entry, text: head }, { id: created, text: tail, cell: "", into: undefined }] : [entry]);
        };
      } else if (action === "join") {
        const above = before[before.indexOf(row.id) - 1], into = above && !above.startsWith("#") && row.id !== "Safe" ? above : null;
        const current = row.into, next = { into, glue: "" };
        expected = !into ? "refused" : JSON.stringify(current) === JSON.stringify(next) ? "unchanged" : "written";
        if (expected === "written") afterRows = rows.map(entry => entry === row ? { ...row, into: next } : entry);
        act = () => joinNativeRow(actor, row.id, into ?? "never-created", "");
      } else if (action === "unjoin") {
        expected = row.into === undefined ? "unchanged" : "written";
        afterRows = rows.map(entry => entry === row ? { ...row, into: undefined } : entry);
        act = () => unjoinNativeRow(actor, row.id);
      } else if (action === "remove") {
        expected = row.id === "Safe" ? "refused" : "written";
        if (expected === "written") {
          removed.add(row.id);
          for (const letter of row.text) deleted.add(letter);
          narration = narration.filter(letter => !row.text.includes(letter));
          order = before.filter(id => id !== row.id);
          afterRows = rows.filter(entry => entry !== row);
        }
        act = () => removeNativeRows(actor, [row.id === "Safe" ? "never-created" : row.id]);
      } else if (action === "heading") {
        const id = "Made" + step, title = String.fromCharCode(0x5000 + step), index = before.indexOf("Safe");
        const safe = rows.find(entry => entry.id === "Safe");
        assert.ok(safe);
        const range = caret(actor, "Safe", 0);
        names.set(id, title);
        order = [...before.slice(0, index), "#" + id, ...before.slice(index)];
        act = () => createNativeHeading(actor, range, id, title);
      } else if (action === "hide") {
        const headings = before.filter(id => id.startsWith("#Made")), id = headings.length ? pick(headings) : "#never-created";
        expected = headings.length ? "written" : "refused";
        order = before.filter(ref => ref !== id);
        act = () => removeNativeHeading(actor, id.slice(1));
      } else {
        const typeVisual = action === "visual", cell = typeVisual ? "visual" : "narration", text = typeVisual ? row.cell : row.text;
        const letter = String.fromCharCode((typeVisual ? 0x5100 : 0x5200) + step), range = target(cell, text.length);
        (typeVisual ? visual : letters).add(letter);
        if (!typeVisual) narration = [...narration, letter];
        afterRows = rows.map(entry => entry !== row ? entry : typeVisual ? { ...row, cell: text + letter } : { ...row, text: text + letter });
        act = () => typeNativeText(actor, range, letter, {});
      }

      const initial = stateOf(actor), result = act();
      if (options.spoil && action === "refuse" && result.kind === "refused") actor.roots.beats.get("Safe")?.set("spoiled", step);
      const context = `seed ${seed}, command ${step}: ${action}`;
      try {
        assert.equal(result.kind, expected, JSON.stringify(result));
        if (expected !== "written") assert.deepEqual(stateOf(actor), initial, "refusal or no-op wrote");
        onSplit(result);
        for (const heading of actor.reader.outline()) if (heading.kind === "heading") assert.equal(heading.name, names.get(heading.id));
        assert.deepEqual(blockOrder(actor), order);
        assert.deepEqual(entries(actor), afterRows);
        assert.deepEqual(actor.reader.rows().map(entry => entry.members), groups(order, afterRows));
        assert.equal(sorted(stored(actor)), sorted(narration));
      } catch (error) { throw new LocalCheck(`${context}: ${String(error)}`, { cause: error }); }
      counts.commands++;
      if (result.kind === "written") counts.written++;
      else if (result.kind === "refused") counts.refused++;
      else counts.unchanged++;
    }
    net.settle(pick(DELIVERY)); net.agree();
    const [first] = all;
    assert.ok(first);
    const visible = blockOrder(first), surviving = [...letters].filter(letter => !deleted.has(letter));
    assert.equal(sorted(stored(first)), sorted(surviving));
    assert.equal(sorted(first.reader.rows().flatMap(row => [...row.narration.map(run => run.text).join("")])), sorted(surviving));
    assert.equal(new Set(visible).size, visible.length);
    assert.deepEqual([...first.roots.beats.keys()].sort(), [...records].sort());
    assert.deepEqual([...first.roots.visuals.keys()].sort(), [...records].sort());
    assert.deepEqual(visible.filter(id => !id.startsWith("#")).sort(), [...records].filter(id => !removed.has(id)).sort());
    assert.equal(sorted([...first.roots.visuals.values()].flatMap(cell => [...cell.toString()])), sorted(visual));
    for (const [id, title] of names) assert.equal(first.roots.names.get(id)?.toString(), title);
    assert.deepEqual([...first.roots.headings.keys()].sort(), [...names.keys()].sort());
    assert.deepEqual([...first.roots.names.keys()].sort(), [...names.keys()].sort());
    assert.equal(touched.size, 10);
    return {
      ...counts, letters: letters.size, shown: surviving.length, deleted: deleted.size, records: records.size,
      visible: records.size - removed.size, hidden: removed.size, visual: visual.size, names: names.size, rankWrites: options.writes?.length ?? 0
    };
  } finally { for (const script of all) script.doc.destroy(); }
}

test("generated moves and mixed commands check locally and settle with exact letter, cell and record inventories", t => {
  const totals: Record<string, number> = {};
  for (let seed = 1; seed <= SEEDS; seed++) {
    const writes: Write[] = [];
    for (const [key, value] of Object.entries(history(seed, { writes }))) totals[key] = (totals[key] ?? 0) + value;
  }
  t.diagnostic(JSON.stringify(totals));
  assert.equal(totals.commands, SEEDS * STEPS);
  assert.ok((totals.moves ?? 0) > 100 && (totals.rankWrites ?? 0) > 100 && (totals.refused ?? 0) > 0 && (totals.unchanged ?? 0) > 0);
});

test("muting each sampled move write fails at that command, including writes to the right of a tie", t => {
  let caught = 0, neighbours = 0;
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    const writes: Write[] = [];
    history(seed, { writes });
    for (const write of writes) {
      assert.throws(() => history(seed, { mute: write }), (error: unknown) =>
        error instanceof LocalCheck && error.message.startsWith(`seed ${seed}, command ${write.step}:`), JSON.stringify(write));
      caught++;
      if (!write.selected) neighbours++;
    }
  }
  t.diagnostic(`${caught} writes muted and caught, including ${neighbours} writes to unselected blocks`);
  assert.ok(caught > 30 && neighbours >= CONTROL_SEEDS);
});

test("a write after a move refusal fails the full-update check at that command", () => {
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    assert.throws(() => history(seed, { spoil: true }), (error: unknown) =>
      error instanceof LocalCheck && /: refuse: .*refusal or no-op wrote/.test(error.message));
  }
});
