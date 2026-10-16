import type { OperationContext } from "../session/operation.ts";
import type { DraftOwnershipPort, DraftPutOptions, DraftWrite, KeyedDraftStore } from "./ports.ts";

export interface DraftWriterPorts {
  readonly store: KeyedDraftStore;
  readonly writerId: string;
  readonly ownership: DraftOwnershipPort;
}

export interface DraftCapture {
  readonly key: string;
  readonly generation: number;
  readonly before: string | null;
  readonly operation: OperationContext;
}

export type DraftFields = Omit<DraftWrite, "key" | "writerId" | "generation">;

export type DraftWriteOutcome =
  | { readonly ok: true; readonly evicted: number; readonly obsolete: boolean }
  | { readonly ok: false; readonly code: string };

export interface DraftWriter {
  readonly writerId: () => string;
  readonly tracked: () => string | null;
  readonly capture: (key: string) => DraftCapture;
  readonly write: (capture: DraftCapture, fields: DraftFields, opts?: DraftPutOptions) => Promise<DraftWriteOutcome>;
  readonly discard: () => Promise<boolean>;
  readonly take: (key: string) => Promise<boolean>;
}

interface Acknowledged {
  readonly key: string;
  readonly generation: number;
}

function ignore(): void {}

export function createDraftWriter(ports: DraftWriterPorts): DraftWriter {
  if (!ports.writerId) throw new Error("createDraftWriter: a writer needs its id");
  const store = ports.store;
  const writerId = ports.writerId;
  let acknowledged: Acknowledged | null = null;
  let generations = 0;

  function trackedKey(): string | null {
    return acknowledged ? acknowledged.key : null;
  }

  function dropOwn(previous: Acknowledged): void {
    store.remove(previous.key, writerId, previous.generation).then(ignore, ignore);
  }

  function capture(key: string): DraftCapture {
    generations += 1;
    return Object.freeze({
      key: key,
      generation: generations,
      before: trackedKey(),
      operation: ports.ownership.capture()
    });
  }

  function write(captured: DraftCapture, fields: DraftFields, opts?: DraftPutOptions): Promise<DraftWriteOutcome> {
    const record: DraftWrite = Object.assign({}, fields, {
      key: captured.key,
      writerId: writerId,
      generation: captured.generation
    });
    return store.put(record, opts).then(function (r): DraftWriteOutcome {
      if (!r.ok) return r;
      const now = acknowledged;
      const nowKey = now ? now.key : null;
      const owned = ports.ownership.stillOwns(captured.operation) &&
        (nowKey === captured.before || nowKey === captured.key);
      if (!owned) return { ok: true, evicted: r.evicted, obsolete: true };
      acknowledged = { key: captured.key, generation: captured.generation };
      if (now && now.key !== captured.key) dropOwn(now);
      return { ok: true, evicted: r.evicted, obsolete: false };
    });
  }

  function discard(): Promise<boolean> {
    const mine = acknowledged;
    acknowledged = null;
    if (!mine) return Promise.resolve(false);
    return store.remove(mine.key, writerId, mine.generation);
  }

  function take(key: string): Promise<boolean> {
    const left = acknowledged;
    if (left && left.key !== key) dropOwn(left);
    generations += 1;
    acknowledged = { key: key, generation: generations };
    return store.claim(key, writerId, generations);
  }

  return Object.freeze({
    writerId: function () { return writerId; },
    tracked: trackedKey,
    capture: capture,
    write: write,
    discard: discard,
    take: take
  });
}
