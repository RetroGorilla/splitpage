import { BROLL_PROPS_MAX, brollPropKey } from "../document/broll.ts";
import type { BrollProp } from "../document/broll.ts";
import { idMap } from "../document/id-map.ts";
import { TAG_STATUS_IDS, normalizeTagName, registryKey, tagStatusId, tagStatusRank } from "../document/tags.ts";

export interface Person {
  id: string;
  name: string;
}

export interface TagInput {
  id?: string | undefined;
  cat?: string | undefined;
  name?: string | undefined;
  owner?: string | undefined;
  notes?: string | undefined;
  status?: string | undefined;
}

export interface TagEntry {
  cat: string;
  name: string;
  owner: string;
  notes: string;
  status: string;
  id?: string;
}

export interface BrollShot {
  id?: string | undefined;
  owner?: unknown;
  notes?: unknown;
  audioRef?: unknown;
  location?: unknown;
  status?: unknown;
  reshoot?: unknown;
  props?: unknown;
  [key: string]: unknown;
}

interface PropInput {
  id?: unknown;
  name?: unknown;
}

type List<T> = readonly (T | null | undefined)[] | null | undefined;

export type PersonList = List<Person>;
export type TagList = List<TagInput>;
export type ShotList = List<BrollShot>;

export type ListMerger = (base: unknown, mine: unknown, theirs: unknown) => unknown[];

function jsonCopy<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function droppedListKeys<T extends object>(baseList: List<T>, mineList: List<T>, theirList: List<T>, keyOf: (e: T) => string, fingerprint: (e: T) => string): Record<string, boolean> {
  const dropped = idMap<boolean>();
  if (!baseList || !baseList.length) return dropped;
  const mineBy = idMap<T>(), theirBy = idMap<T>();
  (mineList || []).forEach(function (e) { const k = e && keyOf(e); if (k) mineBy[k] = e as T; });
  (theirList || []).forEach(function (e) { const k = e && keyOf(e); if (k) theirBy[k] = e as T; });
  baseList.forEach(function (e) {
    const k = e && keyOf(e);
    if (!k) return;
    const m = mineBy[k], t = theirBy[k];
    if (m && t) return;
    if (!m && !t) return;
    if (fingerprint((m || t) as T) === fingerprint(e as T)) dropped[k] = true;
  });
  return dropped;
}

export function mergePeople(basePeople: PersonList, minePeople: PersonList, theirPeople: PersonList): Person[] {
  const personKey = function (p: Person): string { return p.name ? normalizeTagName(p.name) : ""; };
  const dropped = droppedListKeys(basePeople, minePeople, theirPeople, personKey, personKey);
  const out: Person[] = [], seenId = idMap<boolean>(), seenName = idMap<boolean>();
  (theirPeople || []).concat(minePeople || []).forEach(function (p) {
    if (!p || !p.name) return;
    const norm = normalizeTagName(p.name);
    if (dropped[norm]) return;
    if (seenId[p.id] || seenName[norm]) return;
    seenId[p.id] = true;
    seenName[norm] = true;
    out.push({ id: p.id, name: p.name });
  });
  return out;
}

export function mergeProductionTags(baseTags: TagList, mineTags: TagList, theirTags: TagList): TagEntry[] {
  const idOf = function (t: TagInput): string { return t.id || (t.name ? "key:" + registryKey(t.cat as string, t.name) : ""); };
  const tagPrint = function (t: TagInput): string {
    return JSON.stringify([t.cat || "", t.name || "", t.owner || "", t.notes || "",
                           tagStatusId(t.status) || TAG_STATUS_IDS[0]]);
  };
  const dropped = droppedListKeys(baseTags, mineTags, theirTags, idOf, tagPrint);
  const baseById = idMap<TagInput>();
  (baseTags || []).forEach(function (t) { if (t && t.name) baseById[idOf(t)] = t; });
  const out: TagEntry[] = [], byId = idMap<TagEntry>();
  function entryOf(t: TagInput): TagEntry {
    const e: TagEntry = { cat: t.cat as string, name: t.name as string, owner: t.owner || "", notes: t.notes || "",
                          status: tagStatusId(t.status) || TAG_STATUS_IDS[0] };
    if (t.id) e.id = t.id;
    return e;
  }
  (theirTags || []).forEach(function (t) {
    if (!t || !t.name) return;
    const k = idOf(t);
    if (dropped[k] || byId[k]) return;
    byId[k] = entryOf(t);
    out.push(byId[k]);
  });
  (mineTags || []).forEach(function (t) {
    if (!t || !t.name) return;
    const k = idOf(t);
    if (dropped[k]) return;
    const existing = byId[k];
    if (!existing) {
      byId[k] = entryOf(t);
      out.push(byId[k]);
      return;
    }
    const b = baseById[k];
    if (b && existing.name === b.name && t.name !== b.name) existing.name = t.name;
    if (b && existing.cat === b.cat && t.cat !== b.cat) existing.cat = t.cat as string;
    if (!existing.owner && t.owner) existing.owner = t.owner;
    if (!existing.notes && t.notes) existing.notes = t.notes;
    if (tagStatusRank(t.status) > tagStatusRank(existing.status)) {
      existing.status = tagStatusId(t.status) || TAG_STATUS_IDS[0];
    }
  });
  const byKey = idMap<TagEntry>();
  return out.filter(function (e) {
    const key = registryKey(e.cat, e.name);
    const first = byKey[key];
    if (!first) { byKey[key] = e; return true; }
    if (!first.owner && e.owner) first.owner = e.owner;
    if (!first.notes && e.notes) first.notes = e.notes;
    if (tagStatusRank(e.status) > tagStatusRank(first.status)) first.status = e.status;
    return false;
  });
}

export function mergeBrollShots(baseShots: ShotList, mineShots: ShotList, theirShots: ShotList): BrollShot[] {
  const shotKey = function (b: BrollShot): string { return b.id || ""; };
  const shotPrint = function (b: BrollShot): string {
    return JSON.stringify(Object.keys(b).filter(function (k) { return k !== "id"; }).sort()
      .map(function (k) { return [k, b[k]]; }));
  };
  const dropped = droppedListKeys(baseShots, mineShots, theirShots, shotKey, shotPrint);
  const baseById = idMap<BrollShot>();
  (baseShots || []).forEach(function (b) { if (b && b.id && !baseById[b.id]) baseById[b.id] = b; });
  const out: BrollShot[] = [], byId = idMap<BrollShot>();
  (theirShots || []).forEach(function (b) {
    if (!b || !b.id || byId[b.id] || dropped[b.id]) return;
    byId[b.id] = jsonCopy(b);
    out.push(byId[b.id] as BrollShot);
  });
  (mineShots || []).forEach(function (b) {
    if (!b || !b.id || dropped[b.id]) return;
    const existing = byId[b.id];
    if (!existing) { byId[b.id] = jsonCopy(b); out.push(byId[b.id] as BrollShot); return; }
    if (!existing.owner && b.owner) existing.owner = b.owner;
    if (!existing.notes && b.notes) existing.notes = b.notes;
    if (!existing.audioRef && b.audioRef) existing.audioRef = b.audioRef;
    if (!existing.location && b.location) existing.location = b.location;
    if (b.status === "shot") existing.status = "shot";
    if (b.reshoot) existing.reshoot = true;
    const base = baseById[b.id];
    existing.props = mergeBrollProps(base ? base.props : null, b.props, existing.props);
  });
  return out;
}

export function mergeBrollProps(baseProps: unknown, mineProps: unknown, theirProps: unknown): BrollProp[] {
  function keyed(list: unknown): { by: Record<string, PropInput>; order: string[] } {
    const by = idMap<PropInput>(), order: string[] = [];
    (Array.isArray(list) ? list as unknown[] : []).forEach(function (p) {
      if (!p || typeof p !== "object" || !(p as PropInput).name) return;
      const prop = p as PropInput;
      const k = brollPropKey(prop.id as string, prop.name);
      if (by[k]) return;
      by[k] = prop;
      order.push(k);
    });
    return { by: by, order: order };
  }
  const base = keyed(baseProps), mine = keyed(mineProps), theirs = keyed(theirProps);
  const hasBase = Array.isArray(baseProps);
  const out: BrollProp[] = [];
  function keep(k: string): boolean {
    const inMine = !!mine.by[k], inTheirs = !!theirs.by[k], inBase = !!base.by[k];
    if (inMine && inTheirs) return true;
    return !hasBase || !inBase;
  }
  theirs.order.forEach(function (k) {
    const p = theirs.by[k] as PropInput;
    if (keep(k)) out.push({ id: (p.id || "") as string, name: p.name as string });
  });
  mine.order.forEach(function (k) {
    const p = mine.by[k] as PropInput;
    if (!theirs.by[k] && keep(k)) out.push({ id: (p.id || "") as string, name: p.name as string });
  });
  return out.slice(0, BROLL_PROPS_MAX);
}

export const LIST_MERGERS: Readonly<Record<string, ListMerger>> = Object.freeze({
  people: function (b: unknown, m: unknown, t: unknown) { return mergePeople(b as PersonList, m as PersonList, t as PersonList); },
  productionTags: function (b: unknown, m: unknown, t: unknown) { return mergeProductionTags(b as TagList, m as TagList, t as TagList); },
  brollShots: function (b: unknown, m: unknown, t: unknown) { return mergeBrollShots(b as ShotList, m as ShotList, t as ShotList); }
});
