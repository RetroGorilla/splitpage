import type * as Y from "yjs";
import type { NativeHeadingReplica } from "../native/headings.ts";
import type { NativeRow } from "../native/variant.ts";
import { arrange, blockRef } from "./order.ts";
import type { Placement } from "./order.ts";

export type MoveRole = "member" | "dependent";
export interface MoveWrite { ref: string; role: MoveRole; place: Placement }
export interface MovePlan { members: string[]; writes: MoveWrite[] }

export function recordOf(replica: NativeHeadingReplica, ref: string): Y.Map<unknown> {
  const record = ref.startsWith("h:") ? replica.headings.get(ref.slice(2)) : replica.beats.get(ref.slice(2));
  if (!record) throw new Error(`Missing record ${ref}`);
  return record;
}

function nextInContainer(replica: NativeHeadingReplica): Map<string, string | null> {
  const natural = replica.naturalBlocks(), result = new Map<string, string | null>();
  natural.forEach((block, index) => {
    const next = natural[index + 1];
    result.set(blockRef(block.kind, block.id), next && next.segment === block.segment ? blockRef(next.kind, next.id) : null);
  });
  return result;
}

// why: the moved blocks are written after the block shown above the drop place; blocks that were shown after them only
// because they hung on a moved block are written after the block now shown above them, so they stay where they were
export function planMove(replica: NativeHeadingReplica, first: string, last: string, after: string | null): MovePlan | null {
  const arrangement = replica.arrangement(), order = arrangement.order, from = order.indexOf(first), to = order.indexOf(last);
  if (from < 0 || to < from) throw new Error(`No run from ${first} to ${last}`);
  const members = order.slice(from, to + 1), moving = new Set(members);
  if ((order[from - 1] ?? null) === after || after === last) return null;
  if (after !== null && (moving.has(after) || !order.includes(after))) throw new Error(`Cannot move ${first} after ${after}`);
  const rest = order.filter(ref => !moving.has(ref));
  rest.splice(after === null ? 0 : rest.indexOf(after) + 1, 0, ...members);
  const above = new Map(rest.map((ref, index) => [ref, rest[index - 1] ?? null])), until = nextInContainer(replica), n = replica.nextStamp();
  const dependents = order.filter(ref => !moving.has(ref) && moving.has(arrangement.parent.get(ref) ?? ""));
  // why: a block placed before keeps the end of its run, so the beats split off it that go with it still go with it
  const end = (ref: string): string | null => { const placed = arrangement.placed.get(ref); return placed ? placed.u : until.get(ref) ?? null; };
  const writes = new Map<string, MoveWrite>();
  const write = (role: MoveRole) => (ref: string): void => { writes.set(ref, { ref, role, place: { a: above.get(ref) ?? null, n, u: end(ref) } }); };
  members.forEach(write("member"));
  dependents.forEach(write("dependent"));
  const natural = replica.naturalBlocks().map(block => ({ ref: blockRef(block.kind, block.id), kind: block.kind, segment: block.segment, start: block.start }));
  // why: a placement that a loop had set aside can apply again once the move ends the loop; any block the writes so far
  // would leave out of the intended order is placed after the block intended above it, the first one first
  for (let round = 0; ; round++) {
    const shown = arrange(natural, ref => writes.get(ref)?.place ?? replica.placement(ref)).order;
    const wrong = rest.find((ref, index) => shown[index] !== ref);
    if (wrong === undefined) break;
    if (round > rest.length) { rest.forEach(write("dependent")); break; }
    write("dependent")(wrong);
  }
  return { members, writes: [...writes.values()] };
}

export function moveBlocks(replica: NativeHeadingReplica, first: string, last: string, after: string | null): boolean {
  const plan = planMove(replica, first, last, after);
  if (!plan) return false;
  replica.transact(() => { for (const { ref, place } of plan.writes) recordOf(replica, ref).set("place", place); });
  replica.changes();
  return true;
}

function rowOf(replica: NativeHeadingReplica, id: string): NativeRow {
  const row = replica.rows().find(candidate => candidate.id === id);
  if (!row) throw new Error(`No row ${id}`);
  return row;
}

function ends(row: NativeRow): { first: string; last: string } {
  return { first: blockRef("b", row.members[0] ?? row.id), last: blockRef("b", row.members.at(-1) ?? row.id) };
}

// why: the app's drag, Alt+arrow and menu moves name a row and the row it lands before or after
export function moveRow(replica: NativeHeadingReplica, id: string, target: string, after: boolean): boolean {
  const { first, last } = ends(rowOf(replica, id)), aim = ends(rowOf(replica, target)), order = replica.arrangement().order;
  return moveBlocks(replica, first, last, after ? aim.last : order[order.indexOf(aim.first) - 1] ?? null);
}

export function moveRows(replica: NativeHeadingReplica, from: string, to: string, after: string | null): boolean {
  return moveBlocks(replica, ends(rowOf(replica, from)).first, ends(rowOf(replica, to)).last, after);
}

export function moveIntoScene(replica: NativeHeadingReplica, id: string, heading: string): boolean {
  const { first, last } = ends(rowOf(replica, id));
  return moveBlocks(replica, first, last, blockRef("h", heading));
}

export function sceneRange(replica: NativeHeadingReplica, heading: string): { first: string; last: string } {
  const order = replica.arrangement().order, first = blockRef("h", heading), start = order.indexOf(first);
  if (start < 0) throw new Error(`No heading ${heading}`);
  let end = start;
  while (end + 1 < order.length && !isShownHeading(replica, order[end + 1] ?? "")) end++;
  return { first, last: order[end] ?? first };
}

function isShownHeading(replica: NativeHeadingReplica, ref: string): boolean {
  return ref.startsWith("h:") && replica.headings.get(ref.slice(2))?.get("removed") !== true;
}

export function moveScene(replica: NativeHeadingReplica, heading: string, target: string, after: boolean): boolean {
  const { first, last } = sceneRange(replica, heading), aim = sceneRange(replica, target), order = replica.arrangement().order;
  return moveBlocks(replica, first, last, after ? aim.last : order[order.indexOf(aim.first) - 1] ?? null);
}
