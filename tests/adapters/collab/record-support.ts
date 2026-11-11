import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { replicas } from "./executor-support.ts";
import type { SharedRecordCollection } from "../../../src/core/collab/operations.ts";

export function recordReplicas(writers = 2, source?: Record<string, unknown>) {
  const run = replicas(writers, source);
  for (const handle of [run.a, run.b, run.c]) registerSharedRecordHandlers(handle);
  return run;
}
export function createRecord(collection: SharedRecordCollection, record: string, fields: unknown, by = "Alice", id = `create-${record}`): unknown {
  return { kind: "record-create", id, by, target: { collection, record }, fields };
}
export function setRecord(collection: SharedRecordCollection, record: string, field: string, value: unknown, by = "Alice", id = `set-${record}-${field}`): unknown {
  return { kind: "record-set", id, by, target: { collection, record }, field, value };
}
export function deleteRecord(collection: SharedRecordCollection, record: string, by = "Alice", id = `delete-${record}`): unknown {
  return { kind: "record-delete", id, by, target: { collection, record } };
}
export const recordExamples = Object.freeze({
  comments: { id: "C1", author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText" },
  replies: { id: "r1", commentId: "C1", author: "Bob", createdAt: 0, text: "" },
  people: { id: "P1", name: "Alice" },
  tags: { id: "t_new", cat: "prop", name: "Mug", status: "needed" },
  shots: { id: "S2", name: "Mug", status: "unshot", origin: "list" },
  gallery: { beat: "R1", rank: "1", picture: {}, links: [] },
  visuals: { beat: "R1", rank: "1" }
});
export function recordKey(kind: SharedRecordCollection): string {
  return kind === "replies" ? '["C1","r1"]' : kind === "gallery" ? "G1" : kind === "visuals" ? "V1" : String(recordExamples[kind].id);
}
