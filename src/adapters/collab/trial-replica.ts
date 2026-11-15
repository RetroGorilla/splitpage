import * as Y from "yjs";
import { CollabDocumentState, collabState, guardSharedCallback } from "./state.ts";
import type { IngressTrial, SharedAdmissionCount } from "./state.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { timingMarks } from "../../../shared/timing-marks.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

export const SHARED_TRIAL_REBUILD_BUDGET = 3;

let open = 0;

export function openSharedTrialReplicas(): number { return open; }

function vectorOf(doc: Y.Doc): Map<number, number> { return Y.decodeStateVector(Y.encodeStateVector(doc)); }

function sameVector(first: Y.Doc, second: Y.Doc): boolean {
  const left = vectorOf(first), right = vectorOf(second);
  if (left.size !== right.size) return false;
  for (const [client, clock] of left) if (right.get(client) !== clock) return false;
  return true;
}

export class SharedTrialReplica implements IngressTrial {
  readonly #live: CollabDocumentState;
  readonly #count: SharedAdmissionCount | undefined;
  readonly #inflight = new Set<Y.Transaction>();
  readonly #copied = new Map<Y.Transaction, Map<number, number>[]>();
  readonly #stops: (() => void)[] = [];
  #replica: CollabDocumentState;
  #stale = false;
  #rebuildBlocked = false;
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
    const settled = (): void => guardSharedCallback(live, () => { this.#inflight.clear(); this.#copied.clear(); });
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
    const local = transaction.origin !== "remote" && !this.#stale;
    const unsafe = local && (this.#reusesClock(transaction, transaction.afterState) || this.#joinsPair(transaction));
    this.#copied.delete(transaction);
    // why: A remote transaction applies only an update the replica took at its trial; a stale replica is rebuilt whole.
    if (!local) return;
    if (unsafe) { this.#stale = true; return; }
    this.#count?.("apply", "follow", update.byteLength);
    try { Y.applyUpdate(this.#replica.doc, update); } catch { this.#stale = true; }
  }

  #floor(transaction: Y.Transaction, client: number): number {
    const copies = this.#copied.get(transaction);
    return Math.max(transaction.beforeState.get(client) ?? 0, copies?.[copies.length - 1]?.get(client) ?? 0);
  }

  // why: Clocks the replica already holds past what it copied from live belong to held updates, not to this transaction.
  #reusesClock(transaction: Y.Transaction, written: Map<number, number>): boolean {
    for (const [client, clock] of written) {
      const floor = this.#floor(transaction, client);
      if (clock > floor && Y.getState(this.#replica.doc.store, client) > floor) return true;
    }
    return false;
  }

  // why: The library merges a transaction's items only at its cleanup, so each stop inside it is judged at its update.
  #joinsPair(transaction: Y.Transaction): boolean {
    const copies = this.#copied.get(transaction) ?? [];
    for (const [client, after] of transaction.afterState) {
      const before = transaction.beforeState.get(client) ?? 0;
      for (const start of [before, ...copies.map(copy => copy.get(client) ?? 0)]) {
        if (start >= before && after > start && this.#splitsPair(client, start)) return true;
      }
    }
    return false;
  }

  // why: Every stop of the replica is an encoding boundary, and a run that starts between a pair's halves encodes
  // both as replacement characters.
  #splitsPair(client: number, start: number): boolean {
    const structs = this.#live.doc.store.clients.get(client);
    if (!structs || start === 0) return false;
    const item = structs[Y.findIndexSS(structs, start)];
    if (!(item instanceof Y.Item) || !(item.content instanceof Y.ContentString) || item.id.clock === start) return false;
    const offset = start - item.id.clock, low = item.content.str.charCodeAt(offset), high = item.content.str.charCodeAt(offset - 1);
    return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  }

  #mirrored(vector: Map<number, number>): void {
    for (const transaction of this.#inflight) {
      if (transaction.origin !== "remote") this.#copied.set(transaction, [...this.#copied.get(transaction) ?? [], vector]);
    }
  }

  #rebuild(): void {
    if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:rebuild:start");
    try {
      const vector = this.#inflight.size ? vectorOf(this.#live.doc) : null;
      const next = this.#build();
      this.#replica.doc.destroy();
      this.#replica = next;
      this.#stale = false;
      if (vector) this.#mirrored(vector);
    } finally { if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:rebuild:end"); }
  }

  #current(): boolean {
    if (this.#disposed) throw new Error("The trial replica has ended");
    const local = [...this.#inflight].filter(transaction => transaction.origin !== "remote");
    if (!this.#stale && local.length) {
      const vector = vectorOf(this.#live.doc);
      if (local.some(transaction => this.#reusesClock(transaction, vector))) this.#stale = true;
      else {
        if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:rebuild:start");
        try {
          // why: A live transaction whose update is not announced yet is copied by what the replica lacks.
          const missing = Y.encodeStateAsUpdate(this.#live.doc, Y.encodeStateVector(this.#replica.doc));
          this.#count?.("encode", "flush", missing.byteLength); this.#count?.("apply", "flush", missing.byteLength);
          try { Y.applyUpdate(this.#replica.doc, missing); this.#mirrored(vector); } catch { this.#stale = true; }
        } finally { if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:rebuild:end"); }
      }
    }
    if (this.#stale && !this.#rebuildBlocked && !this.#stopped) this.#recover(false);
    return !this.#stale;
  }

  attempt(update: Uint8Array, decoded: ReturnType<typeof Y.decodeUpdate>, copyTrial: () => void): void {
    if (!this.#current()) { copyTrial(); return; }
    const overlapsHeld = this.#live.ingress.held.length > 0 && decoded.structs.some(struct => {
      const live = Y.getState(this.#live.doc.store, struct.id.client);
      const replica = Y.getState(this.#replica.doc.store, struct.id.client);
      return struct.id.clock < replica && struct.id.clock + struct.length > live && replica > live;
    });
    if (overlapsHeld) copyTrial();
    this.#count?.("apply", "trial", update.byteLength);
    try { Y.applyUpdate(this.#replica.doc, update); } catch (error) { this.#refused(); throw error; }
  }

  // why: assumed rule 211: each refusal that may have written into the replica spends one rebuild of a fixed budget,
  // and the last one stops intake, so invalid updates cannot force rebuilds without end.
  #refused(): void {
    this.#stale = true;
    this.#recover(true);
  }

  #spend(): void {
    this.#spent++;
    if (this.#spent >= SHARED_TRIAL_REBUILD_BUDGET) { this.#stopped = true; this.#announce = true; }
  }

  #recover(refused: boolean): void {
    if (refused) this.#spend();
    try { this.#rebuild(); } catch {
      this.#stale = true;
      // why: Accepted arrivals can grow the queue without removing the update that prevents a rebuild.
      this.#rebuildBlocked = true;
      if (!refused) this.#spend();
    }
  }

  stopped(): boolean { return this.#stopped; }

  takeStop(): boolean {
    const announce = this.#announce;
    this.#announce = false;
    return announce;
  }

  encode(): Uint8Array {
    if (!this.#current()) throw new Error("The trial replica cannot be rebuilt while held updates remain");
    return Y.encodeStateAsUpdate(this.#replica.doc);
  }

  liveFailed(): void { this.#stale = true; }

  hold(): void { this.#holders++; }

  release(): void { if (--this.#holders <= 0) this.dispose(); }

  released(): boolean {
    this.#rebuildBlocked = false;
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
    this.#copied.clear();
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
