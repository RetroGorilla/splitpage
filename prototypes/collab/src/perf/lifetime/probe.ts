import assert from "node:assert/strict";
import * as Y from "yjs";
import { createProjectionReplica } from "../../proj/document.ts";
import { mapValue } from "../../schema.ts";
import { IncrementalProjection } from "../incremental.ts";
import { capturePerfBeat, perfStructureView, resolvePerfIdentity } from "../operations.ts";
import { lifetimeRoot } from "./attribution.ts";
import { IndexedStructureProjection } from "./projector.ts";

export type LifetimeProjectionMode = "legacy" | "indexed";
export type LifetimePhase = "prepare" | "apply" | "incremental" | "structure" | "capture" | "resolve";
export interface LifetimeWork { records: Record<string, number>; gets: Record<string, number>; orderItems: number; orderValues: number; textItems: number; textReads: number; integratedItems: number; relativeItems: number; absoluteItems: number; storeProbes: number }
const emptyWork = (): LifetimeWork => ({ records: {}, gets: {}, orderItems: 0, orderValues: 0, textItems: 0, textReads: 0, integratedItems: 0, relativeItems: 0, absoluteItems: 0, storeProbes: 0 });

export function observeLifetimeWork<T>(run: (phase: (value: LifetimePhase) => void) => T) {
  const work = Object.fromEntries((["prepare", "apply", "incremental", "structure", "capture", "resolve"] as const).map(phase => [phase, emptyWork()])) as Record<LifetimePhase, LifetimeWork>;
  let phase: LifetimePhase = "apply";
  const globals = globalThis as unknown as { perfTraversal: { relativeItems: number; absoluteItems: number; storeProbes: number } };
  globals.perfTraversal = { relativeItems: 0, absoluteItems: 0, storeProbes: 0 };
  const finishPhase = (): void => {
    for (const key of ["relativeItems", "absoluteItems", "storeProbes"] as const) work[phase][key] += globals.perfTraversal[key];
    globals.perfTraversal = { relativeItems: 0, absoluteItems: 0, storeProbes: 0 };
  };
  const entries = Y.Map.prototype.entries, values = Y.Map.prototype.values, keys = Y.Map.prototype.keys, get = Y.Map.prototype.get, has = Y.Map.prototype.has;
  const array = Y.Array.prototype.toArray, delta = Y.Text.prototype.toDelta, integrate = Y.Item.prototype.integrate;
  const label = (type: Parameters<typeof lifetimeRoot>[0]): string => type._item?.parentSub === "joins" ? "joins" : lifetimeRoot(type);
  const count = (type: Parameters<typeof lifetimeRoot>[0]): void => { const key = label(type); work[phase].records[key] = (work[phase].records[key] ?? 0) + 1; };
  Y.Map.prototype.entries = function* () { for (const entry of entries.call(this)) { count(this); yield entry; } };
  Y.Map.prototype.values = function* () { for (const value of values.call(this)) { count(this); yield value; } };
  Y.Map.prototype.keys = function* () { for (const key of keys.call(this)) { count(this); yield key; } };
  Y.Map.prototype.get = function (key) { const name = label(this); work[phase].gets[name] = (work[phase].gets[name] ?? 0) + 1; return get.call(this, key) as unknown; };
  Y.Map.prototype.has = function (key) { const name = label(this); work[phase].gets[name] = (work[phase].gets[name] ?? 0) + 1; return has.call(this, key); };
  Y.Array.prototype.toArray = function () {
    if (lifetimeRoot(this) === "order") {
      for (let item = this._start; item; item = item.right) work[phase].orderItems++;
      work[phase].orderValues += this.length;
    }
    return array.call(this) as unknown[];
  };
  Y.Text.prototype.toDelta = function (...args) {
    work[phase].textReads++;
    for (let item = this._start; item; item = item.right) work[phase].textItems++;
    return delta.apply(this, args) as unknown;
  };
  Y.Item.prototype.integrate = function (...args) { work[phase].integratedItems++; integrate.apply(this, args); };
  try { const value = run(value => { finishPhase(); phase = value; }); finishPhase(); return { value, work }; }
  finally { Y.Map.prototype.entries = entries; Y.Map.prototype.values = values; Y.Map.prototype.keys = keys; Y.Map.prototype.get = get; Y.Map.prototype.has = has; Y.Array.prototype.toArray = array; Y.Text.prototype.toDelta = delta; Y.Item.prototype.integrate = integrate; }
}

export function lifetimeProbe(state: Uint8Array, mode: LifetimeProjectionMode) {
  const replica = createProjectionReplica("B", 900), remote = createProjectionReplica("B", 901);
  Y.applyUpdate(replica.doc, state); Y.applyUpdate(remote.doc, state);
  const projection = new IncrementalProjection(replica), indexed = new IndexedStructureProjection(replica);
  indexed.view(projection.document);
  const live = projection.index.spans.filter(span => span.block.kind === "b" && !mapValue(mapValue(replica.doc.getMap("beats").get(span.block.id)).get("removals")).size);
  const candidates = live.slice(Math.floor(live.length * 0.75));
  const target = candidates.reduce((a, b) => b.end - b.start > a.end - a.start ? b : a).block.id;
  const internal = projection as unknown as { commit: () => void };
  const commit = internal.commit.bind(projection);
  let clock = false, ownMs = 0, changePhase: ((value: LifetimePhase) => void) | undefined;
  internal.commit = () => {
    changePhase?.("incremental");
    const start = clock ? performance.now() : 0;
    try { commit(); } finally { if (clock) ownMs += performance.now() - start; changePhase?.("apply"); }
  };
  let serial = 0;
  return {
    target,
    run(timed: boolean, phase?: (value: LifetimePhase) => void) {
      phase?.("prepare");
      const location = remote.locate(target);
      const updates: Uint8Array[] = [];
      const capture = (update: Uint8Array): void => { updates.push(update); };
      remote.doc.on("update", capture);
      try { location.text.insert(location.end, "x", {}); } finally { remote.doc.off("update", capture); }
      assert.equal(updates.length, 1);
      const update = updates[0]; assert.ok(update);
      const decoded = Y.decodeUpdate(update);
      const deleteSetRanges = [...decoded.ds.clients.values()].reduce((sum, ranges) => sum + ranges.length, 0);
      changePhase = phase; clock = timed; ownMs = 0; indexed.statusRecordsRead = 0;
      phase?.("apply");
      const start = timed ? performance.now() : 0;
      Y.applyUpdate(replica.doc, update, "remote");
      const applied = timed ? performance.now() : 0;
      phase?.("structure");
      const structure = mode === "legacy" ? perfStructureView(replica, projection.document) : indexed.view(projection.document);
      const structured = timed ? performance.now() : 0;
      phase?.("capture");
      const identities = capturePerfBeat(projection.index, target), anchor = identities.at(-1);
      const captured = timed ? performance.now() : 0;
      phase?.("resolve");
      assert.ok(anchor); assert.equal(resolvePerfIdentity(projection.index, anchor)?.beat, target);
      const resolved = timed ? performance.now() : 0;
      changePhase = undefined; clock = false;
      serial++;
      return { serial, target, characters: identities.length, updateBytes: update.length, deleteSetRanges, decodedStructs: decoded.structs.length, projectedBeats: projection.lastProjected.length,
        statusRecordsRead: indexed.statusRecordsRead, recovery: structure.recovery.length,
        milliseconds: timed ? { applyExcludingIncremental: applied - start - ownMs, incremental: ownMs, structure: structured - applied,
          component: structured - start, capture: captured - structured, resolve: resolved - captured, withIdentity: resolved - start } : null };
    },
    destroy() { indexed.destroy(); projection.destroy(); replica.destroy(); remote.destroy(); }
  };
}

export function countLifetimeRemote(state: Uint8Array, mode: LifetimeProjectionMode) {
  const probe = lifetimeProbe(state, mode);
  try { return observeLifetimeWork(phase => probe.run(false, phase)); } finally { probe.destroy(); }
}
