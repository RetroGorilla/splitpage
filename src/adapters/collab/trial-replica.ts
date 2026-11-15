import * as Y from "yjs";
import { CollabDocumentState, collabState, guardSharedCallback } from "./state.ts";
import type { IngressTrial, SharedAdmissionCount } from "./state.ts";
import type { SharedDocumentHandle } from "./types.ts";

export const SHARED_TRIAL_REBUILD_BUDGET = 3;

let open = 0;

export function openSharedTrialReplicas(): number { return open; }

function sameVector(first: Y.Doc, second: Y.Doc): boolean {
  const left = Y.decodeStateVector(Y.encodeStateVector(first)), right = Y.decodeStateVector(Y.encodeStateVector(second));
  if (left.size !== right.size) return false;
  for (const [client, clock] of left) if (right.get(client) !== clock) return false;
  return true;
}

export class SharedTrialReplica implements IngressTrial {
  readonly #live: CollabDocumentState;
  readonly #count: SharedAdmissionCount | undefined;
  readonly #inflight = new Set<Y.Transaction>();
  readonly #stops: (() => void)[] = [];
  #replica: CollabDocumentState;
  #stale = false;
  #disposed = false;
  #spent = 0;
  #stopped = false;
  #announce = false;
  #holders = 0;

  constructor(live: CollabDocumentState, count?: SharedAdmissionCount) {
    this.#live = live;
    this.#count = count;
    this.#replica = this.#build();
    open++;
    const doc = live.doc;
    const begin = (transaction: Y.Transaction): void => guardSharedCallback(live, () => { this.#inflight.add(transaction); });
    const follow = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction): void =>
      guardSharedCallback(live, () => { this.#follow(update, transaction); });
    const settled = (): void => guardSharedCallback(live, () => { this.#inflight.clear(); });
    doc.on("beforeTransaction", begin);
    doc.on("update", follow);
    doc.on("afterAllTransactions", settled);
    this.#stops.push(() => { doc.off("beforeTransaction", begin); doc.off("update", follow); doc.off("afterAllTransactions", settled); });
  }

  get stale(): boolean { return this.#stale; }
  get spent(): number { return this.#spent; }
  get replica(): Y.Doc { return this.#replica.doc; }

  #build(): CollabDocumentState {
    const next = new CollabDocumentState();
    try {
      const base = Y.encodeStateAsUpdate(this.#live.doc);
      this.#count?.("encode", "rebuild", base.byteLength); this.#count?.("apply", "rebuild", base.byteLength);
      Y.applyUpdate(next.doc, base);
      for (const held of this.#live.ingress.held) { this.#count?.("apply", "rebuild", held.byteLength); Y.applyUpdate(next.doc, held); }
    } catch (error) { next.doc.destroy(); throw error; }
    return next;
  }

  #follow(update: Uint8Array, transaction: Y.Transaction): void {
    this.#inflight.delete(transaction);
    // why: A remote transaction applies only an update the replica took at its trial; a stale replica is rebuilt whole.
    if (transaction.origin === "remote" || this.#stale) return;
    this.#count?.("apply", "follow", update.byteLength);
    try { Y.applyUpdate(this.#replica.doc, update); } catch { this.#stale = true; }
  }

  #rebuild(): void {
    const next = this.#build();
    this.#replica.doc.destroy();
    this.#replica = next;
    this.#stale = false;
  }

  #current(): void {
    if (this.#disposed) throw new Error("The trial replica has ended");
    if (!this.#stale && [...this.#inflight].some(transaction => transaction.origin !== "remote")) {
      // why: A live transaction whose update is not announced yet is copied by what the replica lacks.
      const missing = Y.encodeStateAsUpdate(this.#live.doc, Y.encodeStateVector(this.#replica.doc));
      this.#count?.("encode", "flush", missing.byteLength); this.#count?.("apply", "flush", missing.byteLength);
      try { Y.applyUpdate(this.#replica.doc, missing); } catch { this.#stale = true; }
    }
    if (this.#stale) this.#rebuild();
  }

  attempt(update: Uint8Array): void {
    this.#current();
    this.#count?.("apply", "trial", update.byteLength);
    try { Y.applyUpdate(this.#replica.doc, update); } catch (error) { this.#refused(); throw error; }
  }

  // why: assumed rule 211: each refusal that may have written into the replica spends one rebuild of a fixed budget,
  // and the last one stops intake, so invalid updates cannot force rebuilds without end.
  #refused(): void {
    this.#stale = true;
    this.#spent++;
    if (this.#spent >= SHARED_TRIAL_REBUILD_BUDGET) { this.#stopped = true; this.#announce = true; }
    try { this.#rebuild(); } catch { this.#stale = true; }
  }

  stopped(): boolean { return this.#stopped; }

  takeStop(): boolean {
    const announce = this.#announce;
    this.#announce = false;
    return announce;
  }

  encode(): Uint8Array {
    this.#current();
    return Y.encodeStateAsUpdate(this.#replica.doc);
  }

  liveFailed(): void { this.#stale = true; }

  hold(): void { this.#holders++; }

  release(): void { if (--this.#holders <= 0) this.dispose(); }

  released(): boolean {
    if (this.#stale || this.#disposed) return true;
    if (sameVector(this.#live.doc, this.#replica.doc)) return true;
    this.#stale = true;
    return false;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const stop of this.#stops.splice(0)) stop();
    this.#inflight.clear();
    this.#replica.doc.destroy();
    open--;
    if (this.#live.trial === this) this.#live.trial = null;
  }
}

export function startSharedTrialReplica(handle: SharedDocumentHandle, count?: SharedAdmissionCount): SharedTrialReplica {
  const state = collabState(handle);
  if (state.destroyed) throw new Error("Shared document has ended");
  if (state.trial) throw new Error("A trial replica is already running");
  const trial = new SharedTrialReplica(state, count);
  state.trial = trial;
  return trial;
}

// why: Every replica port on one document shares its one standing replica; the last release disposes it.
export function acquireSharedTrialReplica(handle: SharedDocumentHandle): () => void {
  const running = collabState(handle).trial;
  const trial = running instanceof SharedTrialReplica ? running : startSharedTrialReplica(handle);
  trial.hold();
  let held = true;
  return () => { if (held) { held = false; trial.release(); } };
}
