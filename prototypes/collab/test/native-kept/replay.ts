import { isDeepStrictEqual as equal } from "node:util";
import * as Y from "yjs";
import { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { KeptReplica } from "../../src/native-kept/replica.ts";
import { ALL_RULES, STRAY_ROW } from "../../src/native/variant.ts";
import type { NativeDeltaItem, NativeRules } from "../../src/native/variant.ts";
import { neverAcceptable, reachability } from "../native-chosen/check.ts";
import { deliver, readStored, readStyles } from "../native-chosen/engine.ts";
import type { Mode } from "../native-chosen/engine.ts";
import { outline, seed } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import { letterItems, perform } from "../native-chosen/play.ts";
import type { Cmd, Step } from "../native-chosen/play.ts";
import { need } from "../native-delete/model.ts";

export function openCopy(bytes: Uint8Array, client: number, keep: boolean, rules: NativeRules = ALL_RULES): ChosenReplica {
  const replica = keep ? new KeptReplica(client, rules) : new ChosenReplica(client, rules, "cells");
  Y.applyUpdate(replica.doc, bytes, "remote");
  replica.changes();
  return replica;
}

export type KeptCommand = Cmd | { op: "sceneDelete"; id: string };
export type KeptStep = { by: number; cmd: KeptCommand } | Exclude<Step, { by: number }>;

export function runCommand(replica: ChosenReplica, cmd: KeptCommand): void {
  if (cmd.op !== "sceneDelete") { perform(replica, cmd); return; }
  const entries = replica.outline(), start = entries.findIndex(entry => entry.kind === "heading" && entry.id === cmd.id);
  if (start === -1) throw new Error(`No scene ${cmd.id}`);
  const ids: string[] = [];
  for (const entry of entries.slice(start + 1)) {
    if (entry.kind === "heading") break;
    ids.push(entry.row.id);
  }
  replica.transact(() => {
    replica.deleteRows(ids);
    replica.removeHeading(cmd.id);
  });
  replica.changes();
}

interface Peer {
  replica: ChosenReplica;
  packets: Set<number>;
}

export interface ReplayResult {
  problems: string[];
  count: number;
  rankUse: boolean;
  missingRank: boolean;
  lines: string[];
  state: { beats: Record<string, Record<string, unknown>>; visuals: Record<string, NativeDeltaItem[]> } | null;
  orphans: string[];
  doubled: string[];
  stale: string[];
  rankAt: string[];
  cuts: Map<number, Set<string>>;
  restored: Set<string>;
}

function narrationStock(spec: Spec, steps: readonly KeptStep[]): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (text: string): void => { for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1); };
  for (const segment of Object.values(spec.segments)) {
    let isName = !!segment.head && "h" in segment.head;
    for (const unit of segment.units) {
      if (typeof unit !== "string") isName = "h" in unit;
      else if (!isName) add(unit);
    }
  }
  for (const step of steps) if ("cmd" in step) {
    const { cmd } = step;
    if (cmd.op === "insert" || cmd.op === "type" && cmd.field === "audio") add(cmd.text);
  }
  return counts;
}

export interface KeptReplayChecks {
  command?: (replica: ChosenReplica, index: number) => void;
  settled?: (replica: ChosenReplica) => void;
}

function place(replica: ChosenReplica): Map<string, string | null> {
  const result = new Map<string, string | null>();
  let scene: string | null = null;
  for (const block of replica.blocks()) {
    if (block.kind === "b") result.set(block.id, scene);
    else if (!replica.headings.get(block.id)?.get("removed")) scene = block.id;
  }
  return result;
}

function tape(replica: ChosenReplica): { ids: Set<string>; letters: Map<string, number> } {
  const ids = new Set<string>(), letters = new Map<string, number>();
  const add = (marker: unknown): void => {
    if (marker && typeof marker === "object" && "b" in marker && typeof marker.b === "string") ids.add(marker.b);
  };
  for (const id of replica.order.toArray()) {
    const segment = replica.segments.get(id), text = segment?.get("text");
    add(segment?.get("head"));
    if (text instanceof Y.Text) for (const unit of text.toDelta() as NativeDeltaItem[]) {
      if (typeof unit.insert === "string") {
        for (const char of unit.insert) letters.set(char, (letters.get(char) ?? 0) + 1);
      } else add(unit.insert);
    }
  }
  return { ids, letters };
}

function surroundings(replica: ChosenReplica, before: Map<string, string | null>): string[] {
  const after = place(replica), common = new Set([...before.keys()].filter(id => after.has(id)));
  const changed = [...common].filter(id => before.get(id) !== after.get(id));
  if (changed.length) return [`untouched beats changed scene: ${changed.join(", ")}`];
  if (!equal([...before.keys()].filter(id => common.has(id)), [...after.keys()].filter(id => common.has(id)))) {
    return ["untouched beats changed relative order"];
  }
  return [];
}

export function replay(spec: Spec, steps: readonly KeptStep[], writers: number, keep: boolean, mode: Mode, number: number,
  rules: NativeRules = ALL_RULES, expected?: KeptReplayChecks): ReplayResult {
  const initial = seed(spec, ALL_RULES, "cells"), updates: Uint8Array[] = [];
  const result: ReplayResult = {
    problems: [], count: 0, rankUse: false, missingRank: false, lines: [], state: null, orphans: [], doubled: [], stale: [], rankAt: [],
    cuts: new Map(), restored: new Set()
  };
  const stock = narrationStock(spec, steps), repeated = new Set<string>();
  const owned: Peer[] = [];
  const load = (bytes: Uint8Array, client: number, packets: Iterable<number> = []): Peer => {
    const peer = { replica: openCopy(bytes, client, keep, rules), packets: new Set(packets) };
    owned.push(peer);
    peer.replica.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") peer.packets.add(updates.push(update) - 1);
    });
    return peer;
  };
  const send = (source: Peer, target: Peer, at: number): void => {
    const packetIds = [...source.packets].filter(id => !target.packets.has(id)).sort((a, b) => a - b);
    for (const id of packetIds) target.packets.add(id);
    if (mode === "state") Y.applyUpdate(target.replica.doc, Y.encodeStateAsUpdate(source.replica.doc, Y.encodeStateVector(target.replica.doc)), "remote");
    else deliver(target.replica, packetIds.map(id => need(updates[id], "update")), mode, number + at);
  };
  const check = (peer: Peer, stage: string): Set<string> => {
    const { replica } = peer, reach = reachability(replica);
    result.problems.push(...neverAcceptable(reach).map(message => `${stage}: ${message}`));
    const { ids: live, letters } = tape(replica);
    for (const [unit, count] of letters) if (count > (stock.get(unit) ?? 0)) repeated.add(unit);
    const members = replica.rows().flatMap(row => row.members).filter(id => id !== STRAY_ROW);
    if (!equal(new Set(members), live) || members.length !== live.size) result.problems.push(`${stage}: boundary and row membership differ`);
    const missing = [...live].filter(id => typeof replica.beats.get(id)?.get("e10Rank") !== "string");
    if (missing.length) {
      result.missingRank = true;
      if (!result.rankAt.length) result.rankAt.push(`${stage}: ${missing.join(",")}`);
    }
    result.rankUse ||= replica.ruleUse().rank > 0;
    return live;
  };
  const peers = Array.from({ length: writers }, (_, i) => steps.some(step => "open" in step && step.open === i) ? undefined : load(initial, i + 1));
  const waiting = load(initial, 801);
  let at = -1;
  try {
    for (const [index, step] of steps.entries()) {
      at = index;
      if ("open" in step) {
        const source = need(peers[step.from], "source copy");
        peers[step.open] = load(source.replica.encode(), step.open + 1, source.packets);
      } else if ("from" in step) {
        const peer = need(peers[step.to], "receiving copy");
        send(need(peers[step.from], "sending copy"), peer, at);
        check(peer, `delivery ${at}`);
      } else {
        const peer = need(peers[step.by], "acting copy"), { replica } = peer, cmd = step.cmd;
        const singleMove = cmd.op === "move" && cmd.drop.unit === "row";
        const checkPlace = singleMove || ["type", "erase", "format", "field", "split", "join", "unjoin", "delete", "sceneDelete", "insert"].includes(cmd.op);
        const before = checkPlace ? place(replica) : null;
        const press = cmd.op === "undo" || cmd.op === "redo";
        const beforePress = press ? tape(replica).ids : null;
        if (singleMove && before) {
          for (const member of replica.rows().find(row => row.id === cmd.drop.first)?.members ?? []) before.delete(member);
        }
        const mayChangeNarration = cmd.op === "delete" || cmd.op === "sceneDelete" || cmd.op === "undo" || cmd.op === "redo"
          || cmd.op === "insert" || (cmd.op === "type" || cmd.op === "erase") && cmd.field === "audio";
        const letters = mayChangeNarration ? null : letterItems(replica);
        const rows = cmd.op === "join" || cmd.op === "move" && cmd.drop.unit !== "scene" ? replica.rows().map(row => row.id) : [];
        const staleJoin = cmd.op === "join" && rows.indexOf(cmd.id) <= 0;
        const staleDrop = cmd.op === "move" && cmd.drop.unit !== "scene"
          && [cmd.drop.first, cmd.drop.last, cmd.drop.target].some(id => typeof id === "string" && !rows.includes(id));
        if (keep && (staleJoin || staleDrop)) {
          result.stale.push(`step ${at} ${cmd.op}`);
          if (cmd.op === "move" && replica.drop(cmd.drop)) result.problems.push(`step ${at}: wrote a stale move`);
        } else runCommand(replica, cmd);
        result.count++;
        if (before) result.problems.push(...surroundings(replica, before).map(message => `step ${at} ${cmd.op}: ${message}`));
        if (letters && !equal(letters, letterItems(replica))) result.problems.push(`step ${at}: ${cmd.op} rewrote narration`);
        const live = check(peer, `step ${at}`);
        if ((cmd.op === "delete" || cmd.op === "sceneDelete") && before) {
          result.cuts.set(at, new Set([...before.keys()].filter(id => !live.has(id))));
        }
        if (beforePress) for (const id of live) if (!beforePress.has(id)) result.restored.add(id);
        expected?.command?.(replica, at);
        if (result.count === 1) send(peer, waiting, at);
      }
    }
    const everyone = [...peers.filter((peer): peer is Peer => peer !== undefined), waiting], hub = need(everyone[0], "hub");
    for (let pass = 0; pass < 10 && everyone.some(peer => peer.packets.size !== updates.length); pass++) {
      for (const peer of everyone.slice(1)) send(peer, hub, steps.length);
      for (const peer of everyone.slice(1)) send(hub, peer, steps.length);
    }
    if (everyone.some(peer => peer.packets.size !== updates.length)) result.problems.push("delivery did not settle");
    result.lines = outline(hub.replica, true);
    result.state = readStyles(hub.replica) as ReplayResult["state"];
    const late = load(hub.replica.encode(), 802);
    for (const peer of [...everyone, late]) {
      check(peer, `settled copy ${peer.replica.doc.clientID}`);
      expected?.settled?.(peer.replica);
      if (!equal(readStyles(peer.replica), result.state) || !equal(outline(peer.replica, true), result.lines)) {
        result.problems.push(`settled copy ${peer.replica.doc.clientID} disagrees`);
      }
    }
    const live = place(hub.replica);
    result.orphans = [...new Set([...hub.replica.beats.keys(), ...hub.replica.visuals.keys()])].filter(id => !live.has(id)).sort();
    result.doubled = [...repeated].sort();
  } catch (error) {
    result.problems.push(`step ${at} threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const peer of owned) peer.replica.destroy();
  }
  return result;
}

export function forkSnapshot(replica: ChosenReplica) {
  return { stored: readStored(replica), names: Object.fromEntries([...replica.names].map(([id, text]) => [id, text.toString()])) };
}
