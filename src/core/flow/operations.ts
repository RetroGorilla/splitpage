import type { SharedContentRef, SharedOperation, SharedTextAddress, SharedInsertionChunk, SharedJsonFields, SharedMarkValue } from "../collab/operations.ts";
import { flowBaseReference } from "../collab/base-reference.ts";
import { clamp, clampRange } from "../text/edits.ts";
import { cellLength } from "../text/runs.ts";
import type { Run } from "../text/runs.ts";
import type { DocumentScene } from "../document/scenes.ts";

interface TraceRow {
  readonly id: string;
  readonly audioText?: string | null | undefined;
  readonly paragraphStart?: boolean | undefined;
  readonly [key: string]: unknown;
}
interface TraceDoc { readonly rows: readonly TraceRow[]; readonly sections?: unknown }
interface TracePorts {
  readonly cells: (html: string | null | undefined) => readonly Run[];
  readonly operations?: FlowOperationRequest | undefined;
  readonly trace?: FlowOperationTrace | undefined;
}

export interface FlowOperationRequest { readonly id: string; readonly by: string }
type FlowOperationPayload = SharedOperation extends infer T ? T extends SharedOperation ? Omit<T, "id" | "by"> : never : never;
export const flowIdentity = (id: string): SharedContentRef => id as SharedContentRef;

export class FlowOperationTrace {
  readonly ops: SharedOperation[] = [];
  private readonly offsets = new Map<string, number[]>();
  private readonly base: TraceDoc;
  private readonly ports: TracePorts;
  private readonly request: FlowOperationRequest;
  constructor(base: TraceDoc, ports: TracePorts, request: FlowOperationRequest) { this.base = base; this.ports = ports; this.request = request; }
  emit(payload: FlowOperationPayload): void {
    this.ops.push({ ...payload, id: flowIdentity(this.request.id + ":" + this.ops.length), by: this.request.by } as SharedOperation);
  }
  target(owner: string, field: SharedTextAddress["field"] = "audioText"): SharedTextAddress {
    return { owner: flowIdentity(owner), segment: flowIdentity(owner), field };
  }
  span(owner: string, from: number, to: number, field: SharedTextAddress["field"] = "audioText"): SharedContentRef[] {
    if (from === to) return [];
    const offsets = this.offsets.get(JSON.stringify([owner, field]));
    return [flowBaseReference(owner, field, offsets?.[from] ?? from, offsets ? (offsets[to - 1] ?? to - 1) + 1 : to)];
  }
  gap(owner: string, offset: number, field: SharedTextAddress["field"] = "audioText") {
    const offsets = this.offsets.get(JSON.stringify([owner, field]));
    const at = offsets ? offsets[offset] ?? (offsets.length ? (offsets.at(-1) as number) + 1 : 0) : offset;
    return { left: null, right: flowBaseReference(owner, field, at), affinity: "before" as const };
  }
  delete(owner: string, cell: readonly Run[], from: number, to: number, field: SharedTextAddress["field"] = "audioText"): void {
    const range = field === "heading" ? { from, to } : clampRange(cell, from, to);
    if (range.from === range.to) return;
    this.emit({ kind: "text-delete", target: this.target(owner, field), observed: this.span(owner, range.from, range.to, field) });
    const length = field === "heading" ? cell.reduce((sum, run) => sum + run.text.length, 0) : cellLength(cell);
    const offsets = this.offsets.get(JSON.stringify([owner, field])) ?? Array.from({ length }, (_, i) => i);
    offsets.splice(range.from, range.to - range.from);
    this.offsets.set(JSON.stringify([owner, field]), offsets);
  }
  insert(owner: string, cell: readonly Run[], offset: number, piece: readonly Run[], field: SharedTextAddress["field"] = "audioText"): void {
    const content: SharedInsertionChunk[] = piece.map(run => {
      const marks: SharedMarkValue[] = Object.entries(run.marks).flatMap(([kind, value]) => value === true ? [{ kind: kind as "b", value: true as const }] : []);
      for (const id of run.marks.cmt ?? []) marks.push({ kind: "comment", id: flowIdentity(id), value: true });
      if (run.marks.href) marks.push({ kind: "link", id: flowIdentity(run.marks.href), value: run.marks.href });
      return { value: run.text, marks };
    });
    this.emit({ kind: "text-insert", target: this.target(owner, field), at: this.gap(owner, field === "heading" ? offset : clamp(cell, offset), field), content });
  }
  create(row: TraceRow, rows: readonly TraceRow[], index: number): void {
    this.emit({ kind: "segment-create", segment: flowIdentity(row.id), beat: flowIdentity(row.id),
      at: { left: index ? flowIdentity((rows[index - 1] as TraceRow).id) : null, right: rows[index + 1] ? flowIdentity((rows[index + 1] as TraceRow).id) : null, affinity: "before" },
      fields: Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")) as SharedJsonFields });
  }
  remove(doc: TraceDoc, row: TraceRow, removalKind: "beat" | "range" | "became-heading" = "beat"): void {
    this.emit({ kind: "remove", removalKind, targets: [flowIdentity(row.id)],
      observed: this.span(row.id, 0, cellLength(this.ports.cells(row.audioText))), boundaries: [flowIdentity(row.id)],
      components: [flowIdentity(row.id + ":visual")], gallery: [flowIdentity(row.id + ":gallery")], at: doc.rows.indexOf(row) });
  }
  finish<T>(out: T): T {
    if (!out || typeof out !== "object" || !("rows" in out)) return out;
    const result = out as T & { readonly rows: readonly TraceRow[]; readonly sections: readonly DocumentScene[] | undefined };
    for (const row of result.rows) {
      const original = this.base.rows.find(item => item.id === row.id);
      if (!original || original.paragraphStart === row.paragraphStart
        && Object.hasOwn(original, "paragraphStart") === Object.hasOwn(row, "paragraphStart")) continue;
      this.emit({ kind: "scalar", target: { scope: "beat", record: flowIdentity(row.id) }, field: "paragraphStart",
        ...(Object.hasOwn(row, "paragraphStart") ? { value: row.paragraphStart as boolean } : { clear: true }) });
    }
    for (const scene of result.sections ?? []) {
      const original = Array.isArray(this.base.sections) ? this.base.sections.find((item: { id: string }) => item.id === scene.id) as { firstSceneId: string } | undefined : undefined;
      if (!original || original.firstSceneId === scene.firstSceneId) continue;
      this.emit({ kind: "scalar", target: { scope: "heading", record: flowIdentity(scene.id) }, field: "firstSceneId", value: scene.firstSceneId });
    }
    return { ...out, ops: this.ops };
  }
}

export function describeFlow<P extends TracePorts, T>(doc: TraceDoc, ports: P, run: (traced: P) => T): T {
  const trace = new FlowOperationTrace(doc, ports, ports.operations as FlowOperationRequest);
  return trace.finish(run({ ...ports, operations: undefined, trace }));
}
