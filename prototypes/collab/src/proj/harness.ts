import * as Y from "yjs";
import { DeliveryQueue } from "../delivery.ts";
import type { SchemaReplica } from "../schema.ts";
import type { SchemaCandidate } from "../schema.ts";
import { createProjectionReplica, fromDocument, toDocument } from "./document.ts";
import type { ProjectionBag } from "./value.ts";

export class DocumentProjectionHarness {
  readonly alice: SchemaReplica;
  readonly bob: SchemaReplica;
  readonly queue: DeliveryQueue;
  readonly replicas: SchemaReplica[];

  constructor(source: ProjectionBag, candidate: SchemaCandidate, swapped = false) {
    const seed = fromDocument(source, candidate);
    this.alice = createProjectionReplica(candidate, swapped ? 2 : 1);
    this.bob = createProjectionReplica(candidate, swapped ? 1 : 2);
    try {
      const update = Y.encodeStateAsUpdate(seed.doc);
      Y.applyUpdate(this.alice.doc, update, "seed");
      Y.applyUpdate(this.bob.doc, update, "seed");
    } finally { seed.destroy(); }
    this.replicas = [this.alice, this.bob];
    this.queue = new DeliveryQueue({ A: this.alice, B: this.bob });
  }

  lateJoin(): void {
    const carol = createProjectionReplica(this.alice.candidate, 3);
    Y.applyUpdate(carol.doc, Y.encodeStateAsUpdate(this.alice.doc), "delivery");
    this.queue.addReplica("C", carol);
    this.replicas.push(carol);
  }

  documents(): ProjectionBag[] {
    return this.replicas.map(replica => toDocument(replica.doc, replica.candidate));
  }

  destroy(): void {
    this.queue.destroy();
    this.replicas.forEach(replica => replica.destroy());
  }
}
