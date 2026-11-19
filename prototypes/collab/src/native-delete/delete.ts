import * as Y from "yjs";
import type { NativeHeadingReplica } from "../native/headings.ts";
import type { NativeBlock } from "../native/variant.ts";

export type DeleteTarget =
  | { rows: readonly string[] }
  | { scene: string }
  | { heading: string; removal: "flag" | "delete" };

function ranges(blocks: readonly NativeBlock[]): { from: number; to: number }[] {
  const result: { from: number; to: number }[] = [];
  for (const { start, end } of blocks) {
    const from = Math.max(0, start - 1), previous = result.at(-1);
    if (previous?.to === from) previous.to = end;
    else if (end > from) result.push({ from, to: end });
  }
  return result;
}

export function deleteNativeRows(
  replica: NativeHeadingReplica, target: DeleteTarget, emptySegment: "keep" | "drop" = "keep"
): void {
  const beats = new Set<string>(), headings = new Set<string>();
  if ("rows" in target) {
    const rows = new Map(replica.rows().map(row => [row.id, row]));
    for (const id of target.rows) {
      const row = rows.get(id);
      if (!row) throw new Error(`No live row ${id}`);
      for (const beat of row.members) beats.add(beat);
    }
  } else {
    const id = "scene" in target ? target.scene : target.heading;
    const outline = replica.outline();
    const at = outline.findIndex(entry => entry.kind === "heading" && entry.id === id);
    const record = replica.headings.get(id);
    if (at < 0 || !record) throw new Error(`No live heading ${id}`);
    if ("heading" in target && target.removal === "flag") {
      replica.transact(() => { record.set("removed", true); });
      return;
    }
    headings.add(id);
    if ("scene" in target) {
      for (const entry of outline.slice(at + 1)) {
        if (entry.kind === "heading") break;
        for (const beat of entry.row.members) beats.add(beat);
      }
    }
  }

  const bySegment = new Map<string, NativeBlock[]>();
  for (const block of replica.naturalBlocks()) {
    const blocks = bySegment.get(block.segment) ?? [];
    blocks.push(block);
    bySegment.set(block.segment, blocks);
  }
  const edits = replica.order.toArray().flatMap((id, index) => {
    const blocks = bySegment.get(id) ?? [];
    const selected = blocks.filter(block => (block.kind === "b" ? beats : headings).has(block.id));
    if (!selected.length) return [];
    const record = replica.segments.get(id), text = record?.get("text");
    if (!record || !(text instanceof Y.Text)) throw new Error(`Missing segment ${id}`);
    return [{ id, index, record, text, ranges: ranges(selected), head: selected[0]?.start === 0,
      drop: emptySegment === "drop" && selected.length === blocks.length }];
  });
  replica.transact(() => {
    for (const { id, index, record, text, ranges, head, drop } of edits.reverse()) {
      if (drop) {
        replica.order.delete(index, 1);
        replica.segments.delete(id);
        continue;
      }
      for (const { from, to } of ranges.reverse()) text.delete(from, to - from);
      if (head) record.delete("head");
    }
    for (const id of beats) {
      replica.beats.delete(id);
      replica.visuals.delete(id);
    }
    for (const id of headings) replica.headings.delete(id);
  });
}
