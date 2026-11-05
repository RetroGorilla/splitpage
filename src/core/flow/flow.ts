import { findAllMatches, findInCell } from "../text/search.ts";
import { endsSentence } from "../text/sentences.ts";
import { toPlainText } from "../text/projections.ts";
import { MAX_MORE, migrateGallery, rowSlots, setRowSlots, videoLinkKey } from "../document/gallery.ts";
import type { VideoLink } from "../document/gallery.ts";
import { cappedText } from "../document/text-policy.ts";
import { normalizeBeatLength, rowStatusId } from "../document/timing.ts";
import { normalizeScenes, scenesAfterRemoval as removedSceneAnchors, scenesInOrder, withSceneFirstBeat, newScene } from "../document/scenes.ts";
import type { DocumentScene } from "../document/scenes.ts";
import type { DocumentShape } from "../document/validated.ts";
import { breakLine, deleteRange, insertCell, insertText, joinCells, markThroughout, setMark, sliceCell, splitCell } from "../text/edits.ts";
import { toHtml } from "../text/html.ts";
import { cellLength, commentIds, normalizeCell, projection } from "../text/runs.ts";
import type { MarkName, Marks, Run } from "../text/runs.ts";

export const SCENE_NAME_MAX = 200;

export interface FlowRow {
  readonly id: string;
  readonly audioText?: string | null | undefined;
  readonly visualText?: string | null | undefined;
  readonly lengthSeconds?: unknown;
  readonly paragraphStart?: boolean | undefined;
  readonly [key: string]: unknown;
}

export interface FlowComment {
  readonly id: string;
  readonly anchorId?: string | null | undefined;
  readonly rowId?: string | null | undefined;
  readonly field?: string | null | undefined;
}

export interface FlowDoc {
  readonly rows: readonly FlowRow[];
  readonly sections?: unknown;
  readonly comments: readonly FlowComment[];
}

export type FlowPos =
  | { readonly kind: "beat"; readonly rowId: string; readonly offset: number; readonly affinity?: "before" | "after" }
  | { readonly kind: "heading"; readonly sceneId: string; readonly offset: number; readonly affinity?: "before" | "after" };

export interface FlowRange {
  readonly anchor: FlowPos;
  readonly head: FlowPos;
}

export interface FlowSelectionPair {
  readonly before: FlowRange;
  readonly after: FlowRange;
}

export interface FlowPorts {
  readonly cells: (html: string | null | undefined) => readonly Run[];
  readonly newId: () => string;
  readonly hasVisual: (row: FlowRow) => boolean;
}

export interface FlowEdit {
  readonly rows: readonly FlowRow[];
  readonly sections: readonly DocumentScene[] | undefined;
  readonly removedComments: readonly string[];
  readonly selection: FlowRange;
  readonly notice?: string | undefined;
  readonly clipboard?: Pick<DocumentShape, "comments" | "people" | "productionTags" | "brollShots">;
}

export interface FlowRefusal {
  readonly refused: string;
}

export interface FlowMove {
  readonly move: FlowPos;
}

export type FlowOutcome = FlowEdit | FlowRefusal | FlowMove | null;

export type FlowBlock =
  | { readonly kind: "heading"; readonly scene: DocumentScene }
  | { readonly kind: "paragraph"; readonly beats: readonly FlowRow[] };

export function beatPos(rowId: string, offset: number): FlowPos {
  return { kind: "beat", rowId, offset };
}

export function headingPos(sceneId: string, offset: number): FlowPos {
  return { kind: "heading", sceneId, offset };
}

export function caretAt(pos: FlowPos): FlowRange {
  return { anchor: pos, head: pos };
}

function scenesOf(doc: Pick<FlowDoc, "rows" | "sections">): readonly DocumentScene[] {
  const originals = Array.isArray(doc.sections) ? doc.sections as readonly DocumentScene[] : [];
  return (scenesInOrder(doc) ?? []).map(scene => {
    const original = originals.find(item => item?.id === scene.id && item.firstSceneId === scene.firstSceneId);
    return typeof original?.name === "string" ? { ...scene, name: original.name } : scene;
  });
}

function sceneBeforeBeat(doc: Pick<FlowDoc, "rows" | "sections">, rowId: string): DocumentScene | undefined {
  return scenesOf(doc).find(scene => scene.firstSceneId === rowId);
}

function scenesAfterRemoval(doc: Pick<FlowDoc, "rows" | "sections">, removed: ReadonlySet<string>): readonly DocumentScene[] | undefined {
  const names = new Map(scenesOf(doc).map(scene => [scene.id, scene.name]));
  return removedSceneAnchors(doc, removed)?.map(scene => ({ ...scene, name: names.get(scene.id) ?? scene.name }));
}

function sceneAnchors(doc: FlowDoc): Map<string, DocumentScene> {
  return new Map(scenesOf(doc).map(scene => [scene.firstSceneId, scene]));
}

export function flowOf(doc: FlowDoc): FlowBlock[] {
  const anchors = sceneAnchors(doc);
  const blocks: FlowBlock[] = [];
  let beats: FlowRow[] | null = null;
  doc.rows.forEach(function (row, index) {
    const scene = anchors.get(row.id);
    if (scene) {
      blocks.push({ kind: "heading", scene });
      beats = null;
    }
    if (!beats || index === 0 || row.paragraphStart) {
      beats = [];
      blocks.push({ kind: "paragraph", beats });
    }
    beats.push(row);
  });
  return blocks;
}

export function startsParagraph(doc: FlowDoc, index: number): boolean {
  const row = doc.rows[index];
  if (!row) return false;
  return index === 0 || !!row.paragraphStart || !!sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, row.id);
}

function indexOfRow(doc: FlowDoc, rowId: string): number {
  return doc.rows.findIndex(row => row.id === rowId);
}

function orderKey(doc: FlowDoc, pos: FlowPos): [number, number] {
  if (pos.kind === "beat") return [indexOfRow(doc, pos.rowId) * 2 + 1, pos.offset];
  const scene = scenesOf(doc).find(item => item.id === pos.sceneId);
  return [(scene ? indexOfRow(doc, scene.firstSceneId) : -1) * 2, pos.offset];
}

export function comparePos(doc: FlowDoc, a: FlowPos, b: FlowPos): number {
  const ka = orderKey(doc, a), kb = orderKey(doc, b);
  return ka[0] - kb[0] || ka[1] - kb[1];
}

export function orderedRange(doc: FlowDoc, range: FlowRange): { from: FlowPos; to: FlowPos } {
  return comparePos(doc, range.anchor, range.head) <= 0
    ? { from: range.anchor, to: range.head }
    : { from: range.head, to: range.anchor };
}

export function isCollapsed(range: FlowRange): boolean {
  const a = range.anchor, h = range.head;
  if (a.kind !== h.kind || a.offset !== h.offset) return false;
  return a.kind === "beat" ? a.rowId === (h as typeof a).rowId : a.sceneId === (h as typeof a).sceneId;
}

export function withinOneBeat(range: FlowRange): boolean {
  return range.anchor.kind === "beat" && range.head.kind === "beat" && range.anchor.rowId === range.head.rowId;
}

function writeCell(row: FlowRow, cell: readonly Run[]): FlowRow {
  return { ...row, audioText: toHtml(cell) };
}


function withoutFlag(row: FlowRow): FlowRow {
  const next: Record<string, unknown> = { ...row };
  delete next.paragraphStart;
  return next as FlowRow;
}

function withFlag(row: FlowRow): FlowRow {
  return { ...row, paragraphStart: true };
}

function blankRow(id: string, flag: boolean): FlowRow {
  const row: FlowRow = { id, visualText: "", imageRef: null, audioText: "", status: "todo" };
  return flag ? withFlag(row) : row;
}

function isBlank(row: FlowRow, ports: FlowPorts): boolean {
  return cellLength(ports.cells(row.audioText)) === 0 && !ports.hasVisual(row);
}

function edit(doc: FlowDoc, rows: readonly FlowRow[], selection: FlowRange, more?: { sections?: readonly DocumentScene[] | undefined; removedComments?: readonly string[]; notice?: string }): FlowEdit {
  const hasSections = !!more && "sections" in more;
  const sections = hasSections ? more?.sections : scenesOf({ rows, sections: doc.sections });
  return {
    rows,
    sections: hasSections ? sections : sections?.length ? sections : undefined,
    removedComments: more?.removedComments ?? [],
    selection,
    notice: more?.notice
  };
}

function commentsLeftBehind(doc: FlowDoc, removed: ReadonlySet<string>, survivors: readonly FlowRow[], ports: FlowPorts): string[] {
  const gone = new Set(doc.rows.filter(row => removed.has(row.id)).flatMap(row =>
    commentIds(ports.cells(row.audioText)).concat(commentIds(ports.cells(row.visualText)))));
  const kept = new Set(survivors.flatMap(row =>
    commentIds(ports.cells(row.audioText)).concat(commentIds(ports.cells(row.visualText)))));
  return doc.comments.filter(comment => {
    const anchor = comment.anchorId || comment.id;
    return !kept.has(anchor) && (gone.has(anchor) || !!comment.rowId && removed.has(comment.rowId));
  }).map(comment => comment.id);
}

function plural(count: number, word: string): string {
  return count + " " + word + (count === 1 ? "" : "s");
}

function removalNotice(removed: readonly FlowRow[], ports: FlowPorts): string | undefined {
  if (!removed.length) return undefined;
  const visuals = removed.filter(row => ports.hasVisual(row)).length;
  const filmed = removed.filter(row => row.status === "shot").length;
  const details = [visuals ? visuals + " with " + (visuals === 1 ? "a visual" : "visuals") : "", filmed ? filmed + " filmed" : ""].filter(Boolean);
  return "Removed " + plural(removed.length, "beat") + (details.length ? ": " + details.join(", ") : "");
}

type RangeFlowPart =
  | { readonly kind: "heading"; readonly scene: DocumentScene; readonly origin: FlowPos }
  | { readonly kind: "beat"; readonly row: FlowRow; readonly origin: FlowPos };

export function replaceRange(doc: FlowDoc, range: FlowRange, insert: readonly Run[], ports: FlowPorts, removeWholeStart = false): FlowOutcome {
  insert = normalizeCell(insert);
  const { from, to } = orderedRange(doc, range);
  const insertLength = cellLength(insert), insertedName = projection(insert);
  const scenes = scenesOf(doc);
  const headings = new Map(scenes.map(scene => [scene.firstSceneId, scene]));
  const source: RangeFlowPart[] = [];
  for (const row of doc.rows) {
    const scene = headings.get(row.id);
    if (scene) source.push({ kind: "heading", scene, origin: headingPos(scene.id, 0) });
    source.push({ kind: "beat", row, origin: beatPos(row.id, 0) });
  }
  const parts: RangeFlowPart[] = [];
  const removed: FlowRow[] = [];
  const removedHeaders = new Set<string>();
  let replacementRow: FlowRow | undefined;
  for (const part of source) {
    const start = part.origin;
    const length = part.kind === "heading" ? part.scene.name.length : cellLength(ports.cells(part.row.audioText));
    const end = { ...start, offset: length };
    const isFrom = start.kind === from.kind && comparePos(doc, start, { ...from, offset: 0 }) === 0;
    const isTo = start.kind === to.kind && comparePos(doc, start, { ...to, offset: 0 }) === 0;
    const touches = comparePos(doc, from, end) <= 0 && comparePos(doc, start, to) <= 0;
    const exclusiveEmptyEndpoint = part.kind === "beat" && !length && isTo && !isFrom
      && to.offset === 0 && part.row.id !== doc.rows[doc.rows.length - 1]?.id;
    if (!touches || exclusiveEmptyEndpoint) { parts.push(part); continue; }
    const a = isFrom ? from.offset : 0, b = isTo ? to.offset : length;
    const whole = a === 0 && b === length;
    if (part.kind === "heading") {
      const name = part.scene.name.slice(0, a) + (isFrom ? insertedName : "") + part.scene.name.slice(b);
      if (Array.from(name).length > SCENE_NAME_MAX) return { refused: "A scene name can be up to " + SCENE_NAME_MAX + " characters." };
      if (!name.trim()) removedHeaders.add(part.scene.id);
      else parts.push({ ...part, scene: { ...part.scene, name } });
    } else if (whole && !withinOneBeat(range) && (removeWholeStart || !(isFrom && insertLength))) {
      removed.push(part.row);
      if (isFrom && insertLength) {
        replacementRow = writeCell(blankRow(ports.newId(), !!part.row.paragraphStart), insert);
        parts.push({ ...part, row: replacementRow });
      }
    } else {
      const cell = ports.cells(part.row.audioText);
      const left = a < b ? deleteRange(cell, a, b) : cell;
      const next = isFrom && insertLength ? insertCell(left, a, insert).cell : left;
      parts.push({ ...part, row: a < b || isFrom && insertLength ? writeCell(part.row, next) : part.row });
    }
  }
  const kept = new Map(parts.flatMap(part => part.kind === "beat" ? [[part.row.id, part.row] as const] : []));
  for (const block of flowOf(doc)) {
    if (block.kind !== "paragraph") continue;
    const first = block.beats[0] as FlowRow;
    const survivor = block.beats.find(row => kept.has(row.id) || replacementRow && from.kind === "beat" && row.id === from.rowId);
    if (survivor && first.id !== survivor.id && [...kept.keys()].indexOf(survivor.id) > 0) {
      kept.set(survivor.id, withFlag(kept.get(survivor.id) as FlowRow));
    }
  }
  const protectedBreaks = new Set<string>();
  scenes.forEach(function (scene, index) {
    if (!removedHeaders.has(scene.id)) return;
    const first = indexOfRow(doc, scene.firstSceneId);
    const last = scenes[index + 1] ? indexOfRow(doc, (scenes[index + 1] as DocumentScene).firstSceneId) : doc.rows.length;
    const survivor = doc.rows.slice(first, last).find(row => kept.has(row.id));
    if (survivor) {
      kept.set(survivor.id, withFlag(kept.get(survivor.id) as FlowRow));
      protectedBreaks.add(survivor.id);
    }
  });
  if (from.kind === "beat" && to.kind === "beat" && from.rowId !== to.rowId && (kept.has(from.rowId) || replacementRow)) {
    const tail = kept.get(to.rowId);
    const scene = headings.get(to.rowId);
    if (tail && !protectedBreaks.has(tail.id) && (!scene || removedHeaders.has(scene.id))) kept.set(tail.id, withoutFlag(tail));
  }
  const repaired: RangeFlowPart[] = [];
  parts.forEach(function (part, index) {
    repaired.push(part.kind === "beat" ? { ...part, row: kept.get(part.row.id) as FlowRow } : part);
    if (part.kind === "heading" && parts[index + 1]?.kind !== "beat") {
      repaired.push({ kind: "beat", row: blankRow(ports.newId(), false), origin: beatPos(part.scene.firstSceneId, 0) });
    }
  });
  if (!repaired.some(part => part.kind === "beat")) {
    repaired.push({ kind: "beat", row: blankRow(ports.newId(), false), origin: source[0]?.origin ?? from });
  }
  const rows = repaired.flatMap(part => part.kind === "beat" ? [part.row] : []);
  const sections = repaired.flatMap((part, index) => part.kind === "heading"
    ? [withSceneFirstBeat(part.scene, (repaired[index + 1] as { row: FlowRow }).row.id)] : []);
  let caret: FlowPos;
  const firstRow = from.kind === "beat" ? kept.get(from.rowId) ?? replacementRow : undefined;
  const firstHeading = from.kind === "heading" ? sections.find(scene => scene.id === from.sceneId) : undefined;
  if (firstHeading) caret = headingPos(firstHeading.id, from.offset + insertedName.length);
  else if (firstRow) caret = beatPos(firstRow.id, from.offset + insertLength);
  else {
    const next = repaired.find(part => comparePos(doc, part.origin, from) >= 0);
    const last = rows[rows.length - 1] as FlowRow;
    caret = next ? next.kind === "heading" ? headingPos(next.scene.id, 0) : beatPos(next.row.id, 0)
      : beatPos(last.id, cellLength(ports.cells(last.audioText)));
  }
  const notice = removalNotice(removed, ports);
  return edit(doc, rows, caretAt(caret), {
    sections: sections.length ? sections : undefined,
    removedComments: commentsLeftBehind(doc, new Set(removed.map(row => row.id)), rows, ports),
    ...(notice ? { notice } : {})
  });
}

interface MarkSegment {
  readonly rowId: string;
  readonly from: number;
  readonly to: number;
}

function segmentsIn(doc: FlowDoc, range: FlowRange, ports: FlowPorts): MarkSegment[] {
  const { from, to } = orderedRange(doc, range);
  const out: MarkSegment[] = [];
  const startIndex = from.kind === "beat" ? indexOfRow(doc, from.rowId) : indexOfRow(doc, (scenesOf(doc).find(s => s.id === from.sceneId) as DocumentScene).firstSceneId);
  const endIndex = to.kind === "beat" ? indexOfRow(doc, to.rowId) : indexOfRow(doc, (scenesOf(doc).find(s => s.id === to.sceneId) as DocumentScene).firstSceneId) - 1;
  for (let index = startIndex; index <= endIndex; index++) {
    const row = doc.rows[index] as FlowRow;
    const len = cellLength(ports.cells(row.audioText));
    const start = index === startIndex && from.kind === "beat" ? from.offset : 0;
    const end = index === endIndex && to.kind === "beat" ? to.offset : len;
    if (start < end) out.push({ rowId: row.id, from: start, to: end });
  }
  return out;
}

export function setMarkAcross(doc: FlowDoc, range: FlowRange, mark: MarkName, ports: FlowPorts): FlowOutcome {
  const segments = segmentsIn(doc, range, ports);
  if (!segments.length) return null;
  const on = !segments.every(function (segment) {
    const row = doc.rows[indexOfRow(doc, segment.rowId)] as FlowRow;
    return markThroughout(ports.cells(row.audioText), segment.from, segment.to, mark);
  });
  const byRow = new Map(segments.map(segment => [segment.rowId, segment]));
  const rows = doc.rows.map(function (row) {
    const segment = byRow.get(row.id);
    return segment ? writeCell(row, setMark(ports.cells(row.audioText), segment.from, segment.to, mark, on)) : row;
  });
  return edit(doc, rows, range);
}

export function startParagraph(doc: FlowDoc, pos: FlowPos, ports: FlowPorts): FlowOutcome {
  if (pos.kind !== "beat") return null;
  const index = indexOfRow(doc, pos.rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const cell = ports.cells(row.audioText);
  const len = cellLength(cell);
  if (!len && !ports.hasVisual(row)) return null;
  const nextRow = doc.rows[index + 1];
  const nextInParagraph = nextRow && !startsParagraph(doc, index + 1) ? nextRow : null;
  if (pos.offset >= len) {
    if (nextInParagraph) {
      const rows = doc.rows.slice();
      rows[index + 1] = withFlag(nextInParagraph);
      return edit(doc, rows, caretAt(beatPos(nextInParagraph.id, 0)));
    }
    const fresh = blankRow(ports.newId(), true);
    const rows = doc.rows.slice();
    rows.splice(index + 1, 0, fresh);
    return edit(doc, rows, caretAt(beatPos(fresh.id, 0)));
  }
  if (pos.offset === 0) {
    const rows = doc.rows.slice();
    if (!startsParagraph(doc, index)) {
      rows[index] = withFlag(row);
      return edit(doc, rows, caretAt(pos));
    }
    const fresh = blankRow(ports.newId(), !!row.paragraphStart);
    rows[index] = withFlag(row);
    rows.splice(index, 0, fresh);
    const sections = scenesOf(doc).map(scene => scene.firstSceneId === row.id ? withSceneFirstBeat(scene, fresh.id) : scene);
    return edit(doc, rows, caretAt(pos), { sections: sections.length ? sections : undefined });
  }
  return splitBeat(doc, index, pos.offset, true, ports);
}

function splitBeat(doc: FlowDoc, index: number, offset: number, flag: boolean, ports: FlowPorts): FlowEdit {
  const row = doc.rows[index] as FlowRow;
  const halves = splitCell(ports.cells(row.audioText), offset);
  const fresh = writeCell(blankRow(ports.newId(), flag), halves[1]);
  const rows = doc.rows.slice();
  rows[index] = writeCell(row, halves[0]);
  rows.splice(index + 1, 0, fresh);
  return edit(doc, rows, caretAt(beatPos(fresh.id, 0)));
}

export function startBeat(doc: FlowDoc, pos: FlowPos, ports: FlowPorts): FlowOutcome {
  if (pos.kind !== "beat") return null;
  const index = indexOfRow(doc, pos.rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const len = cellLength(ports.cells(row.audioText));
  if (!len) return null;
  if (pos.offset === 0) return null;
  if (pos.offset >= len) {
    const fresh = blankRow(ports.newId(), false);
    const rows = doc.rows.slice();
    rows.splice(index + 1, 0, fresh);
    return edit(doc, rows, caretAt(beatPos(fresh.id, 0)));
  }
  return splitBeat(doc, index, pos.offset, false, ports);
}

function blankAfter(doc: FlowDoc, index: number, ports: FlowPorts): FlowEdit {
  const fresh = blankRow(ports.newId(), false);
  const rows = doc.rows.slice();
  rows.splice(index + 1, 0, fresh);
  return edit(doc, rows, caretAt(beatPos(fresh.id, 0)));
}

function blankBefore(doc: FlowDoc, index: number, pos: FlowPos, ports: FlowPorts): FlowEdit {
  const row = doc.rows[index] as FlowRow;
  const fresh = blankRow(ports.newId(), !!row.paragraphStart);
  const rows = doc.rows.slice();
  rows[index] = withoutFlag(row);
  rows.splice(index, 0, fresh);
  const sections = scenesOf(doc).map(scene => scene.firstSceneId === row.id ? withSceneFirstBeat(scene, fresh.id) : scene);
  return edit(doc, rows, caretAt(pos), { sections: sections.length ? sections : undefined });
}

function enterAtCaret(doc: FlowDoc, pos: FlowPos, ports: FlowPorts): FlowOutcome {
  if (pos.kind !== "beat") return null;
  const index = indexOfRow(doc, pos.rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const len = cellLength(ports.cells(row.audioText));
  if (pos.offset >= len && len) return blankAfter(doc, index, ports);
  if (pos.offset > 0) return splitBeat(doc, index, pos.offset, false, ports);
  if (!len && ports.hasVisual(row)) return blankAfter(doc, index, ports);
  const starts = startsParagraph(doc, index);
  if (len) {
    if (starts) return blankBefore(doc, index, pos, ports);
    const rows = doc.rows.slice();
    rows[index] = withFlag(row);
    return edit(doc, rows, caretAt(pos));
  }
  if (starts) return null;
  const next = doc.rows[index + 1];
  const rows = doc.rows.slice();
  // why: a second Enter between two beats means the text after it starts the paragraph, so no empty beat stays behind
  if (next && !startsParagraph(doc, index + 1)) {
    rows[index + 1] = withFlag(next);
    rows.splice(index, 1);
    return edit(doc, rows, caretAt(beatPos(next.id, 0)));
  }
  rows[index] = withFlag(row);
  return edit(doc, rows, caretAt(pos));
}

export function enterAt(doc: FlowDoc, range: FlowRange, ports: FlowPorts): FlowOutcome {
  if (isCollapsed(range)) return enterAtCaret(doc, range.head, ports);
  const cleared = replaceRange(doc, range, [], ports);
  if (!isEdit(cleared)) return cleared;
  const next = enterAtCaret(afterEdit(doc, cleared), cleared.selection.head, ports);
  return isEdit(next) ? { ...next, removedComments: cleared.removedComments, notice: cleared.notice } : cleared;
}

const STATUS_RANK: Readonly<Record<string, number>> = { todo: 0, ready: 1, shot: 2 };

function statusRank(status: unknown): number {
  return typeof status === "string" ? STATUS_RANK[status] ?? 0 : 0;
}

function joinedPictures(prev: FlowRow, row: FlowRow): ReturnType<typeof rowSlots> {
  const slots: ReturnType<typeof rowSlots> = [];
  for (const slot of rowSlots(prev).concat(rowSlots(row))) {
    const at = slot.ref ? slots.findIndex(item => item.ref?.sha256 === slot.ref?.sha256) : -1;
    const first = slots[at];
    if (!first) { slots.push(slot); continue; }
    const byKey = new Map<string, VideoLink>();
    for (const link of first.links.concat(slot.links)) {
      const key = videoLinkKey(link);
      const kept = byKey.get(key);
      if (!kept) byKey.set(key, { ...link });
      else if (link.poster && !kept.poster) byKey.set(key, { ...kept, poster: true });
    }
    const links = [...byKey.values()];
    slots[at] = { ...first, name: first.name || slot.name, annotation: first.annotation || slot.annotation, links };
  }
  return slots;
}

function joinedVisualText(prev: FlowRow, row: FlowRow, ports: FlowPorts): string {
  const first = prev.visualText ?? "", second = row.visualText ?? "";
  if (!cellLength(ports.cells(second))) return first;
  if (!cellLength(ports.cells(first))) return second;
  // why: joined as stored HTML, so nothing in either visual passes through a decoder and gets lost
  return first + "<br>" + second;
}

export function joinWithPrevious(doc: FlowDoc, rowId: string, ports: FlowPorts): FlowOutcome {
  const index = indexOfRow(doc, rowId);
  const row = doc.rows[index], prev = doc.rows[index - 1];
  if (!row || !prev) return null;
  if (sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, row.id)) return { refused: "A beat can't join across a scene header." };
  const pictures = joinedPictures(prev, row);
  if (pictures.length > MAX_MORE + 1) return { refused: "These beats have too many pictures to join. A beat can hold " + (MAX_MORE + 1) + "." };
  const a = ports.cells(prev.audioText), b = ports.cells(row.audioText);
  const glue = cellLength(a) && cellLength(b) && !/\s$/.test(projection(a)) ? " " : "";
  const merged: Record<string, unknown> = { ...prev, audioText: toHtml(joinCells(a, b, glue)), visualText: joinedVisualText(prev, row, ports) };
  if (rowSlots(row).length) setRowSlots(merged, pictures);
  const beforeGallery = rowSlots(merged);
  migrateGallery(merged, { known: () => null, fromDataUrl: () => null });
  const afterGallery = rowSlots(merged);
  const droppedLinks = beforeGallery.reduce((sum, slot) => sum + slot.links.length, 0) - afterGallery.reduce((sum, slot) => sum + slot.links.length, 0);
  const posterChanges = beforeGallery.some((slot, index) => slot.links.filter(link => link.poster).length > 1
    && afterGallery[index]?.links.filter(link => link.poster).length === 1);
  const galleryNotices: string[] = [];
  if (droppedLinks) galleryNotices.push("Left out " + plural(droppedLinks, "picture link") + " under the saved gallery limits.");
  if (posterChanges) galleryNotices.push("Kept one poster link per picture under the saved gallery limits.");
  if (beforeGallery.length !== afterGallery.length) galleryNotices.push("Removed duplicate or invalid gallery entries under the saved limits.");
  if (beforeGallery.some((slot, index) => slot.name !== afterGallery[index]?.name)) galleryNotices.push("Normalized picture names to the saved limits.");
  if (beforeGallery.some((slot, index) => JSON.stringify(slot.annotation) !== JSON.stringify(afterGallery[index]?.annotation))) galleryNotices.push("Normalized annotation details to the saved limits.");
  if (statusRank(row.status) > statusRank(prev.status)) merged.status = row.status;
  const rows = doc.rows.slice();
  rows.splice(index - 1, 2, merged as FlowRow);
  const bothVisuals = ports.hasVisual(prev) && ports.hasVisual(row);
  const originals = rowSlots(prev).concat(rowSlots(row));
  const duplicateDetails = originals.length > pictures.length
    ? " Combined duplicate pictures and their links; kept the first available name and annotations. Names: " + originals.map(slot => slot.name || "unnamed").join(", ") + "." : "";
  const notice = duplicateDetails || galleryNotices.length ? "Joined the beats." + duplicateDetails + (galleryNotices.length ? " " + galleryNotices.join(" ") : "") : bothVisuals ? "Joined the beats and kept both visuals." : undefined;
  return edit(doc, rows, caretAt(beatPos(prev.id, cellLength(a) + glue.length)), notice ? { notice } : undefined);
}

function removeHeader(doc: FlowDoc, scene: DocumentScene, ports: FlowPorts): FlowEdit {
  const index = indexOfRow(doc, scene.firstSceneId);
  const rows = doc.rows.slice();
  const first = rows[index] as FlowRow;
  rows[index] = withFlag(first);
  const sections = scenesOf(doc).filter(item => item.id !== scene.id);
  if (!scene.name) return edit(doc, rows, caretAt(beatPos(first.id, 0)), { sections: sections.length ? sections : undefined });
  const fresh = writeCell(blankRow(ports.newId(), false), [{ text: scene.name, marks: {} }]);
  rows.splice(index, 0, fresh);
  return edit(doc, rows, caretAt(beatPos(fresh.id, 0)), { sections: sections.length ? sections : undefined });
}

export interface BackspaceOptions {
  readonly tick: "delete" | "join";
}

function removeRow(doc: FlowDoc, index: number, selection: FlowPos): FlowEdit {
  const row = doc.rows[index] as FlowRow;
  const rows = doc.rows.slice();
  rows.splice(index, 1);
  const follower = rows[index];
  if (startsParagraph(doc, index) && follower && !sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, follower.id)) {
    rows[index] = withFlag(follower);
  }
  const sections = scenesAfterRemoval({ rows: doc.rows, sections: doc.sections }, new Set([row.id]));
  return edit(doc, rows, caretAt(selection), { sections });
}

export function backspaceAt(doc: FlowDoc, pos: FlowPos, ports: FlowPorts, options: BackspaceOptions): FlowOutcome {
  if (pos.kind === "heading") {
    if (pos.offset > 0) return null;
    const scene = scenesOf(doc).find(item => item.id === pos.sceneId);
    return scene ? removeHeader(doc, scene, ports) : null;
  }
  if (pos.offset > 0) return null;
  const index = indexOfRow(doc, pos.rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const scene = sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, row.id);
  if (scene) return { move: headingPos(scene.id, scene.name.length) };
  const prev = doc.rows[index - 1];
  if (!prev) return null;
  const prevLength = cellLength(ports.cells(prev.audioText));
  if (isBlank(row, ports)) return removeRow(doc, index, beatPos(prev.id, prevLength));
  if (row.paragraphStart) {
    const rows = doc.rows.slice();
    rows[index] = withoutFlag(row);
    return edit(doc, rows, caretAt(pos));
  }
  if (!prevLength) {
    if (ports.hasVisual(prev)) return { move: beatPos(prev.id, 0) };
    return removeRow(doc, index - 1, pos);
  }
  if (options.tick === "join") return joinWithPrevious(doc, row.id, ports);
  const cell = ports.cells(prev.audioText);
  const rows = doc.rows.slice();
  rows[index - 1] = writeCell(prev, deleteRange(cell, prevLength - 1, prevLength));
  const shorter = cellLength(ports.cells((rows[index - 1] as FlowRow).audioText));
  return edit(doc, rows, caretAt(beatPos(prev.id, shorter)));
}

export function deleteForwardAt(doc: FlowDoc, pos: FlowPos, ports: FlowPorts): FlowOutcome {
  if (pos.kind === "heading") {
    const scene = scenesOf(doc).find(item => item.id === pos.sceneId);
    if (!scene || pos.offset < scene.name.length) return null;
    return { move: beatPos(scene.firstSceneId, 0) };
  }
  const index = indexOfRow(doc, pos.rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const len = cellLength(ports.cells(row.audioText));
  if (pos.offset < len) return null;
  const next = doc.rows[index + 1];
  if (!next) return null;
  const scene = sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, next.id);
  if (scene) return { move: headingPos(scene.id, 0) };
  if (isBlank(row, ports) && next) {
    return removeRow(doc, index, beatPos(next.id, 0));
  }
  if (next.paragraphStart) {
    const rows = doc.rows.slice();
    rows[index + 1] = withoutFlag(next);
    return edit(doc, rows, caretAt(pos));
  }
  if (isBlank(next, ports)) return removeRow(doc, index + 1, pos);
  const cell = ports.cells(next.audioText);
  if (!cellLength(cell)) return { move: beatPos(next.id, 0) };
  const rows = doc.rows.slice();
  rows[index + 1] = writeCell(next, deleteRange(cell, 0, 1));
  return edit(doc, rows, caretAt(pos));
}

export function renameHeading(doc: FlowDoc, sceneId: string, name: string, caret: number): FlowOutcome {
  if (!cappedText(name, SCENE_NAME_MAX)) return null;
  if (Array.from(name).length > SCENE_NAME_MAX) return { refused: "A scene name can be up to " + SCENE_NAME_MAX + " characters." };
  const sections = scenesOf(doc).map(item => item.id === sceneId ? { ...item, name } : item);
  return edit(doc, doc.rows, caretAt(headingPos(sceneId, caret)), { sections });
}

export function enterInHeading(doc: FlowDoc, pos: FlowPos, ports: FlowPorts): FlowOutcome {
  if (pos.kind !== "heading") return null;
  const scene = scenesOf(doc).find(item => item.id === pos.sceneId);
  if (!scene) return null;
  const head = scene.name.slice(0, pos.offset), tail = scene.name.slice(pos.offset);
  if (!tail) return { move: beatPos(scene.firstSceneId, 0) };
  if (!head) return { move: beatPos(scene.firstSceneId, 0) };
  const index = indexOfRow(doc, scene.firstSceneId);
  const fresh = writeCell(blankRow(ports.newId(), false), [{ text: tail, marks: {} }]);
  const rows = doc.rows.slice();
  rows[index] = withFlag(rows[index] as FlowRow);
  rows.splice(index, 0, fresh);
  const sections = scenesOf(doc).map(item => item.id === scene.id ? { ...withSceneFirstBeat(item, fresh.id), name: head } : item);
  return edit(doc, rows, caretAt(beatPos(fresh.id, 0)), { sections });
}

export const HEADING_MARKER = "# ";

export function isPendingHeading(doc: FlowDoc, rowId: string, ports: FlowPorts): boolean {
  const index = indexOfRow(doc, rowId);
  const row = doc.rows[index];
  if (!row || !startsParagraph(doc, index)) return false;
  return projection(ports.cells(row.audioText)).startsWith(HEADING_MARKER);
}

function withoutMarker(doc: FlowDoc, index: number, ports: FlowPorts, selection: FlowRange, notice?: string): FlowEdit {
  const row = doc.rows[index] as FlowRow;
  const rows = doc.rows.slice();
  rows[index] = writeCell(row, deleteRange(ports.cells(row.audioText), 0, HEADING_MARKER.length));
  return edit(doc, rows, selection, notice ? { notice } : undefined);
}

export function finalizeHeading(doc: FlowDoc, rowId: string, enterAt: number | null, keep: FlowRange | null, ports: FlowPorts): FlowOutcome {
  const index = indexOfRow(doc, rowId);
  const row = doc.rows[index];
  if (!row || !isPendingHeading(doc, rowId, ports)) return null;
  const cell = ports.cells(row.audioText);
  const text = projection(cell);
  const lineEnd = text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
  const end = enterAt === null ? lineEnd : Math.min(enterAt, lineEnd);
  const name = text.slice(HEADING_MARKER.length, end).trim();
  const fallback = keep ?? caretAt(beatPos(row.id, Math.max(0, (enterAt ?? text.length) - HEADING_MARKER.length)));
  if (!name) return withoutMarker(doc, index, ports, fallback);
  const follower = doc.rows[index + 1];
  const anchors = sceneAnchors(doc);
  const hasRunOn = !!follower && !startsParagraph(doc, index + 1);
  if (enterAt === null && hasRunOn) {
    return withoutMarker(doc, index, ports, fallback, "A scene header can't hold several beats. Press Enter after the header's words.");
  }
  if (Array.from(name).length > SCENE_NAME_MAX) {
    return withoutMarker(doc, index, ports, fallback, "A scene name can be up to " + SCENE_NAME_MAX + " characters, so this stays as narration.");
  }
  const restStart = end < text.length && text[end] === "\n" ? end + 1 : end;
  const rest = sliceCell(cell, restStart);
  const rows = doc.rows.slice();
  const existing = anchors.get(row.id);
  let first: FlowRow;
  const removeBeat = !cellLength(rest) && !ports.hasVisual(row) && !!follower && !anchors.has(follower.id) && !existing;
  if (removeBeat) {
    rows.splice(index, 1);
    first = withoutFlag(follower as FlowRow);
    rows[index] = first;
  } else {
    first = withoutFlag(writeCell(row, rest));
    rows[index] = first;
  }
  const scenes = scenesOf(doc).slice();
  const fresh = newScene(ports.newId(), name, first.id);
  if (existing) {
    const stale = scenes.findIndex(item => item.id === existing.id);
    const blank = blankRow(ports.newId(), false);
    rows.splice(index, 0, blank);
    scenes[stale] = withSceneFirstBeat(existing, blank.id);
  }
  scenes.push(fresh);
  const sections = scenesOf({ rows, sections: scenes });
  const selection = keep ?? caretAt(beatPos(first.id, 0));
  return edit(doc, rows, selection, { sections });
}

const INLINE_RULES: readonly { readonly marker: string; readonly mark: MarkName }[] = [
  { marker: "**", mark: "b" },
  { marker: "~~", mark: "s" },
  { marker: "*", mark: "i" }
];

export interface InlineMarkdown {
  readonly cell: Run[];
  readonly caret: number;
  readonly mark: MarkName;
}

export function inlineMarkdown(cell: readonly Run[], caret: number): InlineMarkdown | null {
  const text = projection(cell);
  for (const rule of INLINE_RULES) {
    const size = rule.marker.length;
    if (text.slice(caret - size, caret) !== rule.marker) continue;
    const line = text.lastIndexOf("\n", caret - 1) + 1;
    const open = text.lastIndexOf(rule.marker, caret - size - 1);
    if (open < line) continue;
    const inner = text.slice(open + size, caret - size);
    if (!inner || /^\s|\s$/.test(inner)) continue;
    if (size === 1 && (text[open - 1] === "*" || text[caret] === "*" || text[caret - 2] === "*" || inner.includes("*"))) continue;
    if (size === 2 && inner.includes(rule.marker)) continue;
    let next = deleteRange(cell, caret - size, caret);
    next = deleteRange(next, open, open + size);
    next = setMark(next, open, open + inner.length, rule.mark, true);
    return { cell: next, caret: open + inner.length, mark: rule.mark };
  }
  return null;
}

export interface FlowMatch {
  readonly range: FlowRange;
}

interface LogicalSpan {
  readonly rowId: string;
  readonly start: number;
  readonly length: number;
  readonly gapBefore: boolean;
}

function logicalParagraph(beats: readonly FlowRow[], ports: FlowPorts): { text: string; spans: LogicalSpan[]; cell: Run[] } {
  let text = "";
  const spans: LogicalSpan[] = [];
  const cell: Run[] = [];
  beats.forEach(function (row) {
    const runs = ports.cells(row.audioText);
    const piece = projection(runs);
    const gap = !!text && !!piece && !/\s$/.test(text) && !/^\s/.test(piece);
    if (gap) { text += " "; cell.push({ text: " ", marks: {} }); }
    cell.push(...runs);
    spans.push({ rowId: row.id, start: text.length, length: piece.length, gapBefore: gap });
    text += piece;
  });
  return { text, spans, cell };
}

function logicalPos(spans: readonly LogicalSpan[], at: number, end: boolean): FlowPos | null {
  for (const span of spans) {
    if (end ? at <= span.start + span.length && at > span.start : at >= span.start && at < span.start + span.length) {
      return beatPos(span.rowId, at - span.start);
    }
  }
  return null;
}

export function logicalText(doc: FlowDoc, range: FlowRange, ports: FlowPorts): string {
  const { from, to } = orderedRange(doc, range);
  const blocks = flowOf(doc);
  const lines: string[] = [];
  const fromKey = orderKey(doc, from), toKey = orderKey(doc, to);
  function inside(key: [number, number]): boolean {
    return key[0] > fromKey[0] && key[0] < toKey[0];
  }
  blocks.forEach(function (block) {
    if (block.kind === "heading") {
      const key = orderKey(doc, headingPos(block.scene.id, 0));
      const same = (pos: FlowPos) => pos.kind === "heading" && pos.sceneId === block.scene.id;
      if (same(from) || same(to)) {
        lines.push(block.scene.name.slice(same(from) ? from.offset : 0, same(to) ? to.offset : block.scene.name.length));
      } else if (inside(key)) {
        lines.push(block.scene.name);
      }
      return;
    }
    const logical = logicalParagraph(block.beats, ports);
    const first = logical.spans[0], last = logical.spans[logical.spans.length - 1];
    if (!first || !last) return;
    const start = from.kind === "beat" ? logical.spans.find(span => span.rowId === from.rowId) : undefined;
    const end = to.kind === "beat" ? logical.spans.find(span => span.rowId === to.rowId) : undefined;
    const intersects = start || end || block.beats.some(row => inside(orderKey(doc, beatPos(row.id, 0))));
    if (!intersects) return;
    const line = logical.text.slice(start ? start.start + from.offset : 0, end ? end.start + to.offset : logical.text.length);
    if (line) lines.push(line);
  });
  return lines.join("\n\n");
}

export function findInFlow(doc: FlowDoc, needle: string, matchCase: boolean, ports: FlowPorts): FlowMatch[] {
  const out: FlowMatch[] = [];
  if (!needle) return out;
  flowOf(doc).forEach(function (block) {
    if (block.kind === "heading") {
      findAllMatches(block.scene.name, needle, matchCase).forEach(function (match) {
        out.push({ range: { anchor: headingPos(block.scene.id, match.start), head: headingPos(block.scene.id, match.end) } });
      });
      return;
    }
    const logical = logicalParagraph(block.beats, ports);
    findInCell(logical.cell, needle, matchCase).forEach(function (match) {
      const anchor = logicalPos(logical.spans, match.from, false);
      const head = logicalPos(logical.spans, match.to, true);
      if (anchor && head) out.push({ range: { anchor, head } });
    });
  });
  return out;
}

export function replaceMatch(doc: FlowDoc, range: FlowRange, text: string, ports: FlowPorts): FlowOutcome {
  const { from, to } = orderedRange(doc, range);
  if (from.kind === "heading" || to.kind === "heading") return replaceRange(doc, range, text ? [{ text, marks: {} }] : [], ports);
  const start = indexOfRow(doc, from.rowId), end = indexOfRow(doc, to.rowId);
  const rows = doc.rows.slice();
  for (let index = start; index <= end; index++) {
    const row = rows[index] as FlowRow;
    const cell = ports.cells(row.audioText);
    const a = index === start ? from.offset : 0;
    const b = index === end ? to.offset : cellLength(cell);
    const left = deleteRange(cell, a, b);
    rows[index] = writeCell(row, index === start && text ? insertCell(left, a, [{ text, marks: {} }]).cell : left);
  }
  return edit(doc, rows, caretAt(beatPos(from.rowId, from.offset + text.length)));
}

export function normalizedSections(value: unknown): readonly DocumentScene[] | undefined {
  return normalizeScenes(value);
}

export function stepFrom(doc: FlowDoc, rowId: string, forward: boolean, ports: FlowPorts): FlowPos | null {
  const index = indexOfRow(doc, rowId);
  const shape = { rows: doc.rows, sections: doc.sections };
  if (forward) {
    const next = doc.rows[index + 1];
    if (!next) return null;
    const scene = sceneBeforeBeat(shape, next.id);
    return scene ? headingPos(scene.id, 0) : beatPos(next.id, 0);
  }
  const scene = sceneBeforeBeat(shape, rowId);
  if (scene) return headingPos(scene.id, scene.name.length);
  const prev = doc.rows[index - 1];
  return prev ? beatPos(prev.id, cellLength(ports.cells(prev.audioText))) : null;
}

function isEdit(outcome: FlowOutcome): outcome is FlowEdit {
  return !!outcome && "rows" in outcome;
}

function afterEdit(doc: FlowDoc, result: FlowEdit): FlowDoc {
  const removed = new Set(result.removedComments);
  return { rows: result.rows, sections: result.sections, comments: doc.comments.filter(comment => !removed.has(comment.id)) };
}

export function lineBreakAt(doc: FlowDoc, range: FlowRange, ports: FlowPorts): FlowOutcome {
  if (!isCollapsed(range)) {
    return replaceRange(doc, range, [{ text: "\n", marks: {} }], ports);
  }
  const pos = range.head;
  if (pos.kind !== "beat") return null;
  const index = indexOfRow(doc, pos.rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const made = breakLine(ports.cells(row.audioText), pos.offset, pos.offset);
  const rows = doc.rows.slice();
  rows[index] = writeCell(row, made.cell);
  return edit(doc, rows, caretAt(beatPos(row.id, made.pos)));
}

export function pasteText(doc: FlowDoc, range: FlowRange, paragraphs: readonly string[], ports: FlowPorts): FlowOutcome {
  const first = paragraphs[0] ?? "";
  let result = replaceRange(doc, range, first ? [{ text: first, marks: {} }] : [], ports);
  if (!isEdit(result)) return result;
  let current = afterEdit(doc, result);
  const removedComments = result.removedComments;
  const notice = result.notice;
  for (const piece of paragraphs.slice(1)) {
    const pos = result.selection.head;
    const broke = pos.kind === "beat" ? splitBeat(current, indexOfRow(current, pos.rowId), pos.offset, true, ports)
      : insertBeats(current, pos, [blankRow(ports.newId(), true)], ports);
    if (!isEdit(broke)) return result;
    const placed = replaceRange(afterEdit(current, broke), broke.selection, piece ? [{ text: piece, marks: {} }] : [], ports);
    if (!isEdit(placed)) return broke;
    result = placed;
    current = afterEdit(current, placed);
  }
  return { ...result, removedComments, notice };
}

export function typeWithMarks(doc: FlowDoc, pos: FlowPos, text: string, marks: Marks, ports: FlowPorts): FlowOutcome {
  text = text.replace(/\u200b/g, "");
  if (pos.kind !== "beat") return null;
  const index = indexOfRow(doc, pos.rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const rows = doc.rows.slice();
  rows[index] = writeCell(row, insertText(ports.cells(row.audioText), pos.offset, text, marks));
  return edit(doc, rows, caretAt(beatPos(row.id, pos.offset + text.length)));
}

export function selectionToOwnBeat(doc: FlowDoc, range: FlowRange, ports: FlowPorts): FlowOutcome {
  if (!withinOneBeat(range) || isCollapsed(range)) return null;
  const { from, to } = orderedRange(doc, range);
  if (from.kind !== "beat" || to.kind !== "beat") return null;
  const index = indexOfRow(doc, from.rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const cell = ports.cells(row.audioText);
  const len = cellLength(cell);
  if (from.offset === 0 && to.offset === len) return edit(doc, doc.rows, range);
  const before = sliceCell(cell, 0, from.offset), middle = sliceCell(cell, from.offset, to.offset), after = sliceCell(cell, to.offset);
  const chosen = writeCell(blankRow(ports.newId(), false), middle);
  const pieces: FlowRow[] = [];
  if (before.length) {
    pieces.push(writeCell(row, before), chosen);
    if (after.length) pieces.push(writeCell(blankRow(ports.newId(), false), after));
  } else {
    pieces.push({ ...chosen, ...(row.paragraphStart ? { paragraphStart: true } : {}) }, withoutFlag(writeCell(row, after)));
  }
  const rows = doc.rows.slice();
  rows.splice(index, 1, ...pieces);
  const first = pieces[0] as FlowRow;
  const sections = first.id === row.id ? scenesOf(doc) : scenesOf(doc).map(scene => scene.firstSceneId === row.id ? withSceneFirstBeat(scene, first.id) : scene);
  return edit(doc, rows, { anchor: beatPos(chosen.id, 0), head: beatPos(chosen.id, cellLength(middle)) }, { sections: sections.length ? sections : undefined });
}

export function replaceAll(doc: FlowDoc, needle: string, text: string, matchCase: boolean, ports: FlowPorts): FlowOutcome {
  let current = doc;
  let last: FlowEdit | null = null;
  const matches = findInFlow(doc, needle, matchCase, ports);
  for (let index = matches.length - 1; index >= 0; index--) {
    const result = replaceMatch(current, (matches[index] as FlowMatch).range, text, ports);
    if (result && "refused" in result) return result;
    if (isEdit(result)) {
      last = result;
      current = afterEdit(current, result);
    }
  }
  return last ? { ...last, notice: "Replaced " + matches.length + (matches.length === 1 ? " match" : " matches") } : null;
}

export function sentenceParagraphs(doc: FlowDoc, ports: FlowPorts): readonly FlowRow[] {
  if (doc.rows.some(row => row.paragraphStart)) return doc.rows;
  return doc.rows.map(function (row, index) {
    const previous = doc.rows[index - 1];
    return previous && !startsParagraph(doc, index) && endsSentence(toPlainText(ports.cells(previous.audioText)))
      ? withFlag(row) : row;
  });
}

export function insertBeats(doc: FlowDoc, pos: FlowPos, beats: readonly FlowRow[], ports: FlowPorts): FlowOutcome {
  if (!beats.length) return null;
  const ids = new Set(doc.rows.map(row => row.id));
  for (const row of beats) {
    if (ids.has(row.id)) return { refused: "Inserted beats need distinct row ids." };
    ids.add(row.id);
  }
  let rows = doc.rows.slice();
  let sections = scenesOf(doc);
  let index: number;
  let boundary: boolean;
  if (pos.kind === "heading") {
    const scene = sections.find(item => item.id === pos.sceneId);
    if (!scene) return null;
    index = indexOfRow(doc, scene.firstSceneId);
    boundary = true;
    if (pos.offset > 0) {
      rows[index] = withFlag(rows[index] as FlowRow);
      const tail = scene.name.slice(pos.offset);
      if (tail) rows.splice(index, 0, writeCell(blankRow(ports.newId(), false), [{ text: tail, marks: {} }]));
      sections = sections.map(item => item.id === scene.id
        ? { ...withSceneFirstBeat(item, (beats[0] as FlowRow).id), name: scene.name.slice(0, pos.offset) } : item);
    }
  } else {
    index = indexOfRow(doc, pos.rowId);
    const row = rows[index];
    if (!row) return null;
    const length = cellLength(ports.cells(row.audioText));
    boundary = pos.offset === 0 ? startsParagraph(doc, index)
      : pos.offset === length && (!rows[index + 1] || startsParagraph(doc, index + 1));
    if (pos.offset > 0 && pos.offset < length) {
      const halves = splitCell(ports.cells(row.audioText), pos.offset);
      rows[index] = writeCell(row, halves[0]);
      rows.splice(index + 1, 0, writeCell(blankRow(ports.newId(), false), halves[1]));
      index++;
    } else if (pos.offset > 0 || (length === 0 && pos.affinity === "after")) {
      index++;
    } else {
      sections = sections.map(scene => scene.firstSceneId === row.id ? withSceneFirstBeat(scene, (beats[0] as FlowRow).id) : scene);
      if (boundary) rows[index] = withFlag(row);
    }
  }
  const placed: FlowRow[] = beats.map(row => {
    const copy: Record<string, unknown> = { ...blankRow(row.id, false), ...(row.paragraphStart === true ? row : withoutFlag(row)),
      audioText: toHtml(ports.cells(row.audioText)), visualText: row.visualText ?? "", imageRef: row.imageRef ?? null, status: rowStatusId(row.status) ?? "todo" };
    const length = normalizeBeatLength(row.lengthSeconds);
    if (length === undefined) delete copy.lengthSeconds; else copy.lengthSeconds = length;
    return copy as FlowRow;
  });
  placed[0] = boundary ? withFlag(placed[0] as FlowRow) : withoutFlag(placed[0] as FlowRow);
  rows.splice(index, 0, ...placed);
  rows = rows.slice();
  const first = placed[0] as FlowRow, last = placed[placed.length - 1] as FlowRow;
  return edit(doc, rows, { anchor: beatPos(first.id, 0), head: beatPos(last.id, cellLength(ports.cells(last.audioText))) },
    { sections: sections.length ? sections : undefined });
}

export function moveBeats(doc: FlowDoc, rowIds: readonly string[], pos: FlowPos, ports: FlowPorts): FlowOutcome {
  const wanted = new Set(rowIds);
  if (!wanted.size || (pos.kind === "beat" && wanted.has(pos.rowId))) return null;
  const beats = doc.rows.filter(row => wanted.has(row.id));
  if (beats.length !== wanted.size) return null;
  const firstIndex = indexOfRow(doc, (beats[0] as FlowRow).id);
  const lastIndex = indexOfRow(doc, (beats[beats.length - 1] as FlowRow).id);
  if (lastIndex - firstIndex + 1 !== beats.length) return { refused: "Move consecutive beats together." };
  const rows = doc.rows.filter(row => !wanted.has(row.id));
  const follower = rows[firstIndex];
  const movedStart = beats.some((_, offset) => startsParagraph(doc, firstIndex + offset));
  if (follower && movedStart && !startsParagraph(doc, lastIndex + 1)) rows[firstIndex] = withFlag(follower);
  const sections = scenesAfterRemoval({ rows: doc.rows, sections: doc.sections }, wanted);
  const detached: FlowDoc = { ...doc, rows, sections };
  return insertBeats(detached, pos, beats, ports);
}

export interface FlowClipboardSlice {
  readonly text: string;
  readonly rows: readonly FlowRow[];
  readonly wholeIds: readonly string[];
  readonly headers: readonly { readonly index: number; readonly scene: DocumentScene }[];
}

export function copyFlowRange(doc: FlowDoc, range: FlowRange, ports: FlowPorts): FlowClipboardSlice {
  const rows: FlowRow[] = [], wholeIds: string[] = [], headers: { index: number; scene: DocumentScene }[] = [];
  const { from, to } = orderedRange(doc, range);
  if (!isCollapsed(range)) {
    for (const block of flowOf(doc)) {
      if (block.kind === "heading") {
        const start = { kind: "heading", sceneId: block.scene.id, offset: 0 } as const;
        const end = { ...start, offset: block.scene.name.length };
        if (comparePos(doc, from, start) <= 0 && comparePos(doc, to, end) >= 0) {
          headers.push({ index: rows.length, scene: block.scene });
        } else if (comparePos(doc, from, end) < 0 && comparePos(doc, to, start) > 0) {
          const text = block.scene.name.slice(from.kind === "heading" && from.sceneId === block.scene.id ? from.offset : 0,
            to.kind === "heading" && to.sceneId === block.scene.id ? to.offset : undefined);
          rows.push({ ...blankRow(ports.newId(), false), audioText: toHtml([{ text, marks: {} }]) });
        }
        continue;
      }
      for (const row of block.beats) {
        const cell = ports.cells(row.audioText), length = cellLength(cell);
        const start = beatPos(row.id, 0), end = beatPos(row.id, length);
        if (comparePos(doc, from, end) > 0 || comparePos(doc, to, start) < 0) continue;
        const atStart = from.kind === "beat" && from.rowId === row.id;
        const atEnd = to.kind === "beat" && to.rowId === row.id;
        if (!length && atEnd && !atStart && row.id !== doc.rows.at(-1)?.id) continue;
        const a = atStart ? from.offset : 0, b = atEnd ? to.offset : length;
        if (a === b && length) continue;
        const whole = !withinOneBeat(range) && a === 0 && b === length;
        if (whole) wholeIds.push(row.id);
        const piece = whole ? row : { ...blankRow(row.id, false), audioText: toHtml(sliceCell(cell, a, b)) };
        rows.push(rows.length && row.id === block.beats[0]?.id ? { ...piece, paragraphStart: true } : piece);
      }
    }
  }
  return { text: logicalText(doc, range, ports), rows, wholeIds, headers };
}

export function pasteFlowRange(doc: FlowDoc, range: FlowRange, clip: FlowClipboardSlice, ports: FlowPorts): FlowOutcome {
  if (!clip.wholeIds.length && !clip.headers.length) {
    return replaceRange(doc, range, clip.text ? [{ text: clip.text, marks: {} }] : [], ports);
  }
  const cleared = isCollapsed(range) ? null : replaceRange(doc, range, [], ports);
  if (cleared && !("rows" in cleared)) return cleared;
  const candidate = cleared?.rows.length === 1 && !cleared.sections?.length ? cleared.rows[0] : undefined;
  const generatedPlaceholder = candidate && !doc.rows.some(row => row.id === candidate.id) ? candidate.id : null;
  const current = cleared ? { ...doc, rows: cleared.rows, sections: cleared.sections } : doc;
  const at = cleared?.selection ?? range;
  const marker = blankRow(ports.newId(), false);
  const beats = clip.rows.length ? clip.rows : [marker];
  const inserted = insertBeats(current, at.head, beats, ports);
  if (!inserted || !("rows" in inserted)) return inserted;
  const rows = inserted.rows.filter(row => row.id !== generatedPlaceholder);
  const index = rows.findIndex(row => row.id === beats[0]?.id);
  const sections = inserted.sections?.slice() ?? [];
  const originalAnchors = new Map(flowOf(current).flatMap(block => block.kind === "heading" ? [[block.scene.id, block.scene.firstSceneId]] : []));
  let insertionIndex = index;
  if (!clip.rows.length) {
    rows.splice(index, 1);
    for (let i = 0; i < sections.length; i++) {
      const scene = sections[i] as DocumentScene;
      if (scene.firstSceneId !== marker.id) continue;
      const blank = blankRow(ports.newId(), false);
      rows.splice(index, 0, blank);
      sections[i] = { ...scene, firstSceneId: blank.id };
      insertionIndex++;
    }
  }
  const anchors = clip.headers.map(header => ({ header, id: rows[insertionIndex + header.index]?.id }));
  for (const { header, id } of anchors) {
    const offset = id ? rows.findIndex(row => row.id === id) : rows.length;
    if (!rows[offset]) rows.push(blankRow(ports.newId(), false));
    let first = rows[offset] as FlowRow;
    const existing = sections.find(scene => scene.firstSceneId === first.id);
    if (existing) {
      const blank = blankRow(ports.newId(), false);
      rows.splice(offset, 0, blank);
      if (originalAnchors.get(existing.id) !== first.id) sections[sections.indexOf(existing)] = { ...existing, firstSceneId: blank.id };
      else first = blank;
    }
    sections.push({ ...header.scene, id: ports.newId(), firstSceneId: first.id });
  }
  const last = rows.find(row => row.id === sections.at(-1)?.firstSceneId) ?? rows.at(-1) as FlowRow;
  const positions = new Map(rows.map((row, offset) => [row.id, offset]));
  sections.sort((a, b) => (positions.get(a.firstSceneId) ?? 0) - (positions.get(b.firstSceneId) ?? 0));
  return { ...inserted, rows, sections: sections.length ? sections : undefined,
    removedComments: cleared?.removedComments ?? [], notice: cleared?.notice,
    selection: clip.rows.length ? inserted.selection : caretAt(beatPos(last.id, 0)) };
}
