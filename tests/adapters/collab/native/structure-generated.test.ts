import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, replaceNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { copiesOf, structureScript } from "./structure-harness.ts";

after(() => { dom.window.close(); });

const SEEDS = 40, STEPS = 70, CONTROL_SEEDS = 4;
const ROWS = { R1: "abc", R2: "def", R3: "ghi", R4: "jkl", R5: "mno", R6: "pqr" };
const VISUALS = { R1: "1", R2: "2", R3: "3", R4: "4", R5: "5", R6: "6" };

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

type Write = "Text.insertEmbed" | "Text.delete" | "Map.set" | "Map.delete";
interface Call { readonly command: number; readonly slot: number; readonly write: Write }
interface Options { readonly immediate?: boolean; readonly mute?: Call; readonly calls?: Call[]; readonly spoil?: boolean }

class LocalCheck extends Error {}

const PATCHED: readonly [object, string, Write][] = [
  [Y.Text.prototype, "insertEmbed", "Text.insertEmbed"], [Y.Text.prototype, "delete", "Text.delete"],
  [Y.Map.prototype, "set", "Map.set"], [Y.Map.prototype, "delete", "Map.delete"]
];

// why: every public write a row command makes is numbered, so a control can mute exactly one and expect the check
// made after that command to fail
function intercept(command: number, options: Options): () => void {
  let slot = 0;
  const originals = PATCHED.map(([owner, name, write]) => {
    const table = owner as Record<string, (...args: unknown[]) => unknown>, original = table[name] as (...args: unknown[]) => unknown;
    table[name] = function (this: unknown, ...args: unknown[]): unknown {
      const call: Call = { command, slot: slot++, write };
      options.calls?.push(call);
      if (options.mute?.command === command && options.mute.slot === call.slot) return undefined;
      return original.apply(this, args);
    };
    return () => { table[name] = original; };
  });
  return () => { for (const restore of originals) restore(); };
}

interface Entry {
  readonly id: string; readonly heading: boolean; readonly narration: string; readonly visual: string; readonly rank: string; readonly joined: string;
  readonly pieces: readonly string[]; readonly own: number;
}

// why: one entry per beat in reading order, a joined row's members each on their own, with the pieces of narration the
// reader shows for it (its own span and recovered text), so a command's expectation is derived beat by beat
function view(script: NativeScript): Entry[] {
  const reader = script.reader;
  return reader.outline().flatMap((entry): Entry[] => {
    if (entry.kind === "heading") return [{ id: entry.id, heading: true, narration: "", visual: "", rank: "", joined: "", pieces: [], own: -1 }];
    const members = reader.row(entry.id)?.members ?? [];
    return (members.length ? members : [entry.id]).map(id => {
      const record = script.roots.beats.get(id), joined: unknown = record?.get("joined"), places = reader.narrationSpans(id), own = reader.beatBoundary(id);
      const pieces = places.map(place => (nativeSegmentSpans(script.roots.segments.get(place.segment))?.[place.span]?.items ?? []).map(item => typeof item.insert === "string" ? item.insert : "").join(""));
      return {
        id, heading: false, narration: pieces.join(""), visual: script.roots.visuals.get(id)?.toString() ?? "", rank: String(record?.get("rank") ?? ""),
        joined: joined === undefined ? "" : JSON.stringify(joined), pieces, own: own ? places.indexOf(own) : -1
      };
    });
  });
}

const compared = (entries: readonly Entry[]): string => JSON.stringify(entries.map(entry => [entry.id, entry.heading, entry.narration, entry.visual, entry.rank, entry.joined]));

// why: decision 7: a caret in the own piece splits there, in a recovered piece before it at its start, after it at its
// end
function splitCut(row: Entry, offset: number): number {
  let start = 0, caret = -1;
  const starts = row.pieces.map(piece => { const at = start; start += piece.length; return at; });
  for (const [index, piece] of row.pieces.entries()) if (offset <= (starts[index] ?? 0) + piece.length) { caret = index; break; }
  const ownStart = starts[row.own] ?? 0, ownEnd = ownStart + (row.pieces[row.own]?.length ?? 0);
  return caret === row.own ? offset : caret < row.own ? ownStart : ownEnd;
}

function storedLetters(script: NativeScript): string[] {
  return [...script.roots.segments.values()].flatMap(segment => (nativeSegmentSpans(segment) ?? []).flatMap(span => span.items.flatMap(item => typeof item.insert === "string" ? [...item.insert] : [])));
}

interface Counts {
  commands: number; written: number; unchanged: number; refused: number;
  letters: number; shown: number; twice: number; storedTwice: number; unplaced: number; deleted: number; notDeleted: number; lost: number;
  records: number; shownRows: number; keptRows: number; vanished: number; missingParts: number;
  visualLetters: number; visualStored: number; visualOnHidden: number; joinsOnHidden: number; mutedExpected: number; movedSplits: number;
}

function history(seed: number, options: Options = {}): Counts {
  const chance = random(seed), pick = <T>(list: readonly T[]): T => list[Math.floor(chance() * list.length)] as T;
  const { net, all } = copiesOf(structureScript(ROWS, VISUALS, [{ id: "H", name: "Scene", before: "R4" }]), [2, 3, 4]);
  const counts: Counts = {
    commands: 0, written: 0, unchanged: 0, refused: 0, letters: 0, shown: 0, twice: 0, storedTwice: 0, unplaced: 0, deleted: 0, notDeleted: 0, lost: 0,
    records: 0, shownRows: 0, keptRows: 0, vanished: 0, missingParts: 0, visualLetters: 0, visualStored: 0, visualOnHidden: 0, joinsOnHidden: 0, mutedExpected: 0, movedSplits: 0
  };
  const letters = new Set(Object.values(ROWS).join("")), visualLetters = new Set<string>(), deletions = new Map<string, number[]>();
  const records = new Set(Object.keys(ROWS)), removed = new Set<string>();
  let fresh = 0;
  const letter = (base: number): string => String.fromCharCode(base + fresh++);
  const deleting = (gone: string, command: number): void => { deletions.set(gone, [...deletions.get(gone) ?? [], command]); };
  const leftovers: string[] = [];
  for (let step = 0; step < STEPS; step++) {
    const actor = pick(all), roll = chance();
    if (roll < 0.22) { const to = pick(all.filter(copy => copy !== actor)); net.deliver(actor, to); continue; }
    const before = view(actor), rows = before.filter(entry => !entry.heading && entry.own >= 0 && actor.roots.beats.get(entry.id) instanceof Y.Map), stored = storedLetters(actor);
    if (!rows.length) continue;
    const row = pick(rows), at = before.indexOf(row), command = counts.commands++;
    let want = before, wantStored = stored, expected = "written", act: () => { kind: string; created?: string };
    if (roll < 0.38) {
      const visual = chance() < 0.3, cell = visual ? row.visual : row.narration, offset = Math.floor(chance() * (cell.length + 1));
      const typed = letter(visual ? 0xac00 : 0x4e00);
      (visual ? visualLetters : letters).add(typed);
      if (!visual) wantStored = [...stored, typed];
      want = before.map(entry => entry !== row ? entry : visual ? { ...entry, visual: cell.slice(0, offset) + typed + cell.slice(offset) } : { ...entry, narration: cell.slice(0, offset) + typed + cell.slice(offset) });
      act = () => { const anchored = anchorNativeText(actor, { beat: row.id, cell: visual ? "visual" : "narration" }, offset); return anchored.kind === "anchored" ? replaceNativeText(actor, anchored.range, [{ text: typed, marks: {} }]) : anchored; };
    } else if (roll < 0.45 && row.narration.length) {
      const from = Math.floor(chance() * row.narration.length), to = Math.min(row.narration.length, from + 1 + Math.floor(chance() * 2)), gone = [...row.narration.slice(from, to)];
      for (const value of gone) deleting(value, command);
      wantStored = stored.filter(value => !gone.includes(value));
      want = before.map(entry => entry !== row ? entry : { ...entry, narration: entry.narration.slice(0, from) + entry.narration.slice(to) });
      act = () => { const anchored = anchorNativeText(actor, { beat: row.id, cell: "narration" }, from, to); return anchored.kind === "anchored" ? replaceNativeText(actor, anchored.range, []) : anchored; };
    } else if (roll < 0.66) {
      const offset = Math.floor(chance() * (row.narration.length + 1));
      act = () => { const anchored = anchorNativeText(actor, { beat: row.id, cell: "narration" }, offset); return anchored.kind === "anchored" ? splitNativeRow(actor, anchored.range) : anchored; };
      const outcome = run(command, actor, act, options);
      const created = outcome.created ?? "";
      if (outcome.kind === "written") { assert.ok(!records.has(created) && /^r[0-9a-z]+-[0-9a-z]+$/.test(created), created); records.add(created); }
      const cut = splitCut(row, offset);
      if (cut !== offset) counts.movedSplits++;
      want = [...before.slice(0, at), { ...row, narration: row.narration.slice(0, cut) }, { id: created, heading: false, narration: row.narration.slice(cut), visual: "", rank: row.rank, joined: "", pieces: [], own: -1 }, ...before.slice(at + 1)];
      leftovers.push(...check(seed, command, actor, { want, wantStored, kind: outcome.kind, expected }, options, counts));
      continue;
    } else if (roll < 0.76) {
      const above = before[at - 1], glue = pick([" ", "", " - "]);
      expected = !above || above.heading ? "refused" : row.joined === JSON.stringify({ into: above.id, glue }) ? "unchanged" : "written";
      if (expected === "written" && above) want = before.map(entry => entry !== row ? entry : { ...entry, joined: JSON.stringify({ into: above.id, glue }) });
      const into = above && !above.heading ? above.id : pick(rows).id;
      act = () => joinNativeRow(actor, row.id, into, glue);
    } else if (roll < 0.82) {
      expected = row.joined ? "written" : "unchanged";
      want = before.map(entry => entry !== row ? entry : { ...entry, joined: "" });
      act = () => unjoinNativeRow(actor, row.id);
    } else {
      const chosen = new Set([row.id, ...chance() < 0.4 ? [pick(rows).id] : []]), gone: string[] = [];
      for (const entry of rows) if (chosen.has(entry.id)) { gone.push(...entry.narration); removed.add(entry.id); }
      for (const value of gone) deleting(value, command);
      wantStored = stored.filter(value => !gone.includes(value));
      want = before.filter(entry => !chosen.has(entry.id));
      act = () => removeNativeRows(actor, [...chosen]);
    }
    const outcome = run(command, actor, act, options);
    leftovers.push(...check(seed, command, actor, { want, wantStored, kind: outcome.kind, expected }, options, counts));
  }
  net.settle(); net.settle();
  net.agree();
  const [first] = all;
  assert.ok(first);
  const shownRows = new Set(view(first).filter(entry => !entry.heading).map(entry => entry.id));
  const shownLetters = first.reader.rows().flatMap(row => [...row.narration.map(run => run.text).join("")]), stored = storedLetters(first);
  for (const value of letters) {
    counts.letters++;
    const times = shownLetters.filter(ch => ch === value).length, kept = stored.includes(value);
    const by = deletions.get(value) ?? [];
    if (times > 1) counts.twice++;
    if (stored.filter(ch => ch === value).length > 1) counts.storedTwice++;
    if (leftovers.includes(value) && by.every(command => command === options.mute?.command)) counts.mutedExpected++;
    if (kept && by.length) counts.notDeleted++;
    else if (times) counts.shown++;
    else if (kept) counts.unplaced++;
    else if (by.length) counts.deleted++;
    else counts.lost++;
  }
  for (const id of records) {
    counts.records++;
    const record = first.roots.beats.get(id), cell = first.roots.visuals.get(id);
    if (!(record instanceof Y.Map) || !(cell instanceof Y.Text)) { counts.missingParts++; continue; }
    if (shownRows.has(id)) counts.shownRows++;
    else if (removed.has(id)) { counts.keptRows++; if (record.has("joined")) counts.joinsOnHidden++; }
    else counts.vanished++;
  }
  const visualText = [...first.roots.visuals].map(([id, cell]) => [id, cell.toString()] as const);
  for (const value of visualLetters) {
    counts.visualLetters++;
    const holder = visualText.find(([, text]) => text.includes(value));
    if (holder) { counts.visualStored++; if (!shownRows.has(holder[0])) counts.visualOnHidden++; }
  }
  for (const copy of all) copy.close();
  return counts;
}

// why: a command that refuses or reports no change must leave the full encoded update as it was, not only the reading
function run(command: number, actor: NativeScript, act: () => { kind: string; created?: string }, options: Options): { kind: string; created?: string } {
  const before = Y.encodeStateAsUpdate(actor.doc), restore = intercept(command, options);
  let outcome: { kind: string; created?: string };
  try { outcome = act(); } finally { restore(); }
  if (options.spoil && outcome.kind === "refused") actor.doc.transact(() => { actor.roots.beats.get("R1")?.set("spoiled", command); }, actor.origin);
  if (outcome.kind !== "written" && options.immediate !== false && !sameBytes(before, Y.encodeStateAsUpdate(actor.doc))) {
    throw new LocalCheck(`command ${command}: ${outcome.kind} but the stored update changed`);
  }
  return outcome;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface Expectation { readonly want: Entry[]; readonly wantStored: readonly string[]; readonly kind: string; readonly expected: string }

// why: the outline alone cannot see letters a command should have deleted but left stored outside every row, so the
// stored narration letters are compared too; with the check off, a muted command's leftovers are returned instead
function check(seed: number, command: number, actor: NativeScript, expectation: Expectation, options: Options, counts: Counts): string[] {
  const { want, wantStored, kind, expected } = expectation;
  actor.reader.refresh();
  counts[kind === "written" ? "written" : kind === "unchanged" ? "unchanged" : "refused"]++;
  const stored = storedLetters(actor);
  if (options.immediate === false) return options.mute?.command === command ? stored.filter(value => !wantStored.includes(value)) : [];
  const got = view(actor), sorted = (list: readonly string[]): string => [...list].sort().join("");
  if (kind !== expected || compared(got) !== compared(want) || sorted(stored) !== sorted(wantStored)) {
    throw new LocalCheck(`seed ${seed}, command ${command}: ${kind} (expected ${expected})\n${compared(want)}\n${compared(got)}`);
  }
  return [];
}

test("generated row commands on three copies: every command checks locally, copies agree, and each letter and record is accounted for", t => {
  const totals: Record<string, number> = {};
  for (let seed = 1; seed <= SEEDS; seed++) for (const [key, value] of Object.entries(history(seed))) totals[key] = (totals[key] ?? 0) + value;
  t.diagnostic(JSON.stringify(totals));
  assert.deepEqual([totals.twice, totals.storedTwice, totals.notDeleted, totals.lost, totals.vanished, totals.missingParts], [0, 0, 0, 0, 0, 0], JSON.stringify(totals));
  const total = (key: string): number => totals[key] ?? 0;
  assert.equal(total("shown") + total("unplaced") + total("deleted"), total("letters"));
  assert.equal(total("shownRows") + total("keptRows"), total("records"));
  assert.equal(totals.visualStored, totals.visualLetters);
  assert.ok((totals.written ?? 0) > (totals.commands ?? 0) * 0.6 && (totals.unchanged ?? 0) > 0 && (totals.refused ?? 0) > 0, JSON.stringify(totals));
  assert.equal(total("unplaced"), 0, JSON.stringify(totals));
  assert.ok(total("keptRows") > 20 && total("visualOnHidden") > 0 && total("movedSplits") > 0, JSON.stringify(totals));
});

test("control: a no-op at any write of a row command fails the local check at that command", t => {
  let reached = 0, caught = 0;
  const writes = new Map<Write, number>();
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    const calls: Call[] = [];
    history(seed, { calls });
    for (const call of calls) {
      reached++;
      writes.set(call.write, (writes.get(call.write) ?? 0) + 1);
      assert.throws(() => history(seed, { mute: call }), (error: unknown) => error instanceof LocalCheck && error.message.startsWith(`seed ${seed}, command ${call.command}:`), JSON.stringify(call));
      caught++;
    }
  }
  t.diagnostic(`${reached} writes muted, ${caught} caught at their command: ${JSON.stringify(Object.fromEntries(writes))}`);
  assert.ok(reached > 100 && [...writes.keys()].length === 4, JSON.stringify(Object.fromEntries(writes)));
});

// why: a muted deletion's leftovers that no later command deleted must each be counted as not deleted when settled
test("control: with the local check off, every letter a muted deletion leaves behind is counted as not deleted", t => {
  let muted = 0, possible = 0;
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    const calls: Call[] = [];
    history(seed, { calls });
    for (const call of calls.filter(entry => entry.write === "Text.delete")) {
      muted++;
      const blind = history(seed, { mute: call, immediate: false });
      assert.equal(blind.notDeleted, blind.mutedExpected, `seed ${seed}, command ${call.command}`);
      possible += Number(blind.mutedExpected > 0);
    }
  }
  t.diagnostic(`${muted} deletions muted, ${possible} left letters the settled count reported`);
  assert.ok(muted > 10 && possible > 5, JSON.stringify({ muted, possible }));
});

test("control: a write slipped into any refusal fails the local check at that command", () => {
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    assert.throws(() => history(seed, { spoil: true }), (error: unknown) => error instanceof LocalCheck && /refused but the stored update changed/.test(error.message), `seed ${seed}`);
  }
});
