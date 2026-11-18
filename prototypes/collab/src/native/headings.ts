import * as Y from "yjs";
import { NativeReplica } from "./variant.ts";
import type { NativeBlock, NativeDeltaItem, NativeRow } from "./variant.ts";

export type NativeHeadingRemoval = "delete" | "flag";
export interface NativeHeading {
  kind: "heading";
  id: string;
  name: NativeDeltaItem[];
}
export type NativeOutlineEntry = NativeHeading | { kind: "row"; row: NativeRow };

export class NativeHeadingReplica extends NativeReplica {
  readonly headingRemoval: NativeHeadingRemoval;

  constructor(client: number, headingRemoval: NativeHeadingRemoval) {
    super(client);
    this.headingRemoval = headingRemoval;
    this.reading = "contiguous";
    this.headings.observeDeep(() => { this.invalidateStructure(); });
  }

  get headings(): Y.Map<Y.Map<unknown>> { return this.doc.getMap("headings"); }

  createHeading(beat: string, id: string, name: string): void {
    if (this.headings.has(id)) throw new Error(`Heading ${id} already exists`);
    const { text, start } = this.cell(beat, "audioText");
    this.transact(() => {
      this.headings.set(id, new Y.Map());
      if (start === 0) {
        const { segment } = this.block(beat);
        this.addSegment(`seg-h-${id}`, { h: id }, [{ text: name, marks: {} }], this.order.toArray().indexOf(segment));
      } else {
        text.insertEmbed(start - 1, { h: id });
        text.insert(start, name, {});
      }
    });
  }

  private headingCell(block: NativeBlock): Y.Text {
    const text = this.segments.get(block.segment)?.get("text");
    if (!(text instanceof Y.Text)) throw new Error(`Missing heading text ${block.id}`);
    return text;
  }

  typeHeading(id: string, offset: number, value: string): void {
    const block = this.block(id, "h");
    if (this.isRemoved(id) || offset < 0 || block.start + offset > block.end) throw new Error(`Cannot type in heading ${id}`);
    this.transact(() => { this.headingCell(block).insert(block.start + offset, value, {}); });
  }

  deleteHeadingText(id: string, from: number, to: number): void {
    const block = this.block(id, "h");
    if (this.isRemoved(id) || from < 0 || to < from || block.start + to > block.end) throw new Error(`Cannot delete in heading ${id}`);
    this.transact(() => { this.headingCell(block).delete(block.start + from, to - from); });
  }

  removeHeading(id: string): void {
    const block = this.block(id, "h");
    this.transact(() => {
      if (this.headingRemoval === "flag") {
        const record = this.headings.get(id);
        if (!record) throw new Error(`Missing heading record ${id}`);
        record.set("removed", true);
      } else if (block.start === 0) this.segments.get(block.segment)?.delete("head");
      else this.headingCell(block).delete(block.start - 1, 1);
    });
  }

  restoreHeading(id: string): void {
    const record = this.headings.get(id);
    if (record?.get("removed") !== true) throw new Error(`Heading ${id} has no recovery entry`);
    this.transact(() => { record.delete("removed"); });
  }

  private isRemoved(id: string): boolean { return this.headings.get(id)?.get("removed") === true; }

  protected override breaksContiguousGroup = (heading: string): boolean => !this.isRemoved(heading);

  outline(): NativeOutlineEntry[] {
    const rows = new Map(this.rows().map(row => [row.id, row])), outline: NativeOutlineEntry[] = [];
    for (const block of this.blocks()) {
      if (block.kind === "h") {
        if (!this.isRemoved(block.id)) outline.push({ kind: "heading", id: block.id, name: block.delta });
      } else {
        const row = rows.get(block.id);
        if (row) outline.push({ kind: "row", row });
      }
    }
    return outline;
  }

  headingRecovery(): NativeHeading[] {
    return this.blocks().filter(block => block.kind === "h" && this.isRemoved(block.id))
      .map(block => ({ kind: "heading", id: block.id, name: block.delta }));
  }
}
