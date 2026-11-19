import * as Y from "yjs";
import { NativeHeadingReplica } from "../native/headings.ts";
import type { NativeBlock, NativeDeltaItem } from "../native/variant.ts";
import { blockRef } from "./order.ts";

function textOf(replica: NativeHeadingReplica, segment: string): Y.Text {
  const text = replica.segments.get(segment)?.get("text");
  if (!(text instanceof Y.Text)) throw new Error(`Missing text ${segment}`);
  return text;
}

function insertDelta(text: Y.Text, at: number, delta: readonly NativeDeltaItem[]): void {
  for (const item of delta) {
    if (typeof item.insert === "string") { text.insert(at, item.insert, item.attributes ?? {}); at += item.insert.length; }
    else { text.insertEmbed(at, item.insert, item.attributes ?? {}); at += 1; }
  }
}

// why: candidate (a): the beat's narration is copied in front of the target block and the original range is deleted
export function copyMove(replica: NativeHeadingReplica, beat: string, before: string, stamp: string): void {
  const source = replica.block(beat), target = replica.block(before), delta = source.delta, length = 1 + delta.reduce((sum, item) =>
    sum + (typeof item.insert === "string" ? item.insert.length : 1), 0);
  replica.transact(() => {
    let shift = 0;
    if (target.start === 0) {
      const id = `seg-copy-${beat}-${stamp}`, segment = new Y.Map<unknown>(), copy = new Y.Text();
      replica.segments.set(id, segment);
      segment.set("head", { b: beat });
      segment.set("text", copy);
      insertDelta(copy, 0, delta);
      replica.order.insert(replica.order.toArray().indexOf(target.segment), [id]);
    } else {
      const into = textOf(replica, target.segment);
      into.insertEmbed(target.start - 1, { b: beat });
      insertDelta(into, target.start, delta);
      if (target.segment === source.segment && target.start - 1 < source.start) shift = length;
    }
    const text = textOf(replica, source.segment);
    if (source.start === 0) {
      if (source.end > 0) text.delete(shift, source.end);
      replica.segments.get(source.segment)?.delete("head");
    } else text.delete(source.start - 1 + shift, source.end - source.start + 1);
  });
  replica.changes();
}

// why: candidate (c) on segments: the existing order list, with a move as a delete and an insert of the segment's key
export function moveSegmentEntry(replica: NativeHeadingReplica, segment: string, before: string | null): void {
  replica.transact(() => {
    const keys = replica.order.toArray();
    for (let index = keys.length - 1; index >= 0; index--) if (keys[index] === segment) replica.order.delete(index, 1);
    const rest = replica.order.toArray(), at = before === null ? rest.length : rest.indexOf(before);
    replica.order.insert(at < 0 ? rest.length : at, [segment]);
  });
  replica.changes();
}

const POSITION = "pos";

function positionOf(record: Y.Map<unknown> | undefined): number {
  const value = record?.get(POSITION);
  return typeof value === "number" ? value : 0;
}

function sortedBy<T>(items: readonly T[], key: (item: T) => number, tie: (item: T) => string): T[] {
  return [...items].sort((left, right) => key(left) - key(right) || (tie(left) < tie(right) ? -1 : tie(left) > tie(right) ? 1 : 0));
}

// why: candidate (b) on segments: each segment holds a number and segments are read in its order, ties by key
export class SegmentKeyReplica extends NativeHeadingReplica {
  override naturalBlocks(): NativeBlock[] {
    const keys = sortedBy([...new Set(this.order.toArray())], key => positionOf(this.segments.get(key)), key => key);
    const rank = new Map(keys.map((key, index) => [key, index]));
    return sortedBy(super.naturalBlocks(), block => (rank.get(block.segment) ?? 0) * 1e6 + block.start, block => block.id);
  }

  numberSegments(): void {
    this.transact(() => { this.order.toArray().forEach((key, index) => this.segments.get(key)?.set(POSITION, index + 1)); });
  }

  moveSegment(segment: string, between: [number, number]): void {
    this.transact(() => { this.segments.get(segment)?.set(POSITION, (between[0] + between[1]) / 2); });
    this.changes();
  }
}

function blockRecord(replica: NativeHeadingReplica, block: NativeBlock): Y.Map<unknown> | undefined {
  return block.kind === "h" ? replica.headings.get(block.id) : replica.beats.get(block.id);
}

// why: candidate (b) on blocks: every beat and heading holds a number and is shown in its order, ties by id
export class BlockKeyReplica extends NativeHeadingReplica {
  constructor(client: number, removal: "delete" | "flag") {
    super(client, removal);
    this.beats.observeDeep(() => { this.invalidateStructure(); });
  }

  override blocks(): NativeBlock[] {
    return sortedBy(this.naturalBlocks(), block => positionOf(blockRecord(this, block)), block => blockRef(block.kind, block.id));
  }

  numberAll(): void {
    this.transact(() => { this.naturalBlocks().forEach((block, index) => blockRecord(this, block)?.set(POSITION, index + 1)); });
  }

  private between(after: string | null): number {
    const shown = this.blocks(), at = after === null ? -1 : shown.findIndex(block => blockRef(block.kind, block.id) === after);
    const left = at < 0 ? 0 : positionOf(blockRecord(this, shown[at] as NativeBlock)), next = shown[at + 1];
    return (left + (next ? positionOf(blockRecord(this, next)) : left + 2)) / 2;
  }

  splitKeyed(beat: string, offset: number, created: string): void {
    const value = this.between(blockRef("b", beat));
    this.transact(() => { this.split(beat, offset, created); this.beats.get(created)?.set(POSITION, value); });
    this.changes();
  }

  moveKeyed(ref: string, after: string | null): void {
    const value = this.between(after), id = ref.slice(2);
    this.transact(() => { (ref.startsWith("h:") ? this.headings : this.beats).get(id)?.set(POSITION, value); });
    this.changes();
  }
}

// why: candidate (c) on blocks: one list of block keys gives the shown order; a key listed twice counts at its first
export class BlockListReplica extends NativeHeadingReplica {
  constructor(client: number, removal: "delete" | "flag") {
    super(client, removal);
    this.list.observe(() => { this.invalidateStructure(); });
  }

  get list(): Y.Array<string> { return this.doc.getArray("rows"); }

  override blocks(): NativeBlock[] {
    const byRef = new Map(this.naturalBlocks().map(block => [blockRef(block.kind, block.id), block]));
    return [...new Set(this.list.toArray())].flatMap(ref => { const block = byRef.get(ref); return block ? [block] : []; });
  }

  listAll(): void {
    this.transact(() => { this.list.push(this.naturalBlocks().map(block => blockRef(block.kind, block.id))); });
  }

  splitListed(beat: string, offset: number, created: string): void {
    this.transact(() => {
      this.split(beat, offset, created);
      this.list.insert(this.list.toArray().indexOf(blockRef("b", beat)) + 1, [blockRef("b", created)]);
    });
    this.changes();
  }

  moveListed(ref: string, after: string | null): void {
    this.transact(() => {
      const keys = this.list.toArray();
      for (let index = keys.length - 1; index >= 0; index--) if (keys[index] === ref) this.list.delete(index, 1);
      this.list.insert(after === null ? 0 : this.list.toArray().indexOf(after) + 1, [ref]);
    });
    this.changes();
  }
}
