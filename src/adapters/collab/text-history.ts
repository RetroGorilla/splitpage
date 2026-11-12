import type { SharedContentRef, SharedInlineValue, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedMarkGroup, SharedTextIdentity } from "./mark-record.ts";
import type { SharedResolvedMarkRecord } from "./mark-store.ts";
import { sharedMarkContains } from "./mark-record.ts";
import { createSharedPreparation } from "./prepare.ts";
import { sharedTextCommandPlan, SharedTextPreparationError } from "./executor-text-plan.ts";
import { collabTextTarget } from "./text-target.ts";
import { createSharedAnchor, readSharedAnchorUnit, resolveSharedTextAnchor } from "./anchors.ts";
import { readProjectionInlineValue } from "./projection-reader.ts";
import { readSharedMarkProvenance, readSharedTextRestoreOperation } from "./mark-provenance.ts";

export interface SharedHistoryUnit {
  readonly identity: SharedContentRef;
  readonly unit: SharedTextIdentity;
  readonly index: number;
  readonly value: SharedInlineValue;
  readonly marks: readonly SharedMarkGroup[];
}

export interface SharedTextHistory {
  readonly target: SharedTextAddress;
  readonly units: readonly SharedHistoryUnit[];
  readonly records: readonly SharedResolvedMarkRecord[];
  readonly known: (unit: SharedTextIdentity) => boolean;
  readonly live: (unit: SharedTextIdentity) => SharedHistoryUnit | null;
  readonly follow: (unit: SharedTextIdentity) => SharedTextIdentity;
  readonly back: (unit: SharedTextIdentity) => boolean;
  readonly left: (unit: SharedTextIdentity) => SharedHistoryUnit | null;
  readonly root: (unit: SharedTextIdentity) => SharedTextIdentity;
  readonly order: (unit: SharedTextIdentity) => number;
  readonly shown: (unit: SharedTextIdentity) => readonly SharedContentRef[];
  readonly showing: (occurrence: SharedContentRef) => readonly SharedHistoryUnit[];
  readonly offset: (anchor: SharedContentRef) => number | null;
}

function key(unit: SharedTextIdentity): string { return unit.client + ":" + unit.clock; }

export function readSharedTextHistory(handle: SharedDocumentHandle, raw: SharedTextAddress): SharedTextHistory | null {
  const prep = createSharedPreparation(handle);
  try {
    const plan = sharedTextCommandPlan(prep.view, raw), target = plan.target, facade = prep.view.text(plan.path), found = collabTextTarget(handle, target);
    if (!facade || !found) return null;
    const records = facade.records, provenance = readSharedMarkProvenance(records);
    const source = (identity: SharedContentRef): SharedContentRef => provenance?.source(identity) ?? identity;
    // why: a deleted character keeps its place in the shared text; only that order says where it and its marks belong.
    const places = new Map<string, number>();
    let place = 0;
    for (let item = found.text._start; item; item = item.right) {
      for (let unit = 0; unit < item.length; unit++) places.set(key({ client: item.id.client, clock: item.id.clock + unit }), place++);
    }
    const units: SharedHistoryUnit[] = [], alive = new Map<string, SharedHistoryUnit>();
    facade.units.forEach((unit, index) => {
      const identity = createSharedAnchor(handle, target, index, "after"), value = readProjectionInlineValue(unit.value);
      if (!identity || value === null) return;
      const entry = { identity, unit: { client: unit.identity.client, clock: unit.identity.clock }, index, value, marks: unit.marks };
      units.push(entry);
      alive.set(key(entry.unit), entry);
    });
    const restorations = new Map<string, SharedTextIdentity[]>(), originals = new Map<string, SharedTextIdentity>();
    for (const { record } of records) {
      const original = record.type === "birth" ? readSharedTextRestoreOperation(record.operation) : null;
      if (!original || record.type !== "birth") continue;
      const restored = { client: record.born.client, clock: record.born.clock };
      restorations.set(key(original), [...restorations.get(key(original)) ?? [], restored].sort((a, b) => a.client - b.client || a.clock - b.clock));
      originals.set(key(restored), original);
    }
    const follow = (unit: SharedTextIdentity): SharedTextIdentity => {
      let current = unit;
      for (let steps = 0; steps <= originals.size && !alive.has(key(current)); steps++) {
        const next = restorations.get(key(current))?.[0];
        if (!next) break;
        current = next;
      }
      return current;
    };
    const root = (unit: SharedTextIdentity): SharedTextIdentity => {
      let current = unit;
      for (let steps = 0; steps <= originals.size; steps++) {
        const original = originals.get(key(current));
        if (!original) break;
        current = original;
      }
      return current;
    };
    const order = (unit: SharedTextIdentity): number => places.get(key(root(unit))) ?? -1;
    const inside = (record: SharedResolvedMarkRecord["record"], at: number): boolean => {
      const start = readSharedAnchorUnit(record.start), end = readSharedAnchorUnit(record.end);
      const from = start && !start.after ? places.get(key(start)) : undefined, to = end?.after ? places.get(key(end)) : undefined;
      return from !== undefined && to !== undefined && from <= at && at <= to;
    };
    return {
      target, units, records,
      known: unit => places.has(key(unit)),
      live: unit => alive.get(key(unit)) ?? null,
      follow,
      // why: a deletion someone already undid, or whose character is back, is not undone a second time.
      back: unit => restorations.has(key(unit)) || units.some(other => key(root(other.unit)) === key(root(unit))),
      left: unit => units.filter(other => order(other.unit) < order(unit)).at(-1) ?? null,
      root, order,
      shown: unit => {
        const at = places.get(key(unit));
        if (at === undefined) return [];
        const covering = records.filter(item => inside(item.record, at) && sharedMarkContains(item.record.type === "remove" ? null : item.record.born, unit));
        const excluded = new Set(covering.flatMap(item => item.record.type === "add" ? [] : item.record.observed));
        const taken = new Set(covering.flatMap(item => item.record.type === "remove" ? item.record.observed.map(source) : []));
        return [...new Set(covering.filter(item => item.record.type === "add" && !excluded.has(item.identity) && !taken.has(source(item.identity))
          && !provenance?.cancelled.has(source(item.identity))).map(item => source(item.identity)))].sort();
      },
      showing: occurrence => units.filter(unit => unit.marks.some(group => group.additions.some(addition => source(addition.record) === occurrence))),
      offset: anchor => {
        const unit = readSharedAnchorUnit(anchor), followed = unit && alive.get(key(follow(unit)));
        return unit && followed ? followed.index + (unit.after ? 1 : 0) : resolveSharedTextAnchor(handle, anchor, target);
      }
    };
  } catch (error) {
    if (error instanceof SharedTextPreparationError) return null;
    throw error;
  } finally { prep.close(); }
}
