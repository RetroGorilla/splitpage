import type { OperationContext } from "../session/operation.ts";

export interface DestinationKey {
  readonly owner: unknown;
  readonly name: string;
}

export type SaveOutcome =
  | { readonly kind: "saved"; readonly acknowledged: boolean }
  | { readonly kind: "failed"; readonly error?: unknown }
  | { readonly kind: "cancelled" }
  | { readonly kind: "obsolete"; readonly here: boolean }
  | { readonly kind: "refused"; readonly reason: string };

export type WriterResult =
  | { readonly kind: "saved" }
  | { readonly kind: "copied" }
  | { readonly kind: "failed"; readonly error?: unknown }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly reason: string };

export interface SaveJob<R> {
  readonly request: R;
  readonly generation: number;
  readonly operation: () => OperationContext;
  readonly moved: () => void;
}

export interface SaveOwnershipPort {
  readonly capture: () => OperationContext;
  readonly stillOwns: (ctx: OperationContext) => boolean;
}

export interface SaveDestinationPort {
  readonly current: () => unknown;
  readonly keyOf: (identity: unknown) => DestinationKey;
}

export interface SaveWriterPort<R> {
  readonly write: (job: SaveJob<R>) => Promise<WriterResult>;
}

export interface SaveReportPort<R> {
  readonly obsolete: (request: R, here: boolean) => void;
  readonly running: (running: boolean) => void;
}

export interface SaveCoordinatorPorts<R> {
  readonly ownership: SaveOwnershipPort;
  readonly destination: SaveDestinationPort;
  readonly writer: SaveWriterPort<R>;
  readonly report: SaveReportPort<R>;
  readonly join: (pending: R, next: R) => R | null;
}

export interface Confirmed<B> {
  readonly generation: number;
  readonly baseline: B | null;
}

export interface SaveCoordinator<R, B> {
  readonly request: (request: R) => Promise<SaveOutcome>;
  readonly running: () => boolean;
  readonly waiting: () => number;
  readonly noteChange: () => number;
  readonly changes: () => number;
  readonly confirmClean: () => void;
  readonly confirmBaseline: (baseline: B | null) => B | null;
  readonly confirmed: (identity?: unknown) => Confirmed<B>;
  readonly dirty: (identity?: unknown) => boolean;
}

interface Entry<R> {
  request: R;
  readonly done: Promise<SaveOutcome>;
  readonly settle: (outcome: SaveOutcome) => void;
}

interface Queue<R> {
  readonly key: DestinationKey;
  readonly entries: Entry<R>[];
  active: boolean;
}

interface Held<B> {
  generation: number;
  baseline: B | null;
}

export const NEVER_CONFIRMED = 0;

function sameKey(a: DestinationKey, b: DestinationKey): boolean {
  return a.owner === b.owner && a.name === b.name;
}

function ofWriter(result: WriterResult | null | undefined): WriterResult {
  if (!result || typeof result !== "object" || typeof result.kind !== "string") {
    return { kind: "failed", error: new Error("The save's writer answered nothing it could be judged by") };
  }
  return result;
}

export function createSaveCoordinator<R, B>(ports: SaveCoordinatorPorts<R>): SaveCoordinator<R, B> {
  const queues: Queue<R>[] = [];
  const held = new Map<unknown, Map<string, Held<B>>>();
  let changes = 0;
  let activeCount = 0;

  function keyNow(): DestinationKey {
    return ports.destination.keyOf(ports.destination.current());
  }

  function keyFor(identity: unknown): DestinationKey {
    return identity === undefined ? keyNow() : ports.destination.keyOf(identity);
  }

  function recordOf(key: DestinationKey, create: boolean): Held<B> | null {
    let byName = held.get(key.owner);
    if (!byName) {
      if (!create) return null;
      byName = new Map();
      held.set(key.owner, byName);
    }
    let found = byName.get(key.name);
    if (!found && create) {
      found = { generation: NEVER_CONFIRMED, baseline: null };
      byName.set(key.name, found);
    }
    return found || null;
  }

  function queueFor(key: DestinationKey): Queue<R> {
    for (const q of queues) if (sameKey(q.key, key)) return q;
    const made: Queue<R> = { key: key, entries: [], active: false };
    queues.push(made);
    return made;
  }

  function drop(queue: Queue<R>): void {
    if (queue.active || queue.entries.length) return;
    const at = queues.indexOf(queue);
    if (at !== -1) queues.splice(at, 1);
  }

  function setRunning(delta: number): void {
    const was = activeCount > 0;
    activeCount += delta;
    const now = activeCount > 0;
    if (was !== now) ports.report.running(now);
  }

  function acknowledge(key: DestinationKey, generation: number): void {
    const record = recordOf(key, true);
    if (record && generation > record.generation) record.generation = generation;
  }

  function judge(entry: Entry<R>, result: WriterResult, operation: OperationContext, generation: number): SaveOutcome {
    if (result.kind === "failed") return "error" in result ? { kind: "failed", error: result.error } : { kind: "failed" };
    if (result.kind === "cancelled") return { kind: "cancelled" };
    if (result.kind === "refused") return { kind: "refused", reason: result.reason };
    const landed = ports.destination.keyOf(operation.destination);
    if (!ports.ownership.stillOwns(operation)) {
      const here = result.kind === "saved" && sameKey(landed, keyNow());
      ports.report.obsolete(entry.request, here);
      return { kind: "obsolete", here: here };
    }
    if (result.kind === "copied") return { kind: "saved", acknowledged: false };
    acknowledge(landed, generation);
    return { kind: "saved", acknowledged: true };
  }

  function runNext(queue: Queue<R>): void {
    if (queue.active) return;
    const entry = queue.entries.shift();
    if (!entry) {
      drop(queue);
      return;
    }
    queue.active = true;
    setRunning(1);
    const generation = changes;
    let operation = ports.ownership.capture();
    const job: SaveJob<R> = Object.freeze({
      request: entry.request,
      generation: generation,
      operation: function () { return operation; },
      moved: function () { operation = ports.ownership.capture(); }
    });
    let written: Promise<WriterResult>;
    try {
      written = Promise.resolve(ports.writer.write(job));
    } catch (error) {
      written = Promise.resolve({ kind: "failed", error: error });
    }
    written
      .then(function (result) { return judge(entry, ofWriter(result), operation, generation); },
        function (error: unknown): SaveOutcome { return { kind: "failed", error: error }; })
      .then(function (outcome) {
        queue.active = false;
        runNext(queue);
        setRunning(-1);
        entry.settle(outcome);
      });
  }

  function request(next: R): Promise<SaveOutcome> {
    const queue = queueFor(keyNow());
    for (const pending of queue.entries) {
      const joined = ports.join(pending.request, next);
      if (joined !== null) {
        pending.request = joined;
        return pending.done;
      }
    }
    let settle: (outcome: SaveOutcome) => void = function () {};
    const done = new Promise<SaveOutcome>(function (resolve) { settle = resolve; });
    queue.entries.push({ request: next, done: done, settle: settle });
    runNext(queue);
    return done;
  }

  function confirmClean(): void {
    acknowledge(keyNow(), changes);
  }

  function confirmBaseline(baseline: B | null): B | null {
    const record = recordOf(keyNow(), true);
    if (record) record.baseline = baseline;
    return baseline;
  }

  function confirmed(identity?: unknown): Confirmed<B> {
    const record = recordOf(keyFor(identity), false);
    return Object.freeze({
      generation: record ? record.generation : NEVER_CONFIRMED,
      baseline: record ? record.baseline : null
    });
  }

  return Object.freeze({
    request: request,
    running: function () { return activeCount > 0; },
    waiting: function () {
      return queues.reduce(function (n, q) { return n + q.entries.length; }, 0);
    },
    noteChange: function () {
      changes += 1;
      return changes;
    },
    changes: function () { return changes; },
    confirmClean: confirmClean,
    confirmBaseline: confirmBaseline,
    confirmed: confirmed,
    dirty: function (identity?: unknown) {
      return changes > confirmed(identity).generation;
    }
  });
}
