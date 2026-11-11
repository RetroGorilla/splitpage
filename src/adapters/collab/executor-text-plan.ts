import type { SharedContentRef, SharedTextAddress, SharedMarkValue } from "../../core/collab/operations.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";

export class SharedTextPreparationError extends Error {}
export interface SharedPlannedTextUnit { readonly value: unknown }
export interface SharedTextProvenance {
  readonly owner: string;
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
  readonly recordKeys: string[];
  readonly additions: { readonly identity: SharedContentRef; readonly mark: SharedMarkValue }[];
}

export function sharedTextLocation(view: SharedPreparationView, raw: SharedTextAddress) {
  if (![raw.owner, raw.segment].every(isStableSharedIdentity)) throw new SharedTextPreparationError("unstable-identity");
  let segment: string = raw.segment, parent: readonly string[];
  if (raw.field === "title") {
    if (raw.owner !== raw.segment || view.get(["meta", "docId"]) !== raw.owner) throw new SharedTextPreparationError("missing-target");
    parent = ["meta"];
  } else if (raw.field === "visualText") {
    parent = ["visuals", segment];
    if (view.get([...parent, "beat"]) !== raw.owner) throw new SharedTextPreparationError("missing-target");
  } else {
    if (view.kind([raw.field === "heading" ? "headings" : "beats", raw.owner]) !== "map") throw new SharedTextPreparationError("missing-target");
    if (raw.segment === raw.owner && view.kind(["segments", segment, "text"]) !== "text") segment = (raw.field === "heading" ? "h:" : "b:") + raw.owner;
    parent = ["segments", segment];
  }
  const path = [...parent, raw.field === "title" ? "title" : "text"], storePath = [...parent, raw.field === "title" ? "titleMarks" : "markRecords"];
  if (view.kind(path) !== "text") throw new SharedTextPreparationError("missing-target");
  if (view.kind(storePath) !== "map") throw new SharedTextPreparationError("missing-store");
  return { target: { owner: raw.owner, segment: segment as SharedContentRef, field: raw.field }, path, storePath };
}

function provenance(owner: string, units: readonly SharedPlannedTextUnit[], at: number): SharedTextProvenance {
  return { owner, units: [...units], value: units.map(unit => typeof unit.value === "string" ? unit.value : "\ufffc").join(""),
    before: Array.from({ length: units.length + 1 }, (_, index) => at + index), after: Array.from({ length: units.length + 1 }, (_, index) => at + index) };
}

export function sharedTextCommandPlan(view: SharedPreparationView, target: SharedTextAddress): SharedTextCommandPlan {
  const located = sharedTextLocation(view, target);
  return view.scratch("text-plan:" + JSON.stringify(located.path), () => {
    const facade = view.text(located.path);
    if (!facade) throw new SharedTextPreparationError("missing-target");
    const units = facade.units.map(unit => ({ value: unit.value }));
    return { ...located, units, sources: [provenance(target.owner, units, 0)], recordKeys: [...facade.recordKeys],
      additions: facade.records.flatMap(item => item.record.type === "add" ? [{ identity: item.identity, mark: item.record.mark }] : []) };
  });
}

export function sharedTextSource(plan: SharedTextCommandPlan, owner: string): SharedTextProvenance | undefined {
  return plan.sources.find(source => source.owner === owner);
}

export function sharedTextRange(value: string, from: number, to: number) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > value.length) throw new SharedTextPreparationError("invalid-reference");
  // why: Cell normalization removes atom placeholders; shared positions must count every raw UTF-16 unit.
  const cuts = (offset: number) => value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff
    && value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff;
  if (from === to) return cuts(from) ? { from: from + 1, to: to + 1 } : { from, to };
  return { from: cuts(from) ? from - 1 : from, to: cuts(to) ? to + 1 : to };
}

export function spliceSharedTextPlan(plan: SharedTextCommandPlan, from: number, to: number, values: readonly unknown[], operation?: string): void {
  const added = values.map(value => ({ value })), removed = to - from;
  for (const source of plan.sources) for (const [positions, stickRight] of [[source.before, false], [source.after, true]] as const) {
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
    plan.sources.push(provenance(operation, added, from));
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
