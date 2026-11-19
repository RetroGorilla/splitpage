export type LossKind = "narration" | "visual" | "marks" | "record" | "join" | "split-text" |
  "split-move" | "double-undo" | "displaced";

export type Effect =
  | { action: "edit"; id: string; kind: "narration" | "visual" | "marks" | "record" | "join"; token?: string | undefined; into?: string | undefined }
  | { action: "delete"; ids: readonly string[] }
  | { action: "create"; id: string; from?: string }
  | { action: "move"; id: string; after: string }
  | { action: "undo" }
  | { action: "other" };

type Event = { person: number; serial: number; seen: ReadonlySet<number>; effect: Effect; undone: Event | undefined };
export type Loss = { person: number; id: string; kind: LossKind; token?: string | undefined; cause: "cut" | "creation-undo" | "undo" | "move" };

export class Ledger {
  private readonly events: Event[] = [];
  private readonly stacks: Event[][];
  private readonly known: Set<number>[];
  private checkpoint = 0;

  constructor(copies: number) {
    this.stacks = Array.from({ length: copies }, () => []);
    this.known = Array.from({ length: copies }, () => new Set());
  }

  write(person: number, effect: Effect): void {
    const stack = this.stacks[person], known = this.known[person];
    if (!stack || !known) throw new Error("Unknown writer");
    const undone = effect.action === "undo" ? stack.pop() : undefined;
    if (effect.action === "undo" && !undone) throw new Error("The history must name a preceding command to undo");
    const event = { person, serial: this.events.length, seen: new Set(known), effect, undone };
    if (effect.action !== "undo") stack.push(event);
    known.add(event.serial);
    this.events.push(event);
  }

  deliver(from: number, to: number): void {
    const sent = this.known[from], received = this.known[to];
    if (!sent || !received) throw new Error("Unknown delivery endpoint");
    for (const serial of sent) received.add(serial);
  }

  inSyncNow(): void {
    if (this.known.some(set => set.size !== this.events.length)) throw new Error("Checkpoint without complete delivery");
    this.checkpoint = this.events.length;
  }

  losses(): Loss[] {
    const fresh = this.events.slice(this.checkpoint);
    const inverses = new Map(this.events.flatMap(event => event.undone ? [[event.undone.serial, event] as const] : []));
    const removed = fresh.flatMap<{ event: Event; ids: readonly string[]; cause: "cut" | "creation-undo" }>(event => {
      const { effect, undone } = event;
      if (effect.action === "delete" && !inverses.has(event.serial)) return [{ event, ids: effect.ids, cause: "cut" as const }];
      if (undone?.effect.action === "create") return [{ event, ids: [undone.effect.id], cause: "creation-undo" as const }];
      return [];
    });
    const concurrent = (first: Event, second: Event) =>
      first.person !== second.person && !first.seen.has(second.serial) && !second.seen.has(first.serial);
    const losses: Loss[] = [];

    for (const { event: deletion, ids, cause } of removed) {
      for (const edit of this.events) {
        const { effect } = edit;
        if (effect.action !== "edit" || !concurrent(edit, deletion) || inverses.has(edit.serial)) continue;
        if (ids.includes(effect.id) || (effect.into !== undefined && ids.includes(effect.into))) {
          losses.push({ person: edit.person, id: effect.id, kind: effect.kind, token: effect.token, cause });
          if (effect.kind === "narration" && cause === "cut") {
            losses.push({ person: deletion.person, id: effect.id, kind: "displaced", token: effect.token, cause });
          }
        }
      }
      for (const split of fresh) {
        const { effect } = split;
        if (effect.action === "create" && effect.from && ids.includes(effect.from) &&
          concurrent(split, deletion) && !inverses.has(split.serial)) {
          losses.push({ person: split.person, id: effect.id, kind: "split-text", cause });
        }
      }
    }

    for (const event of fresh) {
      const { effect } = event;
      if (effect.action === "create" && effect.from && !inverses.has(event.serial)) {
        for (const move of fresh) {
          if (move.effect.action !== "move" || move.effect.id !== effect.from ||
            !concurrent(move, event) || inverses.has(move.serial)) continue;
          losses.push({ person: event.person, id: effect.id, kind: "split-move", cause: "move" });
          losses.push({ person: move.person, id: effect.id, kind: "split-move", cause: "move" });
        }
      }
      if (event.undone?.effect.action !== "delete") continue;
      const original = event.undone;
      for (const other of fresh) {
        const otherCut = other.undone;
        if (otherCut?.effect.action !== "delete" || !concurrent(original, otherCut)) continue;
        for (const id of event.undone.effect.ids) {
          if (otherCut.effect.ids.includes(id)) losses.push({ person: event.person, id, kind: "double-undo", cause: "undo" });
        }
      }
    }
    return losses;
  }
}
