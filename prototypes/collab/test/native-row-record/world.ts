import { isDeepStrictEqual as equal } from "node:util";
import * as Y from "yjs";
import type { KeptReplica } from "../../src/native-kept/replica.ts";
import { ROW_MAKERS } from "../../src/native-row-record/variants.ts";
import type { RowControl, RowOption } from "../../src/native-row-record/variants.ts";
import { ALL_RULES } from "../../src/native/variant.ts";
import type { NativeDeltaItem } from "../../src/native/variant.ts";
import { outline, seed } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Step } from "../native-chosen/play.ts";

const marker = (value: unknown): string => {
  if (value && typeof value === "object" && "b" in value) return `[${String(value.b)}]`;
  if (value && typeof value === "object" && "h" in value) return `[#${String(value.h)}]`;
  return "□";
};

export function stored(replica: KeptReplica): string {
  return [...new Set(replica.order.toArray())].map(id => {
    const segment = replica.segments.get(id), text = segment?.get("text");
    const delta = text instanceof Y.Text ? text.toDelta() as NativeDeltaItem[] : [];
    return marker(segment?.get("head")) + delta.map(item => typeof item.insert === "string" ? item.insert : marker(item.insert)).join("");
  }).join(" | ");
}

// why: copies stay open after the steps, so a history can be continued, observed or compared at any point; every
// exchange sends everything the other copy lacks, which is the forward delivery once all packets are in
export class World {
  readonly peers: KeptReplica[];
  readonly threw: string[] = [];
  readonly option: RowOption | RowControl;

  constructor(option: RowOption | RowControl, spec: Spec, writers = 2) {
    this.option = option;
    const initial = seed(spec, ALL_RULES, "cells");
    this.peers = Array.from({ length: writers }, (_, index) => {
      const replica = ROW_MAKERS[option](index + 1, ALL_RULES);
      Y.applyUpdate(replica.doc, initial, "remote");
      replica.changes();
      return replica;
    });
  }

  peer(index: number): KeptReplica {
    const replica = this.peers[index];
    if (!replica) throw new Error(`No copy ${index}`);
    return replica;
  }

  run(steps: readonly Step[]): this {
    for (const [index, step] of steps.entries()) {
      if ("open" in step) {
        const replica = ROW_MAKERS[this.option](step.open + 1, ALL_RULES);
        Y.applyUpdate(replica.doc, this.peer(step.from).encode(), "remote");
        replica.changes();
        this.peer(step.open).destroy();
        this.peers[step.open] = replica;
      } else if ("from" in step) {
        const to = this.peer(step.to);
        Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(this.peer(step.from).doc, Y.encodeStateVector(to.doc)), "remote");
        to.changes();
      } else {
        const replica = this.peer(step.by);
        try { perform(replica, step.cmd); } catch (error) {
          replica.changes();
          this.threw.push(`step ${index} ${step.cmd.op}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return this;
  }

  settle(): this {
    for (let round = 0; round < 2; round++) for (const from of this.peers) for (const to of this.peers) {
      if (from === to) continue;
      Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote");
      to.changes();
    }
    return this;
  }

  rows(index = 0): string[] { return outline(this.peer(index)); }

  // why: every copy and a fresh reader of the first copy's state must show and store the same document
  agree(): boolean {
    const fresh = ROW_MAKERS[this.option](903, ALL_RULES);
    try {
      Y.applyUpdate(fresh.doc, this.peer(0).encode(), "remote");
      fresh.changes();
      const reading = (replica: KeptReplica) => [outline(replica, true), stored(replica)];
      const first = reading(fresh);
      return this.peers.every(replica => equal(reading(replica), first));
    } finally { fresh.destroy(); }
  }

  destroy(): void { for (const replica of this.peers) replica.destroy(); }
}

export function inWorld<T>(option: RowOption | RowControl, spec: Spec, writers: number, use: (world: World) => T): T {
  const world = new World(option, spec, writers);
  try { return use(world); } finally { world.destroy(); }
}
