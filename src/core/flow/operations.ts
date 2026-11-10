import type { SharedContentRef, SharedOperation, SharedTextAddress, SharedInsertionChunk, SharedJsonFields, SharedMarkValue, SharedJsonValue } from "../collab/operations.ts";
import { flowBaseReference } from "../collab/base-reference.ts";
import { clamp, clampRange, explode } from "../text/edits.ts";
import { cellLength, normalizeCell, projection, tagStack } from "../text/runs.ts";
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
interface FlowObservedOffset { owner: string; offset: number; field: SharedTextAddress["field"] }
type FlowOperationPayload = SharedOperation extends infer T ? T extends SharedOperation ? Omit<T, "id" | "by"> : never : never;
export const flowIdentity = (id: string): SharedContentRef => id as SharedContentRef;

export class FlowOperationTrace {
  readonly ops: SharedOperation[] = [];
  readonly moving = new Set<string>();
  private readonly created = new Map<string, TraceRow>();
  private readonly offsets = new Map<string, FlowObservedOffset[]>();
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
  private content(owner: string, field: SharedTextAddress["field"], length = 0) {
    const key = JSON.stringify([owner, field]);
    if (!this.offsets.has(key)) {
      const row = this.base.rows.find(row => row.id === owner);
      const scene = Array.isArray(this.base.sections) ? this.base.sections.find((scene: DocumentScene) => scene.id === owner) as DocumentScene | undefined : undefined;
      const size = field === "heading" ? scene?.name.length ?? length : row ? cellLength(this.ports.cells(row[field] as string)) : length;
      this.offsets.set(key, Array.from({ length: size }, (_, offset) => ({ owner, offset, field })));
    }
    return this.offsets.get(key) as FlowObservedOffset[];
  }
  span(owner: string, from: number, to: number, field: SharedTextAddress["field"] = "audioText"): SharedContentRef[] {
    const units = this.content(owner, field, to).slice(from, to), refs: SharedContentRef[] = [];
    for (let i = 0; i < units.length;) {
      const first = units[i] as FlowObservedOffset;
      let end = i + 1;
      while (end < units.length && units[end]?.owner === first.owner && units[end]?.field === first.field && units[end]?.offset === first.offset + end - i) end++;
      refs.push(flowBaseReference(first.owner, first.field, first.offset, first.offset + end - i));
      i = end;
    }
    return refs;
  }
  gap(owner: string, offset: number, field: SharedTextAddress["field"] = "audioText") {
    const units = this.content(owner, field, offset), right = units[offset], left = units[offset - 1];
    return right ? { left: null, right: flowBaseReference(right.owner, right.field, right.offset), affinity: "before" as const }
      : left ? { left: flowBaseReference(left.owner, left.field, left.offset), right: null, affinity: "after" as const }
      : { left: null, right: flowBaseReference(owner, field, 0), affinity: "before" as const };
  }
  delete(owner: string, cell: readonly Run[], from: number, to: number, field: SharedTextAddress["field"] = "audioText"): void {
    this.replace(owner, cell, from, to, [], field);
  }
  insert(owner: string, cell: readonly Run[], offset: number, piece: readonly Run[], field: SharedTextAddress["field"] = "audioText"): void {
    this.replace(owner, cell, offset, offset, piece, field);
  }
  replace(owner: string, cell: readonly Run[], from: number, to: number, piece: readonly Run[], field: SharedTextAddress["field"] = "audioText", insertAt?: number): void {
    const range = field === "heading" ? { from, to } : from === to ? { from: clamp(cell, from), to: clamp(cell, to) } : clampRange(cell, from, to);
    const units = this.content(owner, field, field === "heading" ? projection(cell).length : cellLength(cell));
    const observed = this.span(owner, range.from, range.to, field);
    units.splice(range.from, range.to - range.from);
    const offset = insertAt ?? range.from, at = this.gap(owner, offset, field);
    const content: SharedInsertionChunk[] = (field === "heading" ? piece : normalizeCell(piece)).map(run => {
      const marks: SharedMarkValue[] = Object.entries(run.marks).flatMap(([kind, value]) => value === true ? [{ kind: kind as "b", value: true as const }] : []);
      for (const id of run.marks.cmt ?? []) marks.push({ kind: "comment", id: flowIdentity(id), value: true });
      for (const id of tagStack(run.marks)) marks.push({ kind: "tag", id: flowIdentity(id), value: flowIdentity(id) });
      if (run.marks.href) marks.push({ kind: "link", id: flowIdentity(run.marks.href), value: run.marks.href });
      const value = field === "heading" ? run.atom ? projection([run]) : run.text : run.atom === "broll" ? { atom: run.atom, id: flowIdentity(run.id), text: run.text }
        : run.atom === "who" ? { atom: run.atom, name: run.name } : run.atom === "image" ? { atom: run.atom, ref: run.ref }
        : run.atom === "video" ? { atom: run.atom, href: run.href, host: run.host } : run.text;
      return { value, marks: field === "heading" ? [] : marks };
    });
    const id = this.request.id + ":" + this.ops.length;
    if (content.length) this.emit({ kind: "text-insert", target: this.target(owner, field), at, content });
    if (observed.length) this.emit({ kind: "text-delete", target: this.target(owner, field), observed });
    units.splice(offset, 0, ...Array.from({ length: field === "heading" ? piece.reduce((sum, run) => sum + (run.atom ? 1 : run.text.length), 0) : cellLength(piece) }, (_, offset) => ({ owner: id, offset, field })));
  }
  split(owner: string, offset: number, fresh: TraceRow, field: SharedTextAddress["field"] = "audioText", before = false): void {
    this.created.set(fresh.id, fresh);
    const units = this.content(owner, field), at = this.gap(owner, offset, field);
    this.emit({ kind: before ? "split-before" : "split", target: this.target(owner, field), at,
      observed: this.span(owner, 0, units.length, field), boundary: flowIdentity(fresh.id), beat: flowIdentity(fresh.id),
      fields: Object.fromEntries(Object.entries(fresh).filter(([key]) => key !== "id" && key !== "audioText")) as SharedJsonFields });
    this.offsets.set(JSON.stringify([fresh.id, "audioText"]), before ? units.slice(0, offset) : units.slice(offset));
    this.offsets.set(JSON.stringify([owner, field]), before ? units.slice(offset) : units.slice(0, offset));
  }
  create(row: TraceRow, rows: readonly TraceRow[], index: number): void {
    this.created.set(row.id, row);
    for (const field of ["audioText", "visualText"] as const) this.offsets.set(JSON.stringify([row.id, field]),
      Array.from({ length: cellLength(this.ports.cells(row[field] as string)) }, (_, offset) => ({ owner: row.id, field, offset })));
    this.emit({ kind: "segment-create", segment: flowIdentity(row.id), beat: flowIdentity(row.id),
      at: { left: index ? flowIdentity((rows[index - 1] as TraceRow).id) : null, right: rows[index + 1] ? flowIdentity((rows[index + 1] as TraceRow).id) : null, affinity: "before" },
      fields: Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")) as SharedJsonFields });
  }
  remove(doc: TraceDoc, row: TraceRow, removalKind: "beat" | "range" | "became-heading" = "beat"): void {
    this.emit({ kind: "remove", removalKind, targets: [flowIdentity(row.id)],
      observed: this.span(row.id, 0, cellLength(this.ports.cells(row.audioText))), boundaries: [flowIdentity(row.id)],
      components: [flowIdentity(row.id + ":visual")], gallery: [flowIdentity(row.id + ":gallery")], at: doc.rows.indexOf(row) });
  }
  marks(owner: string, cell: readonly Run[], from: number, to: number, next: readonly Run[], requested: string, on: boolean): void {
    const range = clampRange(cell, from, to);
    if (["b", "i", "u", "s", "hl", "dir", "cue"].includes(requested)) {
      this.emit({ kind: "mark", target: this.target(owner), observed: this.span(owner, range.from, range.to), mark: { kind: requested as "b", value: on ? true : null } });
      return;
    }
    const before = explode(cell), after = explode(next);
    const values = (marks: Run["marks"]): SharedMarkValue[] => [
      ...Object.entries(marks).flatMap(([kind, value]) => value === true ? [{ kind: kind as "b", value: true as const }] : []),
      ...(marks.cmt ?? []).map(id => ({ kind: "comment" as const, id: flowIdentity(id), value: true as const })),
      ...tagStack(marks).map(id => ({ kind: "tag" as const, id: flowIdentity(id), value: flowIdentity(id) })),
      ...(marks.href ? [{ kind: "link" as const, id: flowIdentity(marks.href), value: marks.href }] : [])
    ];
    const changes = new Map<string, { mark: SharedMarkValue; offsets: number[] }>();
    for (let i = range.from; i < range.to; i++) {
      const a = before[i], b = after[i];
      if (!a || !b) continue;
      const prior = values(a.atom ? a.atom.marks : a.marks), following = values(b.atom ? b.atom.marks : b.marks);
      for (const mark of [...prior.filter(mark => !following.some(next => JSON.stringify(mark) === JSON.stringify(next))).map(mark => ({ ...mark, value: null })),
        ...following.filter(mark => !prior.some(old => JSON.stringify(mark) === JSON.stringify(old)))]) {
        const key = JSON.stringify(mark), change = changes.get(key) ?? { mark, offsets: [] };
        change.offsets.push(i); changes.set(key, change);
      }
    }
    for (const { mark, offsets } of changes.values()) this.emit({ kind: "mark", target: this.target(owner),
      observed: offsets.flatMap(offset => this.span(owner, offset, offset + 1)), mark });
  }
  normalizedMove(row: TraceRow): void {
    const original = this.base.rows.find(item => item.id === row.id);
    if (!original) return;
    for (const field of new Set([...Object.keys(original), ...Object.keys(row)])) {
      if (field === "id" || field === "paragraphStart" || JSON.stringify(original[field]) === JSON.stringify(row[field])
        && Object.hasOwn(original, field) === Object.hasOwn(row, field)) continue;
      this.emit({ kind: "scalar", target: { scope: "beat", record: flowIdentity(row.id) }, field,
        ...(Object.hasOwn(row, field) ? { value: row[field] as SharedJsonValue } : { clear: true }) });
    }
  }
  removedComments(since: number, comments: readonly string[]): void {
    for (let i = since; i < this.ops.length; i++) {
      const op = this.ops[i];
      if (op?.kind === "remove" && op.removalKind === "range") this.ops[i] = { ...op, comments: comments.map(flowIdentity) };
    }
  }
  finish<T>(out: T): T {
    if (!out || typeof out !== "object" || !("rows" in out)) return out;
    const result = out as T & { readonly rows: readonly TraceRow[]; readonly sections: readonly DocumentScene[] | undefined };
    for (const row of result.rows) {
      const original = this.created.get(row.id) ?? this.base.rows.find(item => item.id === row.id);
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
