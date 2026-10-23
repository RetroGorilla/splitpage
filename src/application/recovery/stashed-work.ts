import { refsIn } from "../../../shared/blob-policy.js";
import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { SERVER_RESUME_KEY } from "../location/server-status.ts";
import type { ConflictStash, KeyValueStorage, StashedWork } from "./conflict-stash.ts";

export interface StashMerged<D, R> {
  readonly state: D;
  readonly result?: R | null | undefined;
  readonly snapshot?: unknown;
  readonly replaced?: boolean | undefined;
}

export type StashMerge<D, R> = (request: Readonly<Record<string, unknown>>) => StashMerged<D, R> | PromiseLike<StashMerged<D, R>>;

export interface StashedWorkPorts<D, R> {
  readonly stash: ConflictStash;
  readonly sessionStorage: () => KeyValueStorage | null | undefined;
  readonly markWrittenOut: () => void;
  readonly copy: (doc: D) => D;
  readonly merge: StashMerge<D, R>;
}

export interface StashApplied<D, R> {
  readonly state: D;
  readonly report: R | null | undefined;
  readonly snapshot: unknown;
  readonly replaced?: boolean;
}

export type ApplyStashedWork<D, R> = (
  loaded: D,
  override: StashedWork | null,
  apply?: Readonly<Record<string, unknown>> | null
) => StashApplied<D, R> | Promise<StashApplied<D, R>>;

function rowsOf(doc: unknown): unknown {
  return doc && typeof doc === "object" ? (doc as { rows?: unknown }).rows : undefined;
}

function docIdOf(doc: unknown): unknown {
  return doc && typeof doc === "object" ? (doc as { docId?: unknown }).docId : undefined;
}

export function createStashedWork<D extends { docId: string }, R>(ports: StashedWorkPorts<D, R>): ApplyStashedWork<D, R> {
  function resumePending(): boolean {
    try {
      const storage = ports.sessionStorage();
      return !!(storage && storage.getItem(SERVER_RESUME_KEY));
    } catch {
      return false;
    }
  }

  return function applyStashedWork(loaded, override, apply) {
    const stash = override || ports.stash.read();
    if (!override) ports.stash.dropReloadGuard();
    if (!stash || !stash.mine || !Array.isArray(rowsOf(stash.mine))) return { state: loaded, report: null, snapshot: null };
    ports.stash.accept(stash, loaded);
    if (!override) {
      if (resumePending()) return { state: loaded, report: null, snapshot: null };
      const stashId = normalizeDocId(docIdOf(stash.mine));
      if (stashId) {
        loaded.docId = stashId;
        ports.markWrittenOut();
      }
      ports.stash.clear();
    }

    function answer(out: StashMerged<D, R>): StashApplied<D, R> {
      return { state: out.state, report: out.result, snapshot: out.snapshot, replaced: !!out.replaced };
    }

    function through(extra: Readonly<Record<string, unknown>>): StashApplied<D, R> | Promise<StashApplied<D, R>> {
      const out = ports.merge({ theirs: loaded, source: "stash", mergeOnly: !apply, ...extra, ...(apply || {}) });
      return typeof (out as PromiseLike<StashMerged<D, R>>).then === "function"
        ? Promise.resolve(out).then(answer)
        : answer(out as StashMerged<D, R>);
    }

    if (JSON.stringify(stash.mine) === JSON.stringify(loaded)) return through({ unchanged: true });

    return through({
      base: stash.base || null,
      mine: stash.mine,
      undoPoint: ports.copy(loaded)
    });
  };
}

export interface LocalWorkPorts<D> {
  readonly stash: ConflictStash;
  readonly current: () => D | null;
  readonly base: () => D | null;
  readonly now: () => string;
  readonly editor: () => string;
  readonly durable: (sha: string) => boolean;
  readonly dataUrl: (sha: string) => string | null | undefined;
}

export function createLocalWorkStash<D>(ports: LocalWorkPorts<D>): () => boolean {
  function blobsFor(docs: readonly (D | null)[]): Record<string, string> | null {
    const blobs: Record<string, string> = {};
    let any = false;
    for (const doc of docs) {
      for (const ref of refsIn(doc)) {
        const sha = String(ref);
        if (blobs[sha] || ports.durable(sha)) continue;
        const url = ports.dataUrl(sha);
        if (url) {
          blobs[sha] = url;
          any = true;
        }
      }
    }
    return any ? blobs : null;
  }

  return function stashLocalWork() {
    const mine = ports.current();
    if (!mine) return false;
    const base = ports.base();
    const payload: StashedWork = { at: ports.now(), by: ports.editor(), base: base, mine: mine };
    const blobs = blobsFor([mine, base]);
    if (blobs) payload["blobs"] = blobs;
    return ports.stash.save(payload);
  };
}
