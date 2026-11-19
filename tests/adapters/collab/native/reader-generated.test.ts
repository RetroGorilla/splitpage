import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { NativeScriptReader } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { convertedScript, edit, shown } from "./helpers.ts";

after(() => { dom.window.close(); });

const SEEDS = 24, STEPS = 160;
const BEATS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"], HEADINGS = ["H4", "H9"];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

interface Reading { readonly shown: string[]; readonly document: string }

function read(script: NativeScript, reader: NativeScriptReader): Reading {
  return { shown: shown(script, reader), document: JSON.stringify(reader.document()) };
}

function freshly(script: NativeScript): Reading {
  const reader = new NativeScriptReader(script.roots);
  try { return read(script, reader); } finally { reader.close(); }
}

function start(): NativeScript {
  const rows = BEATS.slice(0, 6).map(id => ({ id, audioText: id.toLowerCase() + " text", visualText: "v" + id }));
  return convertedScript(migrateRows({ schema: 2, title: "T", docId: "d", rev: 0, rows, sections: [{ id: "H4", name: "Four", firstSceneId: "R4" }], comments: [], people: [], productionTags: [], brollShots: [] }));
}

function operations(script: NativeScript, pick: <T>(list: readonly T[]) => T, chance: () => number): (() => void)[] {
  const roots = script.roots;
  const texts = (): [string, Y.Text][] => [...roots.segments].flatMap(([key, record]) => { const text = record.get("text"); return text instanceof Y.Text ? [[key, text] as [string, Y.Text]] : []; });
  const at = (text: Y.Text): number => Math.floor(chance() * (text.length + 1));
  const block = (): Record<string, string> => chance() < 0.75 ? { b: pick(BEATS) } : { h: pick(HEADINGS) };
  const withText = (act: (text: Y.Text) => void): void => { const list = texts(); if (list.length) act(pick(list)[1]); };
  let made = 0;
  return [
    () => { withText(text => { text.insert(at(text), pick(["q", "zz", " "]), {}); }); },
    () => { withText(text => { if (text.length) { const from = Math.floor(chance() * text.length); text.delete(from, Math.min(1 + Math.floor(chance() * 3), text.length - from)); } }); },
    () => { withText(text => { text.insertEmbed(at(text), block(), {}); }); },
    () => { withText(text => { text.insertEmbed(at(text), pick([{ future: "x" }, { k: "pause", label: "P" }]), {}); text.insert(at(text), pick(["​", "￼", "w"]), {}); }); },
    () => {
      const record = new Y.Map<unknown>(), text = new Y.Text(), key = "s:" + String(made++);
      roots.segments.set(key, record);
      record.set("head", chance() < 0.15 ? "junk" : block());
      record.set("text", text);
      text.insert(0, pick(["", "n", "new text"]), {});
      if (chance() < 0.7) roots.order.insert(Math.floor(chance() * (roots.order.length + 1)), [key]);
    },
    () => { const keys = [...roots.segments.keys()]; if (keys.length) roots.segments.delete(pick(keys)); },
    () => { if (roots.order.length) { const index = Math.floor(chance() * roots.order.length), key = roots.order.get(index); roots.order.delete(index, 1); if (chance() < 0.8) roots.order.push([key]); } },
    () => {
      const id = pick(BEATS);
      if (roots.beats.has(id) && chance() < 0.5) { roots.beats.delete(id); return; }
      const record = new Y.Map<unknown>();
      roots.beats.set(id, record);
      record.set("rank", pick(["a", "m", "~", "0"]));
      record.set("status", JSON.stringify(pick(["ready", "draft"])));
      record.set("extra", pick(["{}", "{bad", JSON.stringify({ note: "n" })]));
    },
    () => { const record = roots.beats.get(pick(BEATS)); if (record) { if (chance() < 0.3) record.delete("rank"); else record.set("rank", pick(["a", "m", "~", "0", "a0V"])); } },
    () => {
      const id = pick(BEATS);
      if (roots.visuals.has(id) && chance() < 0.4) { roots.visuals.delete(id); return; }
      const text = new Y.Text();
      roots.visuals.set(id, text);
      text.insert(0, pick(["", "vis"]), {});
    },
    () => { const record = roots.segments.get(pick([...roots.segments.keys(), "none"])); if (record) { if (chance() < 0.5) record.delete("text"); else { const text = new Y.Text(); record.set("text", text); text.insert(0, "t", {}); } } },
    () => {
      const id = pick(HEADINGS);
      if (chance() < 0.4) { const name = new Y.Text(); roots.names.set(id, name); name.insert(0, pick(["Renamed", "Other"]), {}); return; }
      const record = roots.headings.get(id) ?? new Y.Map<unknown>();
      if (!roots.headings.has(id)) roots.headings.set(id, record);
      record.set("rank", pick(["a", "m", "~"]));
      record.set("removed", chance() < 0.3);
    },
    () => { roots.beats.get(pick(BEATS))?.set("joined", chance() < 0.5 ? JSON.stringify({ into: "R1" }) : "{}"); },
    () => { roots.edited.set(pick(BEATS), chance() < 0.5 ? { at: JSON.stringify("2026"), by: JSON.stringify("x") } : { at: "{bad" }); }
  ];
}

interface Run { compared: number; changed: number; reasons: Set<string>; problems: Set<string> }

function runSeed(seed: number, run: Run): void {
  const chance = random(seed), pick = <T>(list: readonly T[]): T => list[Math.floor(chance() * list.length)] as T;
  const script = start(), ops = operations(script, pick, chance);
  let previous = freshly(script);
  for (let step = 0; step < STEPS; step++) {
    const roll = chance();
    if (roll < 0.15) {
      const beat = pick(BEATS), cell = chance() < 0.7 ? "narration" as const : "visual" as const;
      edit(script, { beat, cell }, 0, Math.floor(chance() * 2), [{ text: "e", marks: {} }]);
    } else if (roll < 0.35) script.doc.transact(() => { for (let n = 1 + Math.floor(chance() * 3); n > 0; n--) pick(ops)(); });
    else pick(ops)();
    const action = chance();
    if (action < 0.2) script.reader.refresh();
    else if (action < 0.3) script.reader.row(pick(BEATS));
    else if (action < 0.75) {
      const fresh = freshly(script), warm = read(script, script.reader);
      assert.deepEqual(warm, fresh, `seed ${seed}, step ${step}`);
      run.compared++;
      if (JSON.stringify(fresh) !== JSON.stringify(previous)) run.changed++;
      previous = fresh;
      for (const span of script.reader.unplaced()) run.reasons.add(span.reason);
      for (const problem of script.reader.problems()) run.problems.add(problem.kind);
    }
  }
  assert.deepEqual(read(script, script.reader), freshly(script), `seed ${seed}, end`);
}

test("generated structural and text changes: a warm reader always reads what a fresh reader reads", () => {
  const run: Run = { compared: 0, changed: 0, reasons: new Set(), problems: new Set() };
  for (let seed = 1; seed <= SEEDS; seed++) runSeed(seed, run);
  assert.deepEqual([...run.reasons].sort(), ["heading-text", "no-head", "no-order", "no-record", "repeated"]);
  assert.deepEqual([...run.problems].sort(), ["bad-value", "heading-without-row", "hidden-units", "join-not-read", "no-text", "unknown-embed"]);
  assert.ok(run.compared > SEEDS * STEPS * 0.3, String(run.compared));
  assert.ok(run.changed > run.compared * 0.5, JSON.stringify({ compared: run.compared, changed: run.changed }));
});

test("control: a reader that stops watching after its first read is caught", () => {
  const chance = random(7), pick = <T>(list: readonly T[]): T => list[Math.floor(chance() * list.length)] as T;
  const script = start(), ops = operations(script, pick, chance), stale = new NativeScriptReader(script.roots);
  const before = read(script, stale);
  stale.close();
  let caught = false;
  for (let step = 0; step < STEPS && !caught; step++) {
    pick(ops)();
    caught = JSON.stringify(before) !== JSON.stringify(freshly(script));
  }
  assert.ok(caught);
});
