import type { SharedJsonValue } from "../../../src/core/collab/operations.ts";

export interface ModelCharacter {
  kind: "char"; id: string; beat: string; after: string | null; restores: string | null;
  value: string; clock: number; by: string; excluded: string[];
}
export interface ModelMark { kind: "mark"; id: string; key: string; value: string | true; from: string; to: string; by: string; seen: string[] }
export interface ModelStatus { kind: "status"; id: string; beat: string; value: string; parents: string[]; by: string }
export interface ModelScalar { kind: "scalar"; id: string; beat: string; field: string; value: SharedJsonValue | null; clear: boolean; after: string | null }
export type ModelOp = ModelCharacter | ModelMark | ModelStatus | ModelScalar
  | { kind: "delete"; id: string; char: string }
  | { kind: "unmark"; id: string; occurrences: string[]; from: string; to: string; identical: boolean }
  | { kind: "retire"; id: string; event: string };

export function compareModelIds(a: string, b: string): number {
  const [clientA = 0, serialA = 0] = a.split(":").map(Number), [clientB = 0, serialB = 0] = b.split(":").map(Number);
  return clientA - clientB || serialA - serialB;
}

export function resolveModelStatus(events: ReadonlyMap<string, ModelStatus>, retired: ReadonlySet<string>, stored: string): string {
  const known = (event: ModelStatus): string[] => event.parents.filter(parent => events.has(parent));
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const cached = ancestry.get(id);
    if (cached) return cached;
    const result = new Set<string>(), event = events.get(id), stack = event ? known(event) : [];
    for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
      if (result.has(parent)) continue;
      result.add(parent);
      const next = events.get(parent);
      if (next) stack.push(...known(next));
    }
    ancestry.set(id, result);
    return result;
  };
  const ordered = [...events.keys()].sort((a, b) => ancestors(a).size - ancestors(b).size || compareModelIds(a, b));
  const resolved = new Map<string, string>();
  const resolve = (initial: readonly string[]): string => {
    let frontier = initial;
    while (frontier.length) {
      const values = new Set(frontier.map(id => resolved.get(id) ?? stored));
      if (values.size === 1) return [...values][0] ?? stored;
      const [first = new Set<string>(), ...others] = frontier.map(id => ancestors(id));
      const shared = [...first].filter(ancestor => others.every(branch => branch.has(ancestor)));
      frontier = shared.filter(id => !shared.some(other => ancestors(other).has(id)));
    }
    return stored;
  };
  for (const id of ordered) {
    const event = events.get(id);
    if (event) resolved.set(id, retired.has(id) ? resolve(known(event)) : event.value);
  }
  return resolve(modelStatusHeads(events));
}

export function modelStatusHeads(events: ReadonlyMap<string, ModelStatus>): string[] {
  const parents = new Set([...events.values()].flatMap(event => event.parents));
  return [...events.keys()].filter(id => !parents.has(id)).sort(compareModelIds);
}

export class ModelView {
  readonly characters = new Map<string, ModelCharacter>();
  readonly deleted = new Set<string>();
  readonly restorations = new Map<string, string[]>();
  readonly marks: ModelMark[] = [];
  readonly unmarks: Extract<ModelOp, { kind: "unmark" }>[] = [];
  readonly sequences = new Map<string, string[]>();
  readonly position = new Map<string, number>();
  readonly events = new Map<string, Map<string, ModelStatus>>();
  readonly retired = new Set<string>();
  readonly scalars = new Map<string, ModelScalar>();
  readonly stored: string;
  private readonly marked = new Map<string, ModelMark>();

  constructor(ops: Iterable<ModelOp>, beats: readonly string[], stored: string) {
    this.stored = stored;
    const right = new Map<string, ModelCharacter[]>(), left = new Map<string, ModelCharacter[]>(), written = new Map<string, ModelScalar[]>();
    for (const op of ops) {
      if (op.kind === "char") {
        this.characters.set(op.id, op);
        const side = op.restores === null ? right : left, key = op.restores ?? op.after ?? "beat:" + op.beat;
        side.set(key, [...side.get(key) ?? [], op]);
      } else if (op.kind === "delete") this.deleted.add(op.char);
      else if (op.kind === "mark") this.marks.push(op);
      else if (op.kind === "unmark") this.unmarks.push(op);
      else if (op.kind === "retire") this.retired.add(op.event);
      else if (op.kind === "status") this.events.set(op.beat, new Map([...this.events.get(op.beat) ?? [], [op.id, op]]));
      else {
        const key = JSON.stringify([op.beat, op.field]);
        written.set(key, [...written.get(key) ?? [], op]);
      }
    }
    for (const [key, all] of written) {
      // why: prepareScalar writes a Y.Map key: of two unseen sets the higher client's stays,
      // and a clear removes only the value it saw.
      const sets = all.filter(op => !op.clear).sort((a, b) => compareModelIds(a.id, b.id));
      let head = sets.filter(op => op.after === null).at(-1);
      for (let next = head; next; next = sets.filter(op => op.after === head?.id).at(-1)) head = next;
      if (head) this.scalars.set(key, all.some(op => op.clear && op.after === head.id) ? { ...head, value: null, clear: true } : head);
    }
    this.marks.sort((a, b) => compareModelIds(a.id, b.id));
    for (const mark of this.marks) this.marked.set(mark.id, mark);
    for (const [original, restored] of left) this.restorations.set(original, restored.map(op => op.id).sort(compareModelIds));
    const visit = (op: ModelCharacter, sequence: string[]): void => {
      for (const id of this.restorations.get(op.id) ?? []) { const restored = this.characters.get(id); if (restored) visit(restored, sequence); }
      this.position.set(op.id, sequence.length);
      sequence.push(op.id);
      for (const next of this.after(right, op.id)) visit(next, sequence);
    };
    for (const beat of beats) {
      const sequence: string[] = [];
      for (const op of this.after(right, "beat:" + beat)) visit(op, sequence);
      this.sequences.set(beat, sequence);
    }
  }

  private after(right: ReadonlyMap<string, ModelCharacter[]>, key: string): ModelCharacter[] {
    return [...right.get(key) ?? []].sort((a, b) => b.clock - a.clock || compareModelIds(a.id, b.id));
  }

  live(id: string): boolean { return this.position.has(id) && !this.deleted.has(id); }

  visible(beat: string): string[] { return (this.sequences.get(beat) ?? []).filter(id => !this.deleted.has(id)); }

  follow(id: string): string {
    let current = id;
    for (let next = this.restorations.get(current)?.[0]; !this.live(current) && next !== undefined; next = this.restorations.get(current)?.[0]) current = next;
    return current;
  }

  root(id: string): string {
    let current = id;
    for (let original = this.characters.get(current)?.restores; original; original = this.characters.get(current)?.restores) current = original;
    return current;
  }

  private covers(range: { from: string; to: string }, id: string): boolean {
    const from = this.position.get(range.from), to = this.position.get(range.to), at = this.position.get(id);
    const beat = this.characters.get(id)?.beat;
    return from !== undefined && to !== undefined && at !== undefined && this.characters.get(range.from)?.beat === beat
      && this.characters.get(range.to)?.beat === beat && from <= at && at <= to;
  }

  occurrences(id: string): ModelMark[] {
    const character = this.characters.get(id);
    if (!character) return [];
    const inherited = character.restores === null ? [] : this.occurrences(character.restores);
    return this.marks.filter(mark => (inherited.includes(mark) || this.covers(mark, id) && !character.excluded.includes(mark.id))
      && !this.unmarks.some(unmark => this.covers(unmark, id) && (unmark.occurrences.includes(mark.id)
        || unmark.identical && unmark.occurrences.some(other => this.identical(mark, this.marked.get(other))))));
  }

  // why: decided row: the same change made by two people who had not seen each other's is one change.
  private identical(mark: ModelMark, other: ModelMark | undefined): boolean {
    return other !== undefined && mark.key === other.key && mark.value === other.value && mark.from === other.from && mark.to === other.to
      && !mark.seen.includes(other.id) && !other.seen.includes(mark.id);
  }

  scalarHead(beat: string, field: string): string | null { return this.scalars.get(JSON.stringify([beat, field]))?.id ?? null; }

  applied(occurrence: string): string[] {
    const mark = this.marks.find(candidate => candidate.id === occurrence), beat = mark && this.characters.get(mark.from)?.beat;
    if (!mark || beat === undefined) return [];
    return (this.sequences.get(beat) ?? []).filter(id => this.covers(mark, id) && !this.characters.get(id)?.excluded.includes(mark.id));
  }

  shown(occurrence: string): string[] {
    const mark = this.marks.find(candidate => candidate.id === occurrence), beat = mark && this.characters.get(mark.from)?.beat;
    return beat === undefined ? [] : this.visible(beat).filter(id => this.occurrences(id).some(candidate => candidate.id === occurrence));
  }

  status(beat: string): string { return resolveModelStatus(this.events.get(beat) ?? new Map<string, ModelStatus>(), this.retired, this.stored); }

  scalar(beat: string, field: string): { value: SharedJsonValue | null; clear: boolean } {
    const op = this.scalars.get(JSON.stringify([beat, field]));
    return op ? { value: op.value, clear: op.clear } : { value: null, clear: true };
  }
}
