import * as Y from "yjs";
import { NativeHeadingReplica } from "../native/headings.ts";
import type { NativeBlock, NativeDeltaItem } from "../native/variant.ts";
import { planMove, recordOf } from "./moves.ts";
import { blockRef } from "./order.ts";
import type { Arrangement } from "./order.ts";

export const MOVE_DESIGNS = ["flat", "run", "placement"] as const;
export type MoveDesign = typeof MOVE_DESIGNS[number];

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const FLAT = "e10Rank";
const BASE_RANK = "e10Base";
const CUT = "e10Cut:";

interface RankedCut { rank: string; at: Uint8Array }
interface RankGroup { head: string; rank: string }
interface RankPiece { head: string; old: RankGroup | undefined; fixed: string | null }
export interface RankDrop { unit: "row" | "rows" | "scene"; first: string; last?: string; target: string | null; after: boolean; intoScene?: string }

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

function digits(value: number, width: number): string {
  let result = "";
  for (let i = 0; i < width; i++) {
    result = DIGITS[value % BASE] + result;
    value = Math.floor(value / BASE);
  }
  if (value !== 0) throw new RangeError("Rank component exceeded its width");
  return result;
}

export function betweenRanks(left: string | null, right: string | null, client: number, serial: number): string {
  if (left !== null && right !== null && left >= right) throw new Error("A rank gap must be open");
  let prefix = "";
  for (let i = 0; ; i++) {
    const lo = DIGITS.indexOf(left?.[i] ?? "0");
    const hi = DIGITS.indexOf(right?.[i] ?? "z");
    if (hi - lo > 1) return prefix + DIGITS[Math.floor((lo + hi) / 2)] + digits(client, 6) + digits(serial, 7) + "V";
    prefix += DIGITS[lo];
    if (hi > lo) right = null;
  }
}

const ref = (block: NativeBlock): string => blockRef(block.kind, block.id);
const initialRank = (index: number): string => digits((index + 1) * 32, 6) + "V";

function boundary(block: NativeBlock): number { return Math.max(0, block.start - 1); }

export class MoveReplica extends NativeHeadingReplica {
  readonly design: MoveDesign;
  private serial = 0;

  constructor(client: number, design: MoveDesign) {
    super(client, "flag");
    this.design = design;
    if (design === "flat") this.beats.observeDeep(events => {
      if (events.some(event => event instanceof Y.YMapEvent && event.keysChanged.has(FLAT))) this.invalidateStructure();
    });
  }

  initializeRanks(): void {
    const natural = this.naturalBlocks();
    this.doc.transact(() => {
      if (this.design === "flat") natural.forEach((block, index) => recordOf(this, ref(block)).set(FLAT, initialRank(index)));
      if (this.design === "run") this.order.toArray().forEach((segment, index) => this.segments.get(segment)?.set(BASE_RANK, initialRank(index)));
    }, "hydration");
  }

  private nextRank(left: string | null, right: string | null): string {
    return betweenRanks(left, right, this.doc.clientID, ++this.serial);
  }

  private text(segment: string): Y.Text {
    const text = this.segments.get(segment)?.get("text");
    if (!(text instanceof Y.Text)) throw new Error(`Missing segment text ${segment}`);
    return text;
  }

  private groupsOf(natural: NativeBlock[]): Map<string, RankGroup> {
    const groups = new Map<string, RankGroup>();
    if (this.design === "flat") {
      for (const block of natural) {
        const head = ref(block), rank = recordOf(this, head).get(FLAT);
        if (typeof rank !== "string") throw new Error(`Missing rank for ${head}`);
        groups.set(head, { head, rank });
      }
      return groups;
    }

    const live = new Set(natural.map(ref));
    let segmentId = "", group: RankGroup | undefined, lost: { at: number; key: string; rank: string }[] = [], cursor = 0;
    for (const block of natural) {
      const head = ref(block), segment = required(this.segments.get(block.segment), "segment");
      if (segmentId !== block.segment) {
        segmentId = block.segment;
        const base = segment.get(BASE_RANK);
        if (typeof base !== "string") throw new Error(`Missing base rank for ${segmentId}`);
        group = { head, rank: base };
        cursor = 0;
        lost = [];
        for (const [key, value] of segment) {
          if (!key.startsWith(CUT) || live.has(key.slice(CUT.length))) continue;
          const cut = value as RankedCut;
          // why: redo links are local to the editing copy, so every reader resolves the same stored cut.
          const at = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(cut.at), this.doc, false);
          if (at?.type === this.text(segmentId)) lost.push({ at: at.index, key, rank: cut.rank });
        }
        lost.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
      }
      for (let cut = lost[cursor]; cut && cut.at <= boundary(block); cut = lost[++cursor]) group = { head, rank: cut.rank };
      const cut = segment.get(CUT + head) as RankedCut | undefined;
      if (cut) group = { head, rank: cut.rank };
      groups.set(head, required(group, "current rank group"));
    }
    return groups;
  }

  private rankedBlocks(natural: NativeBlock[], groups: Map<string, RankGroup>): NativeBlock[] {
    return natural.map(block => ({ block, rank: required(groups.get(ref(block)), "block rank").rank }))
      .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0).map(item => item.block);
  }

  override blocks(): NativeBlock[] {
    if (this.design === "placement") return super.blocks();
    const natural = this.naturalBlocks();
    return this.rankedBlocks(natural, this.groupsOf(natural));
  }

  override arrangement(): Arrangement {
    if (this.design === "placement") return super.arrangement();
    return { order: this.blocks().map(ref), parent: new Map(), placed: new Map(), leader: new Map() };
  }

  private writeRank(block: NativeBlock, rank: string): void {
    const head = ref(block);
    if (this.design === "flat") {
      recordOf(this, head).set(FLAT, rank);
      return;
    }
    const segment = required(this.segments.get(block.segment), "cut's segment");
    const at = Y.createRelativePositionFromTypeIndex(this.text(block.segment), boundary(block), block.start === 0 ? -1 : 0);
    segment.set(CUT + head, { rank, at: Y.encodeRelativePosition(at) } satisfies RankedCut);
  }

  private planRanks(order: string[], moving: Set<string>, groups: Map<string, RankGroup>, natural: NativeBlock[]): { head: string; rank: string }[] {
    const pieces: RankPiece[] = [];
    const kept = new Set<RankGroup>();
    const before = new Map(natural.map((block, index) => {
      const previous = natural[index - 1];
      return [ref(block), previous && ref(previous)] as const;
    }));
    let previous: RankGroup | undefined, previousRef: string | undefined, wasMoving = false;
    for (const head of order) {
      const old = groups.get(head), moves = moving.has(head);
      if (!(old && old === previous && moves === wasMoving && before.get(head) === previousRef)) {
        const fixed = !moves && old && !kept.has(old) ? old.rank : null;
        if (old && fixed !== null) kept.add(old);
        pieces.push({ head, old, fixed });
      }
      previous = old;
      previousRef = head;
      wasMoving = moves;
    }
    const writes: { head: string; rank: string }[] = [];
    let left: string | null = null;
    for (let index = 0; index < pieces.length;) {
      const piece = required(pieces[index], "run piece");
      if (piece.fixed !== null) {
        left = piece.fixed;
        if (piece.old?.head !== piece.head) writes.push({ head: piece.head, rank: left });
        index++;
        continue;
      }
      let stop = index + 1;
      // why: equal ranks read in text order, so opening a gap between them needs a fresh rank for the right tie.
      while (stop < pieces.length) {
        const fixed = required(pieces[stop], "next run piece").fixed;
        if (fixed !== null && (left === null || fixed > left)) break;
        stop++;
      }
      const right = pieces[stop]?.fixed ?? null;
      for (; index < stop; index++) {
        left = this.nextRank(left, right);
        writes.push({ head: required(pieces[index], "run piece").head, rank: left });
      }
    }
    return writes;
  }

  moveRefs(first: string, last: string, after: string | null): boolean {
    if (this.design === "placement") {
      const plan = planMove(this, first, last, after, false);
      if (!plan) return false;
      this.transact(() => {
        for (const { ref: id, place } of plan.writes) recordOf(this, id).set("place", place);
      });
    } else {
      const natural = this.naturalBlocks(), groups = this.groupsOf(natural), shown = this.rankedBlocks(natural, groups).map(ref);
      const from = shown.indexOf(first), to = shown.indexOf(last), members = shown.slice(from, to + 1), moving = new Set(members);
      if (from < 0 || to < from || (after !== null && !shown.includes(after))) throw new Error("Unknown drop");
      if ((shown[from - 1] ?? null) === after || after === last) return false;
      if (after !== null && moving.has(after)) throw new Error("Drop inside the moving range");
      const target = shown.filter(id => !moving.has(id)), byRef = new Map(natural.map(block => [ref(block), block]));
      target.splice(after === null ? 0 : target.indexOf(after) + 1, 0, ...members);
      const writes = this.planRanks(target, moving, groups, natural);
      this.transact(() => {
        for (const { head, rank } of writes) this.writeRank(required(byRef.get(head), "drop block"), rank);
      });
    }
    return true;
  }

  drop(command: RankDrop): boolean {
    const order = command.unit === "scene" || (!command.after && !command.intoScene) ? this.arrangement().order : [];
    const rows = command.unit === "scene" ? [] : this.rows();
    const ends = (id: string): [string, string] => {
      if (command.unit === "scene") {
        const start = order.indexOf(`h:${id}`);
        if (start < 0 || this.headings.get(id)?.get("removed")) throw new Error(`Missing scene ${id}`);
        let end = start + 1;
        for (let next = order[end]; next; next = order[++end]) {
          if (next.startsWith("h:") && !this.headings.get(next.slice(2))?.get("removed")) break;
        }
        return [`h:${id}`, required(order[end - 1], "scene end")];
      }
      const row = rows.find(item => item.id === id);
      if (!row) throw new Error(`Missing row ${id}`);
      return [`b:${row.members[0]}`, `b:${row.members.at(-1)}`];
    };
    const [first, last] = ends(command.first);
    const end = command.last === undefined ? last : ends(command.last)[1];
    if (command.intoScene !== undefined) return this.moveRefs(first, end, blockRef("h", command.intoScene));
    const target = command.target === null ? null : ends(command.target);
    return this.moveRefs(first, end, !target ? null : command.after ? target[1] : order[order.indexOf(target[0]) - 1] ?? null);
  }

  override split(beat: string, offset: number, created: string, fields: Record<string, unknown> = {}): void {
    const additions = this.design === "flat" ? { ...fields, [FLAT]: recordOf(this, `b:${beat}`).get(FLAT) } : fields;
    super.split(beat, offset, created, additions);
  }

  override createHeading(beat: string, id: string, name: string): void {
    if (this.design === "placement") {
      super.createHeading(beat, id, name);
      return;
    }
    const natural = this.naturalBlocks(), groups = this.groupsOf(natural), order = this.rankedBlocks(natural, groups).map(ref);
    const heading = `h:${id}`, target = `b:${beat}`, byRef = new Map(natural.map(block => [ref(block), block]));
    const block = required(byRef.get(target), "beat after new heading");
    order.splice(order.indexOf(target), 0, heading);
    const writes = this.planRanks(order, new Set([heading]), groups, natural);
    this.transact(() => {
      super.createHeading(beat, id, name);
      const standalone = block.start === 0, segment = standalone ? `seg-h-${id}` : block.segment;
      byRef.set(heading, { id, kind: "h", segment, start: block.start, end: 0, delta: [] });
      if (standalone && this.design === "run") {
        const rank = required(writes.find(write => write.head === heading), "heading rank").rank;
        required(this.segments.get(segment), "heading segment").set(BASE_RANK, rank);
      }
      for (const { head, rank } of writes) {
        if (standalone && this.design === "run" && head === heading) continue;
        if (!standalone && this.design === "run" && head === target && groups.get(target)?.head !== target) continue;
        const item = required(byRef.get(head), "ranked block");
        const shifted = !standalone && head !== heading && item.segment === segment && item.start >= block.start;
        this.writeRank(shifted ? { ...item, start: item.start + name.length + 1 } : item, rank);
      }
    });
  }

  deleteBeat(id: string): void {
    const block = this.block(id), text = this.text(block.segment), start = boundary(block);
    this.transact(() => {
      if (block.start === 0) required(this.segments.get(block.segment), "deleted beat's segment").delete("head");
      if (block.end > start) text.delete(start, block.end - start);
      this.beats.delete(id);
      this.visuals.delete(id);
    });
  }

  unownedNarration(): NativeDeltaItem[] {
    const orphaned: NativeDeltaItem[] = [];
    for (const segment of this.segments.values()) {
      const text = segment.get("text");
      if (segment.has("head") || !(text instanceof Y.Text)) continue;
      for (const item of text.toDelta() as NativeDeltaItem[]) {
        if (typeof item.insert !== "string" && ("b" in item.insert || "h" in item.insert)) break;
        orphaned.push(item);
      }
    }
    return orphaned;
  }
}
