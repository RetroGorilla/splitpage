import { identityEntries, identityGet, identityHas } from "../readers/identity.ts";
import type * as Y from "yjs";
import type { CollabMarks, CollabModel, CollabRow } from "../model.ts";
import { readStatusEvent, resolveBeatStatus } from "./status-resolution.ts";
import type { BeatStatusEvent } from "./status-resolution.ts";
import { readBeatRecord, readCommentRecord, readReplyRecord, rootMap } from "../readers/records.ts";
import { compareCodeUnits } from "../readers/order.ts";
import { commentOutputFields, literalRecord, replyOutputFields } from "../readers/output.ts";

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
    for (const extent of [...extents.values()].sort((a, b) => a.start - b.start || b.end - a.end || compareCodeUnits(a.key, b.key))) {
      const crossing = accepted.some(other => extent.start < other.end && other.start < extent.end &&
        !(extent.start >= other.start && extent.end <= other.end) && !(other.start >= extent.start && other.end <= extent.end));
      if (crossing || !identityHas(rootMap(doc, "tags"), extent.tag)) {
        rejected.push({ occurrence: extent.key.slice(2), tag: extent.tag, words: row.characters.slice(extent.start, extent.end).map(character => character.value).join(""), identities: row.characters.slice(extent.start, extent.end).map(character => character.notation) });
      } else accepted.push(extent);
    }
    const raw = row.characters.map(character => character.marks);
    row.characters.forEach((character, index) => {
      const marks: Record<string, string | boolean | readonly string[]> = {};
      for (const [key, value] of Object.entries(raw[index] ?? {})) {
        if (!key.startsWith("t:") && !key.startsWith("l:")) marks[key === "cmt" ? `c:${String(value)}` : key] = value;
      }
      const links = Object.entries(raw[index] ?? {}).filter(([key]) => key.startsWith("l:")).sort(([a], [b]) => compareCodeUnits(a, b));
      if (links[0]) marks.href = links[0][1];
      const stack = accepted.filter(extent => extent.start <= index && extent.end > index).sort((a, b) => (b.end - b.start) - (a.end - a.start) || compareCodeUnits(a.key, b.key));
      if (stack[0]) {
        marks.tag = stack[0].tag;
        if (stack.length > 1) marks.innerTags = stack.slice(1).map(extent => extent.tag);
        for (const extent of stack) {
          let link: string | boolean | readonly string[] | undefined;
          for (const original of raw.slice(extent.start, extent.end)) {
            for (const [key, value] of Object.entries(original)) {
              if (key.startsWith("c:")) marks[key] = value;
            }
            const found = Object.entries(original).filter(([key]) => key.startsWith("l:")).sort(([a], [b]) => compareCodeUnits(a, b))[0];
            link ??= found?.[1];
          }
          if (link !== undefined) marks.href = link;
        }
      }
      character.marks = literalRecord(marks, ["bold", "italic", "underline", "strike", "href", "tag", "innerTags"]) as CollabMarks;
    });
  }
  if (rejected.length) (model.records ??= {}).tagRecovery = rejected;
}

export function projectComments(model: CollabModel, doc: Y.Doc): void {
  const commentEntries = identityEntries(rootMap(doc, "comments")), replyEntries = identityEntries(rootMap(doc, "replies"));
  if (!commentEntries.length && !replyEntries.length) return;
  const records = (model.records ??= {});
  const validated = replyEntries.flatMap(([id, raw]) => { const value = readReplyRecord(raw); return value ? [{ id, data: value.data, commentId: value.commentId, createdAt: value.createdAt }] : []; });
  validated.sort((a, b) => a.createdAt - b.createdAt || compareCodeUnits(a.id, b.id));
  const replies = validated.map(reply => {
    const output = literalRecord(reply.data, replyOutputFields); output.id = reply.data.id ?? reply.id; output.commentId = reply.commentId;
    return literalRecord(output, replyOutputFields);
  });
  const comments: Record<string, unknown> = {};
  const rows: { row: CollabRow; recovery: boolean }[] = [...model.rows.map(row => ({ row, recovery: false })), ...model.recovery.map(entry => ({ row: entry.row, recovery: true }))];
  for (const [id, value] of commentEntries.sort(([a], [b]) => compareCodeUnits(a, b))) {
    const original = readCommentRecord(value); if (!original) continue;
    const anchor = rows.find(({ row }) => !row.kind && row.characters.some(character => character.marks[`c:${id}`]));
    const output = literalRecord(original, commentOutputFields);
    output.rowId = anchor?.row.id ?? original.rowId; output.field = anchor ? "audioText" : original.field;
    output.recovery = anchor?.recovery ?? true; output.replies = replies.filter(reply => reply.commentId === id);
    Object.defineProperty(comments, id, { enumerable: true, configurable: true, value: literalRecord(output, commentOutputFields) });
  }
  records.comments = comments;
  records.recoveryReplies = replies.filter(reply => typeof reply.commentId === "string" && !Object.hasOwn(comments, reply.commentId));
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
  const events: [string, BeatStatusEvent][] = [];
  for (const [id, raw] of identityEntries(rootMap(doc, "statusEvents"))) { const event = readStatusEvent(raw); if (event) events.push([id, event]); }
  if (!events.length) return;
  for (const row of [...model.rows, ...model.recovery.map(entry => entry.row)]) {
    const relevant = events.filter(([, event]) => event.target === row.id);
    if (relevant.length) row.status = resolveBeatStatus(new Map(relevant), { has: (id: string) => identityHas(rootMap(doc, "retiredStatus"), id) },
      readBeatRecord(identityGet(rootMap(doc, "beats"), row.id)).status ?? "undefined");
    const conflict = relevant.filter(([, event]) => relevant.some(([, other]) => event.value !== other.value && JSON.stringify(event.parents) === JSON.stringify(other.parents)));
    if (conflict.length) model.notices = [...new Set(conflict.map(([, event]) => `${event.by}: concurrent status change did not apply`))].sort();
  }
}
