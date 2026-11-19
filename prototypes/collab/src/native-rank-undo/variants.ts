import * as Y from "yjs";
import { ChosenReplica } from "../native-chosen/replica.ts";
import type { ChosenNames } from "../native-chosen/replica.ts";
import { ALL_RULES, STRAY_ROW } from "../native/variant.ts";
import type { NativeRules } from "../native/variant.ts";

export const OPTIONS = ["A", "B", "C", "D"] as const;
export type RankOption = typeof OPTIONS[number];
export type EntryOrder = "stamp" | "lowest" | "clock";

export class RemoteMapUndoReplica extends ChosenReplica {
  constructor(client: number, rules: NativeRules = ALL_RULES, names: ChosenNames = "inline") {
    super(client, rules, names);
    this.undo.ignoreRemoteMapChanges = true;
  }
}

const ENTRY = "rank:";

export interface RankEntry { key: string; stamp: number; client: number; clock: number; rank: string }
type Entry = RankEntry;

function entryOf(key: string, value: unknown): Entry | null {
  if (!key.startsWith(ENTRY) || typeof value !== "string") return null;
  const [stamp, client, clock] = key.slice(ENTRY.length).split(".").map(part => parseInt(part, 36));
  if (stamp === undefined || client === undefined || clock === undefined) return null;
  return { key, stamp, client, clock, rank: value };
}

const later = (a: Entry, b: Entry): number => a.stamp - b.stamp || a.client - b.client || a.clock - b.clock;
const ORDERS: Record<EntryOrder, (a: Entry, b: Entry) => number> = {
  stamp: later,
  lowest: (a, b) => (a.rank < b.rank ? 1 : a.rank > b.rank ? -1 : 0) || later(a, b),
  clock: (a, b) => a.clock - b.clock || a.client - b.client
};

// why: option C: each rank write is a key of its own, so two moves at once leave two entries and an undo removes only
// its own; the reader takes the greatest live entry by one fixed order
export class EntryRankReplica extends ChosenReplica {
  readonly entryOrder: EntryOrder;

  constructor(client: number, rules: NativeRules = ALL_RULES, names: ChosenNames = "inline", order: EntryOrder = "stamp") {
    super(client, rules, names);
    this.entryOrder = order;
    this.beats.observeDeep(events => {
      if (events.some(event => event instanceof Y.YMapEvent && event.path.length === 1 && [...event.keysChanged].some(key => key.startsWith(ENTRY)))) this.invalidateStructure();
    });
  }

  entries(record: Y.Map<unknown>): Entry[] {
    const found: Entry[] = [];
    for (const [key, value] of record) { const entry = entryOf(key, value); if (entry) found.push(entry); }
    return found;
  }

  shownEntry(record: Y.Map<unknown>): Entry | null {
    let best: Entry | null = null;
    for (const entry of this.entries(record)) if (!best || ORDERS[this.entryOrder](entry, best) > 0) best = entry;
    return best;
  }

  protected override readFlat(record: Y.Map<unknown>): unknown { return this.shownEntry(record)?.rank; }

  private key(stamp: number): string {
    const clock = Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(this.doc.clientID) ?? 0;
    return `${ENTRY}${stamp.toString(36)}.${this.doc.clientID.toString(36)}.${clock.toString(36)}`;
  }

  protected override writeFlat(record: Y.Map<unknown>, rank: unknown): void {
    const seen = [...record.keys()].filter(key => key.startsWith(ENTRY));
    const stamp = 1 + Math.max(0, ...seen.map(key => entryOf(key, "")?.stamp ?? 0));
    for (const key of seen) record.delete(key);
    record.set(this.key(stamp), rank);
  }

  protected override flatFields(rank: unknown): Record<string, unknown> { return { [this.key(1)]: rank }; }
}

const LIST = "ranks";

// why: option D: the rank is the last live element of a list made with the record; an undo brings a deleted element
// back at its old place, which the library does whoever wrote after it
export class ListRankReplica extends ChosenReplica {
  constructor(client: number, rules: NativeRules = ALL_RULES, names: ChosenNames = "inline") {
    super(client, rules, names);
    this.beats.observeDeep(events => { if (events.some(event => event.path.length === 2 && event.path[1] === LIST)) this.invalidateStructure(); });
  }

  protected override readFlat(record: Y.Map<unknown>): unknown {
    const list = record.get(LIST);
    return list instanceof Y.Array && list.length ? list.get(list.length - 1) : undefined;
  }

  protected override writeFlat(record: Y.Map<unknown>, rank: unknown): void {
    let list = record.get(LIST);
    if (!(list instanceof Y.Array)) { list = new Y.Array<unknown>(); record.set(LIST, list); }
    const items = list as Y.Array<unknown>;
    if (items.length) items.delete(0, items.length);
    // why: push goes after the last item, deleted or not; insert(0) would go before them, so an undo that brings an old
    // entry back at its old place would put it after the newer one
    items.push([rank]);
  }

  protected override flatFields(): Record<string, unknown> { return {}; }

  // why: the split-off's list is made after its record, so its rank is written through the integrated list
  override split(beat: string, offset: number, created: string, fields: Record<string, unknown> = {}): void {
    this.transact(() => {
      super.split(beat, offset, created, fields);
      const source = beat === STRAY_ROW ? `${created}^` : beat;
      this.writeFlat(this.beats.get(created) ?? new Y.Map<unknown>(), this.storedRank("b", source));
    });
  }
}

export function makeOption(option: RankOption, order: EntryOrder = "stamp"): (client: number, rules: NativeRules, names: ChosenNames) => ChosenReplica {
  switch (option) {
    case "A": return (client, rules, names) => new ChosenReplica(client, rules, names);
    case "B": return (client, rules, names) => new RemoteMapUndoReplica(client, rules, names);
    case "C": return (client, rules, names) => new EntryRankReplica(client, rules, names, order);
    case "D": return (client, rules, names) => new ListRankReplica(client, rules, names);
  }
}
