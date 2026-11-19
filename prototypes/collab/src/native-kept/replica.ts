import type * as Y from "yjs";
import type { Run } from "../../../../src/core/text/runs.ts";
import { ChosenReplica } from "../native-chosen/replica.ts";
import type { RankDrop } from "../native-moves/ranks.ts";
import { ALL_RULES, STRAY_ROW } from "../native/variant.ts";
import type { NativeDeltaItem, NativeField, NativeRules, NativeUndoOutcome } from "../native/variant.ts";

export interface KeptReading {
  fields: Record<string, unknown>;
  visual: NativeDeltaItem[];
}

export class KeptReplica extends ChosenReplica {
  constructor(client: number, rules: NativeRules = ALL_RULES) {
    super(client, rules, "cells");
  }

  protected live(id: string): boolean {
    try {
      this.block(id);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === `Missing beat ${id}`) return false;
      throw error;
    }
  }

  protected orphan(id: string): boolean {
    return id !== STRAY_ROW && (this.beats.has(id) || this.visuals.has(id)) && !this.live(id);
  }

  protected available(id: string): boolean {
    return !this.beats.has(id) && !this.visuals.has(id) && !this.live(id);
  }

  readOrphan(id: string): KeptReading | null {
    if (!this.orphan(id)) return null;
    return structuredClone({
      fields: this.beats.get(id)?.toJSON() ?? {},
      visual: this.visuals.get(id)?.toDelta() ?? []
    });
  }

  override cell(id: string, field: NativeField): ReturnType<ChosenReplica["cell"]> {
    if (field === "visualText" && this.orphan(id)) throw new Error(`Missing visual ${id}`);
    return super.cell(id, field);
  }

  override splice(id: string, field: NativeField, from: number, to: number, insert: readonly Run[]): void {
    if (!this.orphan(id)) super.splice(id, field, from, to, insert);
  }

  override format(id: string, field: NativeField, from: number, to: number, marks: Record<string, true | null>): void {
    if (!this.orphan(id)) super.format(id, field, from, to, marks);
  }

  override setField(id: string, field: string, value: unknown): void {
    if (!this.orphan(id)) super.setField(id, field, value);
  }

  override join(from: string, into: string, glue: string): void {
    if (!this.orphan(from) && !this.orphan(into)) super.join(from, into, glue);
  }

  override unjoin(id: string): void {
    if (!this.orphan(id)) super.unjoin(id);
  }

  override remove(id: string): void { this.deleteBeat(id); }

  override removal(): null { return null; }

  override restore(id: string): void {
    if (!this.orphan(id)) super.restore(id);
  }

  override split(id: string, offset: number, created: string, fields: Record<string, unknown> = {}): void {
    if (!this.orphan(id) && this.available(created) && (id !== STRAY_ROW || this.available(`${created}^`))) {
      super.split(id, offset, created, fields);
    }
  }

  override insertBeat(before: string, id: string, value: string, fields: Record<string, unknown> = {}): void {
    if (!this.orphan(before) && this.available(id)) super.insertBeat(before, id, value, fields);
  }

  override materialize(id: string): string {
    return this.available(id) ? super.materialize(id) : id;
  }

  override createHeading(before: string, id: string, name: string): void {
    if (!this.orphan(before) && (before !== STRAY_ROW || this.available(`${id}^`))) super.createHeading(before, id, name);
  }

  override drop(command: RankDrop): boolean {
    const targets = command.unit === "scene" ? [] : [command.first, command.last, command.target];
    const rows = targets.length ? new Set(this.rows().map(row => row.id)) : null;
    if (rows && targets.some(id => typeof id === "string" && !rows.has(id))) return false;
    return super.drop(command);
  }

  override moveRefs(first: string, last: string, after: string | null): boolean {
    const targets = [first, last, after];
    return targets.some(ref => ref?.startsWith("b:") && this.orphan(ref.slice(2))) ? false : super.moveRefs(first, last, after);
  }

  override undoStep(): NativeUndoOutcome { return this.undoPress() ? "undone" : "empty"; }
  override redoStep(): NativeUndoOutcome { return this.redoPress() ? "undone" : "empty"; }

  override deleteRows(ids: readonly string[]): void {
    const rows = new Map(this.rows().map(row => [row.id, row]));
    this.cutNarration(ids.flatMap(id => {
      const row = rows.get(id);
      if (row) return row.members;
      if (this.orphan(id)) return [];
      throw new Error(`No live row ${id}`);
    }));
  }

  override deleteBeat(id: string): void {
    if (!this.orphan(id)) this.cutNarration([id]);
  }

  private cutNarration(ids: readonly string[]): void {
    const cuts = new Map<Y.Text, { from: number; to: number }[]>();
    const heads = new Set<Y.Map<unknown>>();
    for (const id of ids) for (const span of this.spansOf(id, "audioText")) {
      // why: heading-following narration can belong to the row under rule (f), but the heading belongs to its scene.
      const ours = !span.opener?.startsWith("h:");
      const from = span.boundary === "embed" && ours ? span.start - 1 : span.start;
      if (span.boundary === "head" && span.record && ours) heads.add(span.record);
      if (span.end > from) {
        const ranges = cuts.get(span.text) ?? [];
        ranges.push({ from, to: span.end });
        cuts.set(span.text, ranges);
      }
    }
    this.transact(() => {
      for (const [text, ranges] of cuts) {
        const merged: { from: number; to: number }[] = [];
        for (const range of ranges.sort((a, b) => a.from - b.from)) {
          const last = merged.at(-1);
          if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
          else merged.push(range);
        }
        for (const { from, to } of merged.reverse()) text.delete(from, to - from);
      }
      for (const record of heads) record.delete("head");
    });
  }
}
