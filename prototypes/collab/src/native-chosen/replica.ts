import * as Y from "yjs";
import type { Run } from "../../../../src/core/text/runs.ts";
import type { NativeHeading, NativeOutlineEntry } from "../native/headings.ts";
import { MoveReplica, betweenRanks } from "../native-moves/ranks.ts";
import type { RankDrop } from "../native-moves/ranks.ts";
import { ALL_RULES, STRAY_ROW, nativeAttributes, nativeEmbed, nativeMarkName } from "../native/variant.ts";
import type { NativeBlock, NativeDeltaItem, NativeField, NativeRules } from "../native/variant.ts";

const isTag = (name: string): boolean => name.startsWith("t:");

export interface ChosenCut { text: Y.Text; from: number; to: number }
export type ChosenNames = "inline" | "cells";

export class ChosenReplica extends MoveReplica {
  private count = 0;

  private rankReads = 0;

  constructor(client: number, rules: NativeRules = ALL_RULES, names: ChosenNames = "inline") {
    super(client, "flat");
    this.keepCreated = false;
    this.copyFreeSplit = true;
    this.nameCells = names === "cells";
    this.rules = rules;
  }

  get nameStore(): ChosenNames { return this.nameCells ? "cells" : "inline"; }

  // why: rule (e): Yjs does not redo a map entry a newer write replaced, so a restored record can lack its rank; that
  // beat is read between the ranked neighbours of its stored place, and nothing is written
  protected override groupsOf(natural: NativeBlock[]): Map<string, { head: string; rank: string }> {
    const ranks = natural.map(block => this.storedRank(block.kind, block.id));
    if (!this.rules.rank || ranks.every(rank => typeof rank === "string")) return super.groupsOf(natural);
    this.rankReads++;
    const groups = new Map<string, { head: string; rank: string }>();
    for (const [index, block] of natural.entries()) {
      const head = `${block.kind}:${block.id}`, own = ranks[index];
      if (typeof own === "string") { groups.set(head, { head, rank: own }); continue; }
      const left = ranks.slice(0, index).findLast((rank): rank is string => typeof rank === "string") ?? null;
      let right = ranks.slice(index + 1).find((rank): rank is string => typeof rank === "string") ?? null;
      if (left !== null && (right === null || left >= right)) right = ranks.filter((rank): rank is string => typeof rank === "string" && rank > left).sort()[0] ?? null;
      const rank = betweenRanks(left, right, 0, index + 1);
      ranks[index] = rank;
      // why: a group led by another head makes a move or a new heading write this rank, so the beat stays where it was shown
      groups.set(head, { head: `${head}?`, rank });
    }
    return groups;
  }

  override ruleUse(): Record<keyof NativeRules, number> {
    return { ...super.ruleUse(), rank: this.rankReads };
  }

  // why: decision 1: a plain key per simple mark, a key per application for tags, and an explicit attributes object
  // on every insert
  private readonly writeChosen = (text: Y.Text, index: number, runs: readonly Run[], left: Record<string, unknown> | null): number => {
    let beside = left;
    for (const run of runs) {
      const names = Object.keys(nativeAttributes(run.marks)), attributes: Record<string, true> = {};
      for (const name of names) {
        if (!isTag(name)) { attributes[name] = true; continue; }
        const kept = Object.keys(beside ?? {}).filter(key => beside?.[key] === true && nativeMarkName(key) === name);
        for (const key of kept.length ? kept : [this.actKey(name)]) attributes[key] = true;
      }
      const embed = nativeEmbed(run);
      if (embed) { text.insertEmbed(index, embed, attributes); index += 1; }
      else if (run.text) { text.insert(index, run.text, attributes); index += run.text.length; }
      else continue;
      beside = attributes;
    }
    return index;
  };

  override splice(beat: string, field: NativeField, from: number, to: number, insert: readonly Run[]): void {
    if (beat === STRAY_ROW && field === "visualText") {
      this.transact(() => {
        const claim = this.materialize(`${STRAY_ROW}:${this.doc.clientID}.${++this.count}`);
        this.spliceSpans(claim, field, from, to, insert, "b", this.writeChosen);
      });
      return;
    }
    this.spliceSpans(beat, field, from, to, insert, "b", this.writeChosen);
  }

  override format(beat: string, field: NativeField, from: number, to: number, marks: Record<string, true | null>): void {
    this.transact(() => {
      const spans = this.spansOf(beat, field), pieces = this.pieces(spans, from, to);
      const keys = Object.fromEntries(Object.keys(marks).filter(isTag).map(name => [name, this.actKey(name)]));
      for (const piece of pieces) {
        const attributes: Record<string, true | null> = {};
        for (const [name, value] of Object.entries(marks)) {
          if (!isTag(name)) attributes[name] = value;
          else if (value) attributes[keys[name] as string] = true;
          else for (const key of this.heldKeys(piece.text, piece.from, piece.to)) if (nativeMarkName(key) === name) attributes[key] = null;
        }
        if (Object.keys(attributes).length) piece.text.format(piece.from, piece.to - piece.from, attributes);
      }
    });
  }

  private heldKeys(text: Y.Text, from: number, to: number): Set<string> {
    const held = new Set<string>();
    let index = 0;
    for (const item of text.toDelta() as NativeDeltaItem[]) {
      const next = index + (typeof item.insert === "string" ? item.insert.length : 1);
      if (next > from && index < to) for (const [key, value] of Object.entries(item.attributes ?? {})) if (value === true) held.add(key);
      index = next;
    }
    return held;
  }

  override typeHeading(id: string, offset: number, value: string): void {
    if (this.headings.get(id)?.get("removed") === true) throw new Error(`Cannot type in heading ${id}`);
    if (this.nameCells) { this.transact(() => { this.writeChosen(this.nameCell(id, offset), offset, [{ text: value, marks: {} }], null); }); return; }
    this.spliceSpans(id, "audioText", offset, offset, [{ text: value, marks: {} }], "h", this.writeChosen);
  }

  override deleteHeadingText(id: string, from: number, to: number): void {
    if (this.headings.get(id)?.get("removed") === true) throw new Error(`Cannot delete in heading ${id}`);
    if (this.nameCells) { this.transact(() => { this.nameCell(id, to).delete(from, to - from); }); return; }
    this.spliceSpans(id, "audioText", from, to, [], "h", this.writeChosen);
  }

  private nameCell(id: string, reach: number): Y.Text {
    const cell = this.names.get(id);
    if (!cell || reach > cell.length) throw new Error(`Range outside heading ${id}`);
    return cell;
  }

  override outline(): NativeOutlineEntry[] {
    const entries = super.outline();
    return this.nameCells ? entries.map(entry => entry.kind === "heading" ? { ...entry, name: this.nameDelta(entry.id) } : entry) : entries;
  }

  override headingRecovery(): NativeHeading[] {
    const hidden = super.headingRecovery();
    return this.nameCells ? hidden.map(heading => ({ ...heading, name: this.nameDelta(heading.id) })) : hidden;
  }

  private nameDelta(id: string): NativeDeltaItem[] { return (this.names.get(id)?.toDelta() ?? []) as NativeDeltaItem[]; }

  override split(beat: string, offset: number, created: string, fields: Record<string, unknown> = {}): void {
    if (beat !== STRAY_ROW) { super.split(beat, offset, created, fields); return; }
    this.transact(() => { super.split(this.materialize(`${created}^`), offset, created, fields); });
  }

  override setField(beat: string, field: string, value: unknown): void {
    if (beat !== STRAY_ROW) { super.setField(beat, field, value); return; }
    this.transact(() => { super.setField(this.materialize(`${STRAY_ROW}:${this.doc.clientID}.${++this.count}`), field, value); });
  }

  override createHeading(beat: string, id: string, name: string): void {
    if (beat !== STRAY_ROW) { super.createHeading(beat, id, name); return; }
    this.transact(() => { super.createHeading(this.materialize(`${id}^`), id, name); });
  }

  override drop(command: RankDrop): boolean {
    if (command.first !== STRAY_ROW && command.target !== STRAY_ROW) return super.drop(command);
    let moved = false;
    this.transact(() => {
      const claim = this.materialize(`${STRAY_ROW}:${this.doc.clientID}.${++this.count}`);
      moved = super.drop({ ...command, first: command.first === STRAY_ROW ? claim : command.first, target: command.target === STRAY_ROW ? claim : command.target });
    });
    return moved;
  }

  // why: the narration-only row has no record; the smallest write that gives it one is a boundary before its first
  // letter, a record and a visual cell. Its rank sorts first, where the row was shown
  materialize(claim: string): string {
    const spans = this.spansOf(STRAY_ROW, "audioText"), first = spans[0];
    if (!first) throw new Error("No narration-only row to give a record");
    const ranks = this.naturalBlocks().map(block => this.storedRank(block.kind, block.id)).filter((rank): rank is string => typeof rank === "string").sort();
    const rank = betweenRanks(null, ranks[0] ?? null, this.doc.clientID, ++this.count);
    this.creating?.(`b:${claim}`, rank);
    this.transact(() => {
      first.text.insertEmbed(first.start, this.marker("b", claim), {});
      const record = new Y.Map<unknown>();
      this.beats.set(claim, record);
      this.writeFlat(record, rank);
      this.visuals.set(claim, new Y.Text());
    });
    this.forgetViews();
    return claim;
  }

  storedRank(kind: "b" | "h", id: string): unknown {
    const record = (kind === "h" ? this.headings : this.beats).get(id);
    return record ? this.readFlat(record) : undefined;
  }

  // why: decision 2: a row is deleted by cutting its text with its boundaries and deleting its record and visual cell;
  // the segment stays, so text written into it unseen is kept and read by rule (a)
  deleteRows(ids: readonly string[]): void {
    const rows = new Map(this.rows().map(row => [row.id, row])), beats: string[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) throw new Error(`No live row ${id}`);
      beats.push(...row.members);
    }
    const cuts = new Map<Y.Text, { from: number; to: number }[]>(), heads = new Set<Y.Map<unknown>>();
    for (const beat of beats) for (const span of this.spansOf(beat, "audioText")) {
      // why: rule (f) shows a heading's following text in a beat; deleting that beat keeps the heading's boundary
      const ours = !span.opener?.startsWith("h:"), from = span.boundary === "embed" && ours ? span.start - 1 : span.start;
      if (span.boundary === "head" && span.record && ours) heads.add(span.record);
      if (span.end > from) cuts.set(span.text, [...cuts.get(span.text) ?? [], { from, to: span.end }]);
    }
    this.transact(() => {
      for (const [text, ranges] of cuts) {
        const merged: { from: number; to: number }[] = [];
        for (const range of ranges.toSorted((a, b) => a.from - b.from)) {
          const last = merged.at(-1);
          if (last && range.from <= last.to) last.to = Math.max(last.to, range.to); else merged.push({ ...range });
        }
        for (const { from, to } of merged.reverse()) text.delete(from, to - from);
      }
      for (const record of heads) record.delete("head");
      for (const beat of beats) {
        if (beat === STRAY_ROW) continue;
        this.beats.delete(beat);
        this.visuals.delete(beat);
      }
    });
  }

  insertBeat(before: string, id: string, value: string, fields: Record<string, unknown> = {}): void {
    const block = this.block(before), shown = this.blocks(), at = shown.findIndex(item => item.kind === "b" && item.id === before);
    const above = shown[at - 1], right = this.storedRank("b", before), left = above ? this.storedRank(above.kind, above.id) : null;
    const rank = typeof right === "string" && (left === null || (typeof left === "string" && left < right))
      ? betweenRanks(left as string | null, right, this.doc.clientID, ++this.count) : right;
    this.creating?.(`b:${id}`, rank, `b:${before}`);
    this.transact(() => {
      this.addSegment(`seg-b-${id}`, this.marker("b", id), [{ text: value, marks: {} }], this.order.toArray().indexOf(block.segment));
      const record = new Y.Map<unknown>();
      this.beats.set(id, record);
      for (const [key, item] of Object.entries(fields)) record.set(key, item);
      this.writeFlat(record, rank);
      this.visuals.set(id, new Y.Text());
    });
  }

  undoPress(): boolean { return this.undo.undo() !== null; }

  redoPress(): boolean { return this.undo.redo() !== null; }
}
