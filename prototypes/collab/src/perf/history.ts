import * as Y from "yjs";
import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { records } from "../proj/value.ts";
import type { ProjectionBag } from "../proj/value.ts";
import { toDocument } from "../proj/document.ts";
import { serializeProjection } from "../proj/reference.ts";
import { splitPerfBeat, writePerfStatus } from "./operations.ts";

export const historyMix = { typing: 60, deleting: 15, retyping: 15, split: 1, join: 1, retireJoin: 1, remove: 1, restore: 1, status: 2, comment: 3 };

export function applyWritingCycle(replica: SchemaReplica, cycle: number, beat: string, comment: string): number {
  const location = replica.locate(beat);
  let index = location.start + Math.min(10, location.end - location.start);
  const text = "Writing and revising a sentence with ordinary words and spaces.";
  for (let op = 0; op < 60; op++) location.text.insert(index++, text[op % text.length] as string, {});
  for (let op = 0; op < 15; op++) location.text.delete(--index, 1);
  for (let op = 0; op < 15; op++) location.text.insert(index++, "rewritten words "[op] as string, {});
  const split = `history-beat-${cycle}`;
  splitPerfBeat(replica, beat, index - location.start, split);
  replica.join(split, beat, `history-join-${cycle}`);
  replica.doc.getMap("retiredJoins").set(`history-join-${cycle}`, true);
  const after = replica.locate(split);
  const observed = [];
  for (let position = after.start; position < after.end; position++) {
    const identity = Y.createRelativePositionFromTypeIndex(after.text, position, 0).item;
    if (identity) observed.push({ client: identity.client, clock: identity.clock });
  }
  replica.remove(split, `history-removal-${cycle}`, "writer", observed);
  if (cycle % 5 !== 0) replica.restore(split, `history-removal-${cycle}`);
  else {
    replica.remove(split, `history-second-removal-${cycle}`, "writer", observed);
    replica.restore(split, `history-removal-${cycle}`);
  }
  writePerfStatus(replica, beat, `history-status-${cycle}-a`, "ready");
  writePerfStatus(replica, beat, `history-status-${cycle}-b`, "shot");
  const record = mapValue(replica.doc.getMap("comments").get(comment));
  for (let op = 0; op < 3; op++) record.set("text", `Revision ${cycle}, comment ${op}: clarify the wording.`);
  return cycle % 5 === 0 ? 101 : 100;
}

export function retainedCounts(replica: SchemaReplica): ProjectionBag {
  let removedBeats = 0, removalFlags = 0, joinEntries = 0;
  for (const value of replica.doc.getMap("beats").values()) {
    const beat = mapValue(value);
    const removals = mapValue(beat.get("removals"));
    if (removals.size) removedBeats++;
    removalFlags += removals.size;
    joinEntries += mapValue(beat.get("joins")).size;
  }
  const plain = toDocument(replica.doc, replica.candidate);
  const activeRows = records(plain.rows).filter(row => !mapValue(mapValue(replica.doc.getMap("beats").get(String(row.id))).get("removals")).size);
  return { beats: replica.doc.getMap("beats").size, removedBeats, removalFlags, removalRecords: replica.doc.getMap("removalRecords").size,
    joinEntries, retiredJoins: replica.doc.getMap("retiredJoins").size, statusEvents: replica.doc.getMap("statusEvents").size,
    projectedFileBytes: Buffer.byteLength(serializeProjection(plain)), activeFileBytes: Buffer.byteLength(serializeProjection({ ...plain, rows: activeRows })) };
}
