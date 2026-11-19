import * as Y from "yjs";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { STRAY_ROW } from "../../src/native/variant.ts";
import type { NativeDeltaItem } from "../../src/native/variant.ts";

const isBoundary = (insert: unknown): boolean => !!insert && typeof insert === "object" && ("b" in insert || "h" in insert);

export interface Reach { problems: string[]; shownTwice: string[]; unshown: string[]; unplacedVisual: string[]; doubled: string[] }

// why: the never-acceptable checks: every live narration or name letter stored in a listed segment is shown exactly
// once, through the spans an editor uses, no beat is shown twice, and every shown beat has its visual cell
export function reachability(replica: ChosenReplica): Reach {
  const result: Reach = { problems: [], shownTwice: [], unshown: [], unplacedVisual: [], doubled: [] };
  const cover = new Map<Y.Text, number[]>(), shownBeats = new Map<string, number>();
  const mark = (owner: string, kind: "b" | "h"): string => {
    let text = "";
    for (const span of replica.spansOf(owner, "audioText", kind)) {
      const counts = cover.get(span.text) ?? new Array<number>(span.text.length).fill(0);
      cover.set(span.text, counts);
      const units = (span.text.toDelta() as NativeDeltaItem[]).flatMap(item => typeof item.insert === "string" ? [...item.insert] : [isBoundary(item.insert) ? null : "□"]);
      for (let index = span.start; index < span.end; index++) {
        counts[index] = (counts[index] ?? 0) + 1;
        const unit = units[index];
        if (unit === null || unit === undefined) result.problems.push(`${owner} shows a boundary at ${index}`);
        else text += unit;
      }
    }
    return text;
  };
  for (const entry of replica.outline()) {
    if (entry.kind === "heading") {
      const stored = mark(entry.id, "h"), shown = entry.name.map(item => typeof item.insert === "string" ? item.insert : "□").join("");
      if (stored !== shown) result.problems.push(`heading ${entry.id} shows ${shown}, its editor reaches ${stored}`);
      continue;
    }
    const { row } = entry;
    let offset = 0;
    const shown = row.audio.map(item => typeof item.insert === "string" ? item.insert : "□").join("");
    for (const part of row.parts.audio) {
      const piece = shown.slice(offset, offset + part.length);
      offset += part.length;
      if (part.beat === null) continue;
      shownBeats.set(part.beat, (shownBeats.get(part.beat) ?? 0) + 1);
      const stored = mark(part.beat, "b");
      if (stored !== piece) result.problems.push(`row ${row.id} shows ${piece} for ${part.beat}, its editor reaches ${stored}`);
      if (part.beat !== STRAY_ROW && !replica.visuals.has(part.beat)) result.problems.push(`beat ${part.beat} has no visual cell`);
      if (part.beat !== STRAY_ROW && !replica.beats.has(part.beat)) result.problems.push(`beat ${part.beat} has no record`);
    }
    if (offset !== shown.length) result.problems.push(`row ${row.id} parts cover ${offset} of ${shown.length}`);
  }
  for (const heading of replica.headingRecovery()) mark(heading.id, "h");
  for (const [beat, count] of shownBeats) if (count > 1) result.shownTwice.push(beat);
  const listed = new Set(replica.order.toArray());
  for (const [id, record] of replica.segments) {
    const text = record.get("text");
    if (!(text instanceof Y.Text)) continue;
    const counts = cover.get(text) ?? [];
    let index = 0;
    for (const item of text.toDelta() as NativeDeltaItem[]) {
      const length = typeof item.insert === "string" ? item.insert.length : 1;
      for (let at = 0; at < length; at++, index++) {
        if (isBoundary(item.insert)) { if (counts[index]) result.problems.push(`boundary in ${id} at ${index} is shown`); continue; }
        const char = typeof item.insert === "string" ? item.insert.charAt(at) : "□";
        const count = counts[index] ?? 0;
        if (!listed.has(id) || !count) result.unshown.push(`${char}@${id}:${index}`);
        else if (count > 1) result.problems.push(`${char}@${id}:${index} shown ${count} times`);
      }
    }
  }
  for (const [beat, text] of replica.visuals) if (text.length && !shownBeats.has(beat)) result.unplacedVisual.push(`${beat}:${text.toString()}`);
  const letters = new Map<string, number>();
  for (const [, record] of replica.segments) {
    const text = record.get("text");
    if (text instanceof Y.Text) for (const char of text.toString()) if (char !== "￼") letters.set(char, (letters.get(char) ?? 0) + 1);
  }
  for (const [char, count] of letters) if (count > 1 && (char.codePointAt(0) ?? 0) >= 0x100) result.doubled.push(char);
  return result;
}

export function neverAcceptable(reach: Reach): string[] {
  return [...reach.problems, ...reach.shownTwice.map(beat => `beat ${beat} shown twice`), ...reach.unshown.map(char => `narration ${char} shown nowhere`)];
}

export interface CopyReading { outline: string[]; stored: unknown }

export function storedReading(replica: ChosenReplica): unknown {
  return {
    order: replica.order.toArray(),
    segments: Object.fromEntries([...replica.segments].map(([id, record]) => [id, { head: record.get("head") ?? null, text: (record.get("text") as Y.Text | undefined)?.toDelta() ?? [] }])),
    beats: replica.beats.toJSON(), headings: replica.headings.toJSON(),
    visuals: Object.fromEntries([...replica.visuals].map(([id, text]) => [id, text.toDelta()]))
  };
}
