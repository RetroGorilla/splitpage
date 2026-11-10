import * as Y from "yjs";
import { createProjectionReplica } from "../proj/document.ts";
import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { records } from "../proj/value.ts";
import { IncrementalProjection } from "./incremental.ts";
import { capturePerfBeat, perfStructureView, resolvePerfIdentity, splitPerfBeat, writePerfStatus } from "./operations.ts";

export const perfCases = ["local character", "remote character", "remote status", "remote comment", "capture identities", "resolve identity", "remote burst 100", "remote burst 100 individual transactions", "remote split", "remote join"] as const;
export type PerfCaseName = (typeof perfCases)[number];

export function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  if (fraction === 0.5 && sorted.length % 2 === 0) return ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] as number;
}

export interface PerfEditSamples {
  name: PerfCaseName;
  samples: number[];
  p50: number;
  p95: number;
  max: number;
  projectedBeats: number[];
  projectionCommits: number[];
  targetBeat: string;
  targetCharacters: number;
}

export function measureEdits(replica: SchemaReplica, warmup = 3, repetitions = 11): PerfEditSamples[] {
  const projection = new IncrementalProjection(replica);
  const remote = createProjectionReplica(replica.candidate, 2);
  Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(replica.doc));
  const ids = records(projection.document.rows).map(row => String(row.id));
  const liveIds = ids.filter(id => mapValue(mapValue(replica.doc.getMap("beats").get(id)).get("removals")).size === 0);
  const target = liveIds.slice(Math.floor(liveIds.length * 0.75)).reduce((best, id) => {
    const span = projection.index.locate(id), old = projection.index.locate(best);
    return span.end - span.start >= old.end - old.start ? id : best;
  });
  const previous = ids[ids.indexOf(target) - 1];
  const comment = [...remote.doc.getMap("comments").keys()].at(-1);
  if (!target || !previous || !comment) throw new Error("Measurement fixture lacks targets");
  let serial = 0;
  const results: PerfEditSamples[] = [];
  try {
    for (const name of perfCases) {
      const samples: number[] = [], projectedBeats: number[] = [], projectionCommits: number[] = [];
      const span = projection.index.locate(target);
      const targetCharacters = span.end - span.start;
      for (let trial = -warmup; trial < repetitions; trial++) {
        serial++;
        Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(replica.doc, Y.encodeStateVector(remote.doc)));
        const local = projection.index.locate(target);
        const location = remote.locate(target);
        const updates: Uint8Array[] = [];
        const listener = (update: Uint8Array): void => { updates.push(update); };
        remote.doc.on("update", listener);
        try {
          if (name === "remote character") location.text.insert(location.end, "x", {});
          if (name === "remote split") splitPerfBeat(remote, target, Math.min(2, location.end - location.start), `measure-split-${serial}`);
          if (name === "remote join") remote.join(target, previous, `measure-join-${serial}`);
          if (name === "remote status") writePerfStatus(remote, target, `measure-status-${serial}`, trial % 2 ? "shot" : "ready");
          if (name === "remote comment") mapValue(remote.doc.getMap("comments").get(comment)).set("text", `note ${serial}`);
          if (name.startsWith("remote burst 100")) for (let index = 0; index < 100; index++) location.text.insert(location.start, "x", {});
        } finally { remote.doc.off("update", listener); }
        const painted = name === "resolve identity" ? capturePerfBeat(projection.index, target) : [];
        const anchor = painted.at(-1);
        projection.lastProjected = [];
        const commitsBefore = projection.commits;
        const start = performance.now();
        if (name === "local character") local.text.insert(local.end, "x", {});
        else if (name === "capture identities") capturePerfBeat(projection.index, target);
        else if (name === "resolve identity") {
          if (!anchor || !resolvePerfIdentity(projection.index, anchor)) throw new Error("Identity failed to resolve");
        } else if (name === "remote burst 100 individual transactions") {
          for (const update of updates) {
            Y.applyUpdate(replica.doc, update, "remote");
            perfStructureView(replica, projection.document);
          }
        } else replica.doc.transact(() => { for (const update of updates) Y.applyUpdate(replica.doc, update, "remote"); }, "remote-batch");
        if (name !== "capture identities" && name !== "resolve identity" && name !== "remote burst 100 individual transactions") perfStructureView(replica, projection.document);
        const elapsed = performance.now() - start;
        if (trial >= 0) { samples.push(elapsed); projectedBeats.push(projection.lastProjected.length); projectionCommits.push(projection.commits - commitsBefore); }
        if (name === "remote join") {
          replica.doc.getMap("retiredJoins").set(`measure-join-${serial}`, true);
          Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(replica.doc, Y.encodeStateVector(remote.doc)));
        }
        if (name === "remote split") {
          const split = remote.locate(`measure-split-${serial}`);
          remote.doc.transact(() => {
            split.text.delete(split.start - 1, 1);
            remote.doc.getMap("beats").delete(`measure-split-${serial}`);
          }, "trial-cleanup");
          Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(remote.doc, Y.encodeStateVector(replica.doc)));
        }
      }
      results.push({ name, samples, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples), projectedBeats, projectionCommits, targetBeat: target, targetCharacters });
    }
    return results;
  } finally { projection.destroy(); remote.destroy(); }
}
