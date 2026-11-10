import * as Y from "yjs";
import type { CollabCharacter, CollabMarks, CollabModel, CollabRow, IdentityBook } from "./model.ts";
import type { ReplicaCarets } from "./reader.ts";
import type { SchemaCandidate } from "./schema.ts";
import { projectComments, projectStatus, projectStructuralMarks } from "./marks/projection.ts";

interface StructureSpan {
  row: CollabRow;
  text: Y.Text;
  start: number;
  end: number;
}

function record(value: unknown): Y.Map<unknown> {
  if (!(value instanceof Y.Map)) throw new Error("Structural reader expected a map");
  return value as Y.Map<unknown>;
}

function textRecord(value: unknown): Y.Text {
  if (!(value instanceof Y.Text)) throw new Error("Structural reader expected text");
  return value;
}

function marksOf(value: unknown): CollabMarks {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") throw new Error("Invalid structural marks");
  const marks: Record<string, string | boolean> = {};
  for (const [key, mark] of Object.entries(value)) {
    if (typeof mark !== "string" && typeof mark !== "boolean") throw new Error(`Invalid mark ${key}`);
    marks[key] = mark;
  }
  return marks;
}

function readCharacters(text: Y.Text, start: number, value: string, marks: CollabMarks, beat: string, book: IdentityBook): CollabCharacter[] {
  return Array.from({ length: value.length }, (_, offset) => {
    const id = Y.createRelativePositionFromTypeIndex(text, start + offset, 0).item;
    if (!id) throw new Error("Missing structural character identity");
    const identity = { client: id.client, clock: id.clock };
    return { identity, notation: book.notation(identity), value: value.charAt(offset), marks, beat };
  });
}

export function readStructure(doc: Y.Doc, candidate: SchemaCandidate, book: IdentityBook, carets: ReplicaCarets = new Map()): CollabModel {
  const spans: StructureSpan[] = [];
  const seen = new Set<string>();
  const scan = (text: Y.Text, head?: unknown): void => {
    let current: StructureSpan | undefined;
    let index = 0;
    const begin = (value: unknown, start: number): void => {
      const boundary = value as { b?: string; h?: string };
      const id = boundary.b ?? boundary.h;
      if (!id) throw new Error("Unsupported structural atom");
      if (seen.has(id)) return;
      if (current) current.end = index;
      seen.add(id);
      current = { row: { id, characters: [], ...(boundary.h ? { kind: "heading" } : {}) }, text, start, end: text.length };
      spans.push(current);
    };
    if (head) begin(head, 0);
    for (const delta of text.toDelta()) {
      const insert: unknown = delta.insert;
      if (typeof insert === "string") {
        if (!current) throw new Error("Text outside structural boundary");
        current.row.characters.push(...readCharacters(text, index, insert, current.row.kind ? {} : marksOf(delta.attributes), current.row.id, book));
        index += insert.length;
      } else {
        begin(insert, index + 1);
        index++;
      }
    }
  };
  if (candidate === "A") scan(doc.getText("flow"));
  else {
    const ordered = new Set<string>();
    for (const id of doc.getArray<string>("order").toArray()) {
      if (ordered.has(id)) continue;
      ordered.add(id);
      const segment = record(doc.getMap("segments").get(id));
      scan(textRecord(segment.get("text")), segment.get("head"));
    }
  }
  const model: CollabModel = { rows: spans.map(span => span.row), carets: {}, recovery: [] };
  for (const row of model.rows) if (!row.kind) {
    const beat = record(doc.getMap("beats").get(row.id));
    if (typeof beat.get("status") === "string") row.status = String(beat.get("status"));
  }
  projectStatus(model, doc);
  model.rows = [];
  const destinations = new Map<string, { row: CollabRow; prefix: number }>();
  const activeRemovals: Y.Map<unknown>[] = [];
  for (const value of doc.getMap("beats").values()) {
    for (const id of record(record(value).get("removals")).keys()) {
      const removal = record(doc.getMap("removalRecords").get(id));
      if (removal.get("kind") !== "became-heading") activeRemovals.push(removal);
    }
  }
  const hasIdentity = (character: CollabCharacter, removal: Y.Map<unknown>): boolean => {
    return (removal.get("observed") as { client: number; clock: number; len: number }[]).some(range =>
      range.client === character.identity?.client && character.identity.clock >= range.clock && character.identity.clock < range.clock + range.len);
  };
  for (const span of spans) {
    const row = span.row;
    if (row.kind) {
      if (row.characters.length > 0) model.rows.push(row);
      destinations.set(row.id, { row, prefix: 0 });
      continue;
    }
    const beat = record(doc.getMap("beats").get(row.id));
    if (beat.get("paragraphStart") === true) row.paragraphStart = true;
    const removal = activeRemovals.find(item => item.get("beat") === row.id || row.characters.some(character => hasIdentity(character, item)));
    if (removal) {
      const splitBy = removal.get("beat") === row.id ? undefined : beat.get("splitBy");
      model.recovery.push({ row, by: String(removal.get("by")), edited: row.characters.filter(character => !hasIdentity(character, removal)).map(character => character.notation), ...(typeof splitBy === "string" ? { splitBy } : {}) });
      continue;
    }
    const joins = record(beat.get("joins"));
    const id = [...joins.keys()].filter(key => !doc.getMap("retiredJoins").has(key)).sort()[0];
    const join = id ? joins.get(id) as { into: string; glue: string } : undefined;
    const target = join ? destinations.get(join.into) : undefined;
    if (join && !target) throw new Error("Structural join target unavailable");
    if (join && target) {
      if (join.glue) target.row.characters.push({ identity: null, notation: "[glue]", value: join.glue, marks: {}, beat: target.row.id });
      destinations.set(row.id, { row: target.row, prefix: target.row.characters.length });
      target.row.characters.push(...row.characters.map(character => ({ ...character, beat: target.row.id })));
      const ranks = ["todo", "ready", "shot"];
      if (row.status && ranks.indexOf(row.status) > ranks.indexOf(target.row.status ?? "todo")) target.row.status = row.status;
    } else {
      model.rows.push(row);
      destinations.set(row.id, { row, prefix: 0 });
    }
  }
  for (const [componentId, value] of doc.getMap("visuals")) {
    const component = record(value);
    const origin = String(component.get("beat"));
    const target = destinations.get(origin)?.row ?? model.recovery.find(item => item.row.id === origin)?.row;
    if (!target) continue;
    const text = textRecord(component.get("text"));
    const visual: CollabRow = { id: componentId, characters: [] };
    let index = 0;
    for (const delta of text.toDelta()) {
      const insert: unknown = delta.insert;
      if (typeof insert !== "string") throw new Error("Unsupported visual atom");
      visual.characters.push(...readCharacters(text, index, insert, marksOf(delta.attributes), componentId, book));
      index += insert.length;
    }
    (target.visuals ??= []).push(visual);
    target.visualText = target.visuals.filter(item => item.characters.length > 0).map(item => item.characters.map(character => character.value).join("")).join("<br>");
  }
  const gallery = [...doc.getMap("gallery").values()] as { id: string; beat: string; rank: string; ref: string; name: string; annotation: string; links: { href: string; poster?: string }[] }[];
  for (const item of gallery.sort((a, b) => (spans.findIndex(span => span.row.id === a.beat) - spans.findIndex(span => span.row.id === b.beat)) || a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id))) {
    const target = destinations.get(item.beat)?.row ?? model.recovery.find(entry => entry.row.id === item.beat)?.row;
    if (!target) continue;
    const items = (target.gallery ??= []) as { ref: string; name: string; annotation: string; links: { href: string; poster?: string }[] }[];
    const existing = items.find(entry => entry.ref === item.ref);
    if (!existing) items.push({ ref: item.ref, name: item.name, annotation: item.annotation, links: structuredClone(item.links) });
    else {
      existing.name ||= item.name;
      existing.annotation ||= item.annotation;
      for (const link of item.links) {
        const old = existing.links.find(entry => entry.href === link.href);
        if (!old) existing.links.push({ ...link });
        else if (!old.poster && link.poster) old.poster = link.poster;
      }
    }
  }
  if (gallery.length) model.records = { gallery: Object.fromEntries([...doc.getMap("gallery")].sort(([a], [b]) => a.localeCompare(b))) };
  const locate = (position: Y.RelativePosition): { beat: string; offset: number } => {
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, doc, false);
    if (!absolute) throw new Error("Structural caret missing");
    const span = spans.find(item => item.text === absolute.type && item.start <= absolute.index && absolute.index <= item.end);
    if (!span) {
      for (const [id, component] of doc.getMap("visuals")) {
        const value = record(component);
        if (value.get("text") === absolute.type) {
          const target = destinations.get(String(value.get("beat")));
          if (!target) throw new Error("Visual caret in recovery");
          const prefix = target.row.visuals?.slice(0, target.row.visuals.findIndex(visual => visual.id === id)).reduce((sum, visual) => sum + visual.characters.length + 1, 0) ?? 0;
          return { beat: `${target.row.id}:visual`, offset: prefix + absolute.index };
        }
      }
      throw new Error(`Caret outside structural span at ${absolute.index}`);
    }
    const destination = destinations.get(span.row.id);
    if (destination) return { beat: destination.row.id, offset: destination.prefix + absolute.index - span.start };
    const after = spans.slice(spans.indexOf(span) + 1).find(item => !item.row.kind && destinations.has(item.row.id));
    const fallback = after ? destinations.get(after.row.id) : [...destinations.values()].filter(item => !item.row.kind).at(-1);
    if (!fallback) throw new Error("No surviving caret destination");
    return { beat: fallback.row.id, offset: after ? 0 : fallback.row.characters.length };
  };
  for (const [writer, caret] of carets) {
    const start = locate(caret.position);
    model.carets[writer] = start;
    if (caret.selectionEnd) {
      const end = locate(caret.selectionEnd);
      model.carets[writer] = { ...start, selection: { beat: end.beat, from: start.offset, to: end.offset } };
    }
  }
  projectStructuralMarks(model, doc);
  projectComments(model, doc);
  return model;
}
