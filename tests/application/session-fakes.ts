import { createDocumentSession } from "../../src/application/session/document-session.ts";
import type { DocumentSession } from "../../src/application/session/document-session.ts";
import type { SessionChange } from "../../src/application/session/change-set.ts";
import type { Capability, TimerPort } from "../../src/application/session/ports.ts";
import type { RefreshTiming } from "../../src/application/session/effects.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";

export interface FakeClock extends TimerPort {
  advance: (ms: number) => void;
  stall: (ms: number) => void;
  armed: () => number;
}

export function fakeClock(): FakeClock {
  let now = 1000;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  function advance(ms: number): void {
    const until = now + ms;
    for (;;) {
      let firstId = -1;
      let firstAt = Infinity;
      for (const [id, t] of due) {
        if (t.at <= until && t.at < firstAt) { firstId = id; firstAt = t.at; }
      }
      const t = due.get(firstId);
      if (!t) break;
      due.delete(firstId);
      now = t.at;
      t.run();
    }
    now = until;
  }
  return {
    now: function () { return now; },
    start: function (run, ms) { const id = next++; due.set(id, { at: now + ms, run: run }); return id; },
    stop: function (handle) { due.delete(handle as number); },
    advance: advance,
    stall: function (ms) { now += ms; },
    armed: function () { return due.size; }
  };
}

export interface Harness {
  session: DocumentSession;
  log: string[];
  published: SessionChange[];
  refreshes: string[][];
  clock: FakeClock;
  deny: (reason: string | null) => void;
}

export interface HarnessHooks {
  beforeUndo?: (session: DocumentSession) => void;
  reconcile?: (doc: ValidatedDocument) => number;
}

export function harness(timing?: RefreshTiming, hooks: HarnessHooks = {}): Harness {
  const log: string[] = [];
  const published: SessionChange[] = [];
  const refreshes: string[][] = [];
  const clock = fakeClock();
  const migration = fakeMigration();
  let denied: string | null = null;
  let nesting = false;
  function nested(): void {
    if (!hooks.beforeUndo || nesting) return;
    nesting = true;
    hooks.beforeUndo(session);
    nesting = false;
  }
  const session: DocumentSession = createDocumentSession({
    entry: function (raw) { log.push("entry"); return migrateRows(raw, migration.ports); },
    undo: {
      adopt: function (doc) { nested(); log.push("undo.adopt:" + (doc ? doc.title : "none")); },
      record: function () { log.push("undo.record"); },
      absorbServer: function (doc) { nested(); log.push("undo.server:" + (doc ? doc.title : "none")); },
      absorbReload: function () { log.push("undo.reload"); }
    },
    effects: {
      dirty: function (c) { log.push("dirty:" + c.generation); },
      draft: function (c) { log.push("draft:" + c.generation); },
      save: function (c) { log.push("save:" + c.generation); },
      refresh: function (jobs) { log.push("refresh"); refreshes.push(Array.from(jobs).sort()); }
    },
    capability: {
      edit: function (): Capability { return denied === null ? { allowed: true } : { allowed: false, reason: denied }; }
    },
    reconcile: {
      anchors: function (doc) {
        log.push("reconcile");
        return hooks.reconcile ? hooks.reconcile(doc) : 0;
      }
    },
    timers: clock,
    timing: timing
  });
  session.subscribe(function (c) { published.push(c); log.push("publish:" + c.kind); });
  return {
    session: session,
    log: log,
    published: published,
    refreshes: refreshes,
    clock: clock,
    deny: function (reason) { denied = reason; }
  };
}

export function rawScript(title: string): Record<string, unknown> {
  return {
    title: title,
    docId: "d" + "1".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Every morning.", status: "ready" },
      { id: "r2", visualText: "Close", audioText: "Mara mends nets.", status: "bogus" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", body: "Tighter", replies: [] }]
  };
}
