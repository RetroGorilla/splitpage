import * as Y from "yjs";
import { brollPropKey, resolveBrollProps } from "../../../core/document/broll.ts";
import type { BrollProp } from "../../../core/document/broll.ts";
import { normalizeTagName } from "../../../core/document/tags.ts";
import type { DocumentShape } from "../../../core/document/validated.ts";
import { compareNativeRankedIds, nativeRankBetween } from "./rank.ts";
import {
  NATIVE_SHOT_PROPS, nativeShotPropEntries, nativeShotPropKey, newNativeShotProp, resolveNativeShotPropEntries, shownNativeShotPropEntries
} from "./shot-props.ts";
import type { NativeShotPropEntry } from "./shot-props.ts";
import { encodeNativeValue } from "./values.ts";

type PropWrite = (map: Y.Map<unknown>) => void;
type Write = () => void;
type Drop = Pick<NativeShotPropEntry, "key" | "rank">;

export function prepareNativeShotProps(shot: Y.Map<unknown>, tags: DocumentShape["productionTags"], tagGroup: (id: string) => readonly string[] | undefined) {
  const stored = shot.get(NATIVE_SHOT_PROPS);
  if (!(stored instanceof Y.Map)) return null;
  const map: Y.Map<unknown> = stored;
  const bad = new Set<string>();
  const entries = nativeShotPropEntries(map, key => { bad.add(key); });
  const canonical = (id: string) => tagGroup(id)?.[0] ?? id;
  const resolved = resolveNativeShotPropEntries(entries, props => resolveBrollProps(props.map(prop => ({ ...prop, id: canonical(prop.id) })), tags));
  const shown = shownNativeShotPropEntries(resolved);
  const active = entries.filter(entry => !entry.removed);
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const byRef = new Map(shown.map(entry => [brollPropKey(entry.prop.id, entry.prop.name), entry]));
  function members(entry: (typeof shown)[number]): readonly string[] {
    const group = tagGroup(entry.prop.id);
    return group ? resolved.filter(other => other.prop.id === entry.prop.id).map(other => other.key) : [entry.key];
  }

  function plan(writes: Write[], changes: readonly PropWrite[]): void {
    if (changes.length === 0) return;
    writes.push(() => {
      for (const change of changes) change(map);
    });
  }

  function add(writes: Write[], prop: BrollProp): void {
    const key = nativeShotPropKey(prop), rank = nativeRankBetween(active.at(-1)?.rank ?? null, null);
    plan(writes, [putProp(key, prop, rank, byKey.get(key))]);
  }

  function remove(writes: Write[], ref: string): void {
    const key = ref.startsWith("n:") && !bad.has(ref) ? "n:" + encodeNativeValue(ref.slice(2)) : ref;
    if (bad.has(key)) { plan(writes, [map => { map.delete(key); }]); return; }
    const entry = byRef.get(canonical(ref));
    if (entry) plan(writes, members(entry).map(key => map => { propRecord(map, key).set("removed", true); }));
  }

  function move(writes: Write[], ref: string, before: string | null): "missing" | "value" | null {
    const moving = byRef.get(canonical(ref)), right = before === null ? undefined : byRef.get(canonical(before));
    if (!moving || before !== null && !right) return "missing";
    const at = shown.findIndex(entry => entry.key === moving.key);
    if (moving === right || shown[at + 1] === right) return null;
    const memberKeys = new Set(members(moving));
    const order = active.filter(entry => !memberKeys.has(entry.key));
    const lastShown = shown.at(-1);
    const drop = right ? order.findIndex(entry => entry.key === right.key) : order.findIndex(entry => entry.key === lastShown?.key) + 1;
    const placement = dropRank(moving.key, order[drop - 1], order[drop]);
    if (!placement) return "value";
    plan(writes, [...memberKeys].map(key => map => { writeRank(propRecord(map, key), placement.rank); }));
    return null;
  }

  function replace(writes: Write[], props: readonly BrollProp[]): void {
    const desired = props.map(prop => {
      const key = byRef.get(brollPropKey(prop.id, prop.name))?.key ?? nativeShotPropKey(prop);
      return { prop, key, entry: byKey.get(key) };
    });
    const kept = new Set(desired.map(entry => entry.key));
    const omitted = active.filter(entry => !kept.has(entry.key));
    const changes: PropWrite[] = omitted.map(({ key }) => map => { propRecord(map, key).set("removed", true); });
    for (const key of bad) if (!kept.has(key)) changes.push(map => { map.delete(key); });
    const positions = new Map(active.map((entry, at) => [entry.key, at]));
    const anchor = rankAnchors(desired.map(({ key }) => positions.get(key) ?? -1));
    let left: Drop | undefined;
    for (const [at, { prop, key, entry }] of desired.entries()) {
      if (anchor.has(at) && entry) {
        left = entry;
        if (entry.prop.name !== prop.name) changes.push(map => { propRecord(map, key).set("name", encodeNativeValue(prop.name)); });
        continue;
      }
      let rightAt = desired.findIndex((_, next) => next > at && anchor.has(next));
      let right = desired[rightAt]?.entry;
      let placement = dropRank(key, left, right);
      while (!placement && right) {
        anchor.delete(rightAt);
        rightAt = desired.findIndex((_, next) => next > at && anchor.has(next));
        right = desired[rightAt]?.entry;
        placement = dropRank(key, left, right);
      }
      const rank = entry && after(entry, left) && (!right || after(right, entry)) ? entry.rank : placement?.rank ?? null;
      changes.push(putProp(key, prop, rank, entry));
      left = { key, rank };
    }
    plan(writes, changes);
  }

  return { activeCount: active.length, damaged: bad.size > 0,
    hasName: (name: string) => shown.some(({ prop }) => normalizeTagName(prop.name) === name),
    add, remove, move, replace };
}

function after(entry: Drop, lower: Drop | undefined): boolean {
  return !lower || compareNativeRankedIds(lower.key, lower.rank, entry.key, entry.rank) < 0;
}

function propRecord(map: Y.Map<unknown>, key: string): Y.Map<unknown> {
  return map.get(key) as Y.Map<unknown>;
}

function writeRank(record: Y.Map<unknown>, rank: string | null): void {
  if (rank === null) record.delete("rank");
  else record.set("rank", rank);
}

function putProp(key: string, prop: BrollProp, rank: string | null, entry: NativeShotPropEntry | undefined): PropWrite {
  return map => {
    if (!entry) { map.set(key, newNativeShotProp(prop, rank)); return; }
    const record = propRecord(map, key);
    if (entry.prop.name !== prop.name) record.set("name", encodeNativeValue(prop.name));
    if (entry.rank !== rank) writeRank(record, rank);
    if (entry.removed) record.delete("removed");
  };
}

function dropRank(key: string, left: Drop | undefined, right: Drop | undefined): { rank: string | null } | null {
  if (right && right.rank === (left?.rank ?? null)) {
    return (!left || left.key < key) && key < right.key ? { rank: right.rank } : null;
  }
  return { rank: nativeRankBetween(left?.rank ?? null, right?.rank ?? null) };
}

function rankAnchors(positions: readonly number[]): Set<number> {
  const lengths = positions.map(() => 0), previous = positions.map(() => -1);
  let best = -1;
  for (const [at, position] of positions.entries()) {
    if (position < 0) continue;
    lengths[at] = 1;
    for (let prior = 0; prior < at; prior++) {
      const length = (lengths[prior] ?? 0) + 1;
      if ((positions[prior] ?? -1) >= 0 && (positions[prior] as number) < position && length > lengths[at]) {
        lengths[at] = length;
        previous[at] = prior;
      }
    }
    if (best < 0 || lengths[at] > (lengths[best] ?? 0)) best = at;
  }
  const anchors = new Set<number>();
  for (let at = best; at >= 0; at = previous[at] ?? -1) anchors.add(at);
  return anchors;
}
