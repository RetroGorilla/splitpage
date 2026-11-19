import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { random, RATES } from "../format-keys/life.ts";
import { NativeReplica } from "../native/variant.ts";
import type { NativeDeltaItem, NativeField } from "../native/variant.ts";

const WORDS = "the camera pans across a quiet harbour while the narrator explains why the light changes at the end of the day";
const MARKS = ["t:prop:lamp", "t:prop:coat", "t:prop:boat", "t:prop:map", "hl", "hl", "b", "b", "i", "dir", "cue", "c:note"];
const rate = RATES.realistic;
assert(rate);
const { typed, formats, pastes } = rate;
const BEATS = 300;
const CHARACTERS_PER_BEAT = 75;
const SIZE_TOLERANCE = 0.05;

export interface SizeBuildOptions {
  gc?: boolean;
  faithful?: boolean;
  days?: number;
}

export type SizeTarget = 0.5 | 15;

interface VisibleSizeScript {
  characters: number;
  hash: string;
  beats: number;
  headings: number;
}

export interface SizeFixture {
  state: Uint8Array;
  behind: Record<"day" | "month" | "history", Uint8Array>;
  expected: VisibleSizeScript;
  middle: string;
  days: number;
  buildSeconds: number;
}

function prose(length: number, start: number): string {
  const source = WORDS + " ";
  const offset = start % source.length;
  return source.repeat(Math.ceil((offset + length) / source.length)).slice(offset, offset + length);
}

function heading(index: number): string { return `Scene ${index / 15 + 1}`; }

function digest(rows: Iterable<readonly [string, string, string]>, headings: Iterable<readonly [string, string]>): VisibleSizeScript {
  const hash = createHash("sha256");
  let characters = 0, rowCount = 0, headingCount = 0;
  for (const [id, audio, visual] of rows) {
    hash.update(JSON.stringify([id, audio, visual]));
    characters += audio.length + visual.length;
    rowCount++;
  }
  for (const [id, title] of headings) {
    hash.update(JSON.stringify([id, title]));
    characters += title.length;
    headingCount++;
  }
  return { characters, hash: hash.digest("hex"), beats: rowCount, headings: headingCount };
}

function plain(delta: readonly NativeDeltaItem[]): string {
  return delta.map(item => {
    assert.equal(typeof item.insert, "string");
    return item.insert;
  }).join("");
}

export function readSizeScript(replica: NativeReplica): {
  rows: ReturnType<NativeReplica["rows"]>;
  headings: ReturnType<NativeReplica["blocks"]>;
} {
  return { rows: replica.rows(), headings: replica.blocks().filter(block => block.kind === "h") };
}

export function sizeSignature({ rows, headings }: ReturnType<typeof readSizeScript>): VisibleSizeScript {
  return digest(rows.map(row => [row.id, plain(row.audio), plain(row.visual)]),
    headings.map(block => [block.id, plain(block.delta)]));
}

export function assertTarget(target: SizeTarget, bytes: number): void {
  assert(Math.abs(bytes / (target * 1e6) - 1) <= SIZE_TOLERANCE, `${target} MB target missed: ${bytes} bytes`);
}

interface SourceRow { id: string; audioText: string; visualText: string }

function seeded(): { rows: SourceRow[]; sections: { id: string; name: string; firstSceneId: string }[]; state: Uint8Array } {
  const audioLength = Math.floor(CHARACTERS_PER_BEAT * 0.72);
  const rows = Array.from({ length: BEATS }, (_, index): SourceRow => ({
    id: `r${index}`, audioText: prose(audioLength, index * 11), visualText: prose(CHARACTERS_PER_BEAT - audioLength, index * 13)
  }));
  const sections = rows.flatMap((row, index) => index % 15 ? [] : [{ id: `h${index}`, name: heading(index), firstSceneId: row.id }]);
  const seed = new NativeReplica(1);
  seed.hydrate({ rows: rows.map((row, index) => index % 5 ? row : {
    ...row, audioText: row.audioText.slice(0, 9) + "<strong>" + row.audioText.slice(9, 19) + "</strong>" + row.audioText.slice(19)
  }), sections });
  const state = seed.encode();
  seed.destroy();
  return { rows, sections, state };
}

interface RevisionCell { text: Y.Text; row: SourceRow; field: NativeField }
type RevisionPair = [RevisionCell, RevisionCell];

function revise(doc: Y.Doc, cell: RevisionCell, from: number, text: string, cut: number, faithful?: NativeReplica): void {
  const { row, field } = cell;
  row[field] = row[field].slice(0, from) + text + row[field].slice(from + cut);
  if (faithful) {
    doc.transact(() => cell.text.delete(from, cut));
    faithful.changes();
    for (let offset = 0; offset < text.length; offset++) {
      cell.text.insert(from + offset, text.charAt(offset));
      faithful.changes();
    }
    return;
  }
  doc.transact(() => {
    cell.text.delete(from, cut);
    cell.text.insert(from, text);
  });
}

function dayOfEdits(doc: Y.Doc, cells: RevisionPair[], next: () => number, faithful?: NativeReplica): void {
  const pick = (limit: number): number => Math.floor(next() * limit);
  const choose = (): RevisionPair => {
    const pair = cells[pick(cells.length)];
    assert(pair);
    return pair;
  };
  const select = (pair: RevisionPair): RevisionCell => pair[next() < 0.3 ? 1 : 0];
  for (let round = 0, written = 0; round < 5; round++) {
    const pair = choose();
    while (written < typed * (round + 1) / 5) {
      const cell = select(pair);
      const length = Math.min(5 + pick(36), cell.row[cell.field].length);
      const from = pick(cell.row[cell.field].length - length + 1);
      revise(doc, cell, from, prose(length, pick(WORDS.length)), length, faithful);
      written += length;
    }
  }
  for (let round = 0; round < 5; round++) {
    const pair = choose();
    for (let slot = 0; slot < formats / 5; slot++) {
      const cell = select(pair);
      const name = MARKS[pick(MARKS.length)];
      assert(name);
      const from = pick(cell.row[cell.field].length - 2);
      const length = Math.min(cell.row[cell.field].length - from, 3 + pick(38));
      cell.text.format(from, length, { [name]: next() < 0.2 ? null : true });
      faithful?.changes();
    }
  }
  for (let paste = 0; paste < pastes; paste++) {
    const cell = select(choose());
    const length = Math.min(cell.row[cell.field].length, 10 + pick(51));
    const from = pick(cell.row[cell.field].length - length + 1);
    const text = prose(length, pick(WORDS.length));
    cell.row[cell.field] = cell.row[cell.field].slice(0, from) + text + cell.row[cell.field].slice(from + length);
    doc.transact(() => {
      cell.text.delete(from, length);
      const tag = MARKS[pick(4)];
      assert(tag);
      cell.text.insert(from, text, { b: true, [tag]: true });
    });
    faithful?.changes();
  }
}

export function buildSizeFixture(target: SizeTarget, { gc = true, faithful = false, days: finish }: SizeBuildOptions = {}): SizeFixture {
  const start = performance.now(), { rows, sections, state: original } = seeded();
  const targetBytes = target * 1e6;
  const observed = faithful ? new NativeReplica(2) : undefined;
  observed?.undo.destroy();
  const doc = observed?.doc ?? new Y.Doc({ gc });
  doc.gc = gc;
  doc.clientID = 2;
  try {
    Y.applyUpdate(doc, original);
    observed?.changes();
    const cellFor = (row: SourceRow, field: NativeField): RevisionCell => {
      const text = field === "audioText"
        ? doc.getMap<Y.Map<Y.Text>>("segments").get(`seg-b-${row.id}`)?.get("text")
        : doc.getMap<Y.Text>("visuals").get(row.id);
      assert(text instanceof Y.Text);
      return { text, row, field };
    };
    const cells = rows.map((row): RevisionPair => [cellFor(row, "audioText"), cellFor(row, "visualText")]);
    const next = random(7001);
    const recent = new Map<number, Uint8Array>();
    const sampleEvery = target === 0.5 ? 32 : 256;
    let days = 0, nextSample = sampleEvery;
    let state = original;
    while (days < (finish ?? Infinity)) {
      if (performance.now() - start > 480_000) throw new Error(`Build time limit at day ${days}, last sampled ${state.length} bytes`);
      dayOfEdits(doc, cells, next, observed);
      days++;
      if (finish !== undefined && (days === finish - 30 || days === finish - 1 || days === finish)) {
        state = Y.encodeStateAsUpdate(doc);
        recent.set(days, state);
      } else if (finish === undefined && days === nextSample) {
        state = Y.encodeStateAsUpdate(doc);
        nextSample += state.length < targetBytes * 0.9 ? sampleEvery : 32;
        if (state.length >= targetBytes - 40_000) {
          finish = days + 30;
          recent.set(days, state);
        }
      }
    }
    const expected = digest(rows.map(row => [row.id, row.audioText, row.visualText]), sections.map(section => [section.id, section.name]));
    const actual = digest(cells.map(([audio, visual]) => [audio.row.id, audio.text.toString(), visual.text.toString()]),
      sections.map(section => {
        const text = doc.getMap<Y.Map<Y.Text>>("segments").get(`seg-h-${section.id}`)?.get("text");
        assert(text instanceof Y.Text);
        return [section.id, text.toString()];
      }));
    assert.deepEqual(actual, expected, "Generated Yjs cells differ from the independent text record");
    if (observed) assert.deepEqual(sizeSignature(readSizeScript(observed)), expected);
    if (gc) assertTarget(target, state.length);
    const day = recent.get(days - 1), month = recent.get(days - 30), middle = rows[Math.floor(rows.length / 2)];
    assert(day && month && middle);
    return {
      state, behind: { day, month, history: original },
      expected, middle: middle.id, days, buildSeconds: (performance.now() - start) / 1_000
    };
  } finally {
    if (observed) observed.destroy();
    else doc.destroy();
  }
}

export function loadSizeReplica(state: Uint8Array, editing = false, gc = true): NativeReplica {
  const replica = new NativeReplica(3);
  if (!editing) replica.undo.destroy();
  replica.doc.gc = gc;
  Y.applyUpdate(replica.doc, state, "remote");
  return replica;
}
