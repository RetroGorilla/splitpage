import * as Y from "yjs";
import { BROLL_PROPS_MAX, brollPropKey } from "../../../core/document/broll.ts";
import type { BrollProp } from "../../../core/document/broll.ts";
import { isTagId, normalizeTagName } from "../../../core/document/tags.ts";
import { compareNativeRankedIds, isValidNativeRank, nativeRankBetween } from "./rank.ts";
import { decodeNativeValue, encodeNativeValue, nativeFieldKey } from "./values.ts";

export const NATIVE_SHOT_PROPS = "props";
export const OBSOLETE_SHOT_PROPS = nativeFieldKey(NATIVE_SHOT_PROPS);

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
  let rank: string | null = null;
  for (const prop of props) {
    rank = nativeRankBetween(rank, null);
    map.set(nativeShotPropKey(prop), newNativeShotProp(prop, rank));
  }
  return map;
}

export function nativeShotPropEntries(map: Y.Map<unknown>, bad?: (key: string) => void): NativeShotPropEntry[] {
  const entries: NativeShotPropEntry[] = [];
  for (const [key, record] of map) {
    if (!(record instanceof Y.Map)) { bad?.(key); continue; }
    const rank: unknown = record.get("rank"), removed: unknown = record.get("removed");
    const id = isTagId(key) ? key : "";
    const stored: unknown = record.get("name");
    const name = stored === undefined && !record.has("name") ? id ? "" : decodeNativeValue(key.slice(2))?.value : decodeNativeValue(stored)?.value;
    if (typeof name !== "string" || nativeShotPropKey({ id, name }) !== key ||
        record.has("rank") && !isValidNativeRank(rank) || record.has("removed") && removed !== true) {
      bad?.(key);
      continue;
    }
    entries.push({ key, prop: { id, name }, rank: isValidNativeRank(rank) ? rank : null, removed: removed === true });
  }
  return entries.sort((a, b) => compareNativeRankedIds(a.key, a.rank, b.key, b.rank));
}

export function resolveNativeShotPropEntries(entries: readonly NativeShotPropEntry[], resolve: (props: BrollProp[]) => (BrollProp | null)[]) {
  const active = entries.filter(entry => !entry.removed);
  const props = resolve(active.map(entry => entry.prop));
  return active.flatMap((entry, at) => {
    const prop = props[at];
    return prop ? [{ ...entry, prop }] : [];
  });
}

export function shownNativeShotPropEntries<T extends { readonly prop: BrollProp }>(entries: readonly T[]): T[] {
  const keys = new Set<string>(), shown: T[] = [];
  for (const entry of entries) {
    if (shown.length === BROLL_PROPS_MAX) break;
    const { id, name } = entry.prop, key = brollPropKey(id, name);
    if (keys.has(key)) continue;
    keys.add(key);
    shown.push(entry);
  }
  return shown;
}
