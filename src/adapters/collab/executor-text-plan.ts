import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedStoredMarkValue } from "./stored-mark.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { sharedStructureReference } from "./structure-identity.ts";
import { readSharedStructureBoundary, sharedStructureSpans } from "./structure-boundary.ts";

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
}

export function sharedTextLocation(view: SharedPreparationView, raw: SharedTextAddress) {
  if (![raw.owner, raw.segment].every(isStableSharedIdentity)) throw new SharedTextPreparationError("unstable-identity");
  raw = { ...raw, owner: sharedStructureReference(view, raw.owner), segment: sharedStructureReference(view, raw.segment) };
  let segment: string = raw.segment, parent: readonly string[];
  if (raw.field === "title") {
    if (raw.owner !== raw.segment || view.get(["meta", "docId"]) !== raw.owner) throw new SharedTextPreparationError("missing-target");
    parent = ["meta"];
  } else if (raw.field === "visualText") {
    if (raw.segment === raw.owner && view.kind(["visuals", segment]) !== "map") {
      const stored = view.get(["beats", raw.owner, "visual"]);
      if (typeof stored !== "string" || !stored || !isStableSharedIdentity(stored)) throw new SharedTextPreparationError("missing-target");
      segment = stored;
    }
    parent = ["visuals", segment];
    if (view.get([...parent, "beat"]) !== raw.owner) throw new SharedTextPreparationError("missing-target");
  } else {
    if (view.kind([raw.field === "heading" ? "headings" : "beats", raw.owner]) !== "map") throw new SharedTextPreparationError("missing-target");
    if (raw.segment === raw.owner && view.kind(["segments", segment, "text"]) !== "text") {
      const stored = view.get([raw.field === "heading" ? "headings" : "beats", raw.owner, "segment"]);
      if (stored !== undefined && (typeof stored !== "string" || !stored || !isStableSharedIdentity(stored))) throw new SharedTextPreparationError("unstable-identity");
      segment = typeof stored === "string" ? stored : (raw.field === "heading" ? "h:" : "b:") + raw.owner;
    }
    parent = ["segments", segment];
    const head = view.get([...parent, "head"]), boundary = readSharedStructureBoundary(head);
    if (boundary?.owner !== raw.owner || boundary.field !== raw.field) {
      const slot = sharedTextPlanSlot(view, [...parent, "text"]);
      const deltas = slot.plan ? null : view.get([...parent, "text"]);
      const units = slot.plan?.units ?? (Array.isArray(deltas) ? deltas.flatMap((item: { insert?: unknown }) => typeof item?.insert === "string" ? item.insert.split("").map(value => ({ value })) : [{ value: item?.insert }]) : []);
      if (!sharedStructureSpans(head, units).some(span => span.owner === raw.owner && span.field === raw.field)) throw new SharedTextPreparationError("mismatched-target");
    }
  }
  const path = [...parent, raw.field === "title" ? "title" : "text"], storePath = [...parent, raw.field === "title" ? "titleMarks" : "markRecords"];
  if (view.kind(path) !== "text") throw new SharedTextPreparationError("missing-target");
  if (view.kind(storePath) !== "map") throw new SharedTextPreparationError("missing-store");
  return { target: { owner: raw.owner, segment: segment as SharedContentRef, field: raw.field }, path, storePath };
}

function provenance(owner: string, units: readonly SharedPlannedTextUnit[], at: number, field: SharedTextAddress["field"]): SharedTextProvenance {
  return { owner, field, units: [...units], value: units.map(unit => typeof unit.value === "string" ? unit.value : "\ufffc").join(""),
    before: Array.from({ length: units.length + 1 }, (_, index) => at + index), after: Array.from({ length: units.length + 1 }, (_, index) => at + index) };
}

export function sharedTextCommandPlan(view: SharedPreparationView, target: SharedTextAddress): SharedTextCommandPlan {
  const located = sharedTextLocation(view, target);
  const slot = sharedTextPlanSlot(view, located.path);
  slot.plan ??= (() => {
    const facade = view.text(located.path);
    if (!facade && JSON.stringify(view.get(located.path)) !== "[]") throw new SharedTextPreparationError("missing-target");
    const units = (facade?.units ?? []).map(unit => ({ value: unit.value, additions: unit.marks.flatMap(group => group.additions.map(addition => addition.record)) }));
    const spans = target.field === "audioText" || target.field === "heading" ? sharedStructureSpans(view.get([...located.path.slice(0, -1), "head"]), units) : [];
    return { ...located, units, native: provenance("", units, 0, target.field), sources: spans.length ? spans.map(span => provenance(span.owner, units.slice(span.from, span.to), span.from, span.field)) : [provenance(target.owner, units, 0, target.field)], recordKeys: [...facade?.recordKeys ?? []],
      additions: (facade?.records ?? []).flatMap(item => item.record.type === "add" ? [{ identity: item.identity, mark: item.record.mark }] : []) };
  })();
  return { ...slot.plan, target: located.target };
}

export function sharedTextPlanSlot(view: SharedPreparationView, path: readonly string[]): { plan: SharedTextCommandPlan | null } {
  return view.scratch("text-plan-slot:" + JSON.stringify(path), () => ({ plan: null }));
}

export function requireSharedTextOwnership(view: SharedPreparationView, plan: SharedTextCommandPlan, from: number, to: number): void {
  if (plan.target.field !== "audioText" && plan.target.field !== "heading") return;
  const spans = sharedStructureSpans(view.get([...plan.path.slice(0, -1), "head"]), plan.units);
  if (!spans.some(span => span.owner === plan.target.owner && span.field === plan.target.field && span.from <= from && span.to >= to)) throw new SharedTextPreparationError("mismatched-target");
}

export function sharedTextSource(plan: SharedTextCommandPlan, owner: string): SharedTextProvenance | undefined {
  return plan.sources.find(source => source.owner === owner);
}

export function addSharedTextSource(plan: SharedTextCommandPlan, owner: string, from: number, to: number, field = plan.target.field): void {
  plan.sources.push(provenance(owner, plan.units.slice(from, to), from, field));
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
