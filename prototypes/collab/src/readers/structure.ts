import { identityEntries, identityGet, identityHas } from "./identity.ts";
import * as Y from "yjs";
import type { CollabModel, CollabRecovery, CollabRow, IdentityBook } from "../model.ts";
import type { ReplicaCarets } from "../reader.ts";
import type { SchemaCandidate } from "../schema.ts";
import { projectStatus } from "../marks/projection.ts";
import { firstLiveJoin, readBeatRecord, readCaretRecord, rootMap } from "./records.ts";
import type { ReaderBeatRecord, ReaderJoinRecord } from "./records.ts";
import { readRemovalRecord, removalAttribution, removalIds, removalObserved } from "./removals.ts";
import type { RemovalViewRecord } from "./removals.ts";
import { readerTextSpans } from "./spans.ts";
import type { ReaderTextSpan } from "./spans.ts";
import { readerJoinGroups } from "./joins.ts";
import { compareCodeUnits } from "./order.ts";
import { literalRecord } from "./output.ts";

export interface ReaderDestination { row: CollabRow; prefix: number; recovery: boolean }

export function readerStructure(doc: Y.Doc, candidate: SchemaCandidate, book: IdentityBook, enhanced: boolean) {
  const spans = readerTextSpans(doc, candidate, book), beats = new Map<string, ReaderBeatRecord>();
  for (const [id, raw] of identityEntries(rootMap(doc, "beats"))) if (typeof id === "string") beats.set(id, readBeatRecord(raw));
  const model: CollabModel = { rows: spans.map(span => span.row), carets: {}, recovery: [] };
  for (const row of model.rows) {
    const beat = beats.get(row.id);
    if (enhanced && !row.kind) {
      if (beat?.status !== undefined) row.status = beat.status;
      if (beat?.paragraphStart) row.paragraphStart = true;
    } else if (!enhanced && beat?.lengthSeconds !== undefined) row.lengthSeconds = beat.lengthSeconds;
    if (!enhanced) for (const character of row.characters) if (typeof character.marks.cmt === "string") {
      const marks: Record<string, string | boolean | readonly string[]> = {};
      for (const key of Object.keys(character.marks).filter(key => key !== "cmt").sort(compareCodeUnits)) marks[key] = character.marks[key] as string | boolean | readonly string[];
      marks[`c:${String(character.marks.cmt)}`] = true;
      character.marks = literalRecord(marks, ["bold", "italic", "underline", "strike", "href", "tag", "innerTags"]) as typeof character.marks;
    }
  }
  if (enhanced) projectStatus(model, doc);
  model.rows = [];
  const active = new Map<string, RemovalViewRecord>();
  for (const beat of beats.values()) for (const id of removalIds(beat.removals)) {
    const removal = readRemovalRecord(identityGet(rootMap(doc, "removalRecords"), id)); if (removal) active.set(id, removal);
  }
  const removals = new Map(spans.map(({ row }) => [row.id, row.kind ? [] : [...active.values()].filter(removal =>
    removal.beat === row.id || row.characters.some(character => removalObserved([removal], character.identity)))]));
  const joins = new Map<string, ReaderJoinRecord>(), removed = new Set<string>(), headings = new Set(spans.filter(span => span.row.kind).map(span => span.row.id));
  const retired = { has: (id: string) => identityHas(rootMap(doc, "retiredJoins"), id) };
  for (const { row } of spans) {
    if (removals.get(row.id)?.length) removed.add(row.id);
    const beat = beats.get(row.id), join = beat && firstLiveJoin(beat, retired);
    if (join && !row.kind && !headings.has(join.into)) joins.set(row.id, join);
  }
  const rows = new Map(spans.map(span => [span.row.id, span.row])), destinations = new Map<string, ReaderDestination>();
  for (const group of readerJoinGroups(spans.map(span => span.row.id), joins, removed)) {
    const original = rows.get(group.root); if (!original) continue;
    const row: CollabRow = { id: original.id, characters: [...original.characters] };
    if (original.kind !== undefined) row.kind = original.kind;
    if (original.status !== undefined) row.status = original.status;
    if (original.paragraphStart !== undefined) row.paragraphStart = original.paragraphStart;
    if (original.lengthSeconds !== undefined) row.lengthSeconds = original.lengthSeconds;
    const recovery = removed.has(group.root);
    destinations.set(group.root, { row, prefix: 0, recovery });
    for (const id of group.members.slice(1)) {
      const source = rows.get(id); if (!source) continue;
      const glue = joins.get(id)?.glue;
      if (glue) row.characters.push({ identity: null, notation: "[glue]", value: glue, marks: {}, beat: row.id });
      destinations.set(id, { row, prefix: row.characters.length, recovery });
      row.characters.push(...source.characters.map(character => ({ identity: character.identity, notation: character.notation, value: character.value, marks: character.marks, beat: row.id })));
      const ranks = ["todo", "ready", "shot"];
      if (source.status && ranks.indexOf(source.status) > ranks.indexOf(row.status ?? "todo")) row.status = source.status;
    }
    if (recovery) {
      const applicable = [...new Set(group.members.flatMap(id => removals.get(id) ?? []))];
      const edited = row.characters.filter(character => character.identity && applicable.some(removal => !removalObserved([removal], character.identity))).map(character => character.notation);
      const splitters = group.members.flatMap(id => {
        const by = beats.get(id)?.splitBy;
        return by !== undefined && removals.get(id)?.some(removal => removal.beat !== id) ? [by] : [];
      });
      const splitBy = [...new Set(splitters)].sort(compareCodeUnits).join(", ");
      const entry: CollabRecovery = { row, by: removalAttribution(applicable), edited }; if (splitBy) entry.splitBy = splitBy;
      model.recovery.push(entry);
    } else if (!row.kind || row.characters.length) model.rows.push(row);
  }
  return { model, spans, destinations };
}

export function readerCarets(model: CollabModel, spans: readonly ReaderTextSpan[], destinations: ReadonlyMap<string, ReaderDestination>, doc: Y.Doc, carets: ReplicaCarets,
  visuals: readonly { id: string; beat: string; text: Y.Text }[] = []): void {
  const fallback = (beat: string): { beat: string; offset: number } | null => {
    const after = spans.slice(spans.findIndex(span => span.row.id === beat) + 1).map(span => destinations.get(span.row.id)).find(item => item && !item.recovery && !item.row.kind);
    if (after) return { beat: after.row.id, offset: 0 };
    const last = [...destinations.values()].filter(item => !item.recovery && !item.row.kind).at(-1);
    return last ? { beat: last.row.id, offset: last.row.characters.length } : null;
  };
  const locate = (position: Y.RelativePosition): { beat: string; offset: number } | null => {
    let absolute: Y.AbsolutePosition | null;
    try { absolute = Y.createAbsolutePositionFromRelativePosition(position, doc, false); } catch { return null; }
    if (!absolute) return null;
    const span = spans.find(span => span.text === absolute.type && span.start <= absolute.index && absolute.index <= span.end);
    if (span) {
      const destination = destinations.get(span.row.id);
      return destination && !destination.recovery ? { beat: destination.row.id, offset: destination.prefix + absolute.index - span.start } : fallback(span.row.id);
    }
    const visual = visuals.find(value => value.text === absolute.type);
    if (!visual) return null;
    const target = destinations.get(visual.beat);
    if (!target || target.recovery) return fallback(visual.beat);
    const prefix = target.row.visuals?.slice(0, target.row.visuals.findIndex(row => row.id === visual.id)).reduce((sum, row) => sum + row.characters.length + 1, 0) ?? 0;
    return { beat: `${target.row.id}:visual`, offset: prefix + absolute.index };
  };
  for (const [writer, raw] of [...carets].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const caret = readCaretRecord(raw), start = caret && locate(caret.position);
    if (!start) continue;
    model.carets[writer] = start;
    const end = caret.selectionEnd && locate(caret.selectionEnd);
    if (end) model.carets[writer] = { beat: start.beat, offset: start.offset, selection: { beat: end.beat, from: start.offset, to: end.offset } };
  }
}
