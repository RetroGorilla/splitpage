import * as Y from "yjs";
import { betweenRanks, type MoveReplica } from "../native-moves/ranks.ts";
import { nativeMarkName, usesActionKey, type NativeDeltaItem } from "../native/variant.ts";
import { noticeKey, type NoticeBeat, type NoticeFields, type NoticeReading, type NoticeRun, type NoticeValue } from "./compare.ts";

const rankKey = "e10Rank";

function readRuns(delta: readonly NativeDeltaItem[]): NoticeRun[] {
  const runs: NoticeRun[] = [];
  for (const part of delta) {
    const marks = Object.fromEntries(Object.entries(part.attributes ?? {})
      .filter(([, value]) => value !== null && value !== false)
      .map(([key, value]) => [nativeMarkName(key), value])) as NoticeFields;
    const insert = structuredClone(part.insert) as NoticeRun["insert"];
    const previous = runs.at(-1);
    const currentMarks = Object.keys(marks).length ? marks : undefined;
    if (previous && typeof previous.insert === "string" && typeof insert === "string" &&
      noticeKey(previous.marks) === noticeKey(currentMarks)) {
      runs[runs.length - 1] = { ...previous, insert: previous.insert + insert };
    } else {
      runs.push(currentMarks ? { insert, marks: currentMarks } : { insert });
    }
  }
  return runs;
}

export function readNotice(replica: MoveReplica): NoticeReading {
  const owner = new Map(replica.rows().flatMap(row => row.members.map(member => [member, row.id] as const)));
  const seen = new Set<string>(), result: NoticeBeat[] = [];
  let scene: string | null = null;
  for (const block of replica.blocks()) {
    if (block.kind === "h") {
      if (!replica.headings.get(block.id)?.get("removed")) scene = block.id;
      continue;
    }
    const row = owner.get(block.id), record = replica.beats.get(block.id);
    if (!record || row === undefined || seen.has(block.id)) continue;
    seen.add(block.id);
    const { status, ...fields } = record.toJSON() as Record<string, unknown>;
    delete fields.e10Rank;
    result.push({
      id: block.id, scene, row, narration: readRuns(block.delta),
      visual: readRuns((replica.visuals.get(block.id)?.toDelta() ?? []) as NativeDeltaItem[]),
      status: (structuredClone(status) ?? null) as NoticeValue,
      fields: structuredClone(fields) as NoticeFields
    });
  }
  return result;
}

export interface NoticeCheckpoint {
  readonly base: NoticeReading;
}

export function inSyncNow(replica: MoveReplica): NoticeCheckpoint {
  return { base: readNotice(replica) };
}

export function observeRemoteRemoval(
  replica: MoveReplica, receive: (before: NoticeReading, after: NoticeReading, transaction: Y.Transaction) => void
): () => void {
  let before: NoticeReading | undefined;
  const begin = (transaction: Y.Transaction) => {
    if (!transaction.local) before = readNotice(replica);
  };
  const end = (transaction: Y.Transaction) => {
    if (!transaction.local && before) {
      const earlier = before;
      before = undefined;
      receive(earlier, readNotice(replica), transaction);
    }
  };
  replica.doc.on("beforeTransaction", begin);
  replica.doc.on("afterTransaction", end);
  return () => {
    replica.doc.off("beforeTransaction", begin);
    replica.doc.off("afterTransaction", end);
  };
}

export function observeRemoteBeatIds(
  replica: MoveReplica, receive: (removed: readonly string[]) => void
): () => void {
  const observe = (event: Y.YMapEvent<Y.Map<unknown>>, transaction: Y.Transaction) => {
    if (transaction.local) return;
    const removed = [...event.changes.keys].flatMap(([id, change]) => change.action === "delete" ? [id] : []);
    if (removed.length) receive(removed);
  };
  replica.beats.observe(observe);
  return () => replica.beats.unobserve(observe);
}

export type RestoreWrite = "segment" | "head" | "narration-cell" | "narration" | "order" |
  "beat" | "rank" | "status" | "field" | "visual-cell" | "visual" | "narration-embed" | "visual-embed";

type WriteRestorePart = (part: RestoreWrite, write: () => void) => void;

function restoreGap(replica: MoveReplica, old: NoticeReading, wanted: NoticeBeat): [string | null, string | null] {
  const blocks = replica.blocks().map(block => {
    const fields = block.kind === "h" ? replica.headings.get(block.id) : replica.beats.get(block.id);
    const rank = fields?.get(rankKey);
    if (typeof rank !== "string") throw new Error("Expected a flat rank");
    return { id: block.id, kind: block.kind, shown: block.kind === "h" && !fields?.get("removed"), rank };
  });
  const sceneAt = wanted.scene === null ? -1 : blocks.findIndex(block => block.shown && block.id === wanted.scene);
  const end = blocks.findIndex((block, index) => index > sceneAt && block.shown);
  const start = sceneAt + 1, stop = end === -1 ? blocks.length : end;
  const neighbourhood = blocks.slice(start, stop);
  const oldAt = old.indexOf(wanted);
  const byId = new Map(neighbourhood.flatMap((block, index) => block.kind === "b" ? [[block.id, start + index] as const] : []));
  const survivors = (beats: NoticeReading) => {
    for (const beat of beats) {
      if (beat.id === null || beat.scene !== wanted.scene) continue;
      const position = byId.get(beat.id);
      if (position !== undefined) return position;
    }
  };
  const sameScene = wanted.scene === null || sceneAt >= 0;
  const left = sameScene ? survivors(old.slice(0, oldAt).reverse()) : undefined;
  const right = sameScene ? survivors(old.slice(oldAt + 1)) : undefined;
  let at = left === undefined ? (right ?? stop) : left + 1;
  while (at < stop && at > 0 && blocks[at - 1]?.rank === blocks[at]?.rank) at++;
  if (at > 0 && blocks[at - 1]?.rank === blocks[at]?.rank) {
    while (at > 0 && blocks[at - 1]?.rank === blocks[at]?.rank) at--;
  }
  return [blocks[at - 1]?.rank ?? null, blocks[at]?.rank ?? null];
}

function writeRuns(
  text: Y.Text, runs: readonly NoticeRun[], side: "narration" | "visual", part: WriteRestorePart,
  actionKey: (name: string) => string
): void {
  let previousTags = new Map<string, string>();
  for (const run of runs) {
    const insert = run.insert;
    const tags = new Map<string, string>();
    const attributes = Object.fromEntries(Object.entries(run.marks ?? {}).map(([key, value]) => {
      const name = nativeMarkName(key);
      if (value !== true || !usesActionKey("chosen", name)) return [key, value];
      const fresh = tags.get(name) ?? previousTags.get(name) ?? actionKey(name);
      tags.set(name, fresh);
      return [fresh, value];
    }));
    previousTags = tags;
    if (typeof insert === "string") {
      part(side, () => text.insert(text.doc ? text.length : 0, insert, attributes));
    } else {
      part(`${side}-embed`, () => text.insertEmbed(text.doc ? text.length : 0, structuredClone(insert), attributes));
    }
  }
}

export function putNoticeBack(
  replica: MoveReplica, old: NoticeReading, beatId: string, freshId: string, serial: number,
  part: WriteRestorePart = (_part, write) => write()
): void {
  const saved = old.find(beat => beat.id === beatId);
  const segmentId = "seg-b-" + freshId;
  if (!saved || !freshId || old.some(beat => beat.id === freshId) ||
    replica.beats.has(freshId) || replica.segments.has(segmentId) || replica.visuals.has(freshId)) {
    throw new Error("Expected a saved beat and a fresh id");
  }
  const [left, right] = restoreGap(replica, old, saved);
  const rank = betweenRanks(left, right, replica.doc.clientID, serial);
  const segment = new Y.Map<unknown>(), record = new Y.Map<unknown>();
  const narration = new Y.Text(), visual = new Y.Text();
  const actionKey = (name: string) => {
    const client = replica.doc.clientID;
    const clock = Y.decodeStateVector(Y.encodeStateVector(replica.doc)).get(client) ?? 0;
    return `${name}\u001f${client.toString(36)}.${clock.toString(36)}`;
  };
  replica.undo.stopCapturing();
  replica.transact(() => {
    part("head", () => segment.set("head", { b: freshId }));
    part("narration-cell", () => segment.set("text", narration));
    part("segment", () => replica.segments.set(segmentId, segment));
    writeRuns(narration, saved.narration, "narration", part, actionKey);
    part("order", () => replica.order.push([segmentId]));
    part("rank", () => record.set(rankKey, rank));
    if (saved.status !== null) part("status", () => record.set("status", structuredClone(saved.status)));
    for (const [key, value] of Object.entries(saved.fields)) {
      if (key !== "joined") part("field", () => record.set(key, structuredClone(value)));
    }
    part("beat", () => replica.beats.set(freshId, record));
    part("visual-cell", () => replica.visuals.set(freshId, visual));
    writeRuns(visual, saved.visual, "visual", part, actionKey);
  });
  replica.undo.stopCapturing();
}
