import * as Y from "yjs";
import { createSharedDocument, destroySharedDocument, observeSharedUpdates, readSharedRevision, transactSharedDocument } from "./document.ts";
import { collabState, guardSharedCallback } from "./state.ts";
import { assembleSharedDocument } from "./project.ts";
import type { SharedDocumentProjectionResult } from "./project.ts";
import { freezeSharedProjection, SharedProjectionCache } from "./projection-cache.ts";
import type { SharedProjectionWork } from "./projection-cache.ts";
import { SharedProjectionSource } from "./projection-source.ts";
import type { CollabRoots } from "./roots.ts";
import type { SharedDocumentHandle, SharedTransactionOrigin } from "./types.ts";

export interface SharedIncrementalProjection extends SharedDocumentProjectionResult { readonly revision: number }

export interface SharedIncrementalProjector {
  readonly read: () => SharedIncrementalProjection;
  readonly observe: (listener: (projection: SharedIncrementalProjection, origin: SharedTransactionOrigin | null) => void) => () => void;
  readonly dispose: () => void;
}

export function createSharedIncrementalProjector(handle: SharedDocumentHandle,
  count?: (work: SharedProjectionWork, key: string) => void): SharedIncrementalProjector {
  const state = collabState(handle);
  if (state.destroyed) throw new Error("Shared document has ended");
  let mirror = createSharedDocument(), replica = collabState(mirror);
  try { Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(state.doc)); }
  catch (error) { destroySharedDocument(mirror); throw error; }
  let source = new SharedProjectionSource(mirror, new SharedProjectionCache(count));
  const listeners = new Set<Parameters<SharedIncrementalProjector["observe"]>[0]>(), stops: (() => void)[] = [];
  const mirrorStops: (() => void)[] = [];
  let current: SharedIncrementalProjection;
  try { current = freezeSharedProjection({ ...assembleSharedDocument(source), revision: readSharedRevision(handle) }); }
  catch (error) { destroySharedDocument(mirror); throw error; }
  let disposed = false, normalize = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const stop of stops.splice(0)) stop();
    for (const stop of mirrorStops.splice(0)) stop();
    listeners.clear(); destroySharedDocument(mirror);
  };
  const watchMirror = (): void => {
    const owner = replica, input = source;
    for (const name of Object.keys(owner.roots) as (keyof CollabRoots)[]) {
      const root = owner.roots[name];
      const changed = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => guardSharedCallback(owner, () => input.changed(name, events));
      root.observeDeep(changed); mirrorStops.push(() => root.unobserveDeep(changed));
    }
  };
  watchMirror();
  for (const root of Object.values(state.roots)) {
    const changed = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => guardSharedCallback(state, () => {
      // why: Wire encoding normalizes surrogate fragments per native item; later item merges can change that normalization.
      for (const event of events) if (event.target instanceof Y.Text && event.target.toDelta().some((part: { insert?: unknown }) =>
        typeof part.insert === "string" && /[\ud800-\udfff]/.test(part.insert))) normalize = true;
    });
    root.observeDeep(changed); stops.push(() => root.unobserveDeep(changed));
  }
  const destroyed = (): void => guardSharedCallback(state, dispose);
  state.doc.on("destroy", destroyed); stops.push(() => state.doc.off("destroy", destroyed));
  stops.push(observeSharedUpdates(handle, (update, origin) => {
    if (normalize) {
      const replacement = createSharedDocument(), next = collabState(replacement);
      try { Y.applyUpdate(next.doc, Y.encodeStateAsUpdate(state.doc)); }
      catch (error) { destroySharedDocument(replacement); throw error; }
      for (const stop of mirrorStops.splice(0)) stop(); destroySharedDocument(mirror);
      mirror = replacement; replica = next; source = new SharedProjectionSource(mirror, new SharedProjectionCache(count));
      watchMirror(); normalize = false;
    } else transactSharedDocument(mirror, "remote", () => Y.applyUpdate(replica.doc, update));
    current = freezeSharedProjection({ ...assembleSharedDocument(source), revision: readSharedRevision(handle) });
    for (const listener of listeners) guardSharedCallback(state, () => listener(current, origin));
  }));
  return Object.freeze({
    read: () => current,
    observe: (listener: Parameters<SharedIncrementalProjector["observe"]>[0]) => {
      if (disposed) throw new Error("Incremental projector has ended");
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    dispose
  });
}
