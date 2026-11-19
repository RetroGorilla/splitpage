import { mergeDiffPairHtml, mergeListEntries, mergeRowFate } from "../../../../src/core/merge/review.ts";
import { clashLine, noticeKey, plainNoticeText, type NoticeBeat, type NoticeClash, type NoticeReading } from "./compare.ts";

function row(beat: NoticeBeat | null | undefined) {
  return beat && { ...beat.fields, id: beat.id, status: beat.status,
    audioText: noticeKey(beat.narration), visualText: noticeKey(beat.visual) };
}

function summary(beat: NoticeBeat | null | undefined, kind: NoticeClash["kind"]) {
  if (!beat) return "";
  switch (kind) {
    case "visual": return plainNoticeText(beat.visual);
    case "marks": return noticeKey({ narration: beat.narration, visual: beat.visual });
    case "record": return noticeKey({ status: beat.status, ...beat.fields });
    case "join": return "Shown under " + (beat.row === beat.id ? "its own beat" : beat.row) +
      (beat.fields.joined ? " · Join " + noticeKey(beat.fields.joined) : "");
    case "split-move": return (beat.scene ? "Scene " + beat.scene + " · " : "") + plainNoticeText(beat.narration);
    default: return plainNoticeText(beat.narration);
  }
}

export function adaptNoticeReview(clashes: readonly NoticeClash[], base: NoticeReading, mine: NoticeReading, merged: NoticeReading) {
  const details = clashes.map(clash => {
    const old = base.find(beat => beat.id === clash.id);
    const around = (reading: NoticeReading) => reading.find(beat => beat.id === clash.near);
    const left = clash.kind === "displaced" ? around(mine) : clash.mine;
    const right = clash.kind === "displaced" ? around(merged) : clash.merged;
    const mineText = summary(left, clash.kind), mergedText = summary(right, clash.kind);
    const list = mergeListEntries("Beat", left ? [{ id: clash.id, summary: mineText }] : [],
      right ? [{ id: clash.id, summary: mergedText }] : [], item => item.id, item => item.id, item => item.summary);
    return { id: clash.id, line: clashLine[clash.kind], list,
      fate: mergeRowFate(row(old), row(clash.mine), row(clash.merged)),
      diff: mergeDiffPairHtml(mineText, mergedText),
      canPutBack: clash.mine !== null };
  });
  const groups = new Map<string, { id: string; canPutBack: boolean; details: typeof details }>();
  for (const detail of details) {
    const group = groups.get(detail.id) ?? { id: detail.id, canPutBack: false, details: [] };
    group.details.push(detail);
    group.canPutBack ||= detail.canPutBack;
    groups.set(detail.id, group);
  }
  return [...groups.values()];
}
