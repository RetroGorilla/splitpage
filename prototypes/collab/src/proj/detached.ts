import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { DocumentProjectionHarness } from "./harness.ts";
import { projectionConcurrentSeed } from "./concurrency.ts";
import { copy, records } from "./value.ts";
import type { ProjectionBag } from "./value.ts";
import { mediaComments } from "../../../../src/core/document/media.ts";

export function moveProjectionComment(replica: SchemaReplica, comment: string, from: string, into: string): void {
  replica.doc.transact(() => {
    const source = replica.locate(from);
    const target = replica.locate(into);
    source.text.format(source.start, source.end - source.start, { [`c:${comment}`]: null });
    target.text.format(target.start, target.end - target.start, { [`c:${comment}`]: true });
    const record = mapValue(replica.doc.getMap("comments").get(comment));
    record.set("rowId", into);
    record.set("field", "audioText");
  }, replica.localOrigin);
}

export function runDetachedProjections() {
  const results = [];
  for (const candidate of ["A", "B"] as const) for (const order of ["D1", "dup", "rev", "late-C"] as const) {
    for (const swapped of [false, true]) {
      const source = copy(projectionConcurrentSeed);
      const row = records(source.rows)[0] as ProjectionBag;
      row.audioText = '<span class="cmt-anchor" data-cmt="C1">a</span>';
      const comment = records(source.comments)[0] as ProjectionBag;
      comment.anchorId = "C1";
      const media = mediaComments({ id: "R1", updatedAt: "" }, "visualText", [{ kind: "image", ref: { sha256: "a".repeat(64) } }],
        { known: () => null, fromDataUrl: () => null }, href => href)[0];
      if (!media) throw new Error("Missing media comment input");
      (source.comments as ProjectionBag[]).push({ ...media });
      const harness = new DocumentProjectionHarness(source, candidate, swapped);
      try {
        const location = harness.alice.locate("R1");
        location.text.delete(location.start, 1);
        moveProjectionComment(harness.bob, "C1", "R1", "R2");
        harness.queue.flush(order);
        if (order === "late-C") harness.lateJoin();
        const moved = harness.documents();
        const after = harness.alice.locate("R2");
        after.text.delete(after.start, 1);
        harness.queue.flush(order);
        const detached = harness.documents();
        results.push({ candidate, order, swapped, moved, detached, history: [...harness.queue.history] });
      } finally { harness.destroy(); }
    }
  }
  return results;
}
