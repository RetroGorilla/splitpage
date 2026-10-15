import { bootApp, closeApp, rewireApp } from "../../src/test/_app-boot.mjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../src/application/actions.ts";
import type { ActionRegistry } from "../../src/application/actions.ts";
import { createExportRegistry } from "../../src/application/export/registry.ts";
import type { ExportRegistry } from "../../src/application/export/registry.ts";
import type { CommandOutcome, Replay } from "../../src/application/session/document-session.ts";
import type { StampPorts, TimerPort } from "../../src/application/session/ports.ts";
import { WIRING_STEPS, WiringError, wireApp } from "../../src/bootstrap/wiring.ts";
import type { Wiring, WiringDeps } from "../../src/bootstrap/wiring.ts";
import { appActions } from "../../src/legacy/app-actions.ts";
import { exportFormats, installExportFormats } from "../../src/legacy/export-formats.ts";
import { recoveryStarted } from "../../src/legacy/recovery-bridge.ts";
import { savesStarted } from "../../src/legacy/save-bridge.ts";
import {
  liveSession,
  onDocumentReplaced,
  provideRecordsReconciler,
  provideRefreshRunner,
  provideSessionEffects,
  requestRefresh,
  sessionStarted
} from "../../src/legacy/session-bridge.ts";
import type { ReplayRunner, SessionUndoPorts } from "../../src/legacy/session-bridge.ts";
import { documentTransitions, startTransitions } from "../../src/legacy/transition-bridge.ts";
import type { LegacyTransitionPorts } from "../../src/legacy/transition-bridge.ts";
import { routeReplays, watchUndoAdoption } from "../../src/legacy/undo-adapter.ts";
import { S } from "../../src/js/_state.js";
import { migrateRows } from "../../src/js/02-state.js";

after(closeApp);

const OWNERS = ["actions", "exports", "session", "saves", "transitions", "recovery"] as const;

type Owner = (typeof OWNERS)[number];
type Started = Record<Owner, boolean>;

function live(read: () => unknown): boolean {
  try {
    read();
    return true;
  } catch (error) {
    if (error instanceof Error && /not started yet/.test(error.message)) return false;
    throw error;
  }
}

function started(): Started {
  return {
    actions: live(() => appActions.list()),
    exports: live(() => exportFormats.cards()),
    session: sessionStarted() && live(() => liveSession().epoch()),
    saves: savesStarted(),
    transitions: live(() => documentTransitions()),
    recovery: recoveryStarted()
  };
}

function only(...owners: Owner[]): Started {
  return Object.fromEntries(OWNERS.map((o) => [o, owners.includes(o)])) as Started;
}

const NOTHING = only();
const EVERYTHING = only(...OWNERS);

class FakeTimers implements TimerPort {
  private clock = 0;
  private next = 1;
  readonly pending = new Map<number, { at: number; run: () => void }>();

  now = (): number => this.clock;

  start = (run: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { at: this.clock + ms, run });
    return id;
  };

  stop = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  advance(ms: number): void {
    this.clock += ms;
    for (const [id, t] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > this.clock) continue;
      this.pending.delete(id);
      t.run();
    }
  }
}

const NO_DOCUMENT = { kind: "none" };

function transitionPorts(): LegacyTransitionPorts {
  return {
    live: { current: () => null, assign: () => {} },
    destination: { set: () => {}, confirm: () => {} },
    identity: { mint: () => "d" + "0".repeat(32), writtenOut: () => false, markWrittenOut: () => {} }
  };
}

interface Fakes {
  readonly log: (readonly [string, Started])[];
  readonly held: { adopted: ((doc: unknown) => void) | null; run: ReplayRunner | null };
  readonly live: { exporters: number; undo: number };
  readonly timers: FakeTimers;
  readonly deps: WiringDeps;
}

function fakes(): Fakes {
  const log: (readonly [string, Started])[] = [];
  const held: Fakes["held"] = { adopted: null, run: null };
  const counts = { exporters: 0, undo: 0 };
  const timers = new FakeTimers();
  const note = (what: string): void => { log.push([what, started()]); };
  const undo: SessionUndoPorts = {
    adapter: { adopt: () => {}, record: () => {}, absorbServer: () => {}, absorbReload: () => {} },
    watch: (adopted) => {
      note("undo watch");
      counts.undo++;
      held.adopted = adopted;
      return () => { counts.undo--; };
    },
    route: (run: ReplayRunner) => {
      note("undo route");
      counts.undo++;
      held.run = run;
      return () => { counts.undo--; };
    }
  };
  const deps: WiringDeps = {
    actions: () => {
      note("actions");
      return createActionRegistry();
    },
    entry: (raw) => migrateRows(raw),
    exporters: (registry: ExportRegistry) => {
      note("exporters");
      counts.exporters++;
      const drop = registry.register({ id: "probe", fileName: (name) => name, build: () => ({ data: "" }) });
      return () => {
        counts.exporters--;
        drop();
      };
    },
    saves: (ownership) => {
      note("saves");
      return {
        write: () => Promise.resolve({ kind: "saved" as const }),
        destination: () => NO_DOCUMENT,
        keyOf: () => ({ owner: null, name: "none" }),
        obsolete: () => {},
        running: () => {},
        ownership
      };
    },
    transitions: transitionPorts(),
    recovery: () => {
      note("recovery");
      return { indexedDB: null, limits: { maxAgeMs: 1, maxCount: 1, maxBytes: 1 }, now: () => 0, writerId: "w", desktop: () => null };
    },
    keyTarget: new EventTarget(),
    undo,
    timers,
    report: () => {}
  };
  return { log, held, live: counts, timers, deps };
}

function provideEverything(refreshed: string[] = []): void {
  provideSessionEffects({ dirty: () => {}, draft: () => {}, save: () => {}, edit: () => ({ allowed: true }), editorName: () => "Ann", attribute: () => null });
  provideRefreshRunner((jobs) => { refreshed.push(...jobs); });
  provideRecordsReconciler(() => null);
}

function must<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

function wireLoose(deps: unknown): unknown {
  return Reflect.apply(wireApp, undefined, [deps]);
}

function refused(run: () => unknown): WiringError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof WiringError, "a WiringError, not " + String(error));
    return error;
  }
  assert.fail("wireApp did not refuse");
}

test("interim check: before the load-order providers have run, wireApp refuses and builds nothing", () => {
  const f = fakes();
  const error = refused(() => wireApp(f.deps));
  assert.equal(error.step, "session effects");
  assert.match(error.message, /dirty, draft, save, edit capability, editor name, attribution, refresh runner, records reconciler/);
  assert.deepEqual(f.log, []);
  assert.deepEqual(started(), NOTHING);
});

test("startup: wireApp builds every owner in order, each step sees only the owners before it, and dispose releases them all", () => {
  provideEverything();
  assert.deepEqual(started(), NOTHING);
  assert.throws(() => appActions.list(), /The action registry is not started yet/);
  assert.throws(() => exportFormats.cards(), /The export registry is not started yet/);
  assert.throws(() => liveSession().epoch(), /The document session is not started yet/);
  const f = fakes();
  const wiring = wireApp(f.deps);
  assert.deepEqual(f.log, [
    ["actions", NOTHING],
    ["exporters", only("actions", "exports")],
    ["undo watch", only("actions", "exports", "session")],
    ["undo route", only("actions", "exports", "session")],
    ["saves", only("actions", "exports", "session")],
    ["recovery", only("actions", "exports", "session", "saves", "transitions")]
  ]);
  assert.deepEqual(started(), EVERYTHING);
  assert.equal(wiring.session, liveSession());
  assert.equal(wiring.keyTarget, f.deps.keyTarget);
  assert.equal(exportFormats.byId("probe")?.id, "probe");
  assert.deepEqual(f.live, { exporters: 1, undo: 2 });
  wiring.dispose();
  assert.deepEqual(started(), NOTHING);
  assert.deepEqual(f.live, { exporters: 0, undo: 0 });
  assert.throws(() => liveSession().epoch(), /not started yet/);
  wiring.dispose();
  assert.deepEqual(started(), NOTHING);
});

test("failed partial startup: each missing dependency is named and nothing is built", () => {
  const required: (keyof WiringDeps)[] = ["entry", "exporters", "saves", "transitions", "recovery", "keyTarget"];
  for (const name of required) {
    const f = fakes();
    const error = refused(() => wireLoose(without(f.deps, name)));
    assert.equal(error.step, name);
    assert.match(error.message, new RegExp("the " + name + " dependency is missing"));
    assert.deepEqual(f.log, [], name + ": nothing is built");
    assert.deepEqual(started(), NOTHING, name + ": no facade is started");
  }
  for (const port of ["live", "destination", "identity"] as const) {
    const f = fakes();
    const error = refused(() => wireLoose({ ...f.deps, transitions: without(f.deps.transitions, port) }));
    assert.equal(error.step, "transitions");
    assert.match(error.message, new RegExp("no " + port + " port"));
    assert.deepEqual(f.log, []);
  }
  for (const port of ["adapter", "route", "watch"] as const) {
    const f = fakes();
    const error = refused(() => wireLoose({ ...f.deps, undo: without(must(f.deps.undo), port) }));
    assert.equal(error.step, "undo");
    assert.deepEqual(f.log, []);
  }
  for (const name of ["actions", "undo", "timers", "report"] as const) {
    const f = fakes();
    const error = refused(() => wireLoose({ ...f.deps, [name]: 7 }));
    assert.equal(error.step, name);
    assert.deepEqual(f.log, []);
  }
  assert.equal(refused(() => wireLoose(undefined)).step, "dependencies");
});

test("failed partial startup: a step that throws undoes every step before it, in reverse, and names itself with the cause", () => {
  const boom = new Error("boom");
  const breakers: Record<(typeof WIRING_STEPS)[number], (f: Fakes) => { deps: WiringDeps; cleanup?: () => void; cause?: boolean }> = {
    "action registry": (f) => ({ deps: { ...f.deps, actions: () => { throw boom; } } }),
    "export registry": (f) => ({ deps: f.deps, cleanup: installExportFormats(createExportRegistry()), cause: false }),
    "built-in exporters": (f) => ({ deps: { ...f.deps, exporters: () => { throw boom; } } }),
    session: (f) => ({ deps: { ...f.deps, undo: { ...must(f.deps.undo), route: () => { throw boom; } } } }),
    saves: (f) => ({ deps: { ...f.deps, saves: () => { throw boom; } } }),
    transitions: (f) => ({ deps: f.deps, cleanup: startTransitions(transitionPorts()), cause: false }),
    recovery: (f) => ({ deps: { ...f.deps, recovery: () => { throw boom; } } })
  };
  const preStarted: Partial<Record<(typeof WIRING_STEPS)[number], Owner>> = { "export registry": "exports", transitions: "transitions" };
  assert.deepEqual(Object.keys(breakers), [...WIRING_STEPS], "every step is broken once");
  for (const step of WIRING_STEPS) {
    const f = fakes();
    const { deps, cleanup, cause } = breakers[step](f);
    try {
      const error = refused(() => wireApp(deps));
      assert.equal(error.step, step);
      assert.equal(error.message, "Wiring: the " + step + " step failed");
      if (cause !== false) assert.equal(error.cause, boom);
      else assert.match(String((error.cause as Error).message), /already started/);
      const left = preStarted[step];
      assert.deepEqual(started(), left ? only(left) : NOTHING, step + ": every owner built before it is released");
      assert.deepEqual(f.live, { exporters: 0, undo: 0 }, step + ": the fakes' registrations are all released");
    } finally {
      cleanup?.();
    }
    assert.deepEqual(started(), NOTHING);
  }
});

test("undo teardown: callbacks retained from the routing do nothing after dispose", () => {
  const f = fakes();
  const wiring = wireApp(f.deps);
  const adopted = must(f.held.adopted);
  const run = must(f.held.run);
  wiring.dispose();
  let replaced = 0;
  onDocumentReplaced(() => { replaced++; });
  adopted({ rows: [] });
  assert.equal(replaced, 0);
  const task = { plan: () => { throw new Error("a stale replay must not plan"); } } as unknown as Replay;
  const outcome: CommandOutcome = run(task, null);
  assert.equal(outcome.kind, "noop");
  assert.deepEqual(started(), NOTHING);
});

test("undo teardown: an old uninstall run after a newer installation leaves the newer one in place", async () => {
  const { flushEdits, noteEdit, trackDocument, undo } = await import("../../src/js/12a-undo.js");
  const heard: string[] = [];
  const unwatchOld = watchUndoAdoption(() => { heard.push("old"); });
  const unwatchNew = watchUndoAdoption(() => { heard.push("new"); });
  unwatchOld();
  const doc = migrateRows({ title: "Undo", rows: [{ id: "r1", visualText: "", audioText: "a", status: "todo" }] });
  Reflect.set(S, "state", doc);
  trackDocument();
  assert.deepEqual(heard, ["new"]);
  const ran: string[] = [];
  const replay = (who: string): ReplayRunner => () => { ran.push(who); return { kind: "noop" }; };
  const stamps = { clock: { now: () => "" }, editor: { name: () => "Ann" } } as unknown as StampPorts;
  const unrouteOld = routeReplays(replay("old"), stamps, replay("old"));
  const unrouteNew = routeReplays(replay("new"), stamps, replay("new"));
  unrouteOld();
  Object.assign(must(doc.rows[0]), { audioText: "b" });
  noteEdit();
  flushEdits();
  undo();
  assert.deepEqual(ran, ["new"]);
  unrouteNew();
  unwatchNew();
  Reflect.set(S, "state", migrateRows({ title: "Undo 2", rows: [{ id: "r2", visualText: "", audioText: "", status: "todo" }] }));
  trackDocument();
  assert.deepEqual(heard, ["new"], "a released watch hears nothing");
});

test("cleanup: wire and dispose three times leaves no timer or subscriber, empty registries, and the same owners each time", () => {
  const refreshed: string[] = [];
  provideEverything(refreshed);
  for (let round = 0; round < 3; round++) {
    const f = fakes();
    const wiring = wireApp(f.deps);
    assert.deepEqual(started(), EVERYTHING, "round " + round);
    let heard = 0;
    liveSession().subscribe(() => { heard++; });
    requestRefresh("probe");
    assert.ok(f.timers.pending.size > 0, "the refresh arms a timer");
    const registries: [ActionRegistry, ExportRegistry] = [wiring.actions, wiring.exports];
    wiring.dispose();
    f.timers.advance(60_000);
    assert.equal(f.timers.pending.size, 0, "round " + round + ": no session timer is left");
    assert.deepEqual(refreshed, [], "round " + round + ": a disposed session runs no refresh");
    assert.equal(heard, 0);
    assert.deepEqual(registries[0].list(), [], "the action registry is empty");
    assert.equal(registries[1].byId("probe"), undefined, "the export registry is empty");
    assert.deepEqual(registries[1].cards(), []);
    assert.deepEqual(started(), NOTHING);
    assert.deepEqual(f.live, { exporters: 0, undo: 0 });
  }
});

const proto = window.EventTarget.prototype;
const realAdd = proto.addEventListener;
const realRemove = proto.removeEventListener;
const listeners = new Map<EventTarget, Set<string>>();
const keyOf = (type: string, listener: unknown, options: unknown): string => {
  const capture = typeof options === "boolean" ? options : Boolean((options as { capture?: boolean } | undefined)?.capture);
  return type + "/" + (capture ? "C" : "B") + "/" + idOf(listener);
};
const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(listener: unknown): number {
  if (!listener || (typeof listener !== "object" && typeof listener !== "function")) return 0;
  let id = ids.get(listener);
  if (!id) {
    id = nextId++;
    ids.set(listener, id);
  }
  return id;
}
proto.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
  if (listener) {
    const set = listeners.get(this) ?? new Set<string>();
    set.add(keyOf(type, listener, options));
    listeners.set(this, set);
  }
  return realAdd.call(this, type, listener, options);
};
proto.removeEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
  listeners.get(this)?.delete(keyOf(type, listener, options));
  return realRemove.call(this, type, listener, options);
};
after(() => {
  proto.addEventListener = realAdd;
  proto.removeEventListener = realRemove;
});

function listenerCount(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}

function windowListeners(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of listeners.get(window) ?? []) {
    const type = key.split("/").slice(0, 2).join("/");
    out[type] = (out[type] ?? 0) + 1;
  }
  return out;
}

interface Probe {
  readonly events: { readonly what: string; readonly listeners: number; readonly started: Started }[];
  readonly actions: () => ActionRegistry;
}

function probeActions(fail?: Error): Probe {
  const events: Probe["events"][number][] = [];
  const note = (what: string): void => { events.push({ what, listeners: listenerCount(), started: started() }); };
  return {
    events,
    actions: () => {
      const registry = createActionRegistry();
      return {
        ...registry,
        presentRefusals: (presenter) => {
          note("actions start");
          if (fail) throw fail;
          const stop = registry.presentRefusals(presenter);
          return () => {
            note("actions stop");
            stop();
          };
        }
      };
    }
  };
}

function wireReal(probe?: Probe): Promise<Wiring> {
  return rewireApp(probe ? { actions: probe.actions } : {});
}

test("lifecycle: the booted app's actions start before startup and every mount, and stop after the last mount", async () => {
  await bootApp();
  const app = await import("../../src/bootstrap/app.ts");
  assert.deepEqual(started(), EVERYTHING, "the shim wired and started the app");
  app.stopApp();
  assert.deepEqual(started(), NOTHING, "one stop releases the wiring as well as the mounts and actions");
  const baseline = listenerCount();
  const probe = probeActions();
  const wiring: Wiring = await wireReal(probe);
  app.startApp(wiring);
  await S.initialStateReady;
  assert.ok(listenerCount() > baseline + 100, "the features mounted");
  app.stopApp();
  assert.deepEqual(probe.events, [
    { what: "actions start", listeners: baseline, started: EVERYTHING },
    { what: "actions stop", listeners: baseline, started: EVERYTHING }
  ], "the probe mount saw every owner started, nothing mounted before the actions and nothing left mounted when they stopped");
  assert.deepEqual(started(), NOTHING);
  assert.equal(listenerCount(), baseline);
});

test("lifecycle: a stop before DOM ready means nothing mounts afterwards, no action starts, and the wiring is released", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  const baseline = listenerCount();
  const probe = probeActions();
  const loading = Object.assign(new window.EventTarget(), { readyState: "loading" }) as unknown as Document;
  app.startAppWhenReady(loading, await wireReal(probe));
  assert.deepEqual(started(), EVERYTHING, "wired while waiting");
  app.stopApp();
  assert.deepEqual(started(), NOTHING);
  loading.dispatchEvent(new window.Event("DOMContentLoaded"));
  assert.deepEqual(probe.events, []);
  assert.equal(listenerCount(), baseline);
  assert.deepEqual(started(), NOTHING);
});

test("lifecycle: an action start that throws rolls back and releases the wiring", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  const baseline = listenerCount();
  const boom = new Error("action start failed");
  const probe = probeActions(boom);
  const wiring = await wireReal(probe);
  assert.throws(() => app.startApp(wiring), (error) => error === boom);
  assert.deepEqual(probe.events.map((e) => e.what), ["actions start"]);
  assert.equal(listenerCount(), baseline);
  assert.deepEqual(started(), NOTHING);
  app.stopApp();
});

test("lifecycle: a mount that throws stops everything already started and releases the wiring", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  const baseline = listenerCount();
  const probe = probeActions();
  const button = document.getElementById("merge-dismiss");
  assert.ok(button, "the page has the merge banner's dismiss button, which a mid-list mount needs");
  const parent = must(button.parentNode);
  const next = button.nextSibling;
  button.remove();
  try {
    const wiring = await wireReal(probe);
    assert.throws(() => app.startApp(wiring));
  } finally {
    parent.insertBefore(button, next);
  }
  assert.deepEqual(probe.events.map((e) => e.what), ["actions start", "actions stop"]);
  assert.equal(probe.events[1]?.listeners, baseline, "every mount before the failing one was stopped before the actions");
  assert.equal(listenerCount(), baseline);
  assert.deepEqual(started(), NOTHING);
});

test("lifecycle: start, stop and start again three times with the same owners and one handler per window registration", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  const baseline = listenerCount();
  const baseWindow = windowListeners();
  const rounds: { listeners: number; window: Record<string, number>; actions: readonly string[]; exporters: readonly string[] }[] = [];
  for (let round = 0; round < 3; round++) {
    const wiring = await wireReal();
    app.startApp(wiring);
    await S.initialStateReady;
    assert.deepEqual(started(), EVERYTHING);
    const now = windowListeners();
    const added = Object.fromEntries(Object.entries(now).map(([k, n]) => [k, n - (baseWindow[k] ?? 0)]).filter(([, n]) => n));
    rounds.push({ listeners: listenerCount() - baseline, window: added, actions: appActions.list().map((v) => v.id), exporters: exportFormats.exporters().map((e) => e.id) });
    app.stopApp();
    assert.deepEqual(started(), NOTHING);
    assert.equal(listenerCount(), baseline, "round " + round + ": nothing is left registered");
  }
  const first = must(rounds[0]);
  assert.ok(first.actions.length > 30 && first.exporters.length > 10);
  assert.deepEqual(rounds[1], rounds[0]);
  assert.deepEqual(rounds[2], rounds[0]);
});

test("cleanup: the app-lifetime registrations that survive a stop are the ones made by the initializers, which run once", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  const wiring = await wireReal();
  app.startApp(wiring);
  await S.initialStateReady;
  app.stopApp();
  const survivors = listenerCount();
  assert.ok(survivors > 0, "initializer listeners stay: the shim's __init calls are not repeated by a restart");
  let replaced = 0;
  onDocumentReplaced(() => { replaced++; });
  const again = await wireReal();
  app.startApp(again);
  await S.initialStateReady;
  const { NO_DESTINATION } = await import("../../src/legacy/transition-bridge.ts");
  documentTransitions().startNew({ from: { document: migrateRows({ title: "Fresh", rows: [] }) }, reason: "test: a new script", destination: NO_DESTINATION });
  assert.ok(replaced > 0, "document-replaced listeners registered on the bridge survive a rewire");
  app.stopApp();
  assert.equal(listenerCount(), survivors);
});
