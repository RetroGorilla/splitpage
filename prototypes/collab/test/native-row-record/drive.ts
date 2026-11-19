import { isDeepStrictEqual as equal } from "node:util";
import * as Y from "yjs";
import type { KeptReplica } from "../../src/native-kept/replica.ts";
import { incompleteBoundaries } from "../../src/native-row-record/variants.ts";
import type { RowMaker } from "../../src/native-row-record/variants.ts";
import { ALL_RULES, STRAY_ROW } from "../../src/native/variant.ts";
import type { NativeDeltaItem } from "../../src/native/variant.ts";
import { neverAcceptable, reachability } from "../native-chosen/check.ts";
import { deliver, readStyles } from "../native-chosen/engine.ts";
import type { Mode } from "../native-chosen/engine.ts";
import { outline, seed } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Step } from "../native-chosen/play.ts";

export interface CopyView { rows: string[]; boundaries: number; record: boolean; cell: boolean; rank: boolean; missing: string[] }
export interface DriveResult {
  views: CopyView[][];
  settled: CopyView[];
  never: string[];
  threw: string[];
  disagree: boolean;
  bare: string[];
  state: Uint8Array | null;
}

export function countBoundaries(replica: KeptReplica, id: string): number {
  let count = 0;
  for (const segment of new Set(replica.order.toArray())) {
    const record = replica.segments.get(segment), head = record?.get("head"), text = record?.get("text");
    if (head && typeof head === "object" && "b" in head && head.b === id) count++;
    if (text instanceof Y.Text) for (const item of text.toDelta() as NativeDeltaItem[]) {
      if (item.insert && typeof item.insert === "object" && "b" in item.insert && item.insert.b === id) count++;
    }
  }
  return count;
}

export function viewOf(replica: KeptReplica, beat = "N"): CopyView {
  const rows = outline(replica), members = replica.rows().flatMap(row => row.members).filter(id => id !== STRAY_ROW);
  return {
    rows, boundaries: countBoundaries(replica, beat), record: replica.beats.has(beat), cell: replica.visuals.has(beat),
    rank: typeof replica.storedRank("b", beat) === "string", missing: members.filter(id => !replica.beats.has(id) || !replica.visuals.has(id))
  };
}

// why: every copy is read after every step, so what each person sees and what each copy stores is compared step by step
export function drive(make: RowMaker, spec: Spec, steps: readonly Step[], writers: number, mode: Mode, number: number): DriveResult {
  const initial = seed(spec, ALL_RULES, "cells"), updates: Uint8Array[] = [], owned: KeptReplica[] = [];
  const result: DriveResult = { views: [], settled: [], never: [], threw: [], disagree: false, bare: [], state: null };
  const open = (bytes: Uint8Array, client: number): { replica: KeptReplica; packets: Set<number> } => {
    const replica = make(client, ALL_RULES), peer = { replica, packets: new Set<number>() };
    Y.applyUpdate(replica.doc, bytes, "remote");
    replica.changes();
    owned.push(replica);
    replica.doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "remote") peer.packets.add(updates.push(update) - 1); });
    return peer;
  };
  const send = (from: { replica: KeptReplica; packets: Set<number> }, to: { replica: KeptReplica; packets: Set<number> }, at: number): void => {
    const ids = [...from.packets].filter(id => !to.packets.has(id)).sort((a, b) => a - b);
    for (const id of ids) to.packets.add(id);
    if (mode === "state") Y.applyUpdate(to.replica.doc, Y.encodeStateAsUpdate(from.replica.doc, Y.encodeStateVector(to.replica.doc)), "remote");
    else deliver(to.replica, ids.map(id => updates[id] as Uint8Array), mode, number + at);
    to.replica.changes();
  };
  const look = (replica: KeptReplica, stage: string): CopyView => {
    result.never.push(...neverAcceptable(reachability(replica)).map(problem => `${stage}: ${problem}`));
    for (const id of incompleteBoundaries(replica)) if (!result.bare.includes(id)) result.bare.push(id);
    return viewOf(replica);
  };
  try {
    const peers = Array.from({ length: writers }, (_, index) => open(initial, index + 1));
    for (const [index, step] of steps.entries()) {
      if ("open" in step) throw new Error("Opening a copy is not used here");
      if ("from" in step) send(peers[step.from] as typeof peers[number], peers[step.to] as typeof peers[number], index);
      else {
        const replica = (peers[step.by] as typeof peers[number]).replica;
        try { perform(replica, step.cmd); } catch (error) {
          replica.changes();
          result.threw.push(`step ${index} ${step.cmd.op}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      result.views.push(peers.map((peer, copy) => look(peer.replica, `step ${index} copy ${copy}`)));
    }
    const hub = peers[0] as typeof peers[number];
    for (let pass = 0; pass < 4; pass++) {
      for (const peer of peers.slice(1)) send(peer, hub, steps.length);
      for (const peer of peers.slice(1)) send(hub, peer, steps.length);
    }
    result.state = hub.replica.encode();
    const late = open(result.state, 802), styles = readStyles(hub.replica), lines = outline(hub.replica, true);
    for (const peer of [...peers, late]) {
      if (!equal(readStyles(peer.replica), styles) || !equal(outline(peer.replica, true), lines)) result.disagree = true;
      result.settled.push(look(peer.replica, `settled ${peer.replica.doc.clientID}`));
    }
  } catch (error) {
    result.threw.push(`reader: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const replica of owned) replica.destroy();
  }
  return result;
}
