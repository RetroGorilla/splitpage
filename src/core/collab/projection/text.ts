import { cleanMarks, defaultTagOf } from "../../text/runs.ts";
import type { Marks, Run } from "../../text/runs.ts";
import { toHtml } from "../../text/html.ts";
import type { SharedInlineValue, SharedMarkValue } from "../operations.ts";

export interface SharedProjectionUnit {
  readonly value: SharedInlineValue;
  readonly marks: readonly { readonly kind: SharedMarkValue["kind"]; readonly id?: string; readonly value: true | string }[];
}
export function chooseSharedProjectionPayload(values: readonly (true | string)[]): true | string | undefined {
  return [...values].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)[0];
}
function identifiedMarkPayload(mark: SharedProjectionUnit["marks"][number]): string | null {
  return typeof mark.value === "string" ? mark.value : null;
}
export function projectSharedCommentAnchors(units: readonly SharedProjectionUnit[], comments: Record<string, unknown>[], rowId: string, field: string, anchored: Set<string>): void {
  for (const unit of units) for (const mark of unit.marks) if (mark.kind === "comment") {
    const anchor = identifiedMarkPayload(mark);
    if (anchor === null || anchored.has(anchor)) continue;
    const comment = comments.find(comment => comment.anchorId === anchor);
    if (comment) { comment.rowId = rowId; comment.field = field; anchored.add(anchor); }
  }
}
export function projectSharedText(units: readonly SharedProjectionUnit[], tags: readonly Readonly<Record<string, unknown>>[]): string {
  const runs: Run[] = [];
  for (const unit of units) {
    const marks: Marks = cleanMarks(Object.fromEntries(unit.marks.filter(mark => !["comment", "tag", "link"].includes(mark.kind)).map(mark => [mark.kind, mark.value])), typeof unit.value !== "string");
    const ordered = [...unit.marks].sort((a, b) => (a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0);
    const anchors = ordered.filter(mark => mark.kind === "comment").map(mark => identifiedMarkPayload(mark)).filter((anchor): anchor is string => anchor !== null);
    if (anchors.length) marks.cmt = [...new Set(anchors)].sort();
    const link = ordered.find(mark => mark.kind === "link"), href = link && identifiedMarkPayload(link);
    if (href) marks.href = href;
    const tagged = ordered.filter(mark => mark.kind === "tag").map(mark => identifiedMarkPayload(mark))
      .filter((id): id is string => id !== null && (tags.some(tag => tag.id === id) || defaultTagOf(id) !== null));
    const value = unit.value;
    if (typeof value === "string") {
      if (tagged[0]) marks.tag = tagged[0];
      if (tagged.length > 1) marks.innerTags = tagged.slice(1);
      const last = runs[runs.length - 1];
      if (last && !last.atom && JSON.stringify(last.marks) === JSON.stringify(marks)) last.text += value;
      else runs.push({ text: value, marks });
    } else if (value.atom === "broll") runs.push({ atom: "broll", id: value.id, text: value.text ?? "B-roll:", marks });
    else if (value.atom === "who") runs.push({ atom: "who", name: value.name, text: "@" + value.name, marks });
    else if (value.atom === "image") runs.push({ atom: "image", ref: value.ref, text: "", marks });
    else runs.push({ atom: "video", href: value.href, host: value.host, text: "", marks });
  }
  return toHtml(runs, { tagOf: id => {
    const tag = tags.find(tag => tag.id === id);
    return tag && typeof tag.cat === "string" && typeof tag.name === "string" ? { cat: tag.cat, name: tag.name } : defaultTagOf(id);
  } });
}
