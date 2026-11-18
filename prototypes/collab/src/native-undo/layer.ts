import * as Y from "yjs";
import type { Marks } from "../../../../src/core/text/runs.ts";
import type { NativeField, NativeReplica } from "../native/variant.ts";

export const GROUP_MS = 1000;
export const DEFAULT_STATUS = "todo";
export const RECORD_ROOTS = ["comments", "people", "tags", "shots"] as const;
export type RecordRoot = (typeof RECORD_ROOTS)[number];
export type UndoStackItem = Y.UndoManager["undoStack"][number];

const MAP_SCOPE = ["segments", "beats", "visuals", "comments", "people", "tags", "shots", "meta"] as const;

export interface UndoCaret { beat: string; field: NativeField; offset: number }
export interface ResolvedCaret { text: Y.Text; index: number }
export type CreationRule = "keep-holding" | "keep-always";
export interface UndoLayerOptions { now?: () => number; creations?: CreationRule; grouping?: "words" | "yjs" }
interface TypingGroup { cell: string; at: number; endsInSpace: boolean }

function holds(type: unknown): boolean {
  if (type instanceof Y.Text || type instanceof Y.Array) return type.length > 0;
  return type instanceof Y.Map ? type.size > 0 : false;
}

export function changedDocument(transaction: Y.Transaction): boolean {
  if (transaction.deleteSet.clients.size > 0) return true;
  for (const [client, clock] of transaction.afterState) if ((transaction.beforeState.get(client) ?? 0) !== clock) return true;
  return false;
}

export class UndoLayer {
  readonly replica: NativeReplica;
  readonly manager: Y.UndoManager;
  updates = 0;
  restored: ResolvedCaret | null = null;
  private readonly now: () => number;
  private readonly words: boolean;
  private group: TypingGroup | null = null;
  private caret: Y.RelativePosition | null = null;

  constructor(replica: NativeReplica, options: UndoLayerOptions = {}) {
    this.replica = replica;
    this.now = options.now ?? Date.now;
    this.words = options.grouping !== "yjs";
    // why: one manager per session; the spike's own manager covers fewer roots and must not keep a second history
    replica.undo.destroy();
    const doc = replica.doc, always = (options.creations ?? "keep-always") === "keep-always";
    this.manager = new Y.UndoManager([...MAP_SCOPE.map(name => doc.getMap(name)), doc.getArray("order")], {
      trackedOrigins: new Set([replica.origin]),
      // why: the grouping rule below owns the one-second limit, so a slow machine never splits a group by itself
      ...(this.words ? { captureTimeout: Number.POSITIVE_INFINITY } : {}),
      // why: a created record or cell that is empty here may already hold another copy's unarrived writes, which a
      // deleted type would discard on arrival; so by default undo takes back only what was written into it
      deleteFilter: item => !(item.content instanceof Y.ContentType && (always || holds(item.content.type)))
    });
    this.manager.on("stack-item-added", event => {
      if (this.caret) event.stackItem.meta.set("caret", this.caret);
    });
    this.manager.on("stack-item-popped", event => {
      const caret = event.stackItem.meta.get("caret") as Y.RelativePosition | undefined;
      const absolute = caret ? Y.createAbsolutePositionFromRelativePosition(caret, doc) : null;
      this.restored = absolute && absolute.type instanceof Y.Text ? { text: absolute.type, index: absolute.index } : null;
    });
    doc.on("update", () => { this.updates++; });
  }

  private relative(caret: UndoCaret): Y.RelativePosition {
    const cell = this.replica.cell(caret.beat, caret.field);
    return Y.createRelativePositionFromTypeIndex(cell.text, cell.start + caret.offset);
  }

  type(beat: string, field: NativeField, at: number, text: string, marks: Marks = {}): void {
    this.typing(`${field}:${beat}`, text, false, { beat, field, offset: at }, () => {
      this.replica.splice(beat, field, at, at, [{ text, marks }]);
    });
  }

  erase(beat: string, field: NativeField, from: number, to: number): void {
    this.typing(`${field}:${beat}`, "", false, { beat, field, offset: to }, () => { this.replica.splice(beat, field, from, to, []); });
  }

  replace(beat: string, field: NativeField, from: number, to: number, text: string, marks: Marks = {}): void {
    this.typing(`${field}:${beat}`, text, true, { beat, field, offset: from }, () => {
      this.replica.splice(beat, field, from, to, [{ text, marks }]);
    });
  }

  // why: the app's rule: one cell, under a second since the last keystroke, and a word typed after a space starts anew
  private typing(cell: string, typed: string, replacing: boolean, caret: UndoCaret, run: () => void): void {
    const now = this.words ? this.now() : 0, last = this.group;
    const joins = !replacing && last !== null && last.cell === cell && now - last.at < GROUP_MS && !(last.endsInSpace && /\S/.test(typed));
    if (this.words ? !joins : replacing) this.manager.stopCapturing();
    this.caret = this.relative(caret);
    try { run(); } finally { this.caret = null; }
    if (replacing) { this.endGroup(); return; }
    if (!this.words) return;
    if (joins && last) {
      last.at = now;
      if (typed) last.endsInSpace = /\s$/.test(typed);
    } else this.group = { cell, at: now, endsInSpace: /\s$/.test(typed) };
  }

  command(run: () => void, caret: UndoCaret | null = null): void {
    this.endGroup();
    this.caret = caret ? this.relative(caret) : null;
    try { this.replica.transact(run); } finally { this.caret = null; this.endGroup(); }
  }

  undo(caret: UndoCaret | null = null): UndoStackItem | null {
    return this.press(caret, () => this.manager.undo());
  }

  redo(caret: UndoCaret | null = null): UndoStackItem | null {
    return this.press(caret, () => this.manager.redo());
  }

  private press(caret: UndoCaret | null, run: () => UndoStackItem | null): UndoStackItem | null {
    this.endGroup();
    this.restored = null;
    this.caret = caret ? this.relative(caret) : null;
    try { return run(); } finally { this.caret = null; }
  }

  private endGroup(): void {
    this.group = null;
    this.manager.stopCapturing();
  }

  createRecord(root: RecordRoot, id: string, fields: Record<string, unknown>): void {
    this.replica.transact(() => {
      const record = new Y.Map<unknown>();
      this.replica.doc.getMap<Y.Map<unknown>>(root).set(id, record);
      for (const [key, value] of Object.entries(fields)) record.set(key, value);
    });
  }

  setRecordField(root: RecordRoot, id: string, key: string, value: unknown): void {
    this.replica.transact(() => {
      const record = this.replica.doc.getMap<Y.Map<unknown>>(root).get(id);
      if (!record) throw new Error(`Missing record ${root}/${id}`);
      record.set(key, value);
    });
  }

  status(beat: string): string { return readStatus(this.replica, beat); }

  records(): Record<string, unknown> { return readRecords(this.replica); }
}

// why: an absent status, left when the winner of two identical statuses undoes, reads as the format's default
export function readStatus(replica: NativeReplica, beat: string): string {
  const value = replica.beats.get(beat)?.get("status");
  return typeof value === "string" ? value : DEFAULT_STATUS;
}

// why: a record whose creation was undone stays as an empty map; nothing in it, so it is not shown
export function readRecords(replica: NativeReplica): Record<string, unknown> {
  return Object.fromEntries(RECORD_ROOTS.map(root => {
    const shown = [...replica.doc.getMap<unknown>(root)].filter(([, record]) => !(record instanceof Y.Map) || record.size > 0);
    return [root, Object.fromEntries(shown.map(([id, record]) => [id, record instanceof Y.Map ? record.toJSON() : record]))];
  }));
}
