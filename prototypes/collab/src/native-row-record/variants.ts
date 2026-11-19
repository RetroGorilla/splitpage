import * as Y from "yjs";
import { KeptReplica } from "../native-kept/replica.ts";
import { ALL_RULES, STRAY_ROW } from "../native/variant.ts";
import type { NativeDeltaItem, NativeRules } from "../native/variant.ts";

export const ROW_OPTIONS = ["K", "R", "U"] as const;
export type RowOption = typeof ROW_OPTIONS[number];
export type RowControl = "R0" | "Rdrop" | "U0";

function boundaryIds(replica: KeptReplica, listed: boolean): string[] {
  const found: string[] = [], segments = listed ? [...new Set(replica.order.toArray())] : [...replica.segments.keys()];
  for (const id of segments) {
    const record = replica.segments.get(id), head = record?.get("head"), text = record?.get("text");
    if (head && typeof head === "object" && "b" in head && typeof head.b === "string") found.push(head.b);
    if (text instanceof Y.Text) for (const item of text.toDelta() as NativeDeltaItem[]) {
      if (item.insert && typeof item.insert === "object" && "b" in item.insert && typeof item.insert.b === "string") found.push(item.insert.b);
    }
  }
  return found;
}

export function incompleteBoundaries(replica: KeptReplica): string[] {
  return [...new Set(boundaryIds(replica, true))].filter(id => !replica.beats.has(id) || !replica.visuals.has(id)).sort();
}

// why: option R: a beat boundary without its record or visual cell opens no row; its text is read with the entry above
// (rule c), or at a segment's start by rule (a). Nothing is written, and commands naming that id write nothing
export class ReadRuleReplica extends KeptReplica {
  private readonly bareReading: "above" | "drop" | null;

  constructor(client: number, rules: NativeRules = ALL_RULES, reading: "above" | "drop" | null = "above") {
    super(client, rules);
    this.bareReading = reading;
    this.unopened = key => key.startsWith("b:") && !this.whole(key.slice(2)) ? this.bareReading : null;
    // why: the reading of a segment now depends on two maps outside it, so a change to either drops the cached reading
    const forget = (): void => { this.forgetViews(); };
    this.beats.observe(forget);
    this.visuals.observe(forget);
  }

  private whole(id: string): boolean { return this.beats.has(id) && this.visuals.has(id); }

  private bare(id: string): boolean {
    return id !== STRAY_ROW && !this.live(id) && boundaryIds(this, false).includes(id);
  }

  protected override orphan(id: string): boolean { return super.orphan(id) || this.bare(id); }

  protected override available(id: string): boolean { return super.available(id) && !this.bare(id); }
}

// why: option U: the undo manager's public deleteFilter keeps a beat's record and cell when a creation is undone;
// the undo removes the boundary and what the command wrote inside them, and leaves the two hidden, as a cut does
export class KeptCreationReplica extends KeptReplica {
  constructor(client: number, rules: NativeRules = ALL_RULES, noop = false) {
    super(client, rules);
    this.keepCreated = true;
    if (noop) this.undo.deleteFilter = () => true;
  }
}

export type RowMaker = (client: number, rules?: NativeRules) => KeptReplica;

export const ROW_MAKERS: Record<RowOption | RowControl, RowMaker> = {
  K: (client, rules) => new KeptReplica(client, rules),
  R: (client, rules) => new ReadRuleReplica(client, rules),
  U: (client, rules) => new KeptCreationReplica(client, rules),
  R0: (client, rules) => new ReadRuleReplica(client, rules, null),
  Rdrop: (client, rules) => new ReadRuleReplica(client, rules, "drop"),
  U0: (client, rules) => new KeptCreationReplica(client, rules, true)
};
