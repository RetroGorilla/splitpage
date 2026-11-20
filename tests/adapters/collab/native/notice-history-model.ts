export type NoticeHistoryLossKind = "narration" | "visual" | "marks" | "record" | "join" | "split-text" |
  "split-move" | "double-undo" | "displaced";

export type NoticeHistoryEffect =
  | { action: "edit"; id: string; kind: "narration" | "visual" | "marks" | "record" | "join";
    token?: string | undefined; into?: string | undefined; field?: string; mark?: string; column?: "narration" | "visual"; from?: number; erased?: true }
  | { action: "delete"; ids: readonly string[]; above?: string; landing?: string }
  | { action: "revert"; id: string; kind: "narration" | "record"; token?: string }
  | { action: "create"; id: string; from?: string }
  | { action: "move"; id: string; after: string }
  | { action: "undo" }
  | { action: "other" };

type Event = { person: number; serial: number; seen: ReadonlySet<number>; effect: NoticeHistoryEffect; undone: Event | undefined };
export type NoticeHistoryLoss = { person: number; id: string; kind: NoticeHistoryLossKind; token?: string | undefined; near?: string | undefined;
  field?: string | undefined; column?: "narration" | "visual" | undefined; mark?: string | undefined; erased?: true;
  cause: "cut" | "cut-undo" | "creation-undo" | "undo" | "move" };

export class NoticeHistoryLedger {
  private readonly events: Event[] = [];
  private readonly stacks: Event[][];
  private readonly known: Set<number>[];
  private checkpoint = 0;

  constructor(copies: number) {
    this.stacks = Array.from({ length: copies }, () => []);
    this.known = Array.from({ length: copies }, () => new Set());
  }

  write(person: number, effect: NoticeHistoryEffect): void {
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

  private inactive(): Set<number> {
    const inactive = new Set<number>();
    for (const event of this.events) {
      if (event.undone) inactive.add(event.undone.serial);
      const { effect } = event;
      if (effect.action !== "revert") continue;
      for (const prior of this.events.slice(0, event.serial).reverse()) {
        const edit = prior.effect;
        if (prior.person === event.person && !inactive.has(prior.serial) && edit.action === "edit" &&
          edit.id === effect.id && edit.kind === effect.kind &&
          (effect.kind === "record" ? (edit.field ?? "status") === "status" : edit.token === effect.token)) {
          inactive.add(prior.serial);
          if (effect.kind !== "record") break;
        }
      }
    }
    return inactive;
  }

  losses(): NoticeHistoryLoss[] {
    const fresh = this.events.slice(this.checkpoint);
    const inactive = this.inactive();
    const removed = fresh.flatMap<{ event: Event; ids: readonly string[]; cause: "cut" | "cut-undo" | "creation-undo" }>(event => {
      const { effect, undone } = event;
      if (effect.action === "delete") return [{ event, ids: effect.ids, cause: inactive.has(event.serial) ? "cut-undo" : "cut" }];
      if (undone?.effect.action === "create") return [{ event, ids: [undone.effect.id], cause: "creation-undo" as const }];
      return [];
    });
    const concurrent = (first: Event, second: Event) =>
      first.person !== second.person && !first.seen.has(second.serial) && !second.seen.has(first.serial);
    const losses: NoticeHistoryLoss[] = [];

    for (const { event: deletion, ids, cause } of removed) {
      for (const edit of this.events) {
        const { effect } = edit;
        if (effect.action !== "edit" || !concurrent(edit, deletion) || inactive.has(edit.serial)) continue;
        if (effect.erased && cause !== "cut-undo") continue;
        if (ids.includes(effect.id) || (effect.into !== undefined && ids.includes(effect.into))) {
          if (cause === "cut-undo" && effect.kind !== "visual" && effect.kind !== "record" &&
            !(effect.kind === "marks" && (effect.column === "visual" || (effect.from ?? 0) > 0))) continue;
          losses.push({ person: edit.person, id: effect.id, kind: effect.kind, token: effect.token, cause,
            column: effect.column, mark: effect.mark, field: effect.field, ...(effect.erased ? { erased: true } : {}) });
          if (effect.kind === "narration" && cause === "cut") {
            const near = deletion.effect.action === "delete" ? deletion.effect.landing : undefined;
            losses.push({ person: deletion.person, id: effect.id, kind: "displaced", token: effect.token, near, cause });
          }
        }
      }
      if (cause === "cut-undo") continue;
      for (const split of fresh) {
        const { effect } = split;
        if (effect.action === "create" && effect.from && ids.includes(effect.from) &&
          concurrent(split, deletion) && !inactive.has(split.serial)) {
          losses.push({ person: split.person, id: effect.id, kind: "split-text", cause });
        }
      }
    }

    for (const event of fresh) {
      const { effect } = event;
      if (effect.action === "create" && effect.from && !inactive.has(event.serial)) {
        for (const move of fresh) {
          if (move.effect.action !== "move" || move.effect.id !== effect.from ||
            !concurrent(move, event) || inactive.has(move.serial)) continue;
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
