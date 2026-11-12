import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedStoredMarkValue } from "./stored-mark.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { sharedStructureReference } from "./structure-identity.ts";
import { sharedStructureSpans } from "./structure-spans.ts";
import { resolveSharedTextLocation } from "./text-location.ts";
import { cleanId } from "../../core/document/text-policy.ts";
import { sharedTextPoints } from "./text-points.ts";
import { readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";

export class SharedTextPreparationError extends Error {}
export interface SharedPlannedTextUnit { readonly value: unknown; additions: SharedContentRef[] }
export interface SharedTextProvenance {
  readonly owner: string;
  readonly field: SharedTextAddress["field"];
  readonly units: readonly SharedPlannedTextUnit[];
  readonly value: string;
  readonly before: number[];
  readonly after: number[];
}
export interface SharedTextCommandPlan {
  readonly target: SharedTextAddress;
  readonly path: readonly string[];
  readonly storePath: readonly string[];
  readonly units: SharedPlannedTextUnit[];
  readonly sources: SharedTextProvenance[];
  readonly native: SharedTextProvenance;
  readonly recordKeys: string[];
  readonly additions: { readonly identity: SharedContentRef; readonly mark: SharedStoredMarkValue }[];
  readonly points: { offset: number; assoc: -1 | 0 }[];
}

export function sharedTextLocation(view: SharedPreparationView, raw: SharedTextAddress) {
  raw = { ...raw, owner: sharedStructureReference(view, raw.owner), segment: sharedStructureReference(view, raw.segment) };
  try {
    if (raw.field === "audioText" && raw.segment !== raw.owner) {
      const owner = view.resolveOwner(raw.owner, "audioText");
      if (owner && owner.segment !== raw.segment) {
        const geometry = readSharedJoinedTextGeometry(view, owner.owner);
        const part = geometry?.root === owner.owner && !geometry.removed ? geometry.parts.find(part => part.segment === raw.segment) : null;
        if (!part) throw new SharedTextPreparationError("mismatched-target");
        return resolveSharedTextLocation(view, { ...raw, owner: part.owner as SharedContentRef });
      }
    }
    return resolveSharedTextLocation(view, raw);
  }
  catch (error) { throw new SharedTextPreparationError(error instanceof Error ? error.message : "missing-target"); }
}

function provenance(owner: string, units: readonly SharedPlannedTextUnit[], at: number, field: SharedTextAddress["field"]): SharedTextProvenance {
  return { owner, field, units: [...units], value: units.map(unit => typeof unit.value === "string" ? unit.value : "\ufffc").join(""),
    before: Array.from({ length: units.length + 1 }, (_, index) => at + index), after: Array.from({ length: units.length + 1 }, (_, index) => at + index) };
}

function projectedProvenance(owner: string, units: readonly SharedPlannedTextUnit[], positions: readonly number[], from: number, to: number, field: SharedTextAddress["field"]): SharedTextProvenance {
  const source = provenance(owner, positions.map(position => units[position] as SharedPlannedTextUnit), from, field);
  for (let index = 0; index <= positions.length; index++) {
    source.before[index] = index ? (positions[index - 1] as number) + 1 : positions[0] ?? to;
    source.after[index] = positions[index] ?? to;
  }
  return source;
}

export function sharedTextCommandPlan(view: SharedPreparationView, target: SharedTextAddress): SharedTextCommandPlan {
  const located = sharedTextLocation(view, target);
  const slot = sharedTextPlanSlot(view, located.path);
  slot.plan ??= (() => {
    const facade = view.text(located.path);
    if (!facade && JSON.stringify(view.get(located.path)) !== "[]") throw new SharedTextPreparationError("missing-target");
    const units = (facade?.units ?? []).map(unit => ({ value: unit.value, additions: unit.marks.flatMap(group => group.additions.map(addition => addition.record)) }));
    const spans = target.field === "audioText" || target.field === "heading" ? sharedStructureSpans(view, located.target.segment, units) : [];
    return { ...located, units, points: sharedTextPoints(view, located.path), native: provenance("", units, 0, target.field), sources: spans.length ? spans.flatMap(span => [...new Set([span.owner, span.field === "audioText" ? cleanId(span.owner) : span.owner])].map(owner => projectedProvenance(owner, units, span.positions, span.from, span.to, span.field))) : [provenance(target.owner, units, 0, target.field)], recordKeys: [...facade?.recordKeys ?? []],
      additions: (facade?.records ?? []).flatMap(item => item.record.type === "add" ? [{ identity: item.identity, mark: item.record.mark }] : []) };
  })();
  return { ...slot.plan, target: located.target };
}

export function sharedTextPlanSlot(view: SharedPreparationView, path: readonly string[]): { plan: SharedTextCommandPlan | null } {
  return view.scratch("text-plan-slot:" + JSON.stringify(path), () => ({ plan: null }));
}

export function requireSharedTextOwnership(view: SharedPreparationView, plan: SharedTextCommandPlan, from: number, to: number): number {
  if (plan.target.field !== "audioText" && plan.target.field !== "heading") return from;
  const spans = sharedStructureSpans(view, plan.target.segment, plan.units);
  const span = spans.find(span => span.owner === plan.target.owner && span.field === plan.target.field && span.from <= from && span.to >= to);
  const joined = !span && plan.target.field === "audioText" ? readSharedJoinedTextGeometry(view, plan.target.owner) : null;
  const owned = span ?? (!joined?.removed ? spans.find(span => span.field === "audioText" && span.from <= from && span.to >= to && joined?.parts.some(part => part.owner === span.owner && part.segment === plan.target.segment)) : null);
  if (!owned) throw new SharedTextPreparationError("mismatched-target");
  return from === to ? Math.max(from, owned.positions[0] ?? owned.to) : from;
}

export function sharedTextSource(plan: SharedTextCommandPlan, owner: string): SharedTextProvenance | undefined {
  return plan.sources.find(source => source.owner === owner);
}

export function addSharedTextSource(view: SharedPreparationView, plan: SharedTextCommandPlan, owner: string, from: number, to: number, field = plan.target.field): void {
  if (field === "audioText" || field === "heading") {
    const span = sharedStructureSpans(view, plan.target.segment, plan.units).find(span => span.owner === owner && span.field === field);
    if (!span) throw new SharedTextPreparationError("mismatched-target");
    plan.sources.push(projectedProvenance(owner, plan.units, span.positions.filter(position => position >= from && position < to), from, to, field));
  } else plan.sources.push(provenance(owner, plan.units.slice(from, to), from, field));
}

export function sharedTextRange(value: string, from: number, to: number) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > value.length) throw new SharedTextPreparationError("invalid-reference");
  // why: Cell normalization removes atom placeholders; shared positions must count every raw UTF-16 unit.
  const cuts = (offset: number) => value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff
    && value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff;
  if (from === to) return cuts(from) ? { from: from + 1, to: to + 1 } : { from, to };
  return { from: cuts(from) ? from - 1 : from, to: cuts(to) ? to + 1 : to };
}

export function sharedTextInsertionPosition(plan: SharedTextCommandPlan, offset: number): number {
  return sharedTextRange(plan.units.map(unit => typeof unit.value === "string" ? unit.value : "\ufffc").join(""), offset, offset).from;
}

export function spliceSharedTextPlan(plan: SharedTextCommandPlan, from: number, to: number, values: readonly unknown[], operation?: string): void {
  const added = values.map(value => ({ value, additions: [] as SharedContentRef[] })), removed = to - from;
  for (const point of plan.points) {
    const collapsed = point.offset <= from ? point.offset : point.offset >= to ? point.offset - removed : from;
    point.offset = collapsed + (collapsed > from || collapsed === from && point.assoc === 0 ? added.length : 0);
  }
  for (const source of [plan.native, ...plan.sources]) for (const [positions, stickRight] of [[source.before, false], [source.after, true]] as const) {
    for (let index = 0; index < positions.length; index++) {
      const position = positions[index] as number;
      const collapsed = position <= from ? position : position >= to ? position - removed : from;
      positions[index] = collapsed + (collapsed > from || collapsed === from && stickRight ? added.length : 0);
    }
  }
  const tail = plan.units.slice(to);
  plan.units.length = from;
  for (const unit of added) plan.units.push(unit);
  for (const unit of tail) plan.units.push(unit);
  if (operation !== undefined) {
    if (sharedTextSource(plan, operation)) throw new SharedTextPreparationError("existing-operation");
    plan.sources.push(provenance(operation, added, from, plan.target.field));
  }
}

export function sharedTextOverlay(plan: SharedTextCommandPlan) {
  const value: { insert: unknown }[] = [];
  for (const unit of plan.units) {
    const last = value.at(-1);
    if (typeof unit.value === "string" && last && typeof last.insert === "string") last.insert += unit.value;
    else value.push({ insert: unit.value });
  }
  return { kind: "text" as const, path: plan.path, value };
}
