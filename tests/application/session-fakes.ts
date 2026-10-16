import { createDocumentSession } from "../../src/application/session/document-session.ts";
import type { Command, CommandOutcome, DocumentSession, DocumentView, Plan, SessionCounters } from "../../src/application/session/document-session.ts";
import { NO_CHANGES, needsReconciliation } from "../../src/application/session/change-set.ts";
import type { ChangeSet, SessionChange } from "../../src/application/session/change-set.ts";
import type { Capability, RecordsPlan, TimerPort } from "../../src/application/session/ports.ts";
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
  reported: unknown[];
  clock: FakeClock;
  deny: (reason: string | null) => void;
}

export interface HarnessHooks {
  beforeUndo?: (session: DocumentSession) => void;
  reconcile?: (doc: ValidatedDocument) => number;
  records?: (doc: ValidatedDocument, changes: ChangeSet) => RecordsPlan | null;
  entry?: (raw: unknown) => ValidatedDocument;
  attribute?: (doc: DocumentView) => Plan | null;
  record?: () => void;
  effect?: (name: "dirty" | "draft" | "save") => void;
  after?: SessionCounters;
}

export function harness(timing?: RefreshTiming, hooks: HarnessHooks = {}): Harness {
  const log: string[] = [];
  const published: SessionChange[] = [];
  const refreshes: string[][] = [];
  const reported: unknown[] = [];
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
    entry: function (raw) { log.push("entry"); return hooks.entry ? hooks.entry(raw) : migrateRows(raw, migration.ports); },
    undo: {
      adopt: function (doc) { nested(); log.push("undo.adopt:" + (doc ? doc.title : "none")); },
      record: function () { log.push("undo.record"); if (hooks.record) hooks.record(); },
      absorbServer: function (doc) { nested(); log.push("undo.server:" + (doc ? doc.title : "none")); },
      absorbReload: function () { log.push("undo.reload"); }
    },
    effects: {
      dirty: function (c) { log.push("dirty:" + c.generation); if (hooks.effect) hooks.effect("dirty"); },
      draft: function (c) { log.push("draft:" + c.generation); if (hooks.effect) hooks.effect("draft"); },
      save: function (c) { log.push("save:" + c.generation); if (hooks.effect) hooks.effect("save"); },
      refresh: function (jobs) { log.push("refresh"); refreshes.push(Array.from(jobs).sort()); }
    },
    capability: {
      edit: function (): Capability { return denied === null ? { allowed: true } : { allowed: false, reason: denied }; }
    },
    reconcile: {
      anchors: function (doc) {
        log.push("reconcile");
        return hooks.reconcile ? hooks.reconcile(doc) : 0;
      },
      records: function (doc, changes) {
        if (!hooks.records) return null;
        log.push("records");
        return hooks.records(doc, changes);
      }
    },
    attribution: {
      attribute: function (doc) {
        if (!hooks.attribute) return null;
        log.push("attribute");
        return hooks.attribute(doc);
      }
    },
    report: function (error) {
      log.push("report");
      reported.push(error);
    },
    timers: clock,
    timing: timing,
    after: hooks.after
  });
  session.subscribe(function (c) { published.push(c); log.push("publish:" + c.kind); });
  return {
    session: session,
    log: log,
    published: published,
    refreshes: refreshes,
    reported: reported,
    clock: clock,
    deny: function (reason) { denied = reason; }
  };
}

type Bag = Record<string, unknown>;

function snapshotOf(session: DocumentSession): Bag | null {
  const text = session.read(function (doc) { return doc ? JSON.stringify(doc) : null; });
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" ? { ...parsed } : null;
}

function listOf(value: unknown): Bag[] {
  return Array.isArray(value) ? value.filter(function (v): v is Bag { return !!v && typeof v === "object"; }) : [];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function writesOutside(before: Bag, after: Bag, changes: ChangeSet): string[] {
  if (changes.whole) return [];
  const out: string[] = [];
  const declaredDoc = new Set(changes.docFields);
  const keys = new Set(Object.keys(before).concat(Object.keys(after)));
  keys.forEach(function (key) {
    if (key === "rows" || key === "comments" || declaredDoc.has(key)) return;
    if (!same(before[key], after[key])) out.push(key);
  });
  const cells = new Set(changes.cells.map(function (c) { return c.rowId + "\u0000" + c.field; }));
  const was = listOf(before.rows), now = listOf(after.rows);
  const wasById = new Map(was.map(function (r) { return [String(r.id), r]; }));
  const nowById = new Map(now.map(function (r) { return [String(r.id), r]; }));
  nowById.forEach(function (row, id) {
    const old = wasById.get(id);
    if (!old) {
      if (changes.rowsInserted.indexOf(id) === -1) out.push("rows[" + id + "] inserted");
      return;
    }
    new Set(Object.keys(old).concat(Object.keys(row))).forEach(function (field) {
      if (!same(old[field], row[field]) && !cells.has(id + "\u0000" + field)) out.push("rows[" + id + "]." + field);
    });
  });
  wasById.forEach(function (row, id) {
    if (!nowById.has(id) && changes.rowsRemoved.indexOf(id) === -1) out.push("rows[" + id + "] removed");
  });
  const kept = (ids: Bag[]) => ids.map(function (r) { return String(r.id); }).filter(function (id) { return wasById.has(id) && nowById.has(id); });
  if (!changes.rowsMoved && !same(kept(was), kept(now))) out.push("rows order");
  if (!declaredDoc.has("comments")) {
    const reconciles = needsReconciliation(changes);
    const strip = function (c: Bag): Bag {
      if (!reconciles) return c;
      const rest: Bag = { ...c };
      Reflect.deleteProperty(rest, "rowId");
      Reflect.deleteProperty(rest, "field");
      return rest;
    };
    if (!same(listOf(before.comments).map(strip), listOf(after.comments).map(strip))) out.push("comments");
  }
  return out;
}

export function runConfined(session: DocumentSession, command: Command): CommandOutcome {
  let plannedWrite = false;
  const watched: Command = {
    name: command.name,
    needs: command.needs,
    plan: function (doc, capability) {
      const text = JSON.stringify(doc);
      try {
        return command.plan(doc, capability);
      } finally {
        if (JSON.stringify(doc) !== text) plannedWrite = true;
      }
    }
  };
  const before = snapshotOf(session);
  const outcome = session.run(watched);
  if (plannedWrite) {
    throw new Error("command " + command.name + " planned a write to the document; plan must only read it");
  }
  const after = snapshotOf(session);
  if (!before || !after) return outcome;
  const changes = outcome.kind === "applied" || outcome.kind === "committed" ? outcome.changes : NO_CHANGES;
  const outside = writesOutside(before, after, changes);
  if (outside.length) {
    throw new Error("command " + command.name + " (" + outcome.kind + ") wrote outside its declared change set: " + outside.join(", "));
  }
  return outcome;
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
