import * as Y from "yjs";
import { BROLL_PROPS_MAX, brollPropKey } from "../../../core/document/broll.ts";
import type { BrollProp } from "../../../core/document/broll.ts";
import { isTagId, normalizeTagName } from "../../../core/document/tags.ts";
import { compareNativeRankedIds, isValidNativeRank, nativeRankBetween } from "./rank.ts";
import { decodeNativeValue, encodeNativeValue, nativeFieldKey } from "./values.ts";

export const NATIVE_SHOT_PROPS = "props";
export const LEGACY_SHOT_PROPS = nativeFieldKey("props");

export interface NativeShotPropEntry {
  readonly key: string;
  readonly prop: BrollProp;
  readonly rank: string | null;
  readonly removed: boolean;
}

export function nativeShotPropKey(prop: BrollProp): string {
  return prop.id || "n:" + encodeNativeValue(normalizeTagName(prop.name));
}

export function newNativeShotProp(prop: BrollProp, rank: string | null): Y.Map<unknown> {
  const record = new Y.Map<unknown>();
  record.set("name", encodeNativeValue(prop.name));
  if (rank !== null) record.set("rank", rank);
  return record;
}

export function newNativeShotProps(props: readonly BrollProp[]): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const { key, prop, rank } of orderedNativeShotProps(props)) map.set(key, newNativeShotProp(prop, rank));
  return map;
}

export function orderedNativeShotProps(props: readonly BrollProp[]) {
  let rank: string | null = null;
  return props.map(prop => {
    rank = nativeRankBetween(rank, null);
    return { key: nativeShotPropKey(prop), prop, rank, removed: false };
  });
}

export function nativeShotPropEntries(map: Y.Map<unknown>): NativeShotPropEntry[] | null {
  const entries: NativeShotPropEntry[] = [];
  for (const [key, record] of map) {
    if (!(record instanceof Y.Map)) return null;
    const rank: unknown = record.get("rank"), removed: unknown = record.get("removed");
    const name = decodeNativeValue(record.get("name"))?.value;
    const id = isTagId(key) ? key : "";
    if (typeof name !== "string" || nativeShotPropKey({ id, name }) !== key ||
        record.has("rank") && !isValidNativeRank(rank) || record.has("removed") && removed !== true) return null;
    entries.push({ key, prop: { id, name }, rank: isValidNativeRank(rank) ? rank : null, removed: removed === true });
  }
  return entries.sort((a, b) => compareNativeRankedIds(a.key, a.rank, b.key, b.rank));
}

export function resolveNativeShotPropEntries(entries: readonly NativeShotPropEntry[], resolve: (props: unknown) => (BrollProp | null)[]) {
  const active = entries.filter(entry => !entry.removed);
  const props = resolve(active.map(entry => entry.prop));
  return active.flatMap((entry, at) => {
    const prop = props[at];
    return prop ? [{ ...entry, prop }] : [];
  });
}

export function shownNativeShotPropEntries<T extends { readonly prop: BrollProp }>(entries: readonly T[]): T[] {
  const names = new Set<string>(), keys = new Set<string>(), shown: T[] = [];
  for (const entry of entries) {
    if (shown.length === BROLL_PROPS_MAX) break;
    const { id, name } = entry.prop, normalized = normalizeTagName(name), key = brollPropKey(id, name);
    if (names.has(normalized) || keys.has(key)) continue;
    names.add(normalized);
    keys.add(key);
    shown.push(entry);
  }
  return shown;
}
