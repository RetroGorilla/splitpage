import { isDeepStrictEqual as equal } from "node:util";
import * as Y from "yjs";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { ALL_RULES } from "../../src/native/variant.ts";
import { EntryRankReplica, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { held, liveCount } from "./storage.ts";
import { GENERATED_SPEC, generateHistory } from "../native-chosen/generate.ts";
import { load, seed } from "../native-chosen/kit.ts";
import type { MakeReplica, Spec } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Step } from "../native-chosen/play.ts";
import { NAMES } from "./survey.ts";

interface Held { value: unknown; writer: number | null }
type Internal = { _map: Map<string, { id: { client: number }; deleted: boolean }> };

// why: who wrote a map entry is read from the library's item, which no public call gives; this count only measures
const writerOf = (map: Y.Map<unknown>, key: string): number | null => {
  const item = (map as unknown as Internal)._map.get(key);
  return item && !item.deleted ? item.id.client : null;
};
const SEED_CLIENT = 900;

function rankWriter(replica: ChosenReplica, record: Y.Map<unknown>): number | null {
  const list = record.get("ranks");
  if (list instanceof Y.Array) {
    let last: number | null = null;
    for (let item = (list as unknown as { _start: { id: { client: number }; deleted: boolean; right: unknown } | null })._start; item; item = item.right as typeof item) if (!item.deleted) last = item.id.client;
    return last;
  }
  if (replica instanceof EntryRankReplica) { const entry = replica.shownEntry(record); return entry ? writerOf(record, entry.key) : null; }
  return writerOf(record, "e10Rank");
}

// why: every field of every beat and heading record, the shown rank, and every root entry, each with its writer
function holdings(replica: ChosenReplica): Map<string, Held> {
  const held = new Map<string, Held>();
  for (const [root, map] of [["beats", replica.beats], ["headings", replica.headings], ["segments", replica.segments], ["visuals", replica.visuals], ["names", replica.names]] as const) {
    for (const key of (map as Y.Map<unknown>).keys()) held.set(`${root}/${key}`, { value: (map as Y.Map<unknown>).get(key) !== undefined, writer: writerOf(map as Y.Map<unknown>, key) });
    if (root !== "beats" && root !== "headings" && root !== "segments") continue;
    for (const [id, record] of (map as Y.Map<Y.Map<unknown>>).entries()) {
      for (const key of record.keys()) {
        if (key === "e10Rank" || key.startsWith("rank:") || key === "ranks" || key === "text") continue;
        held.set(`${root}.${key}/${id}`, { value: record.get(key), writer: writerOf(record, key) });
      }
      if (root !== "segments") held.set(`${root}.rank/${id}`, { value: replica.storedRank(root === "headings" ? "h" : "b", id), writer: rankWriter(replica, record) });
    }
  }
  return held;
}

export interface Overwrites { presses: number; changed: number; others: Record<string, number>; histories: number; extraEntries: number; extraRecords: number }

// why: whole-state sync between copies, which is enough to count what an undo press changes on the copy that pressed
export const generatedLists = (size: number): { spec: Spec; steps: Step[] }[] =>
  Array.from({ length: size }, (_, at) => ({ spec: GENERATED_SPEC(), steps: generateHistory(at + 1, 40, false, NAMES).steps }));

// why: an entry beyond the first that is still live once every copy has everything; nobody deletes it until the next
// move of that row or heading
function extras(option: RankOption, copies: readonly (ChosenReplica | null)[], make: MakeReplica): { entries: number; records: number } {
  const merged = make(99, ALL_RULES, NAMES), found = { entries: 0, records: 0 };
  try {
    for (const copy of copies) if (copy) Y.applyUpdate(merged.doc, copy.encode(), "remote");
    for (const now of held(option, merged).values()) { const live = liveCount(option, now); if (live > 1) { found.entries += live - 1; found.records++; } }
    return found;
  } finally { merged.destroy(); }
}

export function countOverwrites(option: RankOption, lists: readonly { spec: Spec; steps: readonly Step[] }[]): Overwrites {
  const make = makeOption(option), result: Overwrites = { presses: 0, changed: 0, others: {}, histories: 0, extraEntries: 0, extraRecords: 0 };
  for (const { spec, steps } of lists) {
    const bytes = seed(spec, ALL_RULES, NAMES, make);
    const copies: (ChosenReplica | null)[] = [0, 1, 2].map(index => steps.some(step => "open" in step && step.open === index) ? null : load(bytes, index + 1, ALL_RULES, NAMES, make));
    let hit = false;
    try {
      for (const step of steps) {
        if ("open" in step) { const source = copies[step.from]; if (source) copies[step.open] = load(source.encode(), step.open + 1, ALL_RULES, NAMES, make); continue; }
        if ("from" in step) {
          const from = copies[step.from], to = copies[step.to];
          if (from && to) { Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote"); to.changes(); }
          continue;
        }
        const copy = copies[step.by];
        if (!copy) continue;
        const pressing = step.cmd.op === "undo" || step.cmd.op === "redo", before = pressing ? holdings(copy) : null;
        try { perform(copy, step.cmd); } catch { continue; }
        if (!before) continue;
        result.presses++;
        const after = holdings(copy);
        let changed = false;
        for (const key of new Set([...before.keys(), ...after.keys()])) {
          const was = before.get(key), now = after.get(key);
          if (equal(was?.value, now?.value)) continue;
          changed = true;
          const present = was !== undefined && was.value !== undefined && was.value !== false;
          if (present && was.writer !== null && was.writer !== copy.doc.clientID && was.writer !== SEED_CLIENT) {
            const kind = key.slice(0, key.indexOf("/"));
            result.others[kind] = (result.others[kind] ?? 0) + 1;
            hit = true;
          }
        }
        if (changed) result.changed++;
      }
      const left = extras(option, copies, make);
      result.extraEntries += left.entries; result.extraRecords += left.records;
    } finally { for (const copy of copies) copy?.destroy(); }
    if (hit) result.histories++;
  }
  return result;
}
