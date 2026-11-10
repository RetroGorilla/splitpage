import { readStructure } from "../../src/structure-reader.ts";
import { mapValue } from "../../src/schema.ts";
import { legacyStructureReader } from "./legacy-structure.ts";

export const legacyRemovalReader: typeof readStructure = (...args) => {
  return legacyStructureReader(...args);
};

export const legacyVisualReader: typeof readStructure = (...args) => {
  const [doc] = args, model = readStructure(...args), ids = [...doc.getMap("visuals").keys()];
  for (const row of [...model.rows, ...model.recovery.map(entry => entry.row)]) if (row.visuals) {
    row.visuals.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    row.visualText = row.visuals.filter(item => item.characters.length > 0).map(item => item.characters.map(character => character.value).join("")).join("<br>");
  }
  return model;
};

export const legacyReplyReader: typeof readStructure = (...args) => {
  const [doc] = args, model = readStructure(...args);
  if (!doc.getMap("comments").size && !doc.getMap("replies").size) return model;
  const replies: (Record<string, unknown> & { id: string })[] = [...doc.getMap("replies")].map(([id, value]) => ({ id, ...mapValue(value).toJSON() }));
  replies.sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || a.id.localeCompare(b.id));
  const records = (model.records ??= {}), comments = records.comments as Record<string, { replies: unknown[] }>;
  for (const [id, comment] of Object.entries(comments)) comment.replies = replies.filter(reply => reply.commentId === id);
  records.recoveryReplies = replies.filter(reply => !doc.getMap("comments").has(String(reply.commentId)));
  return model;
};
