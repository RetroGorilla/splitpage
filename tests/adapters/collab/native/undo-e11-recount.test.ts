import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as Y from "yjs";
import { nativeInitialRank } from "../../../../src/adapters/collab/native/convert.ts";
import { formatNativeText } from "../../../../src/adapters/collab/native/format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading, restoreNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import type { NativeMoveBlock } from "../../../../src/adapters/collab/native/move-commands.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import { setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "../../../../src/adapters/collab/native/structure-commands.ts";
import { anchorNativeText, deleteNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { arrangePackets } from "./helpers.ts";
import type { Delivery } from "./helpers.ts";

type Cell = "audio" | "visual" | "name";
type Drop = { unit: "row" | "rows" | "scene"; first: string; last?: string; target: string; after: boolean };
type Command =
  | { op: "type"; id: string; field: Cell; at: number; text: string }
  | { op: "erase"; id: string; field: Cell; from: number; to: number }
  | { op: "format"; id: string; field: "audio"; from: number; to: number; key: "t:prop" | "b" | "i"; on: boolean }
  | { op: "field"; id: string; key: "status" | "lens"; value: string }
  | { op: "split"; id: string; at: number; created: string }
  | { op: "join" | "unjoin" | "removeHeading" | "restoreHeading"; id: string }
  | { op: "delete"; rows: string[] }
  | { op: "heading"; above: string; id: string; text: string }
  | { op: "move"; drop: Drop }
  | { op: "undo" } | { op: "redo" };
type Step = { by: number; cmd: Command } | { from: number; to: number } | { open: number; from: number };
type Marker = { b: string } | { h: string };
type Spec = {
  order: string[];
  segments: Record<string, { head: Marker; units: (string | Marker)[] }>;
  beats: Record<string, Record<string, unknown>>;
  visuals: Record<string, string>;
  headings: Record<string, Record<string, unknown>>;
};
type TagTotals = { requested: number; kept: number; undone: number[]; lost: number[] };
type History = { seed: number; steps: Step[]; tags: Record<string, string>; baseline: TagTotals[] };

const TAG = "t:prop:lamp";
const MODES: readonly Delivery[] = ["forward", "reverse", "twice", "shuffled", "state"];
const CELLS = { audio: "narration", visual: "visual", name: "name" } as const;

// why: recorded with generateHistory(seed, 40, false, "cells") and the original play/standing ledger;
// preserving the prototype's picks keeps differences in the product replay from changing the input
const [specLine, ...historyLines] = readFileSync(new URL("./undo-e11-histories.ndjson", import.meta.url), "utf8").trimEnd().split("\n");
assert.ok(specLine);
const spec = JSON.parse(specLine) as Spec;
const histories = historyLines.map(line => JSON.parse(line) as History);

function seedNative(spec: Spec): NativeScript {
  const doc = new Y.Doc();
  doc.clientID = 900;
  const script = openNativeScript(doc), roots = script.roots;
  let rank = 0;
  const boundary = (marker: Marker) => {
    if ("h" in marker) {
      roots.headings.set(marker.h, new Y.Map(Object.entries({ ...spec.headings[marker.h], rank: nativeInitialRank(rank++) })));
      const name = new Y.Text();
      roots.names.set(marker.h, name);
      return name;
    }
    const record = spec.beats[marker.b], visual = new Y.Text();
    roots.beats.set(marker.b, new Y.Map(Object.entries({ rank: nativeInitialRank(rank++), extra: JSON.stringify(record ?? {}) })));
    roots.visuals.set(marker.b, visual);
    visual.insert(0, spec.visuals[marker.b] ?? "", {});
    return null;
  };
  doc.transact(() => {
    roots.order.push(spec.order);
    for (const key of spec.order) {
      const data = spec.segments[key];
      assert.ok(data);
      const text = new Y.Text(), segment = new Y.Map<unknown>();
      roots.segments.set(key, segment);
      segment.set("head", data.head);
      segment.set("text", text);
      let name = boundary(data.head);
      for (const unit of data.units) {
        if (typeof unit === "string") {
          const cell = name ?? text;
          cell.insert(cell.length, unit, {});
        } else {
          text.insertEmbed(text.length, unit, {});
          name = boundary(unit);
        }
      }
    }
  }, "fixture");
  return script;
}

function enactMove(script: NativeScript, drop: Drop, id: (label: string) => string): string {
  const order = script.reader.outline(), at = order.findIndex(block => block.id === id(drop.first));
  const last = drop.last;
  const limit = last ? order.findIndex(block => block.id === id(last)) : at;
  const endOfScene = (at: number) => {
    const next = order.findIndex((entry, index) => index > at && entry.kind === "heading");
    return next < 0 ? order.length : next;
  };
  const blocks = (start: number, end: number): NativeMoveBlock[] => order.slice(start, end).flatMap<NativeMoveBlock>(entry =>
    entry.kind === "heading" ? [{ kind: "heading", id: entry.id }]
      : script.reader.row(entry.id)?.members.length ? [{ kind: "beat", id: entry.id }] : []);
  const target = order.findIndex(block => block.id === id(drop.target));
  if (at < 0 || limit < at || target < 0) return "missing move target";
  const picked = blocks(at, drop.unit === "scene" ? endOfScene(at) : limit + 1);
  const gap = drop.after ? drop.unit === "scene" ? endOfScene(target) : target + 1 : target;
  if (!picked.length || gap < order.length && !blocks(gap, gap + 1).length) return "narration-only move";
  return outcomeOf(moveNativeBlocks(script, picked, blocks(gap, gap + 1)[0] ?? null));
}

function outcomeOf(value: { kind: string; reason?: string }): string {
  return value.reason ?? value.kind;
}

function enact(script: NativeScript, cmd: Exclude<Command, { op: "undo" | "redo" }>, labels: Map<string, string>): string {
  const id = (label: string) => labels.get(label) ?? label;
  const range = (label: string, field: Cell, from: number, to = from) =>
    anchorNativeText(script, { beat: id(label), cell: CELLS[field] }, from, to);
  switch (cmd.op) {
    case "type": case "erase": {
      const at = cmd.op === "type" ? range(cmd.id, cmd.field, cmd.at) : range(cmd.id, cmd.field, cmd.from, cmd.to);
      if (at.kind !== "anchored") return at.reason;
      if (cmd.field === "name") return outcomeOf(renameNativeHeading(script, at.range, cmd.op === "type" ? cmd.text : ""));
      return outcomeOf(cmd.op === "type" ? typeNativeText(script, at.range, cmd.text, {}) : deleteNativeText(script, at.range));
    }
    case "format": {
      const at = range(cmd.id, cmd.field, cmd.from, cmd.to);
      if (at.kind !== "anchored") return at.reason;
      return outcomeOf(formatNativeText(script, at.range, cmd.key === "t:prop" ? { kind: "tag", id: TAG, on: cmd.on }
        : { kind: "plain", mark: cmd.key, on: cmd.on }));
    }
    case "field": {
      const status = ["todo", "ready", "shot"][Number(cmd.value.slice(2)) % 3];
      return outcomeOf(setNativeField(script, { kind: "beat", id: id(cmd.id), field: cmd.key }, cmd.key === "status" ? status : cmd.value));
    }
    case "split": {
      const at = range(cmd.id, "audio", cmd.at);
      if (at.kind !== "anchored") return at.reason;
      const result = splitNativeRow(script, at.range);
      if (result.kind === "written") labels.set(cmd.created, result.created);
      return outcomeOf(result);
    }
    case "join": {
      const outline = script.reader.outline(), index = outline.findIndex(entry => entry.id === id(cmd.id)), previous = outline[index - 1];
      const above = previous?.kind === "row" ? script.reader.row(previous.id)?.members.at(-1) : undefined;
      return above ? outcomeOf(joinNativeRow(script, id(cmd.id), above, " ")) : "missing join target";
    }
    case "unjoin": return outcomeOf(unjoinNativeRow(script, id(cmd.id)));
    case "delete": {
      const rows = script.reader.rows(), targets = cmd.rows.flatMap(label => rows.find(row => row.id === id(label) || row.members.includes(id(label)))?.members ?? [id(label)]);
      return outcomeOf(removeNativeRows(script, [...new Set(targets)]));
    }
    case "heading": {
      const at = range(cmd.above, "audio", 0);
      return at.kind === "anchored" ? outcomeOf(createNativeHeading(script, at.range, cmd.id, cmd.text)) : at.reason;
    }
    case "removeHeading": return outcomeOf(removeNativeHeading(script, cmd.id));
    case "restoreHeading": return outcomeOf(restoreNativeHeading(script, cmd.id));
    case "move": return enactMove(script, cmd.drop, id);
  }
}

function narrationAt(script: NativeScript, id: string) {
  return script.reader.narrationSpans(id).flatMap(place =>
    nativeSegmentSpans(script.roots.segments.get(place.segment))?.[place.span]?.items ?? []);
}

function lettersAt(script: NativeScript, id: string): string {
  return narrationAt(script, id).map(item => typeof item.insert === "string" ? item.insert : "").join("");
}

function survivingTags(script: NativeScript): Map<string, boolean> {
  const tags = new Map<string, boolean>();
  for (const row of script.reader.rows()) for (const id of row.members.length ? row.members : [row.id]) {
    for (const { insert, attributes } of narrationAt(script, id)) {
      if (typeof insert !== "string") continue;
      const tagged = Object.entries(attributes ?? {}).some(([key, value]) => value === true && key.split("\u001f")[0] === "t:" + TAG);
      for (const char of insert) tags.set(char, tagged && (tags.get(char) ?? true));
    }
  }
  return tags;
}

type NativeReplay = ReturnType<typeof replay>;
function replay(state: Uint8Array, { seed, steps, tags }: History, mode: Delivery, index: number) {
  const packets: Uint8Array[] = [], writers: (Copy | undefined)[] = [], labels = new Map<string, string>();
  const active = new Map<number, boolean>(), requests: TagRequest[] = [], differences: string[] = [];
  interface Copy {
    script: NativeScript;
    history: ReturnType<typeof openNativeUndo>;
    known: Set<number>;
    seen: Set<number>;
    entries: Map<number, number>;
  }
  interface TagRequest { step: number; letters: string; on: boolean; seen: Set<number>; actual: string; outcome: string }
  function open(id: number, bytes: Uint8Array, source?: Copy): Copy {
    const doc = new Y.Doc();
    doc.clientID = id;
    const script = openNativeScript(doc), history = openNativeUndo(script);
    Y.applyUpdate(doc, bytes, "remote");
    const known = new Set(source?.known);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") known.add(packets.push(update) - 1);
    });
    return { script, history, known, seen: new Set(source?.seen), entries: new Map() };
  }
  function copyAt(at: number): Copy { const copy = writers[at]; assert.ok(copy); return copy; }
  function send(from: Copy, to: Copy, at: number): void {
    const missing = [...from.known].filter(id => !to.known.has(id)).sort((a, b) => a - b);
    for (const id of missing) to.known.add(id);
    const updates = mode === "state" ? [Y.encodeStateAsUpdate(from.script.doc, Y.encodeStateVector(to.script.doc))]
      : arrangePackets(missing.map(id => { const packet = packets[id]; assert.ok(packet); return packet; }), mode, seed * 7 + index + at);
    for (const update of updates) Y.applyUpdate(to.script.doc, update, "remote");
    for (const event of from.seen) to.seen.add(event);
    to.script.reader.refresh();
  }
  writers.push(open(1, state), open(2, state));
  const waiting = open(801, state);
  let witnessed = false;
  try {
    for (const [at, step] of steps.entries()) {
      if ("open" in step) {
        const source = copyAt(step.from);
        writers[step.open] = open(step.open + 1, Y.encodeStateAsUpdate(source.script.doc), source);
      } else if ("from" in step) send(copyAt(step.from), copyAt(step.to), at);
      else {
        const copy = copyAt(step.by), { script, history, entries } = copy, command = step.cmd;
        if (command.op === "undo" || command.op === "redo") {
          const press = history[command.op]();
          if (press.kind === "written") {
            assert.ok(press.entry !== null);
            const original = entries.get(press.entry);
            assert.ok(original !== undefined);
            active.set(original, command.op === "redo");
            if (tags[original] !== undefined) differences.push(`${at} ${command.op}: applied tag command ${original}`);
            const target = (command.op === "redo" ? history.undoStack : history.redoStack).at(-1);
            assert.ok(target !== undefined);
            entries.set(target, original);
          }
        } else {
          const requested = tags[at];
          const actual = requested !== undefined && command.op === "format"
            ? lettersAt(script, labels.get(command.id) ?? command.id).slice(command.from, command.to) : "";
          history.stopCapturing();
          const outcome = enact(script, command, labels);
          if (outcome === "written") {
            const entry = history.undoStack.at(-1);
            assert.ok(entry !== undefined);
            entries.set(entry, at);
          } else if (outcome !== "unchanged") {
            const cell = command.op === "format" ? " in " + JSON.stringify(lettersAt(script, labels.get(command.id) ?? command.id)) : "";
            differences.push(`${at} ${command.op}: ${outcome}${cell}`);
          }
          if (requested && command.op === "format") requests.push({ step: at, letters: requested, on: command.on, seen: new Set(copy.seen), actual, outcome });
        }
        copy.seen.add(at);
        script.reader.refresh();
        if (!witnessed) { witnessed = true; send(copy, waiting, at); }
      }
    }
    const hub = copyAt(0), others = [...writers.slice(1).filter(copy => copy !== undefined), waiting], all = [hub, ...others];
    for (let round = 0; round < 10 && all.some(copy => copy.known.size < packets.length); round++) {
      for (const copy of others) send(copy, hub, steps.length);
      for (const copy of others) send(hub, copy, steps.length);
    }
    assert.ok(all.every(copy => copy.known.size === packets.length), `seed ${seed}, ${mode}: delivered all packets`);
    const surviving = survivingTags(hub.script);
    for (const copy of others) assert.deepEqual(survivingTags(copy.script), surviving, `seed ${seed}, ${mode}: surviving tags`);
    const wanted = requests.filter(ask => ask.on);
    const undone = wanted.filter(ask => active.get(ask.step) === false).map(ask => ask.step);
    const lost = wanted.filter(ask => active.get(ask.step) !== false && [...ask.letters].some(letter => surviving.get(letter) === false
      && !requests.some(off => !off.on && off.seen.has(ask.step) && off.letters.includes(letter) && active.get(off.step) !== false)))
      .map(ask => ask.step);
    return { requested: wanted.length, kept: wanted.length - undone.length - lost.length, undone, lost, differences, requests };
  } finally {
    for (const copy of [...writers, waiting]) copy?.script.doc.destroy();
  }
}

function totals(results: readonly TagTotals[]) {
  const forward = results[0];
  assert.ok(forward);
  return { requested: forward.requested, kept: forward.kept, undone: forward.undone.length, lost: results.find(result => result.lost.length)?.lost.length ?? 0 };
}

test("E11: native commands replay the original 600 name-cell histories in five deliveries", t => {
  const script = seedNative(spec), state = Y.encodeStateAsUpdate(script.doc);
  script.doc.destroy();
  const sum = { requested: 0, kept: 0, undone: 0, lost: 0 }, original = { ...sum };
  const lostSeeds: number[] = [];
  const changed: { seed: number; original: ReturnType<typeof totals>; product: ReturnType<typeof totals>; notes: string[] }[] = [];
  assert.deepEqual(histories.map(history => history.seed), Array.from({ length: 600 }, (_, index) => index + 1));
  for (const history of histories) {
    const results: NativeReplay[] = MODES.map((mode, index) => replay(state, history, mode, index));
    const expected = totals(history.baseline), actual = totals(results);
    if (actual.lost) lostSeeds.push(history.seed);
    for (const key of ["requested", "kept", "undone", "lost"] as const) {
      original[key] += expected[key];
      sum[key] += actual[key];
    }
    if (JSON.stringify(expected) === JSON.stringify(actual)) continue;
    const mode = results.findIndex(result => result.lost.length);
    const replayed = results[mode < 0 ? 0 : mode], base = history.baseline[mode < 0 ? 0 : mode];
    assert.ok(replayed && base);
    const affected = new Set([...replayed.lost, ...replayed.undone, ...base.lost, ...base.undone]);
    const notes = replayed.requests.filter(ask => affected.has(ask.step)).map(ask =>
      `tag ${ask.step}: ${JSON.stringify(ask.letters)} / ${JSON.stringify(ask.actual)} ${ask.outcome}; ${replayed.lost.includes(ask.step) ? "lost" : replayed.undone.includes(ask.step) ? "undone" : "kept"}`);
    changed.push({ seed: history.seed, original: expected, product: actual, notes: [...notes, ...replayed.differences] });
  }
  t.diagnostic(JSON.stringify({ original, product: sum, lostSeeds, differingSeeds: changed }));
  assert.deepEqual(original, { requested: 845, kept: 800, undone: 40, lost: 5 });
  assert.deepEqual(sum, original);
  assert.deepEqual(changed, []);
  assert.deepEqual(lostSeeds, [53, 137, 211, 352, 447]);
});
