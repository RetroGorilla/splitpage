import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import type { NativeMarkChange } from "../../../../src/adapters/collab/native/format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading, restoreNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { NativeScriptReader, readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { convertedScript, edit, joinedScript, shown } from "./helpers.ts";

after(() => { dom.window.close(); });

const SEEDS = 24, STEPS = 160;
const BEATS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"], HEADINGS = ["H4", "H9"], JOINED = ["R1|b:R2", "R2|b:R3", "R5|b:R6"];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

interface Reading { readonly shown: string[]; readonly document: string; readonly recovery: ReturnType<NativeScriptReader["recovery"]> }

function read(script: NativeScript, reader: NativeScriptReader): Reading {
  return { shown: shown(script, reader), document: JSON.stringify(reader.document()), recovery: reader.recovery() };
}

function freshly(script: NativeScript): Reading {
  return readNativeOnce(script.roots, reader => read(script, reader));
}

function start(): NativeScript {
  const rows = BEATS.slice(0, 6).map(id => ({ id, audioText: id.toLowerCase() + " text", visualText: "v" + id }));
  return convertedScript(migrateRows({ schema: 2, title: "T", docId: "d", rev: 0, rows, sections: [{ id: "H4", name: "Four", firstSceneId: "R4" }], comments: [], people: [], productionTags: [], brollShots: [] }));
}

function operations(script: NativeScript, pick: <T>(list: readonly T[]) => T, chance: () => number): (() => void)[] {
  const roots = script.roots;
  const texts = (): [string, Y.Text][] => [...roots.segments].flatMap(([key, record]) => { const text = record.get("text"); return text instanceof Y.Text ? [[key, text] as [string, Y.Text]] : []; });
  const at = (text: Y.Text): number => Math.floor(chance() * (text.length + 1));
  const block = (): Record<string, string> => chance() < 0.75 ? { b: pick(chance() < 0.85 ? BEATS : JOINED) } : { h: pick(HEADINGS) };
  const markers = (text: Y.Text): number[] => {
    const at: number[] = [];
    let index = 0;
    for (const item of text.toDelta() as { insert: unknown }[]) {
      if (typeof item.insert === "string") index += item.insert.length;
      else { if ((item.insert as { b?: unknown }).b !== undefined) at.push(index); index++; }
    }
    return at;
  };
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
    () => { roots.edited.set(pick(BEATS), chance() < 0.5 ? { at: JSON.stringify("2026"), by: JSON.stringify("x") } : { at: "{bad" }); },
    () => {
      withText(text => {
        const at = markers(text);
        if (at.length < 2) return;
        const first = Math.floor(chance() * (at.length - 1)), left = at[first] as number, right = at[first + 1] as number;
        const ids = (text.toDelta() as { insert: unknown }[]).flatMap(item => typeof item.insert === "string" ? [] : [String((item.insert as { b?: unknown }).b ?? "")]).filter(Boolean);
        text.delete(right, 1); text.delete(left, 1);
        text.insertEmbed(left, { b: (ids[first] ?? "R1") + "|b:" + (ids[first + 1] ?? "R2") }, {});
      });
    }
  ];
}

interface Run {
  compared: number; changed: number; joinedMarkers: number; formatted: number;
  readonly reasons: Set<string>; readonly problems: Set<string>; readonly outcomes: Map<string, number>;
}

const emptyRun = (): Run => ({ compared: 0, changed: 0, joinedMarkers: 0, formatted: 0, reasons: new Set(), problems: new Set(), outcomes: new Map() });

type Formatting = "none" | "mixed" | "only" | "rows" | "rows-only";

function rowOnce(script: NativeScript, pick: <T>(list: readonly T[]) => T, chance: () => number, run: Run): void {
  const entries = readNativeOnce(script.roots, reader => reader.outline());
  const rows = entries.flatMap(entry => entry.kind === "heading" ? [] : [entry.id]), beat = pick(rows.length ? rows : BEATS), roll = chance();
  let outcome: { readonly kind: string; readonly reason?: string }, command: string;
  if (roll < 0.4) {
    const anchored = anchorNativeText(script, { beat, cell: "narration" }, Math.floor(chance() * 4));
    outcome = anchored.kind === "anchored" ? splitNativeRow(script, anchored.range) : anchored;
    command = "split";
  } else if (roll < 0.6) {
    const at = entries.findIndex(entry => entry.kind === "row" && entry.id === beat);
    outcome = joinNativeRow(script, beat, entries[at - 1]?.id ?? pick(BEATS), pick([" ", ""]));
    command = "join";
  } else if (roll < 0.7) {
    outcome = unjoinNativeRow(script, beat);
    command = "unjoin";
  } else {
    outcome = removeNativeRows(script, chance() < 0.3 ? [beat, pick(rows.length ? rows : BEATS)] : [beat]);
    command = "remove";
  }
  const kind = command + " " + (outcome.kind === "refused" ? "refused " + String(outcome.reason) : outcome.kind);
  run.outcomes.set(kind, (run.outcomes.get(kind) ?? 0) + 1);
  if (outcome.kind === "written") run.formatted++;
}

function formatOnce(script: NativeScript, pick: <T>(list: readonly T[]) => T, chance: () => number, run: Run): void {
  const rows = readNativeOnce(script.roots, reader => reader.outline().flatMap(entry => entry.kind === "heading" ? [] : [entry.id]));
  const target: NativeTextTarget = { beat: pick(rows.length ? rows : BEATS), cell: chance() < 0.7 ? "narration" : "visual" }, from = Math.floor(chance() * 5);
  const anchored = anchorNativeText(script, target, from, from + 1 + Math.floor(chance() * 4));
  const on = chance() < 0.7;
  const change = pick<NativeMarkChange>([
    { kind: "plain", mark: pick(["b", "i", "u", "s", "hl", "cue"] as const), on }, { kind: "comment", id: pick(["c1", "c2"]), on },
    { kind: "link", href: on ? pick(["https://a.example/", "https://b.example/"]) : null }, { kind: "tag", id: pick(["t:prop:one", "t:prop:two"]), on }
  ]);
  const outcome = anchored.kind === "anchored" ? formatNativeText(script, anchored.range, change) : anchored;
  const kind = outcome.kind === "refused" ? "refused " + outcome.reason : outcome.kind;
  run.outcomes.set(kind, (run.outcomes.get(kind) ?? 0) + 1);
  if (outcome.kind === "written") run.formatted++;
}

type WarmReader = (script: NativeScript) => NativeScriptReader;

function compareStructuralCommands(script: NativeScript, reader: NativeScriptReader, seed: number): void {
  const peer = joinedScript(script, 201);
  const lower = script.roots.beats.get("R2");
  assert.ok(lower);
  let joined = false, removed = false, created = false, name = "Four";
  const glue = seed % 2 ? " " : "";
  const target = seed % 2 ? "R5" : "R6", createdName = "New scene " + seed;
  const check = (step: string): void => {
    const label = `seed ${seed}, ${step}`, expected = ["R1", ...joined ? [] : ["R2"], "R3", ...removed ? [] : ["H4"], "R4",
      ...["R5", "R6"].flatMap(beat => created && beat === target ? ["HX", beat] : [beat])];
    Y.applyUpdate(script.doc, Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(script.doc)), "remote");
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(script.doc, Y.encodeStateVector(peer.doc)), "remote");
    const late = joinedScript(script, 901);
    try {
      const fresh = freshly(script);
      for (const [copy, view] of [[script, reader], [peer, peer.reader], [late, late.reader]] as const) {
        assert.deepEqual(view.outline().map(entry => entry.id), expected, label);
        assert.equal(view.row("R1")?.audioText, joined ? "r1 text" + glue + "r2 text" : "r1 text", label);
        assert.deepEqual(view.recovery(), removed ? [{ id: "H4", name }] : [], label);
        if (created) assert.deepEqual(view.outline().find(entry => entry.id === "HX"), { kind: "heading", id: "HX", name: createdName }, label);
        assert.deepEqual(read(copy, view), fresh, label);
      }
    } finally { late.doc.destroy(); }
  };
  const joins = (): void => {
    lower.set("joined", { into: "R1", glue });
    joined = true;
    check("joined");
    lower.delete("joined");
    joined = false;
    check("unjoined");
  };
  const rename = (): void => {
    const anchor = anchorNativeText(peer, { beat: "H4", cell: "name" }, 0, name.length);
    assert.equal(anchor.kind, "anchored");
    name = "Scene " + seed;
    assert.equal(anchor.kind === "anchored" && renameNativeHeading(peer, anchor.range, name).kind, "written");
    check("renamed");
  };
  const removal = (): void => {
    assert.equal(removeNativeHeading(peer, "H4").kind, "written");
    removed = true;
    check("removed");
    assert.equal(restoreNativeHeading(script, "H4").kind, "written");
    removed = false;
    check("restored");
  };
  const creation = (): void => {
    const anchor = anchorNativeText(peer, { beat: target, cell: "narration" }, 0);
    assert.equal(anchor.kind, "anchored");
    assert.equal(anchor.kind === "anchored" && createNativeHeading(peer, anchor.range, "HX", createdName).kind, "written");
    created = true;
    check("created");
  };
  const sequences = [[joins, rename, removal, creation], [rename, creation, removal, joins], [removal, joins, rename, creation], [creation, joins, rename, removal]];
  try {
    check("initial");
    for (const act of sequences[seed % sequences.length] ?? []) act();
  } finally { peer.doc.destroy(); }
}

function runSeed(seed: number, run: Run, warmOf: WarmReader = script => script.reader, formatting: Formatting = "none"): void {
  const chance = random(seed), pick = <T>(list: readonly T[]): T => list[Math.floor(chance() * list.length)] as T;
  const script = start(), ops = operations(script, pick, chance), reader = warmOf(script);
  if (formatting !== "only" && formatting !== "rows-only") compareStructuralCommands(script, reader, seed);
  let previous = freshly(script);
  for (let step = 0; step < STEPS; step++) {
    const roll = chance();
    if (formatting === "only" || (formatting === "mixed" && roll < 0.4)) formatOnce(script, pick, chance, run);
    else if (formatting === "rows-only" || (formatting === "rows" && roll < 0.4)) rowOnce(script, pick, chance, run);
    else if (roll < 0.15) {
      const beat = pick(BEATS), cell = chance() < 0.7 ? "narration" as const : "visual" as const;
      edit(script, { beat, cell }, 0, Math.floor(chance() * 2), [{ text: "e", marks: {} }]);
    } else if (roll < 0.35) script.doc.transact(() => { for (let n = 1 + Math.floor(chance() * 3); n > 0; n--) pick(ops)(); });
    else pick(ops)();
    const action = chance();
    if (action < 0.2) reader.refresh();
    else if (action < 0.3) reader.row(pick(BEATS));
    else if (action < 0.75) {
      const fresh = freshly(script), warm = read(script, reader);
      assert.deepEqual(warm, fresh, `seed ${seed}, step ${step}`);
      run.compared++;
      if (JSON.stringify(fresh) !== JSON.stringify(previous)) run.changed++;
      previous = fresh;
      for (const span of reader.unplaced()) run.reasons.add(span.reason);
      for (const problem of reader.problems()) run.problems.add(problem.kind);
      if (JSON.stringify([...script.roots.segments.values()].map((record): unknown => { const text = record.get("text"); return text instanceof Y.Text ? text.toDelta() as unknown : null; })).includes("|b:")) run.joinedMarkers++;
    }
  }
  assert.deepEqual(read(script, reader), freshly(script), `seed ${seed}, end`);
}

test("generated structural and text changes: a warm reader always reads what a fresh reader reads", () => {
  const run = emptyRun();
  for (let seed = 1; seed <= SEEDS; seed++) runSeed(seed, run);
  assert.ok(run.joinedMarkers > 0, "no marker holding a separator was reached");
  assert.deepEqual([...run.reasons].sort(), ["no-order"]);
  assert.deepEqual([...run.problems].sort(), ["bad-value", "heading-without-row", "hidden-units", "join-not-read", "missing-beat-record", "missing-heading-record", "missing-name", "missing-visual", "no-order", "no-segment", "no-text", "unknown-embed"]);
  assert.ok(run.compared > SEEDS * STEPS * 0.3, String(run.compared));
  assert.ok(run.changed > run.compared * 0.5, JSON.stringify({ compared: run.compared, changed: run.changed }));
});

test("control: the same comparison loop catches a warm reader whose invalidation is switched off", () => {
  const readers: NativeScriptReader[] = [];
  const blind: WarmReader = script => { const reader = new NativeScriptReader(script.roots, () => () => undefined); readers.push(reader); return reader; };
  for (const [seed, first] of [[1, "renamed"], [2, "removed"], [3, "created"], [4, "joined"]] as const) {
    assert.throws(() => { runSeed(seed, emptyRun(), blind); }, new RegExp(`seed ${seed}, ${first}`));
  }
  for (const reader of readers) reader.close();
});

test("generated formatting, tag and comment commands among the structural changes: a warm reader reads what a fresh reader reads", t => {
  const run = emptyRun();
  for (let seed = 1; seed <= SEEDS; seed++) runSeed(seed, run, undefined, "mixed");
  t.diagnostic(JSON.stringify({ compared: run.compared, changed: run.changed, formatted: run.formatted, outcomes: Object.fromEntries(run.outcomes) }));
  assert.ok(run.formatted > SEEDS * STEPS * 0.05, String(run.formatted));
  assert.ok(run.compared > SEEDS * STEPS * 0.3 && run.changed > run.compared * 0.3, JSON.stringify({ compared: run.compared, changed: run.changed }));
});

test("control: with formatting commands alone, the comparison catches a warm reader whose invalidation is switched off", () => {
  const readers: NativeScriptReader[] = [];
  const blind: WarmReader = script => { const reader = new NativeScriptReader(script.roots, () => () => undefined); readers.push(reader); return reader; };
  for (let seed = 1; seed <= 3; seed++) {
    const run = emptyRun();
    runSeed(seed, run, undefined, "only");
    assert.ok(run.formatted > 20, String(run.formatted));
    assert.throws(() => { runSeed(seed, emptyRun(), blind, "only"); }, new RegExp(`seed ${seed}, `));
  }
  for (const reader of readers) reader.close();
});

test("generated split, join, unjoin and removal among the structural changes: a warm reader reads what a fresh reader reads", t => {
  const run = emptyRun();
  for (let seed = 1; seed <= SEEDS; seed++) runSeed(seed, run, undefined, "rows");
  t.diagnostic(JSON.stringify({ compared: run.compared, changed: run.changed, written: run.formatted, outcomes: Object.fromEntries(run.outcomes) }));
  for (const command of ["split", "join", "unjoin", "remove"]) assert.ok((run.outcomes.get(command + " written") ?? 0) > 5, command);
  assert.ok(run.formatted > SEEDS * STEPS * 0.05, String(run.formatted));
  assert.ok(run.compared > SEEDS * STEPS * 0.3 && run.changed > run.compared * 0.3, JSON.stringify({ compared: run.compared, changed: run.changed }));
});

test("control: with row commands alone, the comparison catches a warm reader whose invalidation is switched off", () => {
  const readers: NativeScriptReader[] = [];
  const blind: WarmReader = script => { const reader = new NativeScriptReader(script.roots, () => () => undefined); readers.push(reader); return reader; };
  for (let seed = 1; seed <= 3; seed++) {
    const run = emptyRun();
    runSeed(seed, run, undefined, "rows-only");
    assert.ok(run.formatted > 10, String(run.formatted));
    assert.throws(() => { runSeed(seed, emptyRun(), blind, "rows-only"); }, new RegExp(`seed ${seed}, (step \\d+|end)`));
  }
  for (const reader of readers) reader.close();
});
