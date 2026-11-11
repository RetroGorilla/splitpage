import { readFlowBaseReference } from "../../core/collab/base-reference.ts";
import type { SharedContentRef, SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView } from "./prepare.ts";
import type { SharedTextCommandPlan, SharedPlannedTextUnit } from "./executor-text-plan.ts";
import { sharedTextCommandPlan, sharedTextRange, sharedTextSource, SharedTextPreparationError } from "./executor-text-plan.ts";
import { createSharedPreparation } from "./prepare.ts";
import { readSharedRevision } from "./document.ts";
import { createSharedAnchor, readSharedAnchor, sharedAnchorCharacterEnd } from "./anchors.ts";
import { readSharedTextTarget } from "./text-target.ts";

interface CapturedTextSpan { readonly target: SharedTextAddress; readonly start: SharedContentRef; readonly end: SharedContentRef; readonly units: readonly SharedContentRef[] }
export interface SharedResolvedTextReference { readonly from: number; readonly to: number; readonly units: readonly SharedPlannedTextUnit[] }

function spanString(span: CapturedTextSpan): SharedContentRef {
  return JSON.stringify(["shared-text-span", { owner: span.target.owner, segment: span.target.segment, field: span.target.field }, span.start, span.end, span.units]) as SharedContentRef;
}

function readSpan(raw: unknown): CapturedTextSpan | null {
  if (!Array.isArray(raw) || raw.length !== 5 || raw[0] !== "shared-text-span") return null;
  const target = readSharedTextTarget(raw[1]), start = readSharedAnchor(raw[2]), end = readSharedAnchor(raw[3]), units: SharedContentRef[] = [];
  if (!target || !start || !end || !Array.isArray(raw[4])) return null;
  for (let index = 0; index < raw[4].length; index++) {
    const unit = readSharedAnchor(raw[4][index]);
    if (!unit || !sharedAnchorCharacterEnd(unit)) return null;
    units.push(unit);
  }
  return { target, start, end, units };
}

function mappedGap(plan: SharedTextCommandPlan, index: number, affinity: "before" | "after"): number {
  const original = sharedTextSource(plan, plan.target.owner), positions = affinity === "after" ? original?.after : original?.before;
  const mapped = positions?.[index];
  if (mapped === undefined) throw new SharedTextPreparationError("invalid-reference");
  return mapped;
}

function anchored(view: SharedPreparationView, plan: SharedTextCommandPlan, reference: SharedContentRef, point: boolean): SharedResolvedTextReference {
  const facade = view.text(plan.path);
  if (!facade) throw new SharedTextPreparationError("missing-target");
  const position = facade.resolveAnchor(reference);
  if (position.kind === "gone") throw new SharedTextPreparationError("invalid-reference");
  const from = mappedGap(plan, position.index, position.affinity);
  if (point) return { from, to: from, units: [] };
  const endAnchor = sharedAnchorCharacterEnd(reference);
  if (!endAnchor) throw new SharedTextPreparationError("invalid-reference");
  const end = facade.resolveAnchor(endAnchor);
  if (end.kind === "gone") throw new SharedTextPreparationError("invalid-reference");
  const original = sharedTextSource(plan, plan.target.owner), selected = position.kind === "index" ? original?.units[position.index] : undefined;
  const range = sharedTextRange(original?.value ?? "", position.index, end.index);
  return { from: mappedGap(plan, range.from, "after"), to: mappedGap(plan, range.to, "before"), units: selected ? original?.units.slice(range.from, range.to) ?? [] : [] };
}

export function resolveSharedTextReference(view: SharedPreparationView, plan: SharedTextCommandPlan, reference: SharedContentRef, purpose: "point" | "left" | "range"): SharedResolvedTextReference {
  let raw: unknown;
  try { raw = JSON.parse(reference) as unknown; } catch { throw new SharedTextPreparationError("invalid-reference"); }
  if (Array.isArray(raw) && raw[0] === "flow-base") {
    if (view.base === null) throw new SharedTextPreparationError("stale-base");
    let base: ReturnType<typeof readFlowBaseReference>;
    try { base = readFlowBaseReference(reference); } catch { throw new SharedTextPreparationError("invalid-reference"); }
    const source = sharedTextSource(plan, base.owner);
    if (!source || base.field !== plan.target.field || purpose !== "range" && base.from !== base.to) throw new SharedTextPreparationError("invalid-reference");
    const range = sharedTextRange(source.value, base.from + (purpose === "left" ? 1 : 0), purpose === "range" ? base.to : base.from + (purpose === "left" ? 1 : 0));
    const from = (purpose === "left" ? source.before : source.after)[range.from], to = purpose === "range" ? source.before[range.to] : from;
    if (from === undefined || to === undefined) throw new SharedTextPreparationError("invalid-reference");
    return { from, to: Math.max(from, to), units: purpose === "range" ? source.units.slice(range.from, range.to) : [] };
  }
  const span = readSpan(raw);
  if (span) {
    if (purpose !== "range" || span.target.owner !== plan.target.owner || span.target.segment !== plan.target.segment || span.target.field !== plan.target.field || spanString(span) !== reference) throw new SharedTextPreparationError("invalid-reference");
    const facade = view.text(plan.path);
    if (!facade) throw new SharedTextPreparationError("missing-target");
    const start = facade.resolveAnchor(span.start), end = facade.resolveAnchor(span.end);
    if (start.kind === "gone" || end.kind === "gone" || start.index > end.index) throw new SharedTextPreparationError("invalid-reference");
    const from = mappedGap(plan, start.index, start.affinity), to = mappedGap(plan, end.index, end.affinity);
    return { from, to: Math.max(from, to), units: span.units.flatMap(unit => anchored(view, plan, unit, false).units) };
  }
  if (!readSharedAnchor(reference)) throw new SharedTextPreparationError("invalid-reference");
  return anchored(view, plan, reference, purpose !== "range");
}

export function captureSharedTextRange(handle: SharedDocumentHandle, target: SharedTextAddress, from: number, to: number): SharedContentRef | null {
  const prep = createSharedPreparation(handle);
  try {
    const plan = sharedTextCommandPlan(prep.view, target), source = sharedTextSource(plan, target.owner);
    if (!source) return null;
    const range = sharedTextRange(source.value, from, to), start = createSharedAnchor(handle, plan.target, range.from, "after"), end = createSharedAnchor(handle, plan.target, range.to, "before");
    if (!start || !end) return null;
    const units: SharedContentRef[] = [];
    for (let index = range.from; index < range.to; index++) { const unit = createSharedAnchor(handle, plan.target, index, "after"); if (!unit) return null; units.push(unit); }
    return spanString({ target: plan.target, start, end, units });
  } catch { return null; } finally { prep.close(); }
}

export function resolveSharedBaseReference(handle: SharedDocumentHandle, target: SharedTextAddress, reference: SharedContentRef, base: number):
  { readonly ok: true; readonly target: SharedTextAddress; readonly from: number; readonly to: number } | { readonly ok: false; readonly reason: string } {
  if (base !== readSharedRevision(handle)) return { ok: false, reason: "stale-base" };
  const prep = createSharedPreparation(handle, base);
  try {
    readFlowBaseReference(reference);
    const plan = sharedTextCommandPlan(prep.view, target), span = resolveSharedTextReference(prep.view, plan, reference, "range");
    return { ok: true, target: plan.target, from: span.from, to: span.to };
  } catch (error) { return { ok: false, reason: error instanceof SharedTextPreparationError ? error.message : "invalid-reference" }; }
  finally { prep.close(); }
}
