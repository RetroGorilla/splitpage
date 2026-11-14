import type { SharedContentRef, SharedJsonFields, SharedJsonValue, SharedOperation, SharedStatusEvent } from "./operations.ts";

export type SharedRegistryCollection = "people" | "tags" | "shots";
type Entry = Readonly<Record<string, unknown>>;
type Listed = readonly (Entry | null | undefined)[];
export interface SharedRegistryLists {
  readonly people: Listed;
  readonly tags: Listed;
  readonly shots: Listed;
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

function keyed(list: Listed): Map<string, Entry> | null {
  const out = new Map<string, Entry>();
  for (const entry of list) {
    if (!entry || typeof entry.id !== "string" || !entry.id || out.has(entry.id)) return null;
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

function movedToEnd(order: readonly string[], keys: readonly string[], kept: readonly string[]): ReadonlySet<string> {
  for (let stay = kept.length; stay > 0; stay--) {
    const unmoved = kept.slice(0, stay);
    if (json(keys.slice(0, stay)) === json(unmoved) && json(order.filter(id => unmoved.includes(id))) === json(unmoved)) return new Set(kept.slice(stay));
  }
  return new Set(kept);
}

export function sharedRegistryOperations(edit: SharedRegistryEdit): SharedRegistryOperations {
  const operations: SharedOperation[] = [], author = edit.author;
  const next = () => (author.id + ":" + operations.length) as SharedContentRef;
  for (const collection of collections()) {
    const before = keyed(edit.before[collection]), after = keyed(edit.after[collection]);
    if (!before || !after) return { refused: "records-without-id" };
    const kept = [...after.keys()].filter(id => before.has(id)), order = [...before.keys()].filter(id => after.has(id));
    const moved = movedToEnd(order, [...after.keys()], kept);
    let rank = highest(edit.ranks(collection));
    for (const entry of after.values()) {
      const key = String(entry.id) as SharedContentRef, target = { collection, record: key }, was = before.get(key);
      if (!was) {
        rank = rankAfter(rank);
        const fields: Record<string, unknown> = {};
        for (const field of ["status", ...storedFields(collection)]) if (collection !== "people" && entry[field] !== undefined) fields[field] = entry[field];
        if (collection === "people" && entry.name !== undefined) fields.name = entry.name;
        operations.push({ kind: "record-create", id: next(), by: author.by, target, fields: { ...fields, rank, extra: extra(collection, entry) } as SharedJsonFields });
        continue;
      }
      if (moved.has(key)) {
        rank = rankAfter(rank);
        operations.push({ kind: "record-set", id: next(), by: author.by, target, field: "rank", value: rank });
      }
      for (const field of storedFields(collection)) {
        if (json(was[field]) === json(entry[field])) continue;
        // why: clearing removes only the owner this copy saw; an assignment made elsewhere at once survives (rule 54).
        operations.push(entry[field] === undefined || field === "owner" && entry[field] === "" ? { kind: "record-set", id: next(), by: author.by, target, field, clear: true }
          : { kind: "record-set", id: next(), by: author.by, target, field, value: entry[field] as SharedJsonValue });
      }
      if (extra(collection, was) !== extra(collection, entry)) operations.push({ kind: "record-set", id: next(), by: author.by, target, field: "extra", value: extra(collection, entry) });
      if (collection !== "people" && json(was.status) !== json(entry.status)) {
        const scope = collection === "tags" ? "tag" as const : "shot" as const;
        operations.push({ kind: "status", id: next(), by: author.by, target: { scope, record: key }, value: entry.status,
          parents: edit.heads(scope, key) as SharedContentRef[] } as SharedStatusEvent);
      }
    }
    for (const key of before.keys() as Iterable<SharedContentRef>) {
      if (!after.has(key)) operations.push({ kind: "record-delete", id: next(), by: author.by, target: { collection, record: key } });
    }
  }
  return { operations };
}
