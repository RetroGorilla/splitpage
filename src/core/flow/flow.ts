import { normalizeScenes, sceneBeforeBeat, scenesAfterRemoval, scenesInOrder, withSceneFirstBeat, newScene } from "../document/scenes.ts";
import type { DocumentScene } from "../document/scenes.ts";
import { breakLine, deleteRange, explode, insertCell, insertText, joinCells, markThroughout, setMark, sliceCell, splitCell } from "../text/edits.ts";
import { toHtml } from "../text/html.ts";
import { OBJ, cellLength, commentIds, projection } from "../text/runs.ts";
import type { MarkName, Marks, Run } from "../text/runs.ts";

export const SCENE_NAME_MAX = 200;

export interface FlowRow {
  readonly id: string;
  readonly audioText?: string | null | undefined;
  readonly visualText?: string | null | undefined;
  readonly paragraphStart?: boolean | undefined;
  readonly [key: string]: unknown;
}

export interface FlowComment {
  readonly id: string;
  readonly rowId?: string | null | undefined;
  readonly field?: string | null | undefined;
}

export interface FlowDoc {
  readonly rows: readonly FlowRow[];
  readonly sections?: unknown;
  readonly comments: readonly FlowComment[];
}

export type FlowPos =
  | { readonly kind: "beat"; readonly rowId: string; readonly offset: number }
  | { readonly kind: "heading"; readonly sceneId: string; readonly offset: number };

export interface FlowRange {
  readonly anchor: FlowPos;
  readonly head: FlowPos;
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

function scenesOf(doc: FlowDoc): readonly DocumentScene[] {
  return scenesInOrder({ rows: doc.rows, sections: doc.sections }) ?? [];
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
  return {
    rows,
    sections: hasSections ? (more as { sections?: readonly DocumentScene[] | undefined }).sections : scenesInOrder({ rows, sections: doc.sections }),
    removedComments: more?.removedComments ?? [],
    selection,
    notice: more?.notice
  };
}

function commentsLeftBehind(doc: FlowDoc, removed: ReadonlySet<string>, survivors: readonly FlowRow[], ports: FlowPorts): string[] {
  const wanted = new Set<string>();
  doc.comments.forEach(function (comment) {
    if (comment.rowId && removed.has(comment.rowId)) wanted.add(comment.id);
  });
  doc.rows.forEach(function (row) {
    if (removed.has(row.id)) commentIds(ports.cells(row.audioText)).forEach(id => wanted.add(id));
  });
  if (!wanted.size) return [];
  survivors.forEach(function (row) {
    commentIds(ports.cells(row.audioText)).forEach(id => wanted.delete(id));
    commentIds(ports.cells(row.visualText)).forEach(id => wanted.delete(id));
  });
  return Array.from(wanted);
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

interface Ends {
  readonly fromIndex: number;
  readonly fromOffset: number;
  readonly toIndex: number;
  readonly toOffset: number;
  readonly headName: string | null;
  readonly tailName: { readonly id: string; readonly name: string } | null;
  readonly gone: ReadonlySet<string>;
}

function endsOf(doc: FlowDoc, from: FlowPos, to: FlowPos, ports: FlowPorts): Ends {
  const scenes = scenesOf(doc);
  let fromIndex = 0, fromOffset = 0, headName: string | null = null;
  if (from.kind === "beat") {
    fromIndex = indexOfRow(doc, from.rowId);
    fromOffset = from.offset;
  } else {
    const scene = scenes.find(item => item.id === from.sceneId) as DocumentScene;
    fromIndex = indexOfRow(doc, scene.firstSceneId);
    if (from.offset > 0) headName = scene.name.slice(0, from.offset);
  }
  let toIndex = 0, toOffset = 0, tailName: Ends["tailName"] = null;
  if (to.kind === "beat") {
    toIndex = indexOfRow(doc, to.rowId);
    toOffset = to.offset;
  } else {
    const scene = scenes.find(item => item.id === to.sceneId) as DocumentScene;
    toIndex = indexOfRow(doc, scene.firstSceneId) - 1;
    toOffset = toIndex >= 0 ? cellLength(ports.cells((doc.rows[toIndex] as FlowRow).audioText)) : 0;
    if (to.offset > 0 && to.offset < scene.name.length) tailName = { id: scene.id, name: scene.name.slice(to.offset) };
  }
  const gone = new Set<string>();
  scenes.forEach(function (scene) {
    const whole = comparePos(doc, from, headingPos(scene.id, 0)) <= 0 && comparePos(doc, headingPos(scene.id, scene.name.length), to) <= 0;
    if (whole) gone.add(scene.id);
  });
  return { fromIndex, fromOffset, toIndex, toOffset, headName, tailName, gone };
}

function isAnchor(doc: FlowDoc, rowId: string): boolean {
  return !!sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, rowId);
}

export function replaceRange(doc: FlowDoc, range: FlowRange, insert: readonly Run[], ports: FlowPorts): FlowOutcome {
  const { from, to } = orderedRange(doc, range);
  if (from.kind === "heading" && to.kind === "heading" && from.sceneId === to.sceneId) {
    const scene = scenesOf(doc).find(item => item.id === from.sceneId);
    if (!scene) return null;
    const name = scene.name.slice(0, from.offset) + projection(insert) + scene.name.slice(to.offset);
    if (name.length > SCENE_NAME_MAX) return { refused: "A scene name can be up to " + SCENE_NAME_MAX + " characters." };
    if (!name) return removeHeader(doc, { ...scene, name: "" }, ports);
    const sections = scenesOf(doc).map(item => item.id === scene.id ? { ...item, name } : item);
    return edit(doc, doc.rows, caretAt(headingPos(scene.id, from.offset + projection(insert).length)), { sections });
  }
  const ends = endsOf(doc, from, to, ports);
  const insertLength = cellLength(insert);
  const single = ends.fromIndex === ends.toIndex;
  const fromWasStart = startsParagraph(doc, ends.fromIndex);
  const survivors: FlowRow[] = doc.rows.slice(0, ends.fromIndex);
  const removed: FlowRow[] = [];
  let fromSurvives = false, toSurvives = false;

  for (let index = ends.fromIndex; index <= ends.toIndex; index++) {
    const row = doc.rows[index] as FlowRow;
    const cell = ports.cells(row.audioText);
    const len = cellLength(cell);
    const isFrom = index === ends.fromIndex, isTo = index === ends.toIndex;
    const start = isFrom ? ends.fromOffset : 0;
    const end = isTo ? ends.toOffset : len;
    const nothingSelected = start === end && !(isFrom && insertLength);
    if (nothingSelected && (isFrom || isTo)) {
      survivors.push(row);
      fromSurvives = fromSurvives || isFrom;
      toSurvives = toSurvives || isTo;
      continue;
    }
    const whole = start === 0 && end === len;
    if (whole && !single && !(isFrom && insertLength)) {
      removed.push(row);
      continue;
    }
    const left = deleteRange(cell, start, end);
    survivors.push(writeCell(row, isFrom && insertLength ? insertCell(left, start, insert).cell : left));
    fromSurvives = fromSurvives || isFrom;
    toSurvives = toSurvives || isTo;
  }
  const firstAfterAt = survivors.length;
  doc.rows.slice(ends.toIndex + 1).forEach(row => survivors.push(row));

  const tailRow = single ? null : doc.rows[ends.toIndex] as FlowRow;
  const fromRow = doc.rows[ends.fromIndex] as FlowRow;
  const removedIds = new Set(removed.map(row => row.id));
  const lastKept = survivors.findIndex(row => row.id === fromRow.id);
  const followerAt = lastKept !== -1 ? lastKept + 1 : (removedIds.has(fromRow.id) ? ends.fromIndex : firstAfterAt);
  const follower = survivors[followerAt];
  if (follower && followerAt > 0) {
    if (fromSurvives) {
      if (toSurvives && tailRow && follower.id === tailRow.id) survivors[followerAt] = withoutFlag(follower);
    } else if (fromWasStart && !isAnchor(doc, follower.id)) {
      survivors[followerAt] = withFlag(follower);
    } else if (toSurvives && tailRow && follower.id === tailRow.id) {
      survivors[followerAt] = withoutFlag(follower);
    }
  }

  let caret: FlowPos;
  if (from.kind === "heading" && ends.headName !== null) {
    caret = headingPos(from.sceneId, from.offset);
  } else if (fromSurvives) {
    caret = beatPos(fromRow.id, ends.fromOffset + insertLength);
  } else if (survivors[followerAt]) {
    caret = beatPos((survivors[followerAt] as FlowRow).id, 0);
  } else if (survivors.length) {
    const lastRow = survivors[survivors.length - 1] as FlowRow;
    caret = beatPos(lastRow.id, cellLength(ports.cells(lastRow.audioText)));
  } else {
    const fresh = blankRow(ports.newId(), false);
    survivors.push(fresh);
    caret = beatPos(fresh.id, 0);
  }

  let sections: readonly DocumentScene[] | undefined = scenesAfterRemoval({ rows: doc.rows, sections: doc.sections }, removedIds)?.filter(scene => !ends.gone.has(scene.id));
  if (ends.headName !== null && from.kind === "heading") {
    sections = sections?.map(scene => scene.id === from.sceneId ? { ...scene, name: ends.headName as string } : scene);
  }
  if (ends.tailName) {
    const tail = ends.tailName;
    sections = sections?.map(scene => scene.id === tail.id ? { ...scene, name: tail.name } : scene);
  }
  if (sections && !sections.length) sections = undefined;
  const notice = removalNotice(removed, ports);
  return edit(doc, survivors, caretAt(caret), {
    sections,
    removedComments: commentsLeftBehind(doc, removedIds, survivors, ports),
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

export function setParagraphStart(doc: FlowDoc, rowId: string): FlowOutcome {
  const index = indexOfRow(doc, rowId);
  const row = doc.rows[index];
  if (!row) return null;
  const rows = doc.rows.slice();
  rows[index] = withFlag(row);
  return edit(doc, rows, caretAt(beatPos(rowId, 0)));
}

export function joinWithPrevious(doc: FlowDoc, rowId: string, ports: FlowPorts): FlowOutcome {
  const index = indexOfRow(doc, rowId);
  const row = doc.rows[index], prev = doc.rows[index - 1];
  if (!row || !prev) return null;
  if (sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, row.id)) return { refused: "A beat can't join across a scene header." };
  if (ports.hasVisual(prev) && ports.hasVisual(row)) return { refused: "Both beats have a visual. Join them in the split view, so you can pick which one to keep." };
  const a = ports.cells(prev.audioText), b = ports.cells(row.audioText);
  const glue = cellLength(a) && cellLength(b) && !/\s$/.test(projection(a)) ? " " : "";
  const joined = joinCells(a, b, glue);
  const merged: FlowRow = ports.hasVisual(row)
    ? { ...row, id: prev.id, audioText: toHtml(joined), paragraphStart: prev.paragraphStart }
    : { ...prev, audioText: toHtml(joined) };
  const rows = doc.rows.slice();
  rows.splice(index - 1, 2, prev.paragraphStart ? withFlag(merged) : withoutFlag(merged));
  return edit(doc, rows, caretAt(beatPos(prev.id, cellLength(a) + glue.length)));
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
  if (isBlank(row, ports) && next) {
    const scene = sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, next.id);
    return removeRow(doc, index, scene ? headingPos(scene.id, 0) : beatPos(next.id, 0));
  }
  if (!next) return null;
  const scene = sceneBeforeBeat({ rows: doc.rows, sections: doc.sections }, next.id);
  if (scene) return { move: headingPos(scene.id, 0) };
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
  if (name.length > SCENE_NAME_MAX) return { refused: "A scene name can be up to " + SCENE_NAME_MAX + " characters." };
  if (!name) return null;
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
  if (name.length > SCENE_NAME_MAX) {
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
  const sections = scenesInOrder({ rows, sections: scenes });
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

function logicalParagraph(beats: readonly FlowRow[], ports: FlowPorts): { text: string; spans: LogicalSpan[] } {
  let text = "";
  const spans: LogicalSpan[] = [];
  beats.forEach(function (row) {
    const chars = explode(ports.cells(row.audioText));
    const piece = chars.map(char => char.atom ? OBJ : char.marks.tag ? OBJ : char.ch).join("");
    const gap = !!text && !!piece && !/\s$/.test(text) && !/^\s/.test(piece);
    if (gap) text += " ";
    spans.push({ rowId: row.id, start: text.length, length: piece.length, gapBefore: gap });
    text += piece;
  });
  return { text, spans };
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
    let line = "";
    let any = false;
    block.beats.forEach(function (row) {
      const key: [number, number] = [indexOfRow(doc, row.id) * 2 + 1, 0];
      const isFrom = from.kind === "beat" && from.rowId === row.id, isTo = to.kind === "beat" && to.rowId === row.id;
      if (!isFrom && !isTo && !inside(key)) return;
      const whole = projection(ports.cells(row.audioText));
      const piece = whole.slice(isFrom ? (from as { offset: number }).offset : 0, isTo ? (to as { offset: number }).offset : whole.length);
      if (!piece) return;
      if (any && !/\s$/.test(line) && !/^\s/.test(piece)) line += " ";
      line += piece;
      any = true;
    });
    if (any) lines.push(line);
  });
  return lines.join("\n\n");
}

export function findInFlow(doc: FlowDoc, needle: string, matchCase: boolean, ports: FlowPorts): FlowMatch[] {
  const out: FlowMatch[] = [];
  if (!needle) return out;
  const wanted = matchCase ? needle : needle.toLowerCase();
  flowOf(doc).forEach(function (block) {
    if (block.kind === "heading") {
      const name = matchCase ? block.scene.name : block.scene.name.toLowerCase();
      for (let at = name.indexOf(wanted); at !== -1; at = name.indexOf(wanted, at + wanted.length)) {
        out.push({ range: { anchor: headingPos(block.scene.id, at), head: headingPos(block.scene.id, at + wanted.length) } });
      }
      return;
    }
    const logical = logicalParagraph(block.beats, ports);
    const text = matchCase ? logical.text : logical.text.toLowerCase();
    for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + wanted.length)) {
      const anchor = logicalPos(logical.spans, at, false);
      const head = logicalPos(logical.spans, at + wanted.length, true);
      if (anchor && head) out.push({ range: { anchor, head } });
    }
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
    const cleared = replaceRange(doc, range, [], ports);
    if (!isEdit(cleared)) return cleared;
    const next = lineBreakAt(afterEdit(doc, cleared), cleared.selection, ports);
    return isEdit(next) ? { ...next, removedComments: cleared.removedComments, notice: cleared.notice } : cleared;
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
    const broke = startParagraph(current, result.selection.head, ports);
    if (!isEdit(broke)) return result;
    const placed = replaceRange(afterEdit(current, broke), broke.selection, piece ? [{ text: piece, marks: {} }] : [], ports);
    if (!isEdit(placed)) return broke;
    result = placed;
    current = afterEdit(current, placed);
  }
  return { ...result, removedComments, notice };
}

export function typeWithMarks(doc: FlowDoc, pos: FlowPos, text: string, marks: Marks, ports: FlowPorts): FlowOutcome {
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
    if (isEdit(result)) {
      last = result;
      current = afterEdit(current, result);
    }
  }
  return last ? { ...last, notice: "Replaced " + matches.length + (matches.length === 1 ? " match" : " matches") } : null;
}
