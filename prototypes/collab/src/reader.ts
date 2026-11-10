import * as Y from "yjs";
import type { CollabCaret, CollabCharacter, CollabMarks, CollabModel, CollabRow, IdentityBook } from "./model.ts";
import type { SchemaCandidate } from "./schema.ts";

export interface ReplicaCaretAnchor {
  position: Y.RelativePosition;
  selectionEnd?: Y.RelativePosition;
}

export type ReplicaCarets = ReadonlyMap<string, ReplicaCaretAnchor>;

interface ReadSpan {
  row: CollabRow;
  text: Y.Text;
  start: number;
  end: number;
}

function sharedMap(value: unknown): Y.Map<unknown> {
  if (!(value instanceof Y.Map)) throw new Error("Reader expected Y.Map");
  return value as Y.Map<unknown>;
}

function sharedText(value: unknown): Y.Text {
  if (!(value instanceof Y.Text)) throw new Error("Reader expected Y.Text");
  return value;
}

function boundary(value: unknown): string {
  if (typeof value !== "object" || value === null || !("b" in value) || typeof value.b !== "string") {
    throw new Error("Reader encountered an unsupported boundary");
  }
  return value.b;
}

function attributes(value: unknown): CollabMarks {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object") throw new Error("Invalid attributes");
  const result: Record<string, string | boolean> = {};
  for (const [key, attribute] of Object.entries(value)) {
    if (typeof attribute !== "boolean" && typeof attribute !== "string") throw new Error(`Unsupported mark ${key}`);
    if (key === "cmt" && typeof attribute === "string") result[`c:${attribute}`] = true;
    else result[key] = attribute;
  }
  return result;
}

export function readReplica(doc: Y.Doc, candidate: SchemaCandidate, identities: IdentityBook, anchors: ReplicaCarets = new Map()): CollabModel {
  const spans: ReadSpan[] = [];
  const seen = new Set<string>();
  const beats = doc.getMap("beats");
  const scan = (text: Y.Text, head?: unknown): void => {
    let current: ReadSpan | undefined;
    let index = 0;
    const begin = (id: string, start: number): void => {
      if (current) current.end = index;
      if (seen.has(id)) return;
      seen.add(id);
      const record = sharedMap(beats.get(id));
      const lengthSeconds = record.get("lengthSeconds");
      const row: CollabRow = { id, characters: [] };
      if (typeof lengthSeconds === "number") row.lengthSeconds = lengthSeconds;
      current = { row, text, start, end: text.length };
      spans.push(current);
    };
    if (head !== undefined) begin(boundary(head), 0);
    for (const operation of text.toDelta()) {
      const insert: unknown = operation.insert;
      if (typeof insert === "string") {
        if (!current) throw new Error("Reader found text before a boundary");
        for (let offset = 0; offset < insert.length; offset++) {
          const id = Y.createRelativePositionFromTypeIndex(text, index + offset, 0).item;
          if (!id) throw new Error("Reader found a character without identity");
          const identity = { client: id.client, clock: id.clock };
          current.row.characters.push({ identity, notation: identities.notation(identity), value: insert.charAt(offset), marks: attributes(operation.attributes), beat: current.row.id });
        }
        index += insert.length;
      } else {
        begin(boundary(insert), index + 1);
        index++;
      }
    }
  };
  if (candidate === "A") {
    scan(doc.getText("flow"));
  } else {
    const segments = doc.getMap("segments");
    const ordered = new Set<string>();
    for (const id of doc.getArray<string>("order").toArray()) {
      if (ordered.has(id)) continue;
      ordered.add(id);
      const segment = sharedMap(segments.get(id));
      scan(sharedText(segment.get("text")), segment.get("head"));
    }
  }
  const model: CollabModel = { rows: [], carets: {}, recovery: [] };
  const destinations = new Map<string, { row: CollabRow; prefix: number }>();
  for (const span of spans) {
    const record = sharedMap(beats.get(span.row.id));
    const removals = sharedMap(record.get("removals"));
    if (removals.size > 0) {
      const removal = sharedMap(doc.getMap("removalRecords").get([...removals.keys()].sort()[0] ?? ""));
      const observed = removal.get("observed") as { client: number; clock: number; len: number }[];
      const edited = span.row.characters.filter(character => !observed.some(range => character.identity?.client === range.client && character.identity.clock >= range.clock && character.identity.clock < range.clock + range.len)).map(character => character.notation);
      model.recovery.push({ row: span.row, by: String(removal.get("by")), edited });
      continue;
    }
    const joins = sharedMap(record.get("joins"));
    const join = joins.get([...joins.keys()].sort()[0] ?? "") as { into: string; glue: string } | undefined;
    const target = join ? destinations.get(join.into) : undefined;
    if (join && !target) throw new Error("Probe requires an earlier live join target");
    if (target && join) {
      if (join.glue) {
        const glue: CollabCharacter = { identity: null, notation: "[glue]", value: join.glue, marks: {}, beat: target.row.id };
        target.row.characters.push(glue);
      }
      destinations.set(span.row.id, { row: target.row, prefix: target.row.characters.length });
      target.row.characters.push(...span.row.characters.map(character => ({ ...character, beat: target.row.id })));
    } else {
      model.rows.push(span.row);
      destinations.set(span.row.id, { row: span.row, prefix: 0 });
    }
  }
  const locateCaret = (position: Y.RelativePosition): CollabCaret => {
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, doc, false);
    if (!absolute) throw new Error("Caret identity is unavailable");
    const span = spans.find(item => item.text === absolute.type && item.start <= absolute.index && absolute.index <= item.end);
    if (!span) throw new Error(`Caret is outside a beat at ${absolute.index}`);
    const destination = destinations.get(span.row.id);
    if (destination) return { beat: destination.row.id, offset: destination.prefix + absolute.index - span.start };
    const after = spans.slice(spans.indexOf(span) + 1).find(item => destinations.has(item.row.id));
    const fallback = after ? destinations.get(after.row.id) : [...destinations.values()].at(-1);
    if (!fallback) throw new Error("Caret recovery requires a surviving beat in this probe");
    return { beat: fallback.row.id, offset: after ? 0 : fallback.row.characters.length };
  };
  for (const [writer, anchor] of anchors) {
    const caret = locateCaret(anchor.position);
    model.carets[writer] = caret;
    if (anchor.selectionEnd) {
      const end = locateCaret(anchor.selectionEnd);
      caret.selection = { beat: end.beat, from: caret.offset, to: end.offset };
    }
  }
  return model;
}
