import * as Y from "yjs";
import { BROLL_PROPS_MAX, brollPropKey, normalizeBrollProps, resolveBrollProps } from "../../../core/document/broll.ts";
import type { BrollProp } from "../../../core/document/broll.ts";
import { normalizeTagName } from "../../../core/document/tags.ts";
import type { DocumentShape } from "../../../core/document/validated.ts";
import { compareNativeRankedIds, nativeRankBetween } from "./rank.ts";
import {
  LEGACY_SHOT_PROPS, NATIVE_SHOT_PROPS, nativeShotPropEntries, nativeShotPropKey, newNativeShotProp, newNativeShotProps,
  orderedNativeShotProps, resolveNativeShotPropEntries, shownNativeShotPropEntries
} from "./shot-props.ts";
import type { NativeShotPropEntry } from "./shot-props.ts";
import { decodeNativeValue, encodeNativeValue } from "./values.ts";

type PropWrite = (map: Y.Map<unknown>) => void;
type Write = () => void;
type Drop = Pick<NativeShotPropEntry, "key" | "rank">;

export function prepareNativeShotProps(shot: Y.Map<unknown>, tags: DocumentShape["productionTags"]) {
  const map = shot.get(NATIVE_SHOT_PROPS);
  if (shot.has(NATIVE_SHOT_PROPS) && !(map instanceof Y.Map)) return null;
  const raw = !(map instanceof Y.Map) && shot.has(LEGACY_SHOT_PROPS) ? decodeNativeValue(shot.get(LEGACY_SHOT_PROPS))?.value : [];
  if (!Array.isArray(raw)) return null;
  const legacy = normalizeBrollProps(raw, []);
  const entries = map instanceof Y.Map ? nativeShotPropEntries(map) : orderedNativeShotProps(legacy);
  if (!entries) return null;
  const resolved = resolveNativeShotPropEntries(entries, props => resolveBrollProps(props, tags));
  const shown = shownNativeShotPropEntries(resolved);
  const active = entries.filter(entry => !entry.removed);
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const resolvedByKey = new Map(resolved.map(entry => [entry.key, entry.prop]));
  const byRef = new Map(shown.map(entry => [brollPropKey(entry.prop.id, entry.prop.name), entry]));

  function plan(writes: Write[], changes: readonly PropWrite[]): void {
    if (changes.length === 0) return;
    writes.push(() => {
      const props = map instanceof Y.Map ? map : newNativeShotProps(legacy);
      if (!(map instanceof Y.Map)) shot.set(NATIVE_SHOT_PROPS, props);
      for (const change of changes) change(props);
    });
  }

  function add(writes: Write[], prop: BrollProp): void {
    const key = nativeShotPropKey(prop), rank = nativeRankBetween(active.at(-1)?.rank ?? null, null);
    plan(writes, [putProp(key, prop, rank, byKey.get(key))]);
  }

  function remove(writes: Write[], ref: string): void {
    const entry = byRef.get(ref);
    if (entry) plan(writes, [map => { propRecord(map, entry.key).set("removed", true); }]);
  }

  function move(writes: Write[], ref: string, before: string | null): "missing" | "value" | null {
    const moving = byRef.get(ref), right = before === null ? undefined : byRef.get(before);
    if (!moving || before !== null && !right) return "missing";
    const at = shown.findIndex(entry => entry.key === moving.key);
    if (moving === right || shown[at + 1] === right) return null;
    const order = active.filter(entry => entry.key !== moving.key);
    const lastShown = shown.at(-1);
    const drop = right ? order.findIndex(entry => entry.key === right.key) : order.findIndex(entry => entry.key === lastShown?.key) + 1;
    const placement = dropRank(moving.key, order[drop - 1], order[drop]);
    if (!placement) return "value";
    plan(writes, [map => { writeRank(propRecord(map, moving.key), placement.rank); }]);
    return null;
  }

  function replace(writes: Write[], props: readonly BrollProp[]): void {
    const desired = props.map(prop => {
      const key = nativeShotPropKey(prop);
      return { prop, key, entry: byKey.get(key), projected: resolvedByKey.get(key) };
    });
    const kept = new Set(desired.map(entry => entry.key));
    const omitted = active.filter(entry => !kept.has(entry.key));
    const changes: PropWrite[] = omitted.map(({ key }) => map => { propRecord(map, key).set("removed", true); });
    const positions = new Map(active.map((entry, at) => [entry.key, at]));
    const anchor = rankAnchors(desired.map(({ key }) => positions.get(key) ?? -1));
    let left: Drop | undefined;
    for (const [at, { prop, key, projected, entry }] of desired.entries()) {
      if (anchor.has(at) && entry) {
        left = entry;
        if ((projected?.name ?? entry.prop.name) !== prop.name) changes.push(map => { propRecord(map, key).set("name", encodeNativeValue(prop.name)); });
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
      changes.push(putProp(key, projected?.name === prop.name && entry ? entry.prop : prop, rank, entry));
      left = { key, rank };
    }
    plan(writes, changes);
  }

  return { activeCount: active.length, hasName: (name: string) => shown.some(({ prop }) => normalizeTagName(prop.name) === name),
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
