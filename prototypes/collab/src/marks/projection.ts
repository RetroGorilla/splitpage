import * as Y from "yjs";
import type { CollabMarks, CollabModel, CollabRow } from "../model.ts";
import { mapValue } from "../schema.ts";
import { resolveBeatStatus } from "./status-resolution.ts";
import type { BeatStatusEvent } from "./status-resolution.ts";

interface TagExtent {
  key: string;
  tag: string;
  start: number;
  end: number;
}

export function projectStructuralMarks(model: CollabModel, doc: Y.Doc): void {
  const rejected: { occurrence: string; tag: string; words: string; identities: string[] }[] = [];
  const all = [...model.rows, ...model.recovery.map(entry => entry.row)];
  for (const row of all) {
    const extents = new Map<string, TagExtent>();
    row.characters.forEach((character, index) => {
      for (const [key, value] of Object.entries(character.marks)) {
        if (key.startsWith("t:") && typeof value === "string") {
          const existing = extents.get(key);
          if (existing) existing.end = index + 1;
          else extents.set(key, { key, tag: value, start: index, end: index + 1 });
        }
      }
    });
    const accepted: TagExtent[] = [];
    for (const extent of [...extents.values()].sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key))) {
      const crossing = accepted.some(other => extent.start < other.end && other.start < extent.end &&
        !(extent.start >= other.start && extent.end <= other.end) && !(other.start >= extent.start && other.end <= extent.end));
      if (crossing || !doc.getMap("tags").has(extent.tag)) {
        rejected.push({ occurrence: extent.key.slice(2), tag: extent.tag, words: row.characters.slice(extent.start, extent.end).map(character => character.value).join(""), identities: row.characters.slice(extent.start, extent.end).map(character => character.notation) });
      } else accepted.push(extent);
    }
    const raw = row.characters.map(character => character.marks);
    row.characters.forEach((character, index) => {
      const marks: Record<string, string | boolean | readonly string[]> = {};
      for (const [key, value] of Object.entries(raw[index] ?? {})) {
        if (!key.startsWith("t:") && !key.startsWith("l:")) marks[key === "cmt" ? `c:${String(value)}` : key] = value;
      }
      const links = Object.entries(raw[index] ?? {}).filter(([key]) => key.startsWith("l:")).sort(([a], [b]) => a.localeCompare(b));
      if (links[0]) marks.href = links[0][1];
      const stack = accepted.filter(extent => extent.start <= index && extent.end > index).sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.key.localeCompare(b.key));
      if (stack[0]) {
        marks.tag = stack[0].tag;
        if (stack.length > 1) marks.innerTags = stack.slice(1).map(extent => extent.tag);
        for (const extent of stack) {
          let link: string | boolean | readonly string[] | undefined;
          for (const original of raw.slice(extent.start, extent.end)) {
            for (const [key, value] of Object.entries(original)) {
              if (key.startsWith("c:")) marks[key] = value;
            }
            const found = Object.entries(original).filter(([key]) => key.startsWith("l:")).sort(([a], [b]) => a.localeCompare(b))[0];
            link ??= found?.[1];
          }
          if (link !== undefined) marks.href = link;
        }
      }
      character.marks = marks;
    });
  }
  if (rejected.length) (model.records ??= {}).tagRecovery = rejected;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!(value instanceof Y.Map)) throw new Error("Expected comment/reply record");
  return value.toJSON() as Record<string, unknown>;
}

export function projectComments(model: CollabModel, doc: Y.Doc): void {
  if (!doc.getMap("comments").size && !doc.getMap("replies").size) return;
  const records = (model.records ??= {});
  const replies: (Record<string, unknown> & { id: string })[] = [...doc.getMap("replies")].map(([id, value]) => ({ id, ...plainRecord(value) }));
  replies.sort((a, b) =>
    Number(a.createdAt) - Number(b.createdAt) || a.id.localeCompare(b.id));
  const comments: Record<string, unknown> = {};
  const rows: { row: CollabRow; recovery: boolean }[] = [...model.rows.map(row => ({ row, recovery: false })), ...model.recovery.map(entry => ({ row: entry.row, recovery: true }))];
  for (const [id, value] of [...doc.getMap("comments")].sort(([a], [b]) => a.localeCompare(b))) {
    const original = plainRecord(value);
    const anchor = rows.find(({ row }) => !row.kind && row.characters.some(character => character.marks[`c:${id}`]));
    comments[id] = { ...original, rowId: anchor?.row.id ?? original.rowId, field: anchor ? "audioText" : original.field, recovery: anchor?.recovery ?? true, replies: replies.filter(reply => reply.commentId === id) };
  }
  records.comments = comments;
  records.recoveryReplies = replies.filter(reply => !doc.getMap("comments").has(String(reply.commentId)));
}

export function storedMarkNames(key: string, characters: readonly { text: Y.Text; index: number; notation: string }[]): string[] {
  const result: string[] = [];
  for (const character of characters) {
    let index = 0;
    for (const delta of character.text.toDelta()) {
      const insert: unknown = delta.insert;
      const length = typeof insert === "string" ? insert.length : 1;
      const marks = delta.attributes as CollabMarks | undefined;
      if (index <= character.index && character.index < index + length && marks?.[key]) result.push(character.notation);
      index += length;
    }
  }
  return result;
}

export function projectStatus(model: CollabModel, doc: Y.Doc): void {
  const events = [...doc.getMap<BeatStatusEvent>("statusEvents")];
  if (!events.length) return;
  for (const row of [...model.rows, ...model.recovery.map(entry => entry.row)]) {
    const relevant = events.filter(([, event]) => event.target === row.id);
    if (relevant.length) row.status = resolveBeatStatus(new Map(relevant), doc.getMap("retiredStatus"),
      String(mapValue(doc.getMap("beats").get(row.id)).get("status")));
    const conflict = relevant.filter(([, event]) => relevant.some(([, other]) => event.value !== other.value && JSON.stringify(event.parents) === JSON.stringify(other.parents)));
    if (conflict.length) model.notices = [...new Set(conflict.map(([, event]) => `${event.by}: concurrent status change did not apply`))].sort();
  }
}
