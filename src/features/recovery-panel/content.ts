import type { SharedRecoveryEntry } from "../../core/collab/recovery.ts";
import type { RecoveryPanelPorts } from "./ports.ts";
import { tagNameOf } from "../../core/text/runs.ts";

function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export function recoveryPanelContent(entry: SharedRecoveryEntry, ports: Pick<RecoveryPanelPorts, "document" | "text" | "reply">): { label: string; by: string; text: string } {
  const doc = ports.document.current(), plain = (html: unknown) => ports.text.htmlToPlainText(string(html));
  const row = (value: Readonly<Record<string, unknown>>) => [plain(value.audioText), plain(value.visualText), string(value.imageName),
    ...(Array.isArray(value.moreImages) ? value.moreImages : []).flatMap(slot => slot && typeof slot === "object" ? [string((slot as Record<string, unknown>).name)] : [])].filter(Boolean).join("\n");
  const provenance = (removed: string | undefined, edited: unknown, split?: string) => [removed ? "Removed by " + removed : "",
    string(edited) ? "Last edited by " + string(edited) : "", split ? "Split by " + split : ""].filter(Boolean).join("\n");
  switch (entry.kind) {
    case "removed-beat": return { label: "Removed beat", by: provenance(entry.removal?.by, entry.row.updatedBy, entry.splitBy),
      text: [row(entry.row), ...(entry.comments ?? []).flatMap(id => {
        const comment = doc?.comments.find(item => item.id === id);
        return comment ? [string(comment.author) + ": " + string(comment.body), ...(comment.replies ?? []).map(reply => string(reply.author) + ": " + string(reply.body))] : [];
      })].filter(Boolean).join("\n") };
    case "removed-heading": return { label: "Removed heading", by: provenance(entry.removal?.by, entry.heading.updatedBy), text: string(entry.heading.name) };
    case "scene-with-no-beats": return { label: "Scene without beats", by: string(entry.heading.updatedBy), text: string(entry.heading.name) };
    case "crossing-tag": case "deleted-tag": {
      const tag = doc?.productionTags.find(item => item?.id === entry.tag);
      return { label: entry.kind === "crossing-tag" ? "Overlapping tag" : "Deleted tag", by: "", text: [tag?.name || tagNameOf(entry.tag)?.name || entry.tag, entry.words].join("\n") };
    }
    case "gallery-overflow": return { label: "Extra picture", by: string(entry.slot.updatedBy), text: string(entry.slot.name) || entry.itemId };
    case "unprojectable-fragment": return { label: "Unplaced text", by: "", text: plain(entry.html) };
    case "comment-without-words": {
      const comment = doc?.comments.find(item => item.id === entry.comment);
      return { label: "Comment without words", by: string(comment?.author), text: comment ? [string(comment.quotedText), string(comment.body),
        ...(comment.replies ?? []).map(reply => string(reply.author) + ": " + string(reply.body))].filter(Boolean).join("\n") : entry.comment };
    }
    case "reply-without-comment": {
      const reply = ports.reply(entry.reply);
      return { label: "Reply without comment", by: string(reply?.author), text: string(reply?.text) || entry.reply };
    }
    case "deleted-person": return { label: "Deleted person", by: entry.by, text: entry.name };
  }
}
