import * as Y from "yjs";
import type { ChosenNames, ChosenReplica } from "../../src/native-chosen/replica.ts";
import { ALL_RULES, STRAY_ROW } from "../../src/native/variant.ts";
import type { NativeRules } from "../../src/native/variant.ts";
import { randomFor } from "../native/e5-histories.ts";
import { need } from "../native-delete/model.ts";
import { base, load as loadCopy, seed } from "./kit.ts";
import type { MakeReplica, Spec } from "./kit.ts";
import { perform, shown } from "./play.ts";
import type { Cmd, Step } from "./play.ts";

export const GENERATED_SPEC = (): Spec => {
  const spec = base();
  spec.beats.B = { note: "two" };
  return spec;
};

export interface Generated { seed: number; steps: Step[]; lateAt: number; offline: [number, number, number][]; thrown: string[]; crashed: string | null }

// why: commands are picked from the rows the acting copy shows, the way a person picks them; the picks are recorded
// as plain commands and replayed unchanged under every delivery mode
export function generateHistory(number: number, length = 40, twins = false, names: ChosenNames = "inline", make?: MakeReplica): Generated {
  const random = randomFor(number * 104729 + 7), pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const second = randomFor(number * 7919 + 3), twinPick = <T>(items: readonly T[]): T => items[Math.floor(second() * items.length)] as T;
  const chance = (p: number): boolean => random() < p;
  const load = (bytes: Uint8Array, client: number, rules: NativeRules, names: ChosenNames): ChosenReplica => loadCopy(bytes, client, rules, names, make);
  const bytes = seed(GENERATED_SPEC(), ALL_RULES, names, make), log: Uint8Array[] = [], known = [new Set<number>(), new Set<number>(), new Set<number>()];
  const watched = (replica: ChosenReplica, index: number): ChosenReplica => {
    replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") need(known[index], "known set").add(log.push(update) - 1); });
    return replica;
  };
  const copies: (ChosenReplica | null)[] = [watched(load(bytes, 1, ALL_RULES, names), 0), watched(load(bytes, 2, ALL_RULES, names), 1), null], steps: Step[] = [];
  const lateAt = 4 + Math.floor(random() * 10), offline: [number, number, number][] = [], thrown: string[] = [];
  let letter = 0x410, serial = 0, away: { copy: number; until: number } | null = null, crashed: string | null = null;
  const char = (): string => { const value = String.fromCodePoint(letter); letter += letter === 0x44f ? 0x60 : 1; return value; };
  const send = (from: number, to: number): void => {
    const source = copies[from], target = copies[to];
    if (!source || !target || from === to) return;
    const have = need(known[from], "known set"), into = need(known[to], "known set");
    const missing = [...have].filter(id => !into.has(id)).sort((a, b) => a - b);
    steps.push({ from, to });
    for (const id of missing) into.add(id);
    for (const id of missing) Y.applyUpdate(target.doc, need(log[id], "update"), "remote");
    target.changes();
  };
  for (let count = 0; count < length; count++) {
    if (count === lateAt) {
      const from = chance(0.5) ? 0 : 1, source = need(copies[from] ?? undefined, "copy");
      known[2] = new Set(known[from]);
      copies[2] = watched(load(source.encode(), 3, ALL_RULES, names), 2);
      steps.push({ open: 2, from });
    }
    if (!away && count > 2 && chance(0.12)) {
      const copy = Math.floor(random() * copies.length);
      if (copies[copy]) { away = { copy, until: count + 6 + Math.floor(random() * 10) }; offline.push([copy, count, away.until]); }
    }
    if (away && count >= away.until) away = null;
    const open = copies.map((copy, index) => copy ? index : -1).filter(index => index >= 0);
    if (chance(0.3)) {
      const online = open.filter(index => index !== away?.copy);
      if (online.length > 1) {
        const from = pick(online), to = pick(online.filter(index => index !== from));
        try { send(from, to); } catch (error) { crashed = `receive: ${error instanceof Error ? error.message : String(error)}`; break; }
      }
    }
    const by = pick(open), replica = need(copies[by] ?? undefined, "copy");
    let cmd: Cmd | null;
    try { cmd = choose(replica, pick, chance, char, () => ++serial, by); } catch (error) { crashed = `read: ${error instanceof Error ? error.message : String(error)}`; break; }
    if (!cmd) continue;
    try { perform(replica, cmd); } catch (error) {
      steps.push({ by, cmd });
      thrown.push(`${cmd.op}: ${error instanceof Error ? error.message : String(error)}`);
      crashed = thrown.at(-1) ?? null;
      break;
    }
    steps.push({ by, cmd });
    if (!twins || second() >= 0.35) continue;
    for (const [who, split] of twinSplits(copies, twinPick, () => ++serial)) {
      const replica = need(copies[who] ?? undefined, "copy");
      try { perform(replica, split); } catch (error) {
        thrown.push(`${split.op}: ${error instanceof Error ? error.message : String(error)}`);
        crashed = thrown.at(-1) ?? null;
      }
      steps.push({ by: who, cmd: split });
      if (crashed) break;
    }
    if (crashed) break;
  }
  for (const copy of copies) copy?.destroy();
  return { seed: number, steps, lateAt, offline, thrown, crashed };
}

function choose(replica: ChosenReplica, pick: <T>(items: readonly T[]) => T, chance: (p: number) => boolean, char: () => string, next: () => number, by: number): Cmd | null {
  const view = shown(replica), rows = [...view.rows.keys()], beats = [...view.rows.values()].flat(), headings = [...view.names.keys()], hidden = [...view.hidden.keys()];
  const text = (count = 1): string => Array.from({ length: count }, char).join("");
  if (!beats.length && !headings.length && !hidden.length) return null;
  if (!beats.length) return headings.length && chance(0.5) ? { op: "type", id: pick(headings), field: "name", at: 0, text: text() } : hidden.length ? { op: "restoreHeading", id: pick(hidden) } : null;
  const kind = pick(["type", "type", "type", "visual", "name", "erase", "format", "tag", "field", "split", "join", "unjoin", "delete", "heading", "remove", "restore", "move", "run", "scene", "undo", "redo"]);
  const where = (value: string): number => pickNumber(pick, value.length + 1);
  switch (kind) {
    case "type": { const beat = pick(beats), value = view.audio.get(beat) ?? ""; return { op: "type", id: beat, field: "audio", at: where(value), text: text(chance(0.3) ? 2 : 1) }; }
    case "visual": { const beat = pick(beats), value = view.visual.get(beat) ?? ""; return { op: "type", id: beat, field: "visual", at: where(value), text: text() }; }
    case "name": { if (!headings.length) return null; const id = pick(headings), value = view.names.get(id) ?? ""; return { op: "type", id, field: "name", at: where(value), text: text() }; }
    case "erase": {
      const beat = pick(beats), field = chance(0.7) ? "audio" : "visual", value = (field === "audio" ? view.audio.get(beat) : view.visual.get(beat)) ?? "";
      if (!value.length || beat === STRAY_ROW && field === "visual") return null;
      const from = where(value.slice(1)), to = Math.min(value.length, from + 1 + (chance(0.3) ? 1 : 0));
      return { op: "erase", id: beat, field, from, to };
    }
    case "format": case "tag": {
      const beat = pick(beats.filter(id => id !== STRAY_ROW)), value = view.audio.get(beat) ?? "";
      if (!beat || value.length < 1) return null;
      const from = where(value.slice(1)), to = Math.min(value.length, from + 1 + Math.floor(pickNumber(pick, 3)));
      return { op: "format", id: beat, field: "audio", from, to, key: kind === "tag" ? "t:prop" : pick(["b", "i"]), on: !chance(0.25) };
    }
    case "field": { const beat = pick(beats.filter(id => id !== STRAY_ROW)); return beat ? { op: "field", id: beat, key: pick(["status", "lens"]), value: `v${by}${next()}` } : null; }
    case "split": { const beat = pick(beats), value = view.audio.get(beat) ?? ""; return { op: "split", id: beat, at: where(value), created: `N${by}${next()}` }; }
    case "join": {
      const candidates = view.order.filter((id, index) => index > 0 && !id.startsWith("#") && !(view.order[index - 1] ?? "#").startsWith("#") && id !== STRAY_ROW && view.order[index - 1] !== STRAY_ROW);
      return candidates.length ? { op: "join", id: pick(candidates) } : null;
    }
    case "unjoin": { const joined = beats.filter(id => !rows.includes(id)); return joined.length ? { op: "unjoin", id: pick(joined) } : null; }
    case "delete": {
      const at = Math.floor(pickNumber(pick, rows.length)), first = rows[at];
      if (!first) return null;
      const next = rows[at + 1];
      return { op: "delete", rows: chance(0.3) && next ? [first, next] : [first] };
    }
    case "heading": { const above = pick(rows.filter(id => id !== STRAY_ROW)); return above ? { op: "heading", above, id: `J${by}${next()}`, text: text() } : null; }
    case "remove": return headings.length ? { op: "removeHeading", id: pick(headings) } : null;
    case "restore": return hidden.length ? { op: "restoreHeading", id: pick(hidden) } : null;
    case "move": case "run": {
      const candidates = rows.filter(id => id !== STRAY_ROW);
      if (candidates.length < 3) return null;
      const at = Math.floor(pickNumber(pick, candidates.length - 1)), first = need(candidates[at], "row"), last = kind === "run" ? candidates[at + 1] : undefined;
      const targets = candidates.filter(id => id !== first && id !== last);
      const target = pick(targets), after = chance(0.6);
      return { op: "move", drop: { unit: kind === "run" ? "rows" : "row", first, ...last ? { last } : {}, target, after } };
    }
    case "scene": {
      if (headings.length < 2) return null;
      const first = pick(headings), target = pick(headings.filter(id => id !== first));
      return { op: "move", drop: { unit: "scene", first, target, after: false } };
    }
    case "undo": return replica.undo.undoStack.length ? { op: "undo" } : null;
    case "redo": return replica.undo.redoStack.length ? { op: "redo" } : null;
  }
  return null;
}

// why: two copies that show the same rule-read row each split it before seeing the other's split
function twinSplits(copies: readonly (ChosenReplica | null)[], pick: <T>(items: readonly T[]) => T, next: () => number): [number, Cmd][] {
  const pairs: [number, number, string][] = [];
  for (const [one, first] of copies.entries()) for (const [other, second] of copies.entries()) {
    if (!first || !second || other <= one) continue;
    const mine = shown(first), theirs = shown(second);
    for (const [beat, text] of mine.audio) {
      if (beat === STRAY_ROW || theirs.audio.get(beat) !== text) continue;
      if (first.spansOf(beat, "audioText").some(span => span.opened === "unowned" && span.end > span.start)) pairs.push([one, other, beat]);
    }
  }
  if (!pairs.length) return [];
  const [one, other, beat] = pick(pairs), length = shown(need(copies[one] ?? undefined, "copy")).audio.get(beat)?.length ?? 0;
  return [one, other].map((who): [number, Cmd] => [who, { op: "split", id: beat, at: pickNumber(pick, length + 1), created: `T${who}${next()}` }]);
}

function pickNumber(pick: <T>(items: readonly T[]) => T, below: number): number {
  return below <= 0 ? 0 : pick(Array.from({ length: below }, (_, index) => index));
}
