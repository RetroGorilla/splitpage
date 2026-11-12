import { canonicalSharedProjection } from "../../core/collab/projection/canonical.ts";
import { sharedProjectionExtra, projectSharedRegistryFields, projectSharedCommentFields, projectSharedBeatFields } from "../../core/collab/projection/fields.ts";
import { readSharedContentRef } from "../../core/collab/read-operation.ts";
import { withSharedSnapshot } from "./snapshot.ts";
import type { SharedRecordCollection } from "../../core/collab/operations.ts";
import { projectSharedJoinedUnits, projectSharedJoinedFields, projectSharedSections } from "../../core/collab/projection/joins.ts";
import { projectSharedJoinedLayout } from "../../core/collab/projection/join-layout.ts";
import type { SharedProjectionUnit } from "../../core/collab/projection/units.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { DocumentShape } from "../../core/document/validated.ts";
import { projectSharedTextResult, projectSharedCommentAnchors } from "../../core/collab/projection/text.ts";
import type { SharedTagProjectionRejection } from "../../core/collab/projection/tag-extents.ts";
import { SharedProjectionSource } from "./projection-source.ts";
import type { SharedProjectionCache } from "./projection-cache.ts";
import type { SharedProjectionFragmentReason } from "../../core/collab/projection/blocks.ts";
import { applySharedBrollRewrite, assignSharedBrollKeys, readSharedBrollAtoms } from "../../core/collab/projection/broll.ts";
import type { SharedProjectionGalleryOverflow } from "../../core/collab/projection/gallery.ts";
import { readSharedRemovalBufferSources } from "./removal-record.ts";
import type { SharedRemovalBufferSource } from "./removal-record.ts";
import { collabState } from "./state.ts";
import { compareSharedProjections } from "../../core/collab/projection/changes.ts";
import type { SharedProjectionChanges } from "../../core/collab/projection/changes.ts";

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
    | { readonly kind: "removed-beat"; readonly row: Readonly<Record<string, unknown>>; readonly members: readonly string[]; readonly buffer?: readonly SharedRemovalBufferSource[] }
    | { readonly kind: "unprojectable-fragment"; readonly reason: SharedProjectionFragmentReason; readonly owner: string | null; readonly segment: string;
      readonly field: "audioText" | "heading"; readonly from: number; readonly to: number; readonly html: string }
    | { readonly kind: "scene-with-no-beats"; readonly heading: Readonly<Record<string, unknown>>; readonly beforeRowId: string | null }
    | { readonly kind: "removed-heading"; readonly heading: Readonly<Record<string, unknown>> })[];
}

export interface SharedDocumentProjectionStep extends SharedDocumentProjectionResult {
  readonly changes: SharedProjectionChanges;
}

export function projectSharedDocumentWithRecovery(handle: SharedDocumentHandle): SharedDocumentProjectionResult {
  const { document, recovery } = projectSharedDocumentStep(handle, null);
  return { document, recovery };
}

export function projectSharedDocumentStep(handle: SharedDocumentHandle, previous: DocumentShape | null): SharedDocumentProjectionStep {
  return withSharedSnapshot(handle, state => assembleSharedDocument(new SharedProjectionSource(state as unknown as SharedDocumentHandle), previous));
}

type SharedBrollCell = { readonly key: string; readonly units: readonly SharedProjectionUnit[] };

// why: A rebuilt group hands on an equal new narration array; keeping the old one keeps its scan and cell cached.
function projectSharedBrollCells(cache: SharedProjectionCache, cells: readonly SharedBrollCell[], shotIds: readonly string[]): Map<string, readonly SharedProjectionUnit[]> {
  const kept = cells.map(value => ({ key: value.key, units: cache.array(["broll-input", value.key], value.units) }));
  const rewrites = assignSharedBrollKeys(kept.map(value => ({ key: value.key,
    atoms: cache.read(["broll-atoms", value.key], [value.units], () => {
      cache.counted("broll-scan", value.key, value.units.length); return readSharedBrollAtoms(value.units);
    }) })), shotIds);
  return new Map(kept.map((value, at) => {
    const rewrite = rewrites[at];
    return [value.key, !rewrite?.replaced.length ? value.units : cache.read(["broll-cell", value.key],
      [value.units, JSON.stringify(rewrite.replaced.map(entry => [entry.index, entry.unit.value]))], () => applySharedBrollRewrite(value.units, rewrite))];
  }));
}

export function assembleSharedDocument(source: SharedProjectionSource, previous: DocumentShape | null): SharedDocumentProjectionStep {
  source.begin();
  const cache = source.cache;
  const recovery: SharedDocumentProjectionResult["recovery"][number][] = [];
  const fields = assembleSharedDocumentFields(source), out = { ...fields.document };
  const tags = out.productionTags as Record<string, unknown>[], comments = (out.comments as Record<string, unknown>[]).map(comment => ({ ...comment }));
  out.comments = comments;
  Object.assign(out, { title: source.title(), docId: out.docId ?? "", schema: out.schema ?? 2, rev: out.rev ?? 0 });
  const visuals = source.recordGroups("visuals"), gallery = source.records("gallery"), galleryGroups = source.recordGroups("gallery"), anchored = new Set<string>();
  const fragments = source.blocks();
  const blocks = fragments.filter((block): block is typeof block & { id: string } => !block.reason && block.id !== null);
  const narrationByBeat = new Map(blocks.filter(block => block.kind === "b").map(block => [block.id, block.units]));
  function cell(value: readonly SharedProjectionUnit[], rowId: string, field: "audioText" | "visualText", key: string): string {
    const units = value;
    const result = cache.read(["cell", key], [units, tags], () => projectSharedTextResult(units, tags), "cell");
    recovery.push(...result.rejected.map(entry => ({ ...entry, rowId, field })));
    return result.html;
  }
  for (const fragment of fragments) if (fragment.reason) recovery.push({ kind: "unprojectable-fragment", reason: fragment.reason,
    owner: fragment.id, segment: fragment.segment, field: fragment.kind === "h" ? "heading" : "audioText", from: fragment.from, to: fragment.to,
    html: cell(fragment.units, fragment.id ?? fragment.segment, "audioText", JSON.stringify([fragment.segment, fragment.from, fragment.to])) });
  const sourceRows = out.rows as Record<string, unknown>[], byId = new Map(sourceRows.map(row => [String(row.id), row]));
  const order = sourceRows.map(row => String(row.id)), groups = projectSharedJoinedLayout(blocks.filter(block => block.kind === "b"), order.map(id => source.structure(id)));
  const ranks = new Map(order.map((id, index) => [id, index]));
  const rows: Record<string, unknown>[] = [], plans = groups.flatMap(group => {
    const root = byId.get(group.root); if (!root) return [];
    const members = group.members.map(member => member.id), inOrder = [...group.fields].sort((a, b) => (ranks.get(a) ?? 0) - (ranks.get(b) ?? 0));
    const memberRows = inOrder.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
    const memberUnits = group.members.map(member => narrationByBeat.get(member.id));
    const memberVisuals = group.fields.flatMap(id => visuals.get(id) ?? []);
    const visualCells = memberVisuals.map(visual => {
      return { key: JSON.stringify([group.root, "visualText", visual.key]), units: source.units("visuals", visual.key) };
    });
    const relevantGallery = group.fields.flatMap(id => galleryGroups.get(id) ?? []);
    return [cache.read(["group", group.root], [JSON.stringify(group), root, tags, ...memberRows, ...memberUnits,
      ...memberVisuals, ...visualCells.map(cell => cell.units), ...relevantGallery], () => {
      const projected = projectSharedJoinedFields(root, memberRows, gallery);
      const narration = projectSharedJoinedUnits(group.members.map(member => ({ units: narrationByBeat.get(member.id) ?? [], glue: member.glue, ...(member.glueSet ? { glueSet: true as const } : {}) })), tags, group.cyclic);
      return { group, members, ...projected, audio: { key: JSON.stringify([group.root, "audioText"]), units: narration }, visualCells };
    }, "group")];
  });
  const broll = projectSharedBrollCells(cache, plans.filter(plan => !plan.group.removed).flatMap(plan => [...plan.visualCells, plan.audio]),
    (out.brollShots as Record<string, unknown>[]).map(shot => String(shot.id)));
  for (const { group, members, row, overflow, audio, visualCells } of plans) {
    recovery.push(...overflow.map(entry => ({ kind: "gallery-overflow" as const, rowId: group.root, ...entry,
      slot: canonicalSharedProjection(entry.slot, "gallery") as Record<string, unknown> })));
    if (!group.removed) for (const [units, field] of [...visualCells.map(value => [broll.get(value.key) ?? value.units, "visualText"] as const),
      [broll.get(audio.key) ?? audio.units, "audioText"] as const]) projectSharedCommentAnchors(units, comments, group.root, field, anchored);
    const audioText = cell(broll.get(audio.key) ?? audio.units, group.root, "audioText", audio.key);
    const visualText = visualCells.map(value => cell(broll.get(value.key) ?? value.units, group.root, "visualText", value.key)).filter(Boolean).join("<br>");
    const painted = cache.read(["painted-row", group.root], [row, audioText, visualText], () => ({ ...row, audioText, visualText }));
    if (group.removed) {
      const buffer = readSharedRemovalBufferSources(source.roots.beats, source.roots.removalRecords, members, collabState(source.handle).reads);
      recovery.push({ kind: "removed-beat", row: cache.canonical(painted, "row") as Record<string, unknown>, members, ...(buffer.length ? { buffer } : {}) });
    }
    else rows.push(painted);
  }
  const headings = blocks.flatMap<Parameters<typeof projectSharedSections>[0][number]>(block => {
    if (block.kind === "b") return [cache.read(["heading-beat", block.id], [], () => ({ kind: "b" as const, id: block.id }))];
    const extra = source.fields("heading", block.id);
    if (!extra) return [];
    const heading = cache.read(["heading", block.id], [extra, block.units], () => ({ kind: "h" as const, id: block.id,
      name: block.units.map(unit => typeof unit.value === "string" ? unit.value : "").join(""), extra: sharedProjectionExtra(extra) }));
    if (!source.headingRemoved(block.id)) return [heading];
    for (const entry of projectSharedSections([heading], new Set()).empty) recovery.push({ kind: "removed-heading", heading: canonicalSharedProjection(entry.heading, "section") as Record<string, unknown> });
    return [];
  });
  const visible = rows.map(row => String(row.id));
  const { sections, empty } = cache.read(["sections"], [...headings, ...visible], () => projectSharedSections(headings, new Set(visible)));
  recovery.push(...empty.map(entry => ({ kind: "scene-with-no-beats" as const, heading: canonicalSharedProjection(entry.heading, "section") as Record<string, unknown>, beforeRowId: entry.beforeRowId })));
  Object.assign(out, { rows }); if (sections.length) out.sections = sections; else delete out.sections;
  const document = cache.canonical(out) as DocumentShape;
  const changes = compareSharedProjections(previous, document, (kind, key) => cache.counted(kind === "row" ? "compare-row" : "compare-field", key));
  const result = { document, recovery, changes };
  cache.end();
  return result;
}

export function readSharedDocumentFieldProjection(handle: SharedDocumentHandle): SharedDocumentFieldProjection {
  const fields = readNativeDocumentFieldProjection(handle);
  return { document: canonicalSharedProjection(fields.document) as Record<string, unknown>, sections: canonicalSharedProjection(fields.sections, "section") as typeof fields.sections };
}

function readNativeDocumentFieldProjection(handle: SharedDocumentHandle): SharedDocumentFieldProjection {
  return withSharedSnapshot(handle, state => {
    const source = new SharedProjectionSource(state as unknown as SharedDocumentHandle); source.begin();
    return assembleSharedDocumentFields(source);
  });
}

function assembleSharedDocumentFields(source: SharedProjectionSource): SharedDocumentFieldProjection {
  const cache = source.cache;
  const meta = source.fields("document") ?? {}, out = sharedProjectionExtra(meta);
  for (const key of ["docId", "schema", "wordsPerMinute", "targetSeconds", "paragraphsDecided"]) if (Object.hasOwn(meta, key)) out[key] = meta[key];
  for (const key of ["fileTitle", "capture"]) Object.assign(out, meta[key]);
  const records = (collection: SharedRecordCollection) => source.records(collection);
  const people = cache.array(["people"], records("people").map(record => cache.read(["registry", "people", record.key], [record],
    () => projectSharedRegistryFields("people", record.fields))));
  const tags = records("tags").map(record => {
    const id = readSharedContentRef(record.key);
    const status = id ? source.status({ scope: "tag", record: id }) : null;
    return cache.read(["registry", "tags", record.key], [record, status], () => projectSharedRegistryFields("tags", status === null ? record.fields : { ...record.fields, status }));
  });
  const shots = records("shots").map(record => {
    const id = readSharedContentRef(record.key);
    const status = id ? source.status({ scope: "shot", record: id }) : null;
    return cache.read(["registry", "shots", record.key], [record, status], () => projectSharedRegistryFields("shots", status === null ? record.fields : { ...record.fields, status }));
  });
  const replies = records("replies"), comments = records("comments").map(record => cache.read(["comment", record.key], [record, replies], () => projectSharedCommentFields(record.fields, replies)));
  const gallery = records("gallery"), galleryGroups = source.recordGroups("gallery"), rows: Record<string, unknown>[] = [], sections: { id: string; firstSceneId: string }[] = [];
  let heading: string | null = null;
  for (const head of source.blocks(false)) {
    if (head.reason || head.id === null) continue;
    if (head.kind === "h") { heading = source.fields("heading", head.id)?.id === head.id && !source.headingRemoved(head.id) ? head.id : null; continue; }
    const fields = source.fields("beat", head.id), id = readSharedContentRef(head.id);
    if (!fields || fields.id !== head.id || !id) continue;
    const rowId = head.id;
    const relevantGallery = cache.array(["beat-gallery", head.id], galleryGroups.get(head.id) ?? []);
    rows.push(cache.read(["beat-fields", head.id], [fields, source.status({ scope: "beat", record: id }), relevantGallery],
      () => projectSharedBeatFields(rowId, fields, source.status({ scope: "beat", record: id }), gallery), "fields"));
    if (heading) { sections.push({ id: heading, firstSceneId: head.id }); heading = null; }
  }
  Object.assign(out, { rows, comments, people, productionTags: cache.array(["tags"], tags), brollShots: cache.array(["shots"], shots) });
  return { document: out, sections };
}
