import type { SharedContentRef, SharedJsonFields, SharedJsonValue, SharedOperation, SharedStatusEvent } from "./operations.ts";

export type SharedRegistryCollection = "people" | "tags" | "shots";
type Entry = Readonly<Record<string, unknown>>;
export interface SharedRegistryLists {
  readonly people: readonly Entry[];
  readonly tags: readonly Entry[];
  readonly shots: readonly Entry[];
}
export interface SharedRegistryEdit {
  readonly before: SharedRegistryLists;
  readonly after: SharedRegistryLists;
  readonly ranks: (collection: SharedRegistryCollection) => readonly string[];
  readonly heads: (scope: "tag" | "shot", record: string) => readonly string[];
  readonly author: { readonly id: string; readonly by: string };
}
export type SharedRegistryOperations = { readonly operations: readonly SharedOperation[] } | { readonly refused: string };

function collections(): readonly SharedRegistryCollection[] { return ["people", "tags", "shots"]; }

function storedFields(collection: SharedRegistryCollection): readonly string[] {
  return collection === "people" ? ["name"] : collection === "tags" ? ["cat", "name", "owner", "notes"]
    : ["name", "desc", "reshoot", "notes", "audioRef", "location", "owner", "origin", "props"];
}

function json(value: unknown): string { return JSON.stringify(value) ?? "undefined"; }

function extra(collection: SharedRegistryCollection, entry: Entry): string {
  const known = ["id", "status", ...storedFields(collection)];
  return JSON.stringify(Object.fromEntries(Object.keys(entry).filter(key => !known.includes(key) && entry[key] !== undefined).sort().map(key => [key, entry[key]])));
}

function keyed(list: readonly Entry[]): Map<string, Entry> | null {
  const out = new Map<string, Entry>();
  for (const entry of list) {
    if (typeof entry.id !== "string" || !entry.id || out.has(entry.id)) return null;
    out.set(entry.id, entry);
  }
  return out;
}

function rankAfter(rank: string | null): string {
  if (rank === null) return "0000000000";
  return /^\d{10}$/.test(rank) && rank !== "9999999999" ? String(Number(rank) + 1).padStart(10, "0") : rank + "V";
}

function highest(ranks: readonly string[]): string | null {
  let top: string | null = null;
  for (const rank of ranks) if (top === null || rank > top) top = rank;
  return top;
}

export function sharedRegistryOperations(edit: SharedRegistryEdit): SharedRegistryOperations {
  const operations: SharedOperation[] = [], author = edit.author;
  const next = () => (author.id + ":" + operations.length) as SharedContentRef;
  for (const collection of collections()) {
    const before = keyed(edit.before[collection]), after = keyed(edit.after[collection]);
    if (!before || !after) return { refused: "records-without-id" };
    const kept = edit.after[collection].map(entry => String(entry.id)).filter(id => before.has(id));
    const order = edit.before[collection].map(entry => String(entry.id)).filter(id => after.has(id));
    if (json(kept) !== json(order)) return { refused: "records-reordered" };
    let rank = highest(edit.ranks(collection));
    for (const entry of edit.after[collection]) {
      const key = String(entry.id) as SharedContentRef, target = { collection, record: key }, was = before.get(key);
      if (!was) {
        rank = rankAfter(rank);
        const fields: Record<string, unknown> = {};
        for (const field of ["status", ...storedFields(collection)]) if (collection !== "people" && entry[field] !== undefined) fields[field] = entry[field];
        if (collection === "people" && entry.name !== undefined) fields.name = entry.name;
        operations.push({ kind: "record-create", id: next(), by: author.by, target, fields: { ...fields, rank, extra: extra(collection, entry) } as SharedJsonFields });
        continue;
      }
      for (const field of storedFields(collection)) {
        if (json(was[field]) === json(entry[field])) continue;
        operations.push(entry[field] === undefined ? { kind: "record-set", id: next(), by: author.by, target, field, clear: true }
          : { kind: "record-set", id: next(), by: author.by, target, field, value: entry[field] as SharedJsonValue });
      }
      if (extra(collection, was) !== extra(collection, entry)) operations.push({ kind: "record-set", id: next(), by: author.by, target, field: "extra", value: extra(collection, entry) });
      if (collection !== "people" && json(was.status) !== json(entry.status)) {
        const scope = collection === "tags" ? "tag" as const : "shot" as const;
        operations.push({ kind: "status", id: next(), by: author.by, target: { scope, record: key }, value: entry.status,
          parents: edit.heads(scope, key) as SharedContentRef[] } as SharedStatusEvent);
      }
    }
    for (const entry of edit.before[collection]) {
      const key = String(entry.id) as SharedContentRef;
      if (!after.has(key)) operations.push({ kind: "record-delete", id: next(), by: author.by, target: { collection, record: key } });
    }
  }
  return { operations };
}
