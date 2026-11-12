import type { Run } from "../../core/text/runs.ts";
import { tagStack } from "../../core/text/runs.ts";
import type { SharedContentRef, SharedInsertionChunk, SharedMarkValue, SharedTextAddress, SharedRecordCreate } from "../../core/collab/operations.ts";
import { flowBaseReference } from "../../core/collab/base-reference.ts";
import type { SharedPreparationView, SharedPreparedWrite, SharedPreparationResult } from "./prepare.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { prepareStructureAlias, sharedStructureReference, SharedStructurePreparationError } from "./structure-identity.ts";
import { freezeSharedPreparedValue, sharedPreparedValue } from "./prepare-value.ts";
import { prepareSharedTextInsertion } from "./text-executor.ts";
import { sharedTextCommandPlan, addSharedTextSource, SharedTextPreparationError } from "./executor-text-plan.ts";

export interface SharedStructureContentPorts {
  readonly cells: (html: string) => readonly Run[];
}

export function sharedStructureView(view: SharedPreparationView, writes: readonly SharedPreparedWrite[]): SharedPreparationView {
  const exact = (path: readonly string[]) => writes.findLast(write => JSON.stringify(write.path) === JSON.stringify(path));
  const changed = (path: readonly string[]) => exact(path) ?? (writes.some(write => write.path.length < path.length && write.path.every((part, index) => part === path[index])) ? { kind: "delete" as const, path } : undefined);
  const prepared: SharedPreparationView = { ...view, kind: path => { const write = changed(path); return write ? write.kind === "set" ? "value" : write.kind === "delete" ? "missing" : write.kind : view.kind(path); },
    get: path => { const write = changed(path); return write ? sharedPreparedValue(write.value) : view.get(path); }, has: path => { const write = changed(path); return write ? write.kind !== "delete" : view.has(path); },
    text: path => changed(path) ? null : view.text(path), keys: path => {
      const keys = new Set(changed(path) ? [] : view.keys(path));
      for (const write of writes) if (write.path.length === path.length + 1 && path.every((part, index) => part === write.path[index])) {
        const key = write.path.at(-1); if (key !== undefined) { if (write.kind === "delete") keys.delete(key); else keys.add(key); }
      }
      return Object.freeze([...keys].sort());
    } };
  return Object.freeze(prepared);
}

export function prepareSharedInitialContent(view: SharedPreparationView, target: SharedTextAddress, html: string, id: string, by: string, ports: SharedStructureContentPorts) {
  const content: SharedInsertionChunk[] = ports.cells(html).map(run => {
    const marks: SharedMarkValue[] = Object.entries(run.marks).flatMap(([kind, value]) => value === true ? [{ kind: kind as "b", value: true as const }] : []);
    for (const anchor of run.marks.cmt ?? []) marks.push({ kind: "comment", id: anchor as SharedContentRef, value: true });
    for (const tag of tagStack(run.marks)) marks.push({ kind: "tag", id: tag as SharedContentRef, value: tag as SharedContentRef });
    if (run.marks.href) marks.push({ kind: "link", id: run.marks.href as SharedContentRef, value: run.marks.href });
    const value = run.atom === "broll" ? { atom: run.atom, id: run.id as SharedContentRef, text: run.text } : run.atom === "who" ? { atom: run.atom, name: run.name }
      : run.atom === "image" ? { atom: run.atom, ref: run.ref } : run.atom === "video" ? { atom: run.atom, href: run.href, host: run.host } : run.text;
    return { value, marks };
  });
  const plan = sharedTextCommandPlan(view, target), start = plan.units.length;
  const prepared = prepareSharedTextInsertion({ kind: "text-insert", id: id as SharedContentRef, by, target,
    at: { left: null, right: flowBaseReference(target.owner, target.field, 0), affinity: "before" }, content }, view);
  if (!prepared.ok) throw new SharedTextPreparationError(prepared.reason);
  const source = plan.sources.findIndex(source => source.owner === target.owner), prior = plan.sources[source]?.before[0] ?? 0;
  if (source >= 0) plan.sources.splice(source, 1);
  const added = plan.units.length - start, span = plan.sources.find(source => source.owner === id);
  const from = span?.before[0] ?? prior;
  addSharedTextSource(view, plan, target.owner, from, from + added, target.field);
  return prepared;
}

export function sharedCreatedAttachments(view: SharedPreparationView): { collection: "visuals" | "gallery"; beat: string; html: string | null; record: SharedContentRef }[] {
  return view.scratch("structure-created-attachments", () => []);
}

export function prepareSharedCreatedAttachment(operation: SharedRecordCreate, view: SharedPreparationView): SharedPreparationResult | null {
  const { collection, record } = operation.target, beat = operation.fields.beat;
  if (typeof beat !== "string") return null;
  const created = sharedCreatedAttachments(view).find(entry => entry.collection === collection && entry.beat === sharedStructureReference(view, beat));
  if (!created) return null;
  if (Object.keys(operation.fields).some(field => field !== "beat" && (collection !== "visuals" || field !== "html"))
    || collection === "visuals" && operation.fields.html !== created.html) return { ok: false, reason: "inconsistent-initial-attachment" };
  try {
    if (record !== created.record) {
      if (view.has([collection, record])) return { ok: false, reason: "existing-identity" };
      prepareStructureAlias(view, record, created.record);
    }
  } catch (error) { if (error instanceof SharedStructurePreparationError) return { ok: false, reason: error.message }; throw error; }
  const description = freezeSharedPreparedValue<SharedPreparedWrite[]>([]);
  return { ok: true, writes: description, apply: handle => applySharedMapWrites(handle, description) };
}
