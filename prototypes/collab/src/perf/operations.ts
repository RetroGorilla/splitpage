import { wireIdentity } from "../readers/identity.ts";
import * as Y from "yjs";
import { perfReaderView } from "../readers/perf.ts";
import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { statusFrontier, statusValue } from "../marks/commands.ts";
import { readStatusEvent } from "../marks/status-resolution.ts";
import type { ProjectionBag } from "../proj/value.ts";
import type { PerfBlockIndex } from "./blocks.ts";

export function splitPerfBeat(replica: SchemaReplica, beat: string, offset: number, id: string): void {
  beat = wireIdentity(beat); id = wireIdentity(id);
  replica.doc.transact(() => {
    replica.split(beat, offset, id, `boundary-${id}`);
    const record = mapValue(replica.doc.getMap("beats").get(id));
    record.set("id", id);
    record.set("status", "todo");
    record.set("stamp", {});
    record.set("keys", ["id", "audioText", "visualText", "status"]);
  }, replica.localOrigin);
}

export function writePerfStatus(replica: SchemaReplica, beat: string, id: string, value: string): void {
  beat = wireIdentity(beat); id = wireIdentity(id);
  const event = readStatusEvent({ target: beat, value, parents: statusFrontier(replica, beat).map(([key]) => key).sort(), by: "writer" });
  if (!event) throw new Error("Invalid performance status command");
  replica.doc.getMap("statusEvents").set(id, { target: event.target, value: event.value, prior: statusValue(replica, beat), parents: event.parents, by: event.by });
}

export function capturePerfBeat(index: PerfBlockIndex, beat: string): Y.RelativePosition[] {
  const span = index.locate(beat);
  const result: Y.RelativePosition[] = [];
  for (let offset = span.start; offset < span.end; offset++) result.push(Y.createRelativePositionFromTypeIndex(span.text, offset, 0));
  return result;
}

export function resolvePerfIdentity(index: PerfBlockIndex, position: Y.RelativePosition): { beat: string; offset: number } | null {
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, index.doc, false);
  if (!absolute) return null;
  const span = index.containing(absolute.type, absolute.index);
  if (!span) return null;
  const fresh = Y.createRelativePositionFromTypeIndex(span.text, absolute.index, 0);
  if (fresh.item?.client !== position.item?.client || fresh.item?.clock !== position.item?.clock) return null;
  return { beat: span.block.id, offset: absolute.index - span.start };
}

export interface PerfStructureView {
  groups: { id: string; members: string[]; narration: string; visual: string; status: string }[];
  recovery: string[];
}

export function perfStructureView(replica: SchemaReplica, document: ProjectionBag): PerfStructureView {
  return perfReaderView(replica, document, id => statusValue(replica, id));
}
