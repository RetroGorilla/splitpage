import * as Y from "yjs";
import { canonicalSharedProjection } from "../../core/collab/projection/canonical.ts";
import { sharedProjectionExtra, projectSharedRegistryFields, projectSharedCommentFields, projectSharedBeatFields } from "../../core/collab/projection/fields.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { withSharedSnapshot } from "./snapshot.ts";
import { readSharedRecords } from "./record-reader.ts";
import { readSharedStatus } from "./status.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { readProjectionFields, readProjectionHead } from "./projection-reader.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { DocumentShape } from "../../core/document/validated.ts";
import { projectSharedTextResult, projectSharedCommentAnchors } from "../../core/collab/projection/text.ts";
import type { SharedTagProjectionRejection } from "../../core/collab/projection/tag-extents.ts";
import { readProjectionUnits } from "./projection-text-reader.ts";

export interface SharedDocumentFieldProjection {
  readonly document: Readonly<Record<string, unknown>>;
  readonly sections: readonly { readonly id: string; readonly firstSceneId: string }[];
}

export function projectSharedDocument(handle: SharedDocumentHandle): DocumentShape {
  return projectSharedDocumentWithRecovery(handle).document;
}

export interface SharedDocumentProjectionResult {
  readonly document: DocumentShape;
  readonly recovery: readonly (SharedTagProjectionRejection & { readonly rowId: string; readonly field: "audioText" | "visualText" })[];
}

export function projectSharedDocumentWithRecovery(handle: SharedDocumentHandle): SharedDocumentProjectionResult {
  return withSharedSnapshot(handle, state => {
    const recovery: (SharedTagProjectionRejection & { rowId: string; field: "audioText" | "visualText" })[] = [];
    const copy = state as unknown as SharedDocumentHandle, roots = state.roots;
    const fields = readSharedDocumentFieldProjection(copy), out = { ...fields.document };
    const tags = out.productionTags as Record<string, unknown>[], comments = out.comments as Record<string, unknown>[];
    const title: unknown = roots.meta.get("title");
    Object.assign(out, { title: title instanceof Y.Text ? title.toString() : "", docId: out.docId ?? "", schema: out.schema ?? 2, rev: out.rev ?? 0 });
    const segments = new Map<string, Y.Map<unknown>>();
    for (const key of roots.order.toArray()) {
      if (typeof key !== "string" || !isStableSharedIdentity(key)) continue;
      const segment: unknown = roots.segments.get(key);
      if (!(segment instanceof Y.Map)) continue;
      const head = readProjectionHead(segment.get("head"));
      if (head && !segments.has(head.kind + head.id)) segments.set(head.kind + head.id, segment);
    }
    const visuals = readSharedRecords(copy, "visuals"), anchored = new Set<string>();
    function cell(container: Y.Map<unknown>, rowId: string, field: "audioText" | "visualText"): string {
      const units = readProjectionUnits(copy, container.get("text"), container.get("markRecords"));
      projectSharedCommentAnchors(units, comments, rowId, field, anchored);
      const result = projectSharedTextResult(units, tags);
      recovery.push(...result.rejected.map(entry => ({ ...entry, rowId, field })));
      return result.html;
    }
    const rows = (out.rows as Record<string, unknown>[]).map(row => {
      const id = String(row.id), segment = segments.get("b" + id);
      const audioText = segment ? cell(segment, id, "audioText") : "";
      const visualText = visuals.filter(visual => visual.fields.beat === id).map(visual => {
        const container: unknown = roots.visuals.get(visual.key);
        return container instanceof Y.Map ? cell(container, id, "visualText") : "";
      }).filter(Boolean).join("<br>");
      return { ...row, audioText, visualText };
    });
    const sections = fields.sections.flatMap(section => {
      const segment = segments.get("h" + section.id), extra = readProjectionFields(roots.headings.get(section.id), "heading");
      const text: unknown = segment?.get("text");
      return text instanceof Y.Text && text.toString() ? [{ ...sharedProjectionExtra(extra ?? {}), ...section, name: text.toString() }] : [];
    });
    Object.assign(out, { rows }); if (sections.length) out.sections = sections;
    return { document: canonicalSharedProjection(out) as DocumentShape, recovery };
  });
}

export function readSharedDocumentFieldProjection(handle: SharedDocumentHandle): SharedDocumentFieldProjection {
  return withSharedSnapshot(handle, state => {
    const copy = state as unknown as SharedDocumentHandle, roots = state.roots;
    const meta = readProjectionFields(roots.meta, "document") ?? {}, out = sharedProjectionExtra(meta);
    for (const key of ["docId", "schema", "wordsPerMinute", "targetSeconds", "paragraphsDecided"]) if (Object.hasOwn(meta, key)) out[key] = meta[key];
    for (const key of ["fileTitle", "capture"]) Object.assign(out, meta[key]);
    const records = (collection: Parameters<typeof readSharedRecords>[1]) => readSharedRecords(copy, collection);
    const people = records("people").map(record => projectSharedRegistryFields("people", record.fields));
    const tags = records("tags").map(record => {
      const id = readSharedContentRef(record.key);
      return projectSharedRegistryFields("tags", id ? { ...record.fields, status: readSharedStatus(copy, { scope: "tag", record: id }) } : record.fields);
    });
    const shots = records("shots").map(record => {
      const id = readSharedContentRef(record.key);
      return projectSharedRegistryFields("shots", id ? { ...record.fields, status: readSharedStatus(copy, { scope: "shot", record: id }) } : record.fields);
    });
    const replies = records("replies"), comments = records("comments").map(record => projectSharedCommentFields(record.fields, replies));
    const gallery = records("gallery"), rows: Record<string, unknown>[] = [], sections: { id: string; firstSceneId: string }[] = [];
    const seen = new Set<string>(); let heading: string | null = null;
    for (const key of roots.order.toArray()) {
      if (typeof key !== "string" || !isStableSharedIdentity(key) || seen.has(key)) continue;
      seen.add(key);
      const segment: unknown = roots.segments.get(key);
      if (!(segment instanceof Y.Map)) continue;
      const head = readProjectionHead(segment.get("head"));
      if (!head) continue;
      if (head.kind === "h") { heading = readProjectionFields(roots.headings.get(head.id), "heading")?.id === head.id ? head.id : null; continue; }
      const fields = readProjectionFields(roots.beats.get(head.id), "beat"), id = readSharedContentRef(head.id);
      if (!fields || fields.id !== head.id || !id) continue;
      rows.push(projectSharedBeatFields(head.id, fields, readSharedStatus(copy, { scope: "beat", record: id }), gallery));
      if (heading) { sections.push({ id: heading, firstSceneId: head.id }); heading = null; }
    }
    Object.assign(out, { rows, comments, people, productionTags: tags, brollShots: shots });
    return { document: canonicalSharedProjection(out) as Record<string, unknown>, sections };
  });
}
