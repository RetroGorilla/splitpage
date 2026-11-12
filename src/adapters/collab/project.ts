import * as Y from "yjs";
import { canonicalSharedProjection } from "../../core/collab/projection/canonical.ts";
import { sharedProjectionExtra, projectSharedRegistryFields, projectSharedCommentFields, projectSharedBeatFields } from "../../core/collab/projection/fields.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { withSharedSnapshot } from "./snapshot.ts";
import { readSharedRecords } from "./record-reader.ts";
import { readSharedStatus } from "./status.ts";
import { readProjectionFields, readProjectionBlocks, readProjectionBeatStructure } from "./projection-reader.ts";
import { projectSharedJoinGroups, projectSharedJoinedUnits, projectSharedJoinedFields, projectSharedSections } from "../../core/collab/projection/joins.ts";
import type { SharedProjectionUnit } from "../../core/collab/projection/units.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { DocumentShape } from "../../core/document/validated.ts";
import { projectSharedTextResult, projectSharedCommentAnchors } from "../../core/collab/projection/text.ts";
import type { SharedTagProjectionRejection } from "../../core/collab/projection/tag-extents.ts";
import { readProjectionUnits } from "./projection-text-reader.ts";
import type { SharedProjectionFragmentReason } from "../../core/collab/projection/blocks.ts";
import { projectSharedBrollKeys } from "../../core/collab/projection/broll.ts";
import type { SharedProjectionGalleryOverflow } from "../../core/collab/projection/gallery.ts";

export interface SharedDocumentFieldProjection {
  readonly document: Readonly<Record<string, unknown>>;
  readonly sections: readonly { readonly id: string; readonly firstSceneId: string }[];
}

export function projectSharedDocument(handle: SharedDocumentHandle): DocumentShape {
  return projectSharedDocumentWithRecovery(handle).document;
}

export interface SharedDocumentProjectionResult {
  readonly document: DocumentShape;
  readonly recovery: readonly ((SharedTagProjectionRejection & { readonly rowId: string; readonly field: "audioText" | "visualText" })
    | (SharedProjectionGalleryOverflow & { readonly kind: "gallery-overflow"; readonly rowId: string })
    | { readonly kind: "removed-beat"; readonly row: Readonly<Record<string, unknown>>; readonly members: readonly string[] }
    | { readonly kind: "unprojectable-fragment"; readonly reason: SharedProjectionFragmentReason; readonly owner: string | null; readonly segment: string;
      readonly field: "audioText" | "heading"; readonly from: number; readonly to: number; readonly html: string }
    | { readonly kind: "scene-with-no-beats"; readonly heading: Readonly<Record<string, unknown>>; readonly beforeRowId: string | null })[];
}

export function projectSharedDocumentWithRecovery(handle: SharedDocumentHandle): SharedDocumentProjectionResult {
  return withSharedSnapshot(handle, state => {
    const recovery: SharedDocumentProjectionResult["recovery"][number][] = [];
    const copy = state as unknown as SharedDocumentHandle, roots = state.roots;
    const fields = readNativeDocumentFieldProjection(copy), out = { ...fields.document };
    const tags = out.productionTags as Record<string, unknown>[], comments = out.comments as Record<string, unknown>[];
    const title: unknown = roots.meta.get("title");
    Object.assign(out, { title: title instanceof Y.Text ? title.toString() : "", docId: out.docId ?? "", schema: out.schema ?? 2, rev: out.rev ?? 0 });
    const visuals = readSharedRecords(copy, "visuals"), gallery = readSharedRecords(copy, "gallery"), anchored = new Set<string>();
    function units(container: Y.Map<unknown> | undefined): SharedProjectionUnit[] {
      return container ? readProjectionUnits(copy, container.get("text"), container.get("markRecords")) : [];
    }
    const fragments = readProjectionBlocks(roots.order, roots.segments, roots.beats, units);
    const blocks = fragments.filter((block): block is typeof block & { id: string } => !block.reason && block.id !== null);
    const narrationByBeat = new Map(blocks.filter(block => block.kind === "b").map(block => [block.id, block.units]));
    function cell(value: readonly SharedProjectionUnit[], rowId: string, field: "audioText" | "visualText", visible: boolean): string {
      if (visible) projectSharedCommentAnchors(value, comments, rowId, field, anchored);
      const units = value;
      const result = projectSharedTextResult(units, tags);
      recovery.push(...result.rejected.map(entry => ({ ...entry, rowId, field })));
      return result.html;
    }
    for (const fragment of fragments) if (fragment.reason) recovery.push({ kind: "unprojectable-fragment", reason: fragment.reason,
      owner: fragment.id, segment: fragment.segment, field: fragment.kind === "h" ? "heading" : "audioText", from: fragment.from, to: fragment.to,
      html: cell(fragment.units, fragment.id ?? fragment.segment, "audioText", false) });
    const sourceRows = out.rows as Record<string, unknown>[], byId = new Map(sourceRows.map(row => [String(row.id), row]));
    const order = sourceRows.map(row => String(row.id)), groups = projectSharedJoinGroups(order.map(id => readProjectionBeatStructure(roots.beats.get(id), id, roots.retiredJoins, roots.meta)));
    const rows: Record<string, unknown>[] = [], plans = groups.flatMap(group => {
      const root = byId.get(group.root); if (!root) return [];
      const members = group.members.map(member => member.id), inOrder = order.filter(id => members.includes(id));
      const projected = projectSharedJoinedFields(root, inOrder.flatMap(id => { const row = byId.get(id); return row ? [row] : []; }), gallery);
      const narration = projectSharedJoinedUnits(group.members.map(member => ({ units: narrationByBeat.get(member.id) ?? [], glue: member.glue })), tags, group.cyclic);
      const visualCells = members.flatMap(id => visuals.filter(visual => visual.fields.beat === id)).map(visual => {
        const container: unknown = roots.visuals.get(visual.key);
        return { key: JSON.stringify([group.root, "visualText", visual.key]), units: container instanceof Y.Map ? units(container) : [] };
      });
      return [{ group, members, ...projected, audio: { key: JSON.stringify([group.root, "audioText"]), units: narration }, visualCells }];
    });
    const broll = new Map(projectSharedBrollKeys(plans.filter(plan => !plan.group.removed).flatMap(plan => [...plan.visualCells, plan.audio]),
      (out.brollShots as Record<string, unknown>[]).map(shot => String(shot.id))).map(value => [value.key, value.units]));
    for (const { group, members, row, overflow, audio, visualCells } of plans) {
      recovery.push(...overflow.map(entry => ({ kind: "gallery-overflow" as const, rowId: group.root, ...entry,
        slot: canonicalSharedProjection(entry.slot, "gallery") as Record<string, unknown> })));
      const audioText = cell(broll.get(audio.key) ?? audio.units, group.root, "audioText", !group.removed);
      const visualText = visualCells.map(value => cell(broll.get(value.key) ?? value.units, group.root, "visualText", !group.removed)).filter(Boolean).join("<br>");
      Object.assign(row, { audioText, visualText });
      if (group.removed) recovery.push({ kind: "removed-beat", row: canonicalSharedProjection(row, "row") as Record<string, unknown>, members });
      else rows.push(row);
    }
    const headings = blocks.flatMap<Parameters<typeof projectSharedSections>[0][number]>(block => {
      if (block.kind === "b") return [{ kind: "b", id: block.id }];
      const extra = readProjectionFields(roots.headings.get(block.id), "heading");
      return extra ? [{ kind: "h", id: block.id, name: block.units.map(unit => typeof unit.value === "string" ? unit.value : "").join(""), extra: sharedProjectionExtra(extra) }] : [];
    });
    const { sections, empty } = projectSharedSections(headings, new Set(rows.map(row => String(row.id))));
    recovery.push(...empty.map(entry => ({ kind: "scene-with-no-beats" as const, heading: canonicalSharedProjection(entry.heading, "section") as Record<string, unknown>, beforeRowId: entry.beforeRowId })));
    Object.assign(out, { rows }); if (sections.length) out.sections = sections; else delete out.sections;
    return { document: canonicalSharedProjection(out) as DocumentShape, recovery };
  });
}

export function readSharedDocumentFieldProjection(handle: SharedDocumentHandle): SharedDocumentFieldProjection {
  const fields = readNativeDocumentFieldProjection(handle);
  return { document: canonicalSharedProjection(fields.document) as Record<string, unknown>, sections: canonicalSharedProjection(fields.sections, "section") as typeof fields.sections };
}

function readNativeDocumentFieldProjection(handle: SharedDocumentHandle): SharedDocumentFieldProjection {
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
    let heading: string | null = null;
    for (const head of readProjectionBlocks(roots.order, roots.segments, roots.beats)) {
      if (head.reason || head.id === null) continue;
      if (head.kind === "h") { heading = readProjectionFields(roots.headings.get(head.id), "heading")?.id === head.id ? head.id : null; continue; }
      const fields = readProjectionFields(roots.beats.get(head.id), "beat"), id = readSharedContentRef(head.id);
      if (!fields || fields.id !== head.id || !id) continue;
      rows.push(projectSharedBeatFields(head.id, fields, readSharedStatus(copy, { scope: "beat", record: id }), gallery));
      if (heading) { sections.push({ id: heading, firstSceneId: head.id }); heading = null; }
    }
    Object.assign(out, { rows, comments, people, productionTags: tags, brollShots: shots });
    return { document: out, sections };
  });
}
