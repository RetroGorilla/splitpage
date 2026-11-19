import * as Y from "yjs";
import type { KeptReplica } from "../../src/native-kept/replica.ts";
import type { RowMaker } from "../../src/native-row-record/variants.ts";
import { ALL_RULES } from "../../src/native/variant.ts";
import { outline, seed } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { perform } from "../native-chosen/play.ts";
import type { Cmd, Step } from "../native-chosen/play.ts";

export type Outcome = "done" | "no write" | "throws before writing" | "throws after writing";
export interface Tried { label: string; outcome: Outcome; message: string; rows: string[] }

// why: plays a history with every step delivered as written, then hands back the state the given copy holds
export function stateAfter(make: RowMaker, spec: Spec, steps: readonly Step[], writers: number, copy: number): Uint8Array {
  const initial = seed(spec, ALL_RULES, "cells"), peers: KeptReplica[] = [];
  for (let client = 1; client <= writers; client++) { const replica = make(client, ALL_RULES); Y.applyUpdate(replica.doc, initial, "remote"); replica.changes(); peers.push(replica); }
  try {
    for (const step of steps) {
      if ("open" in step) throw new Error("Opening a copy is not used here");
      if ("from" in step) {
        const from = peers[step.from] as KeptReplica, to = peers[step.to] as KeptReplica;
        Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote");
        to.changes();
      } else perform(peers[step.by] as KeptReplica, step.cmd);
    }
    return (peers[copy] as KeptReplica).encode();
  } finally { for (const replica of peers) replica.destroy(); }
}

export function tryCommand(make: RowMaker, state: Uint8Array, label: string, cmd: Cmd): Tried {
  const replica = make(9, ALL_RULES);
  try {
    Y.applyUpdate(replica.doc, state, "remote");
    replica.changes();
    const before = Y.snapshot(replica.doc);
    let message = "";
    try { perform(replica, cmd); } catch (error) { message = error instanceof Error ? error.message : String(error); replica.changes(); }
    const wrote = !Y.equalSnapshots(before, Y.snapshot(replica.doc));
    const outcome: Outcome = message ? wrote ? "throws after writing" : "throws before writing" : wrote ? "done" : "no write";
    let rows: string[];
    try { rows = outline(replica); } catch (error) { rows = [`reader throws: ${error instanceof Error ? error.message : String(error)}`]; }
    return { label, outcome, message, rows };
  } finally { replica.destroy(); }
}

export const COMMANDS: { label: string; cmd: Cmd }[] = [
  { label: "type narration in N", cmd: { op: "type", id: "N", field: "audio", at: 0, text: "x" } },
  { label: "type in N's visual cell", cmd: { op: "type", id: "N", field: "visual", at: 0, text: "v" } },
  { label: "bold N's narration", cmd: { op: "format", id: "N", field: "audio", from: 0, to: 1, key: "bold", on: true } },
  { label: "set N's status", cmd: { op: "field", id: "N", key: "status", value: "done" } },
  { label: "move N to the top", cmd: { op: "move", drop: { unit: "row", first: "N", target: null, after: true } } },
  { label: "split N", cmd: { op: "split", id: "N", at: 0, created: "M" } },
  { label: "join N up to B", cmd: { op: "join", id: "N" } },
  { label: "cut N", cmd: { op: "delete", rows: ["N"] } },
  { label: "insert a row before N", cmd: { op: "insert", before: "N", id: "M", text: "m" } },
  { label: "create a heading above N", cmd: { op: "heading", above: "N", id: "H", text: "h" } },
  { label: "move B to the top", cmd: { op: "move", drop: { unit: "row", first: "B", target: null, after: true } } },
  { label: "move A below B", cmd: { op: "move", drop: { unit: "row", first: "A", target: "B", after: true } } },
  { label: "type narration at the start of B", cmd: { op: "type", id: "B", field: "audio", at: 0, text: "y" } },
  { label: "cut B", cmd: { op: "delete", rows: ["B"] } },
  { label: "create a heading above B", cmd: { op: "heading", above: "B", id: "H", text: "h" } },
  { label: "move the run B through N above A", cmd: { op: "move", drop: { unit: "rows", first: "B", last: "N", target: "A", after: false } } }
];
