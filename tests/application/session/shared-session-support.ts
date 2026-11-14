import { createSharedSession } from "../../../src/application/session/shared-session.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { ReplicaExecution, ReplicaOrigin, ReplicaPort, SharedDocumentSession } from "../../../src/application/session/shared-session.ts";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { SessionChange } from "../../../src/application/session/change-set.ts";
import type { Command, SessionCounters } from "../../../src/application/session/document-session.ts";
import type { Capability } from "../../../src/application/session/ports.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import type { SharedCommandDescription } from "../../../src/core/collab/undo-record.ts";
import type { SharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import type { FlowSelectionPair } from "../../../src/core/flow/flow.ts";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import { compareSharedProjections } from "../../../src/core/collab/projection/changes.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { fakeClock } from "../session-fakes.ts";
import type { FakeClock } from "../session-fakes.ts";

export interface SharedHarnessHooks {
  refused?: (reason: string) => void;
  record?: () => void;
  effect?: (name: "dirty" | "draft" | "save") => void;
  asked?: () => void;
  after?: SessionCounters;
}

export interface SharedHarness {
  session: SharedDocumentSession;
  log: string[];
  published: SessionChange[];
  undo: { changes: SessionChange["changes"]; selection: FlowSelectionPair | undefined }[];
  executed: { operations: readonly SharedOperation[]; base: number }[];
  described: (SharedCommandDescription | null)[];
  refreshes: string[][];
  reported: unknown[];
  clock: FakeClock;
  deny: (reason: string | null) => void;
}

export function adapterReplica(handle: SharedDocumentHandle, undo?: Pick<SharedUndo, "perform">): ReplicaPort {
  return createSharedReplica(handle, undefined, undo);
}

export function registerSplits(handle: SharedDocumentHandle): void {
  registerSharedSplitHandlers(handle, { cells: createFlowLoadRuntime().cells });
}

export function sharedHarness(replica: ReplicaPort, hooks: SharedHarnessHooks = {}): SharedHarness {
  const log: string[] = [], published: SessionChange[] = [], refreshes: string[][] = [], reported: unknown[] = [];
  const undo: SharedHarness["undo"] = [], executed: SharedHarness["executed"] = [], described: SharedHarness["described"] = [];
  const clock = fakeClock();
  let denied: string | null = null;
  const can = (): Capability => { hooks.asked?.(); return denied === null ? { allowed: true } : { allowed: false, reason: denied }; };
  const session = createSharedSession({
    refused: hooks.refused,
    replica: {
      revision: replica.revision,
      project: () => { log.push("project"); return replica.project(); },
      changes: replica.changes,
      recovery: replica.recovery,
      execute: (operations, options) => { log.push("execute"); executed.push({ operations, base: options.base }); described.push(options.description); return replica.execute(operations, options); },
      observe: replica.observe
    },
    entry: enterSharedDocument,
    undo: { record: (changes, selection) => { log.push("undo.record"); undo.push({ changes, selection }); hooks.record?.(); } },
    effects: {
      dirty: change => { log.push("dirty:" + change.generation); hooks.effect?.("dirty"); },
      draft: change => { log.push("draft:" + change.generation); hooks.effect?.("draft"); },
      save: change => { log.push("save:" + change.generation); hooks.effect?.("save"); },
      refresh: jobs => { log.push("refresh"); refreshes.push(Array.from(jobs).sort()); }
    },
    capability: createSessionCapabilities("shared", { edit: can, comment: can }),
    report: error => { log.push("report"); reported.push(error); },
    timers: clock,
    after: hooks.after
  });
  session.subscribe(change => { published.push(change); log.push("publish:" + change.kind); });
  return { session, log, published, undo, executed, described, refreshes, reported, clock, deny: reason => { denied = reason; } };
}

export interface FakeReplica {
  port: ReplicaPort;
  write: (origin: ReplicaOrigin | null, document: Record<string, unknown>) => void;
  echo: (origin: ReplicaOrigin | null) => void;
  script: (next: (operations: readonly SharedOperation[]) => ReplicaExecution) => void;
  fail: (error: Error | null) => void;
  observers: () => number;
}

export function fakeReplica(initial: Record<string, unknown> | null = null): FakeReplica {
  const listeners = new Set<(origin: ReplicaOrigin | null) => void>();
  let revision = initial ? 1 : 0, held: Record<string, unknown> = initial ?? {}, failing: Error | null = null;
  let before: Record<string, unknown> | null = null;
  let script: (operations: readonly SharedOperation[]) => ReplicaExecution = () => ({ ok: true });
  const tell = (origin: ReplicaOrigin | null): void => { for (const listener of [...listeners]) listener(origin); };
  return {
    port: {
      revision: () => revision,
      project: () => { if (failing) throw failing; return JSON.parse(JSON.stringify(held)) as unknown; },
      changes: () => compareSharedProjections(before, held),
      recovery: () => [],
      execute: (operations, options) => options.base === revision ? script(operations) : { ok: false, reason: "stale-base" },
      observe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }
    },
    write: (origin, document) => { before = revision ? held : null; held = document; revision++; tell(origin); },
    echo: tell,
    script: next => { script = next; },
    fail: error => { failing = error; },
    observers: () => listeners.size
  };
}

export interface SharedCommandOptions {
  base?: number;
  derive?: readonly string[];
  saveNow?: boolean;
  selection?: FlowSelectionPair;
  needs?: "edit" | "nothing";
}

export function sharedCommand(name: string, operations: readonly SharedOperation[], options: SharedCommandOptions = {}): Command {
  return {
    name,
    needs: options.needs ?? "edit",
    plan: () => ({
      ...(options.selection ? { selection: options.selection } : {}),
      changes: changeSet({ whole: true, derive: options.derive ?? [], saveNow: options.saveNow ?? false }),
      apply: () => { throw new Error("A shared session applied a standalone plan"); },
      shared: options.base === undefined ? { operations } : { operations, base: options.base }
    })
  };
}
