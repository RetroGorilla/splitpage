import type { CollabModel } from "./model.ts";
import type { SchemaReplica } from "./schema.ts";

export function replaceWithStaleBeat(replica: SchemaReplica): void {
  replica.doc.transact(() => {
    const { text, start, end } = replica.locate("R1");
    text.delete(start + 1, end - start - 2);
  }, replica.localOrigin);
}

export function deleteStaleOffsets(replica: SchemaReplica): void {
  replica.doc.transact(() => {
    const { text, start } = replica.locate("R1");
    text.delete(start + 1, 2);
  }, replica.localOrigin);
}

export function copyOnRestore(replica: SchemaReplica): void {
  replica.insert("R2", 0, "cd", ["x1", "x2"]);
  replica.restore("R2", "rA");
}

export function copyOnJoin(replica: SchemaReplica): void {
  replica.insert("R1", 2, "cd", ["x1", "x2"]);
  replica.join("R2", "R1", "jA");
}

export function singleCommentMark(replica: SchemaReplica, comment: string, offset: number): void {
  replica.format("R1", offset, 2, { cmt: comment });
}

export function omitLength(model: CollabModel): CollabModel {
  for (const row of model.rows) delete row.lengthSeconds;
  return JSON.parse(JSON.stringify(model)) as CollabModel;
}
