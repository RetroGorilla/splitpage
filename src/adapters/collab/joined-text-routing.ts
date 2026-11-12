import type { SharedContentRef, SharedTextAddress, SharedIdentityGap } from "../../core/collab/operations.ts";
import { readFlowBaseReference } from "../../core/collab/base-reference.ts";
import type { SharedPreparationView, SharedPreparationResult } from "./prepare.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { sharedStructureReference } from "./structure-identity.ts";
import { sharedTextCommandPlan, sharedTextRange, SharedTextPreparationError } from "./executor-text-plan.ts";
import type { SharedTextCommandPlan, SharedPlannedTextUnit, SharedTextProvenance } from "./executor-text-plan.ts";
import { sharedStructureSpans } from "./structure-spans.ts";
import { readSharedJoinedTextGeometry, sharedJoinedTextBaseline } from "./joined-text-geometry.ts";
import { sharedJoinGlueRegisterField } from "../../core/collab/projection/join-glue.ts";
import { readSharedAnchor } from "./anchors.ts";
import { projectSharedJoinSeparator } from "../../core/collab/projection/joins.ts";
import { resolveSharedTextReference } from "./executor-references.ts";
import { isPlannedStructureOwner } from "./structure-plan.ts";
import { readSharedJoinedSpan } from "./joined-text-span.ts";
import { readSharedJoinGlueReference } from "./join-glue-reference.ts";

interface JoinedUnit { readonly unit: SharedPlannedTextUnit; readonly plan: SharedTextCommandPlan | null; readonly source: SharedTextProvenance | null; readonly offset: number; readonly group: string | null; readonly at?: number }
export interface SharedJoinedTextReading {
  readonly owner: string;
  readonly items: readonly JoinedUnit[];
  readonly plans: readonly SharedTextCommandPlan[];
  readonly byUnit: ReadonlyMap<SharedPlannedTextUnit, JoinedUnit>;
  readonly spans: readonly { readonly owner: string; readonly plan: SharedTextCommandPlan; readonly from: number; readonly to: number; readonly group: string | null; readonly glue: "" | " " }[];
  readonly value: string;
}
function glueUnit(view: SharedPreparationView, group: string) {
  const held = view.scratch("joined-glue-units", () => new Map<string, SharedPlannedTextUnit>());
  let unit = held.get(group); if (!unit) { unit = { value: " ", additions: [] }; held.set(group, unit); } return unit;
}
export function usesSharedJoinedText(view: SharedPreparationView, target: SharedTextAddress): boolean {
  if (target.field !== "audioText") return false;
  const owner = sharedStructureReference(view, target.owner), winner = view.resolveOwner(owner, "audioText");
  if (!winner) throw new SharedTextPreparationError("missing-target");
  const geometry = readSharedJoinedTextGeometry(view, winner.owner); if (!geometry || geometry.removed) throw new SharedTextPreparationError("missing-target");
  sharedJoinedTextBaseline(view, { ...target, owner: winner.owner as SharedContentRef });
  const segment = sharedStructureReference(view, target.segment);
  return geometry.root === winner.owner && geometry.parts.length > 1 || segment !== owner && segment !== winner.segment;
}
export function readSharedJoinedText(view: SharedPreparationView, target: SharedTextAddress): SharedJoinedTextReading | null {
  if (target.field !== "audioText") return null;
  const rawOwner = sharedStructureReference(view, target.owner), winner = view.resolveOwner(rawOwner, "audioText");
  if (!winner) throw new SharedTextPreparationError("missing-target");
  const geometry = readSharedJoinedTextGeometry(view, winner.owner); if (!geometry || geometry.removed) throw new SharedTextPreparationError("missing-target");
  sharedJoinedTextBaseline(view, { ...target, owner: winner.owner as SharedContentRef });
  const segment = sharedStructureReference(view, target.segment), parts = segment === rawOwner
    ? geometry.root === winner.owner ? geometry.parts : geometry.parts.filter(part => part.owner === winner.owner)
    : geometry.parts.filter(part => part.segment === segment && (geometry.root === winner.owner || part.owner === winner.owner));
  if (!parts.length) throw new SharedTextPreparationError("mismatched-target");
  const spans: SharedJoinedTextReading["spans"][number][] = [], items: JoinedUnit[] = [], plans = new Set<SharedTextCommandPlan>();
  const byPath = new Map<string, SharedTextCommandPlan>();
  const sources = new Map<SharedTextCommandPlan, Map<SharedPlannedTextUnit, { readonly source: SharedTextProvenance; readonly offset: number }>>();
  for (const part of parts) {
    let plan = byPath.get(part.segment);
    if (!plan) { plan = sharedTextCommandPlan(view, { owner: part.owner as SharedContentRef, segment: part.segment as SharedContentRef, field: "audioText" }); byPath.set(part.segment, plan); }
    let sourceIndex = sources.get(plan);
    if (!sourceIndex) {
      sourceIndex = new Map(); sources.set(plan, sourceIndex);
      for (const source of plan.sources) source.units.forEach((unit, offset) => { if (!sourceIndex?.has(unit)) sourceIndex?.set(unit, { source, offset }); });
    }
    const span = sharedStructureSpans(view, part.segment, plan.units).find(span => span.owner === part.owner);
    if (!span) throw new SharedTextPreparationError("missing-target"); plans.add(plan);
    const glue = projectSharedJoinSeparator(items.map(item => typeof item.unit.value === "string" ? item.unit.value : "\ufffc").join(""),
      span.positions.map(at => typeof plan.units[at]?.value === "string" ? plan.units[at]?.value : "\ufffc").join(""), part.glue, spans.length, geometry.cyclic, part.glueSet);
    if (glue && part.group && spans.length) items.push({ unit: glueUnit(view, part.group), plan: null, source: null, offset: 0, group: part.group });
    spans.push({ owner: part.owner, plan, from: span.from, to: span.to, group: part.group, glue });
    for (const at of span.positions) {
      const unit = plan.units[at]; if (!unit) throw new SharedTextPreparationError("invalid-reference");
      const origin = sourceIndex.get(unit); if (!origin) throw new SharedTextPreparationError("invalid-reference");
      items.push({ unit, plan, source: origin.source, offset: origin.offset, group: null, at });
    }
  }
  return { owner: winner.owner, items, spans, plans: [...plans], byUnit: new Map(items.map(item => [item.unit, item])), value: items.map(item => typeof item.unit.value === "string" ? item.unit.value : "\ufffc").join("") };
}

function baseline(view: SharedPreparationView, row: SharedJoinedTextReading, owner: string) {
  const cache = view.scratch("joined-text-sources", () => new Map<string, { readonly items: readonly JoinedUnit[]; readonly value: string }>());
  const held = cache.get(owner); if (held) return held;
  if (row.owner === owner && isPlannedStructureOwner(view, owner)) {
    const value = { items: [...row.items], value: row.value }; cache.set(owner, value); return value;
  }
  const inserted = row.plans.flatMap(plan => plan.sources.filter(source => source.owner === owner).map(source => ({ plan, source })));
  const items: JoinedUnit[] = [];
  const located = view.resolveOwner(owner, "audioText"), geometry = located ? sharedJoinedTextBaseline(view, { owner: located.owner as SharedContentRef, segment: owner as SharedContentRef, field: "audioText" }) : null;
  let partIndex = 0;
  if (geometry) for (const part of geometry.root === located?.owner ? geometry.parts : geometry.parts.filter(part => part.owner === located?.owner)) {
    const plan = sharedTextCommandPlan(view, { owner: part.owner as SharedContentRef, segment: part.segment as SharedContentRef, field: "audioText" });
    const source = plan.sources.find(source => source.owner === part.owner);
    if (!source) throw new SharedTextPreparationError("invalid-reference");
    const glue = projectSharedJoinSeparator(items.map(item => typeof item.unit.value === "string" ? item.unit.value : "\ufffc").join(""), source.value, part.glue, partIndex++, geometry.cyclic, part.glueSet);
    if (glue && part.group) items.push({ unit: glueUnit(view, part.group), plan: null, source: null, offset: 0, group: part.group });
    items.push(...source.units.map((unit, offset) => ({ unit, plan, source, offset, group: null })));
  }
  else for (const { plan, source } of inserted) items.push(...source.units.map((unit, offset) => ({ unit, plan, source, offset, group: null })));
  if (!geometry && !inserted.length) throw new SharedTextPreparationError("invalid-reference");
  const result = { items, value: items.map(item => typeof item.unit.value === "string" ? item.unit.value : "\ufffc").join("") }; cache.set(owner, result); return result;
}

export function captureSharedJoinedTextSource(view: SharedPreparationView, row: SharedJoinedTextReading): void { baseline(view, row, row.owner); }

function physicalPoint(row: SharedJoinedTextReading, plan: SharedTextCommandPlan, offset: number) {
  const span = row.spans.find(span => span.plan.path.join("\0") === plan.path.join("\0") && span.from <= offset && span.to >= offset);
  if (!span) throw new SharedTextPreparationError("mismatched-target");
  return { plan: { ...plan, target: { ...plan.target, owner: span.owner as SharedContentRef } }, offset };
}
function virtualPoint(row: SharedJoinedTextReading, group: string, after: boolean) {
  const index = row.spans.findIndex(span => span.group === group), right = row.spans[index], left = row.spans[index - 1];
  if (!left || !right) throw new SharedTextPreparationError("mismatched-target");
  return after ? physicalPoint(row, right.plan, right.from) : physicalPoint(row, left.plan, left.to);
}
export function resolveSharedJoinedReference(view: SharedPreparationView, row: SharedJoinedTextReading, reference: SharedContentRef, purpose: "point" | "left" | "range"): { items: SharedJoinedTextReading["items"]; point: { plan: SharedTextCommandPlan; offset: number } | null } {
  let raw: unknown; try { raw = JSON.parse(reference); } catch { throw new SharedTextPreparationError("invalid-reference"); }
  const span = readSharedJoinedSpan(reference);
  if (span) {
    const owner = view.resolveOwner(sharedStructureReference(view, span.target.owner), "audioText");
    if (purpose !== "range" || !owner || !row.spans.some(part => part.owner === owner.owner)) throw new SharedTextPreparationError("invalid-reference");
    return { items: span.units.flatMap(unit => resolveSharedJoinedReference(view, row, unit, "range").items), point: null };
  }
  if (Array.isArray(raw) && raw[0] === "flow-base") {
    if (view.base === null) throw new SharedTextPreparationError("stale-base");
    let ref; try { ref = readFlowBaseReference(reference); } catch { throw new SharedTextPreparationError("invalid-reference"); }
    if (ref.field !== "audioText" || purpose !== "range" && ref.from !== ref.to) throw new SharedTextPreparationError("invalid-reference");
    const source = baseline(view, row, sharedStructureReference(view, ref.owner));
    const range = sharedTextRange(source.value, ref.from + (purpose === "left" ? 1 : 0), purpose === "range" ? ref.to : ref.from + (purpose === "left" ? 1 : 0));
    if (purpose === "range") {
      const items = source.items.slice(range.from, range.to);
      for (const item of items) if (!row.byUnit.has(item.unit) && (item.source && (item.source.after[item.offset] ?? 0) < (item.source.before[item.offset + 1] ?? 0)
        || item.group && row.spans.every(span => span.group !== item.group))) throw new SharedTextPreparationError("mismatched-target");
      return { items, point: null };
    }
    const right = source.items[range.from], left = source.items[range.from - 1];
    const item = purpose === "left" ? left ?? right : right ?? left;
    if (!item) { const first = row.spans[0]; if (!first) throw new SharedTextPreparationError("missing-target"); return { items: [], point: { plan: first.plan, offset: first.from } }; }
    if (item.group) return { items: [], point: virtualPoint(row, item.group, item === left) };
    if (!item.plan || !item.source) throw new SharedTextPreparationError("invalid-reference");
    const index = item.offset + (item === left ? 1 : 0), offset = (purpose === "left" ? item.source.before : item.source.after)[index];
    if (offset === undefined) throw new SharedTextPreparationError("invalid-reference");
    return { items: [], point: physicalPoint(row, item.plan, offset) };
  }
  const virtual = readSharedJoinGlueReference(reference);
  if (virtual) {
    if (virtual.after && purpose === "range") throw new SharedTextPreparationError("invalid-reference");
    const group = virtual.group, item = row.items.find(item => item.group === group);
    if (!item && !row.spans.some(span => span.group === group)) throw new SharedTextPreparationError("invalid-reference");
    return { items: purpose === "range" && item ? [item] : [], point: purpose === "range" ? null : virtualPoint(row, group, virtual.after || purpose === "left") };
  }
  if (!readSharedAnchor(reference)) throw new SharedTextPreparationError("invalid-reference");
  for (const plan of row.plans) {
    const location = view.text(plan.path)?.resolveAnchor(reference); if (!location || location.kind === "gone") continue;
    const resolved = resolveSharedTextReference(view, plan, reference, purpose);
    if (purpose !== "range") return { items: [], point: physicalPoint(row, plan, resolved.from) };
    const items = resolved.units.flatMap(unit => {
      const item = row.byUnit.get(unit);
      const at = plan.native.units[location.index] === unit ? location.index : plan.native.units[location.index - 1] === unit ? location.index - 1 : location.index + 1;
      if (!item && (plan.native.after[at] ?? 0) < (plan.native.before[at + 1] ?? 0)) throw new SharedTextPreparationError("mismatched-target");
      return item ? [item] : [];
    });
    return { items, point: null };
  }
  throw new SharedTextPreparationError("invalid-reference");
}

export function sharedJoinedGap(view: SharedPreparationView, row: SharedJoinedTextReading, gap: SharedIdentityGap) {
  const left = gap.left === null ? null : resolveSharedJoinedReference(view, row, gap.left, "left").point;
  const right = gap.right === null ? null : resolveSharedJoinedReference(view, row, gap.right, "point").point;
  const rank = (point: NonNullable<typeof left>) => {
    const at = row.items.findIndex(item => item.plan?.path.join("\0") === point.plan.path.join("\0") && item.at !== undefined && item.at >= point.offset);
    return at < 0 ? row.items.length : at;
  };
  if (left && right && rank(left) > rank(right)) throw new SharedTextPreparationError("invalid-reference");
  const chosen = gap.affinity === "before" ? right ?? left : left ?? right;
  if (chosen) return chosen;
  if (row.items.length) throw new SharedTextPreparationError("invalid-reference");
  const first = row.spans[0]; if (!first) throw new SharedTextPreparationError("missing-target"); return { plan: first.plan, offset: first.from };
}

export function sharedJoinedSelected(view: SharedPreparationView, row: SharedJoinedTextReading, observed: readonly SharedContentRef[]) {
  const chosen = new Set(observed.flatMap(reference => resolveSharedJoinedReference(view, row, reference, "range").items.map(item => item.unit)));
  const plans = new Map(row.plans.map(plan => [plan, new Set<SharedPlannedTextUnit>()])), groups = new Set<string>();
  for (const item of row.items) if (chosen.has(item.unit)) { if (item.plan) plans.get(item.plan)?.add(item.unit); if (item.group) groups.add(item.group); }
  return { physical: [...plans].filter(([, units]) => units.size).map(([plan, units]) => ({ plan, units })), groups: [...groups] };
}

export function prepareSharedGlueDeletion(view: SharedPreparationView, groups: readonly string[]): SharedPreparationResult {
  const writes = freezeSharedPreparedValue(groups.map(group => ({ kind: "set" as const, path: ["meta", sharedJoinGlueRegisterField(group)], value: "" })));
  return { ok: true, writes, apply: handle => applySharedMapWrites(handle, writes) };
}
