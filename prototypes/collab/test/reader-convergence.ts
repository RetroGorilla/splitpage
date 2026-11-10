import assert from "node:assert/strict";
import { after } from "node:test";
import { projectionDifference } from "./strict-comparison.ts";
import * as Y from "yjs";
import type { ReplicaHarness, DeliveryOrder } from "../src/delivery.ts";
import type { CollabModel, IdentityBook } from "../src/model.ts";
import type { ReplicaCarets } from "../src/reader.ts";
import { readReplica } from "../src/reader.ts";
import { SchemaReplica } from "../src/schema.ts";
import type { SchemaCandidate } from "../src/schema.ts";
import { readStructure } from "../src/structure-reader.ts";
import { classifyReaderFinding } from "./reader-order/known-failures.ts";
import type { ReaderComparisonFinding } from "./reader-order/known-failures.ts";

type ProjectionReader = (doc: Y.Doc, candidate: SchemaCandidate, book: IdentityBook, carets: ReplicaCarets) => CollabModel;
type ConvergenceHarness = Pick<ReplicaHarness, "alice" | "bob" | "replicas" | "queue" | "identities">;

const strictCheckpoints = { inspections: 0, projections: 0, comparisons: 0 };
after(() => { process.stdout.write(`Strict reader checkpoints: ${JSON.stringify(strictCheckpoints)}\n`); });

function differences(left: unknown, right: unknown, path = ""): string[] {
  if (projectionDifference(left, right, path) === null) return [];
  if (left && right && typeof left === "object" && typeof right === "object" && Object.getPrototypeOf(left) === Object.getPrototypeOf(right)) {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    const keys = [...new Set([...Object.getOwnPropertyNames(a), ...Object.getOwnPropertyNames(b)])];
    const paths = keys.flatMap(key => {
      const next = path ? `${path}.${key}` : key;
      return Object.hasOwn(a, key) !== Object.hasOwn(b, key) ? [next] : differences(a[key], b[key], next);
    });
    return paths.length ? paths : [path];
  }
  return [path];
}

export class ReaderConvergence {
  private readonly seed: Uint8Array;
  private readonly updates: Uint8Array[] = [];
  private readonly attached = new Set<Y.Doc>();
  private readonly harness: ConvergenceHarness;
  private readonly orders: readonly DeliveryOrder[];

  constructor(harness: ConvergenceHarness, orders: readonly DeliveryOrder[]) {
    this.harness = harness; this.orders = orders;
    this.seed = Y.encodeStateAsUpdate(harness.alice.doc);
    for (const replica of harness.replicas) this.attach(replica);
    const add = harness.queue.addReplica.bind(harness.queue);
    harness.queue.addReplica = (name, replica) => { add(name, replica); this.attach(replica); };
  }

  private attach(replica: SchemaReplica): void {
    if (this.attached.has(replica.doc)) return;
    this.attached.add(replica.doc);
    replica.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "delivery" && origin !== "network" && origin !== "seed") this.updates.push(update.slice());
    });
  }

  inspect(phase: string, carets: ReplicaCarets = new Map(), read: ProjectionReader = readStructure): ReaderComparisonFinding[] {
    const counted = read === readStructure || read === readReplica;
    if (counted) strictCheckpoints.inspections++;
    assert.equal(this.harness.queue.pending.length, 0, `${phase}: convergence checked with undelivered updates`);
    const source = this.harness.alice, book = this.harness.identities, findings: ReaderComparisonFinding[] = [];
    const project = (replica: SchemaReplica, label: string): { value: unknown } | null => {
      let changes = 0; const changed = (): void => { changes++; };
      replica.doc.on("update", changed);
      try { if (counted) strictCheckpoints.projections++; return { value: read(replica.doc, source.candidate, book, carets) }; }
      catch (error) { findings.push({ phase, replica: label, kind: "throw", paths: [], message: error instanceof Error ? error.message : String(error) }); return null; }
      finally { replica.doc.off("update", changed); assert.equal(changes, 0, `${phase}: reader wrote shared state`); }
    };
    const compare = (left: { value: unknown } | null, right: { value: unknown } | null, label: string): void => {
      if (!left || !right) return;
      if (counted) strictCheckpoints.comparisons++;
      const paths = differences(left.value, right.value);
      if (paths.length) findings.push({ phase, replica: label, kind: "output", paths, message: "Full projected output differs" });
    };
    const expected = project(source, "live-A");
    for (const [index, replica] of this.harness.replicas.entries()) compare(expected, project(replica, `live-${index}`), `live-${index}`);
    const probeIds = ["__reader_probe:\u00e9", "__reader_probe:e\u0301"] as const;
    const probeUpdates = read === readReplica ? [] : probeIds.map((id, index) => {
      assert.equal(source.doc.getMap("replies").has(id), false);
      const writer = new Y.Doc(); writer.clientID = 103 + index;
      try {
        const reply = new Y.Map<unknown>(); writer.getMap("replies").set(id, reply);
        for (const [key, value] of Object.entries({ commentId: "__reader_probe_comment__", author: "Probe", createdAt: 0, text: id })) reply.set(key, value);
        return Y.encodeStateAsUpdate(writer);
      } finally { writer.destroy(); }
    });
    for (const order of this.orders) {
      const replay = new SchemaReplica(source.candidate, 101, book), late = new SchemaReplica(source.candidate, 102, book);
      try {
        Y.applyUpdate(replay.doc, this.seed, "delivery");
        const updates = order === "rev" ? [...this.updates].reverse() : this.updates;
        for (const update of updates) { Y.applyUpdate(replay.doc, update, "delivery"); if (order === "dup") Y.applyUpdate(replay.doc, update, "delivery"); }
        assert.deepEqual(Y.encodeStateVector(replay.doc), Y.encodeStateVector(source.doc), `${phase}/${order}: incomplete replay`);
        compare(expected, project(replay, `${order}/replay`), `${order}/replay`);
        Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(replay.doc), "delivery");
        compare(expected, project(late, `${order}/late`), `${order}/late`);
        if (probeUpdates.length) {
          for (const update of probeUpdates) Y.applyUpdate(replay.doc, update, "delivery");
          for (const update of [...probeUpdates].reverse()) Y.applyUpdate(late.doc, update, "delivery");
          const probed = project(replay, `${order}/canonical-forward`);
          compare(probed, project(late, `${order}/canonical-reverse`), `${order}/canonical-reverse`);
          const joined = new SchemaReplica(source.candidate, 105, book);
          try { Y.applyUpdate(joined.doc, Y.encodeStateAsUpdate(replay.doc), "delivery"); compare(probed, project(joined, `${order}/canonical-late`), `${order}/canonical-late`); }
          finally { joined.destroy(); }
        }
      } finally { replay.destroy(); late.destroy(); }
    }
    return findings;
  }

  check(phase: string, carets: ReplicaCarets = new Map(), read: ProjectionReader = readStructure): void {
    assert.deepEqual(this.inspect(phase, carets, read), [], `${phase}: full output or no-throw check failed`);
  }

  checkKnown(phase: string, carets: ReplicaCarets = new Map(), read: ProjectionReader = readStructure): ReaderComparisonFinding[] {
    const findings = this.inspect(phase, carets, read);
    for (const finding of findings) assert.ok(classifyReaderFinding(finding).length, `Unlisted reader failure: ${JSON.stringify(finding)}`);
    return findings;
  }
}
