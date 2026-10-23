import { productionEditingStarted, startProductionEditing } from "../../src/legacy/production-editing-bridge.ts";
import { bootApp, closeApp, rewireApp } from "../../src/test/_app-boot.mjs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../src/application/actions.ts";
import type { ActionRegistry } from "../../src/application/actions.ts";
import { createExportRegistry } from "../../src/application/export/registry.ts";
import type { ExportRegistry } from "../../src/application/export/registry.ts";
import { exportServicesStarted, installExportServices } from "../../src/application/export/services.ts";
import type { CommandOutcome, Replay } from "../../src/application/session/document-session.ts";
import type { StampPorts, TimerPort } from "../../src/application/session/ports.ts";
import { WIRING_STEPS, WiringError, legacySessionPorts, wireApp } from "../../src/bootstrap/wiring.ts";
import { legacyExportServices } from "../../src/bootstrap/export-services.ts";
import type { TransitionDeps, Wiring, WiringDeps } from "../../src/bootstrap/wiring.ts";
import { appActions } from "../../src/legacy/app-actions.ts";
import { exportFormats, installExportFormats } from "../../src/legacy/export-formats.ts";
import { editorStarted, startEditor } from "../../src/legacy/editor-bridge.ts";
import { locationStarted, startLocation } from "../../src/legacy/location-bridge.ts";
import { preferencesStarted, startPreferences } from "../../src/legacy/preferences-bridge.ts";
import { effectsStarted, startEffects } from "../../src/legacy/effects-bridge.ts";
import type { EffectPorts } from "../../src/application/effects/ports.ts";
import { recoveryStarted } from "../../src/legacy/recovery-bridge.ts";
import { requestSave, savesStarted, savesWaiting } from "../../src/legacy/save-bridge.ts";
import { startupReady } from "../../src/legacy/startup-bridge.ts";
import type { LegacySaveJob, LegacySavePorts } from "../../src/legacy/save-bridge.ts";
import type { SaveOutcome, WriterResult } from "../../src/application/save/coordinator.ts";
import {
  liveDocumentPort,
  liveSession,
  onDocumentReplaced,
  requestRefresh,
  runCommand,
  sessionStamps,
  sessionStarted,
  startSessionBridge
} from "../../src/legacy/session-bridge.ts";
import type { ReplayRunner, SessionUndoPorts } from "../../src/legacy/session-bridge.ts";
import { documentTransitions, startTransitions } from "../../src/legacy/transition-bridge.ts";
import { createUndoAdapter, routeReplays } from "../../src/legacy/undo-adapter.ts";
import { sceneLengthCommand } from "../../src/application/commands/scene-length.ts";
import { migrateRows } from "../../src/js/02-state.js";

after(closeApp);

const OWNERS = ["location", "effects", "actions", "exportServices", "exports", "session", "saves", "transitions", "recovery", "editor", "productionEditing", "preferences"] as const;

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
    location: locationStarted(),
    effects: effectsStarted(),
    actions: live(() => appActions.list()),
    exportServices: exportServicesStarted(),
    exports: live(() => exportFormats.cards()),
    session: sessionStarted() && live(() => liveSession().epoch()),
    saves: savesStarted(),
    transitions: live(() => documentTransitions()),
    recovery: recoveryStarted(),
    editor: editorStarted(),
    productionEditing: productionEditingStarted(),
    preferences: preferencesStarted()
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

function transitionPorts(): TransitionDeps {
  return {
    destination: { set: () => {}, confirm: () => {} },
    identity: { mint: () => "d" + "0".repeat(32), writtenOut: () => false, markWrittenOut: () => {} }
  };
}

interface Fakes {
  readonly log: (readonly [string, Started])[];
  readonly held: { run: ReplayRunner | null };
  readonly live: { exporters: number; undo: number };
  readonly timers: FakeTimers;
  readonly refreshed: string[];
  readonly deps: WiringDeps;
}

function fakes(): Fakes {
  const log: (readonly [string, Started])[] = [];
  const held: Fakes["held"] = { run: null };
  const counts = { exporters: 0, undo: 0 };
  const timers = new FakeTimers();
  const refreshed: string[] = [];
  const note = (what: string): void => { log.push([what, started()]); };
  const undo: SessionUndoPorts = {
    adapter: { adopt: () => {}, record: () => {}, absorbServer: () => {}, absorbReload: () => {} },
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
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, edit: () => ({ allowed: true }), attribute: () => null },
    editorName: () => "Ann",
    refresh: (jobs) => { refreshed.push(...jobs); },
    records: () => null,
    bulkTags: { cell: (html) => ({ hits: 0, inTags: 0, skipped: 0, html: html }), stamp: () => {} },
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
        destination: () => NO_DOCUMENT,
        keyOf: () => ({ owner: null, name: "none" }),
        obsolete: () => {},
        ownership,
        autosave: { enabledAtStart: () => false, changed: () => {} }
      };
    },
    destinations: () => {
      note("destinations");
      return [{ id: "probe", takes: () => true, autoSaveTarget: () => null, write: () => Promise.resolve({ kind: "saved" as const }) }];
    },
    transitions: transitionPorts(),
    recovery: () => {
      note("recovery");
      return { indexedDB: null, limits: { maxAgeMs: 1, maxCount: 1, maxBytes: 1 }, now: () => 0, writerId: "w", desktop: () => null, sessionStorage: () => null, localStorage: () => null, internImage: () => {} };
    },
    keyTarget: new EventTarget(),
    undo,
    timers,
    report: () => {}
  };
  return { log, held, live: counts, timers, refreshed, deps };
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

test("startup: wireApp builds every owner in order, each step sees only the owners before it, and dispose releases them all", () => {
  assert.deepEqual(started(), NOTHING);
  assert.throws(() => appActions.list(), /The action registry is not started yet/);
  assert.throws(() => exportFormats.cards(), /The export registry is not started yet/);
  assert.throws(() => liveSession().epoch(), /The document session is not started yet/);
  const f = fakes();
  const wiring = wireApp(f.deps);
  assert.deepEqual(f.log, [
    ["actions", only("location", "effects")],
    ["exporters", only("location", "effects", "actions", "exportServices", "exports")],
    ["undo route", only("location", "effects", "actions", "exportServices", "exports", "session")],
    ["saves", only("location", "effects", "actions", "exportServices", "exports", "session")],
    ["destinations", only("location", "effects", "actions", "exportServices", "exports", "session", "saves")],
    ["recovery", only("location", "effects", "actions", "exportServices", "exports", "session", "saves", "transitions")]
  ]);
  assert.deepEqual(started(), EVERYTHING);
  assert.equal(wiring.session, liveSession());
  assert.equal(wiring.keyTarget, f.deps.keyTarget);
  assert.equal(exportFormats.byId("probe")?.id, "probe");
  assert.deepEqual(f.live, { exporters: 1, undo: 1 });
  wiring.dispose();
  assert.deepEqual(started(), NOTHING);
  assert.deepEqual(f.live, { exporters: 0, undo: 0 });
  assert.throws(() => liveSession().epoch(), /not started yet/);
  wiring.dispose();
  assert.deepEqual(started(), NOTHING);
});

test("failed partial startup: each missing dependency is named and nothing is built", () => {
  const required: (keyof WiringDeps)[] = ["entry", "effects", "editorName", "refresh", "records", "saves", "destinations", "transitions", "recovery", "keyTarget"];
  for (const name of required) {
    const f = fakes();
    const error = refused(() => wireLoose(without(f.deps, name)));
    assert.equal(error.step, name);
    assert.match(error.message, new RegExp("the " + name + " dependency is missing"));
    assert.deepEqual(f.log, [], name + ": nothing is built");
    assert.deepEqual(started(), NOTHING, name + ": no facade is started");
  }
  for (const effect of ["dirty", "draft", "save", "edit", "attribute"] as const) {
    const f = fakes();
    const error = refused(() => wireLoose({ ...f.deps, effects: without(f.deps.effects, effect) }));
    assert.equal(error.step, "effects");
    assert.match(error.message, new RegExp("the effects dependency has no " + effect + " effect"));
    assert.deepEqual(f.log, [], effect + ": nothing is built");
    assert.deepEqual(started(), NOTHING, effect + ": no facade is started");
  }
  for (const port of ["destination", "identity"] as const) {
    const f = fakes();
    const error = refused(() => wireLoose({ ...f.deps, transitions: without(f.deps.transitions, port) }));
    assert.equal(error.step, "transitions");
    assert.match(error.message, new RegExp("no " + port + " port"));
    assert.deepEqual(f.log, []);
  }
  for (const port of ["adapter", "route"] as const) {
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

test("failed partial startup: a port that is present but lacks a function is named and nothing is built", () => {
  const methods: Record<keyof TransitionDeps, readonly string[]> = {
    destination: ["set", "confirm"],
    identity: ["mint", "writtenOut", "markWrittenOut"]
  };
  for (const [port, names] of Object.entries(methods) as [keyof TransitionDeps, readonly string[]][]) {
    for (const method of names) {
      for (const spoilt of [(given: object) => without(given, method), (given: object) => ({ ...given, [method]: 7 })]) {
        const f = fakes();
        const transitions = { ...f.deps.transitions, [port]: spoilt(f.deps.transitions[port]) };
        const error = refused(() => wireLoose({ ...f.deps, transitions }));
        assert.equal(error.step, "transitions");
        assert.equal(error.message, "Wiring: the transitions dependency's " + port + " port has no " + method + " function");
        assert.deepEqual(f.log, [], port + "." + method + ": nothing is built");
        assert.deepEqual(started(), NOTHING, port + "." + method + ": no facade is started");
      }
    }
  }
  const f = fakes();
  const empty = refused(() => wireLoose({ ...f.deps, transitions: { destination: {}, identity: {} } }));
  assert.equal(empty.message, "Wiring: the transitions dependency's destination port has no set function", "empty port objects are refused");
  assert.deepEqual(f.log, []);
  assert.deepEqual(started(), NOTHING);
});

test("failed partial startup: a save factory that returns malformed ports fails the saves step, names the port and installs no save owner", () => {
  const malformed: [string, (ports: LegacySavePorts) => unknown, string][] = [
    ["nothing", () => undefined, "the saves dependency returned no save ports"],
    ...(["destination", "keyOf", "obsolete"] as const).map((port): [string, (ports: LegacySavePorts) => unknown, string] =>
      [port, (ports) => without(ports, port), "the saves dependency returned no " + port + " port"]),
    ...(["destination", "keyOf", "obsolete"] as const).map((port): [string, (ports: LegacySavePorts) => unknown, string] =>
      [port + " not a function", (ports) => ({ ...ports, [port]: 7 }), "the saves dependency returned no " + port + " port"]),
    ["ownership not an object", (ports) => ({ ...ports, ownership: 7 }), "the saves dependency returned no ownership port"],
    ["ownership", (ports) => without(ports, "ownership"), "the saves dependency returned no ownership port"],
    ...(["capture", "stillOwns"] as const).map((method): [string, (ports: LegacySavePorts) => unknown, string] =>
      [method, (ports) => ({ ...ports, ownership: without(ports.ownership, method) }), "the saves dependency's ownership port has no " + method + " function"]),
    ...(["capture", "stillOwns"] as const).map((method): [string, (ports: LegacySavePorts) => unknown, string] =>
      [method + " not a function", (ports) => ({ ...ports, ownership: { ...ports.ownership, [method]: "x" } }), "the saves dependency's ownership port has no " + method + " function"]),
    ["autosave not an object", (ports) => ({ ...ports, autosave: 7 }), "the saves dependency returned no autosave port"],
    ["autosave", (ports) => without(ports, "autosave"), "the saves dependency returned no autosave port"],
    ...(["enabledAtStart", "changed"] as const).map((method): [string, (ports: LegacySavePorts) => unknown, string] =>
      [method, (ports) => ({ ...ports, autosave: without(ports.autosave, method) }), "the saves dependency's autosave port has no " + method + " function"]),
    ...(["enabledAtStart", "changed"] as const).map((method): [string, (ports: LegacySavePorts) => unknown, string] =>
      [method + " not a function", (ports) => ({ ...ports, autosave: { ...ports.autosave, [method]: "x" } }), "the saves dependency's autosave port has no " + method + " function"])
  ];
  for (const [what, spoil, message] of malformed) {
    const f = fakes();
    const saves = (ownership: Parameters<WiringDeps["saves"]>[0]): unknown => spoil(f.deps.saves(ownership));
    const error = refused(() => wireLoose({ ...f.deps, saves }));
    assert.equal(error.step, "saves", what);
    assert.equal(error.message, "Wiring: the saves step failed", what);
    assert.ok(error.cause instanceof WiringError, what + ": the cause is a WiringError");
    assert.equal(error.cause.step, "saves", what);
    assert.equal(error.cause.message, "Wiring: " + message, what);
    assert.equal(savesStarted(), false, what + ": no save coordinator is installed");
    assert.deepEqual(started(), NOTHING, what + ": every owner built before it is released");
    assert.deepEqual(f.live, { exporters: 0, undo: 0 }, what);
  }
});

test("failed partial startup: a destinations dependency that returns no list fails the save destinations step and installs no save owner", () => {
  for (const given of [undefined, null, 7, {}]) {
    const f = fakes();
    const error = refused(() => wireLoose({ ...f.deps, destinations: () => given }));
    assert.equal(error.step, "save destinations", String(given));
    assert.ok(error.cause instanceof WiringError, String(given) + ": the cause is a WiringError");
    assert.equal(error.cause.message, "Wiring: the destinations dependency returned no list of destinations", String(given));
    assert.equal(savesStarted(), false, String(given) + ": no save coordinator is installed");
    assert.deepEqual(started(), NOTHING, String(given) + ": every owner built before it is released");
  }
  const f = fakes();
  const probe = { id: "probe", takes: () => true, autoSaveTarget: () => null, write: () => Promise.resolve({ kind: "saved" as const }) };
  const twice = refused(() => wireLoose({ ...f.deps, destinations: () => [probe, probe] }));
  assert.equal(twice.step, "save destinations", "a second destination with the same id");
  assert.match(String((twice.cause as Error).message), /a destination called probe is already registered/);
  assert.equal(savesStarted(), false, "the first destination and the coordinator are released");
  assert.deepEqual(started(), NOTHING);
});

test("failed partial startup: a timers port, undo adapter or key target that lacks a method is named and nothing is built", () => {
  const listeners = { addEventListener: () => {}, removeEventListener: () => {} };
  const cases: [string, (f: Fakes) => unknown, string, string][] = [];
  for (const method of ["now", "start", "stop"] as const) {
    const spoil = (f: Fakes): object => ({ now: f.timers.now, start: f.timers.start, stop: f.timers.stop });
    cases.push(["timers." + method, (f) => ({ ...f.deps, timers: without(spoil(f), method) }), "timers", "Wiring: the timers dependency has no " + method + " function"]);
    cases.push(["timers." + method + " not a function", (f) => ({ ...f.deps, timers: { ...spoil(f), [method]: 7 } }), "timers", "Wiring: the timers dependency has no " + method + " function"]);
  }
  cases.push(["timers {}", (f) => ({ ...f.deps, timers: {} }), "timers", "Wiring: the timers dependency has no now function"]);
  for (const method of ["adopt", "record", "absorbServer", "absorbReload"] as const) {
    const undo = (f: Fakes): SessionUndoPorts => must(f.deps.undo);
    cases.push(["undo.adapter." + method, (f) => ({ ...f.deps, undo: { ...undo(f), adapter: without(undo(f).adapter, method) } }), "undo", "Wiring: the undo dependency's adapter port has no " + method + " function"]);
    cases.push(["undo.adapter." + method + " not a function", (f) => ({ ...f.deps, undo: { ...undo(f), adapter: { ...undo(f).adapter, [method]: 7 } } }), "undo", "Wiring: the undo dependency's adapter port has no " + method + " function"]);
  }
  for (const method of ["addEventListener", "removeEventListener"] as const) {
    cases.push(["keyTarget." + method, (f) => ({ ...f.deps, keyTarget: without(listeners, method) }), "keyTarget", "Wiring: the keyTarget dependency has no " + method + " function"]);
    cases.push(["keyTarget." + method + " not a function", (f) => ({ ...f.deps, keyTarget: { ...listeners, [method]: 7 } }), "keyTarget", "Wiring: the keyTarget dependency has no " + method + " function"]);
  }
  for (const [what, spoil, step, message] of cases) {
    const f = fakes();
    const error = refused(() => wireLoose(spoil(f)));
    assert.equal(error.step, step, what);
    assert.equal(error.message, message, what);
    assert.deepEqual(f.log, [], what + ": nothing is built");
    assert.deepEqual(started(), NOTHING, what + ": no facade is started");
  }
  const f = fakes();
  const wiring = wireApp({ ...f.deps, keyTarget: listeners as unknown as EventTarget });
  assert.deepEqual(started(), EVERYTHING, "a key target with both listener methods is accepted");
  wiring.dispose();
});

test("failed partial startup: an actions, exporters or recovery factory that returns something malformed fails its step, names what is missing and leaves no owner", () => {
  const registryMethods = ["register", "has", "shortcuts", "view", "list", "invoke", "presentRefusals"] as const;
  const recoveryMethods = ["now", "desktop", "sessionStorage", "localStorage", "internImage"] as const;
  type Spoilt = [string, (f: Fakes) => WiringDeps | Record<string, unknown>, string, string];
  const cases: Spoilt[] = [
    ["actions nothing", (f) => ({ ...f.deps, actions: () => undefined }), "action registry", "the actions dependency returned no action registry"],
    ...registryMethods.flatMap((method): Spoilt[] => [
      ["actions " + method, (f) => ({ ...f.deps, actions: () => without(createActionRegistry(), method) }), "action registry", "the action registry has no " + method + " function"],
      ["actions " + method + " not a function", (f) => ({ ...f.deps, actions: () => ({ ...createActionRegistry(), [method]: 7 }) }), "action registry", "the action registry has no " + method + " function"]
    ]),
    ["exporters nothing", (f) => ({ ...f.deps, exporters: () => undefined }), "built-in exporters", "the exporters dependency returned no function to remove them"],
    ["exporters not a function", (f) => ({ ...f.deps, exporters: () => 7 }), "built-in exporters", "the exporters dependency returned no function to remove them"],
    ["recovery nothing", (f) => ({ ...f.deps, recovery: () => undefined }), "recovery", "the recovery dependency returned no recovery ports"],
    ...recoveryMethods.flatMap((method): Spoilt[] => [
      ["recovery " + method, (f) => ({ ...f.deps, recovery: () => without(f.deps.recovery(), method) }), "recovery", "the recovery dependency returned no " + method + " function"],
      ["recovery " + method + " not a function", (f) => ({ ...f.deps, recovery: () => ({ ...f.deps.recovery(), [method]: 7 }) }), "recovery", "the recovery dependency returned no " + method + " function"]
    ])
  ];
  for (const [what, spoil, step, message] of cases) {
    const f = fakes();
    const error = refused(() => wireLoose(spoil(f)));
    assert.equal(error.step, step, what);
    assert.equal(error.message, "Wiring: the " + step + " step failed", what);
    assert.ok(error.cause instanceof WiringError, what + ": the cause is a WiringError");
    assert.equal(error.cause.step, step, what);
    assert.equal(error.cause.message, "Wiring: " + message, what);
    assert.deepEqual(started(), NOTHING, what + ": every owner built before it is released");
    assert.deepEqual(f.live, { exporters: 0, undo: 0 }, what + ": the fakes' registrations are all released");
  }
});

test("failed partial startup: a step that throws undoes every step before it, in reverse, and names itself with the cause", () => {
  const boom = new Error("boom");
  const breakers: Record<(typeof WIRING_STEPS)[number], (f: Fakes) => { deps: WiringDeps; cleanup?: () => void; cause?: boolean }> = {
    location: (f) => ({ deps: f.deps, cleanup: startLocation(), cause: false }),
    "page effects": (f) => ({ deps: f.deps, cleanup: startEffects({} as EffectPorts<Element>), cause: false }),
    "action registry": (f) => ({ deps: { ...f.deps, actions: () => { throw boom; } } }),
    "export services": (f) => ({ deps: f.deps, cleanup: installExportServices(legacyExportServices()), cause: false }),
    "export registry": (f) => ({ deps: f.deps, cleanup: installExportFormats(createExportRegistry()), cause: false }),
    "built-in exporters": (f) => ({ deps: { ...f.deps, exporters: () => { throw boom; } } }),
    session: (f) => ({ deps: { ...f.deps, undo: { ...must(f.deps.undo), route: () => { throw boom; } } } }),
    saves: (f) => ({ deps: { ...f.deps, saves: () => { throw boom; } } }),
    "save destinations": (f) => ({ deps: { ...f.deps, destinations: () => { throw boom; } } }),
    transitions: (f) => ({ deps: f.deps, cleanup: startTransitions({ ...transitionPorts(), live: liveDocumentPort }), cause: false }),
    recovery: (f) => ({ deps: { ...f.deps, recovery: () => { throw boom; } } }),
    editor: (f) => ({ deps: f.deps, cleanup: startEditor(liveDocumentPort), cause: false }),
    "production editing": (f) => ({ deps: f.deps, cleanup: startProductionEditing(must(f.deps.timers)), cause: false }),
    preferences: (f) => ({ deps: f.deps, cleanup: startPreferences(), cause: false })
  };
  const preStarted: Partial<Record<(typeof WIRING_STEPS)[number], Owner>> = { location: "location", "page effects": "effects", "export services": "exportServices", "export registry": "exports", transitions: "transitions", editor: "editor", "production editing": "productionEditing", preferences: "preferences" };
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
  const run = must(f.held.run);
  wiring.dispose();
  const task = { plan: () => { throw new Error("a stale replay must not plan"); } } as unknown as Replay;
  const outcome: CommandOutcome = run(task);
  assert.equal(outcome.kind, "noop");
  assert.deepEqual(started(), NOTHING);
});

test("undo teardown: an old uninstall run after a newer installation leaves the newer one in place", async () => {
  const { flushEdits, noteEdit, undo } = await import("../../src/js/12a-undo.js");
  const stopSession = startSessionBridge(legacySessionPorts({ ...fakes().deps, undo: { adapter: createUndoAdapter(), route: () => () => {} } }));
  const doc = migrateRows({ title: "Undo", rows: [{ id: "r1", visualText: "", audioText: "a", status: "todo" }] });
  liveDocumentPort.assign(doc);
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
  stopSession();
});

test("a session built by wireApp runs exactly the effects it was handed: a probe counts one call of each per edit", () => {
  const f = fakes();
  const calls = new Map<string, number>();
  const count = (what: string): void => { calls.set(what, (calls.get(what) ?? 0) + 1); };
  const counted = (): Record<string, number> => Object.fromEntries([...calls].sort());
  const wiring = wireApp({
    ...f.deps,
    undo: undefined,
    effects: {
      dirty: () => { count("dirty"); },
      draft: () => { count("draft"); },
      save: () => { count("save"); },
      edit: () => { count("edit"); return { allowed: true }; },
      attribute: () => { count("attribute"); return null; }
    },
    editorName: () => { count("editor name"); return "Probe"; },
    refresh: (jobs) => { for (const job of jobs) count("refresh " + job); },
    records: () => { count("records"); return null; }
  });
  try {
    const doc = migrateRows({ title: "Probe", rows: [{ id: "r1", visualText: "", audioText: "", status: "todo" }] });
    liveDocumentPort.assign(doc);
    Object.assign(must(doc.rows[0]), { audioText: "typed" });
    calls.clear();
    liveSession().noteEdit();
    assert.deepEqual(counted(), { dirty: 1, draft: 1, records: 1, save: 1 }, "a legacy edit to the held document reconciles its records and runs each change effect once");
    calls.clear();
    const outcome = runCommand(sceneLengthCommand("r1", 30, sessionStamps));
    assert.equal(outcome.kind, "applied");
    assert.equal(doc.rows[0]?.updatedBy, "Probe", "the stamp comes from the editor name handed in");
    assert.deepEqual(counted(), { attribute: 1, dirty: 1, draft: 1, edit: 1, "editor name": 1, records: 1, save: 1 }, "a command runs each effect once");
    calls.clear();
    requestRefresh("probe");
    f.timers.advance(60_000);
    assert.equal(calls.get("refresh probe"), 1, "a refresh that comes due reaches the runner handed in, once");
    assert.deepEqual([...calls.keys()].filter((what) => !what.startsWith("refresh ")), [], "a refresh runs no other effect");
  } finally {
    wiring.dispose();
  }
  assert.deepEqual(started(), NOTHING);
});

test("session release: a session dispose that throws still runs the undo uninstalls", () => {
  const f = fakes();
  const stopFails = new Error("timer stop failed");
  const wiring = wireApp({ ...f.deps, timers: { now: () => 0, start: () => 1, stop: () => { throw stopFails; } } });
  requestRefresh("probe");
  assert.deepEqual(f.live, { exporters: 1, undo: 1 });
  assert.throws(() => wiring.dispose(), (error) => error instanceof AggregateError && error.errors.includes(stopFails));
  assert.deepEqual(f.live, { exporters: 0, undo: 0 }, "the undo routing and adoption watch were uninstalled");
  assert.deepEqual(started(), NOTHING);
});

test("cleanup: wire and dispose three times leaves no timer or subscriber, empty registries, and the same owners each time", () => {
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
    assert.deepEqual(f.refreshed, [], "round " + round + ": a disposed session runs no refresh");
    assert.equal(heard, 0);
    assert.deepEqual(registries[0].list(), [], "the action registry is empty");
    assert.equal(registries[1].byId("probe"), undefined, "the export registry is empty");
    assert.deepEqual(registries[1].cards(), []);
    assert.deepEqual(started(), NOTHING);
    assert.deepEqual(f.live, { exporters: 0, undo: 0 });
  }
});

interface HeldSaves {
  readonly calls: string[];
  readonly jobs: LegacySaveJob[];
  readonly finish: ((result: WriterResult) => void)[];
  readonly saves: WiringDeps["saves"];
  readonly destinations: WiringDeps["destinations"];
}

function heldSaves(name: string): HeldSaves {
  const calls: string[] = [];
  const jobs: LegacySaveJob[] = [];
  const finish: ((result: WriterResult) => void)[] = [];
  const call = (what: string): void => { calls.push(name + " " + what); };
  const saves: WiringDeps["saves"] = (ownership) => ({
    destination: () => { call("destination"); return NO_DOCUMENT; },
    keyOf: () => { call("keyOf"); return { owner: null, name: "none" }; },
    obsolete: () => { call("obsolete"); },
    ownership: {
      capture: () => { call("capture"); return ownership.capture(); },
      stillOwns: (ctx) => { call("stillOwns"); return ownership.stillOwns(ctx); }
    },
    autosave: { enabledAtStart: () => false, changed: () => {} }
  });
  const destinations: WiringDeps["destinations"] = () => [{
    id: name,
    takes: () => true,
    autoSaveTarget: () => null,
    write: (job) => {
      call("write");
      jobs.push(job);
      return new Promise<WriterResult>((resolve) => { finish.push(resolve); });
    }
  }];
  return { calls, jobs, finish, saves, destinations };
}

function settled(promise: Promise<SaveOutcome>): Promise<SaveOutcome | "still pending"> {
  return Promise.race([promise, new Promise<"still pending">((resolve) => { setTimeout(() => { resolve("still pending"); }, 200); })]);
}

for (const rewire of [false, true]) {
  test("save teardown" + (rewire ? ", then a rewire" : "") + ": dispose settles the queued save, and the held write that finishes afterwards settles without calling any old or replacement owner", async () => {
    const f = fakes();
    const old = heldSaves("old");
    const wiring = wireApp({ ...f.deps, saves: old.saves, destinations: old.destinations });
    const active = requestSave({ kind: "save" });
    const queued = requestSave({ kind: "saveAs" });
    assert.equal(old.jobs.length, 1, "the first save is writing");
    assert.equal(savesWaiting(), 1, "the second waits behind it");
    const job = must(old.jobs[0]);
    wiring.dispose();
    assert.deepEqual(started(), NOTHING);
    old.calls.length = 0;
    assert.deepEqual(await settled(queued), { kind: "cancelled" }, "the queued save settles at dispose and never writes");
    const fresh = heldSaves("new");
    const replacement = rewire ? wireApp({ ...fakes().deps, saves: fresh.saves, destinations: fresh.destinations }) : null;
    try {
      assert.equal(job.owns(), false, "the held job no longer owns anything");
      job.moved();
      must(old.finish[0])({ kind: "saved" });
      assert.deepEqual(await settled(active), { kind: "obsolete", here: false }, "the held save settles as landed but no longer this app's");
      assert.deepEqual(old.calls, [], "nothing after dispose reaches the old ports");
      assert.deepEqual(fresh.calls, [], "nothing from the old coordinator reaches the replacement");
      assert.equal(old.jobs.length, 1, "the queued save was never written");
      if (replacement) {
        const next = requestSave({ kind: "save" });
        assert.equal(fresh.jobs.length, 1, "the replacement writes its own save");
        must(fresh.finish[0])({ kind: "saved" });
        assert.equal((await settled(next) as SaveOutcome).kind, "saved", "the replacement's own save settles normally");
        assert.deepEqual(old.calls, [], "the replacement's save reaches none of the old ports");
      }
    } finally {
      replacement?.dispose();
    }
    assert.deepEqual(started(), NOTHING);
  });
}

test("save teardown: a held write that fails or is cancelled after dispose settles with what the writer said", async () => {
  for (const result of [{ kind: "failed", error: new Error("disk") }, { kind: "cancelled" }, { kind: "refused", reason: "read-only" }] as const) {
    const f = fakes();
    const held = heldSaves("held");
    const wiring = wireApp({ ...f.deps, saves: held.saves, destinations: held.destinations });
    const active = requestSave({ kind: "save" });
    wiring.dispose();
    held.calls.length = 0;
    must(held.finish[0])(result);
    assert.deepEqual(await settled(active), result, result.kind);
    assert.deepEqual(held.calls, [], result.kind + ": nothing after dispose reaches the old ports");
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

function labelOf(target: EventTarget): string {
  if (target === window) return "window";
  if (target === document) return "document";
  const element = target as Element;
  if (element.id) return "#" + element.id;
  if (element.tagName) return element.tagName.toLowerCase() + (typeof element.className === "string" && element.className.trim() ? "." + element.className.trim().split(/\s+/).join(".") : "");
  return target.constructor.name;
}

function survivorNames(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [target, set] of listeners) {
    for (const key of set) {
      const name = labelOf(target) + " " + key.split("/").slice(0, 2).join("/");
      out[name] = (out[name] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
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
  await startupReady();
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
    await startupReady();
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

const SURVIVING_GLOBAL_LISTENERS: Record<string, number> = {
  "document beforecopy/C": 1, "document beforecut/C": 1, "document click/B": 1, "document contextmenu/B": 1, "document copy/C": 1,
  "document cut/C": 1, "document dragend/B": 1, "document dragover/B": 1, "document dragstart/C": 1, "document drop/B": 1, "document focusin/B": 1,
  "document input/C": 1, "document keydown/C": 3, "document mousedown/B": 1, "document mousedown/C": 2, "document mousemove/B": 1,
  "document mouseup/B": 1, "document paste/C": 1, "document securitypolicyviolation/B": 1, "document selectionchange/B": 4,
  "document splitpage:pref/B": 4, "document undo-owner-cleared/B": 1, "document visibilitychange/B": 3, "window beforeinput/C": 1,
  "window blur/B": 2, "window click/C": 3, "window compositionstart/C": 1, "window cut/C": 1, "window dragstart/C": 1, "window drop/C": 1,
  "window focus/C": 2, "window focusin/C": 3, "window hashchange/B": 1, "window input/C": 1, "window keydown/B": 3, "window keydown/C": 8,
  "window keyup/C": 2, "window mousedown/C": 3, "window mouseout/C": 2, "window mouseover/C": 2, "window mouseup/C": 2, "window pagehide/B": 2,
  "window pageshow/B": 1, "window paste/C": 1, "window pointerdown/C": 1, "window pointerup/C": 1, "window resize/B": 6,
  "window scroll/C": 2, "window storage/B": 2, "window touchmove/B": 1, "window wheel/B": 1
};

function globalOnly(names: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(names).filter(([name]) => /^(?:window|document) /.test(name)));
}

test("cleanup: the app-lifetime registrations that survive a stop are the ones made by the initializers, which run once", async () => {
  const app = await import("../../src/bootstrap/app.ts");
  const wiring = await wireReal();
  app.startApp(wiring);
  await startupReady();
  app.stopApp();
  const survivors = survivorNames();
  assert.deepEqual(globalOnly(survivors), SURVIVING_GLOBAL_LISTENERS, "the window and document listeners the initializers registered, by event, stay");
  assert.ok(Object.keys(survivors).length > Object.keys(SURVIVING_GLOBAL_LISTENERS).length, "the initializers' element listeners stay too");
  let replaced = 0;
  onDocumentReplaced(() => { replaced++; });
  const again = await wireReal();
  app.startApp(again);
  await startupReady();
  const { NO_DESTINATION } = await import("../../src/legacy/transition-bridge.ts");
  documentTransitions().startNew({ from: { document: migrateRows({ title: "Fresh", rows: [] }) }, reason: "test: a new script", destination: NO_DESTINATION });
  assert.ok(replaced > 0, "document-replaced listeners registered on the bridge survive a rewire");
  app.stopApp();
  assert.deepEqual(survivorNames(), survivors, "a second start and stop leaves exactly the same named listeners");
});

interface OnboardingReport {
  readonly arrival: string;
  readonly error: string | null;
  readonly booted: boolean;
  readonly seedCheck: boolean | null;
  readonly desktop: boolean;
  readonly opened: boolean;
}

async function bootFresh(arrival: string): Promise<OnboardingReport> {
  const probe = fileURLToPath(new URL("../../src/test/_onboarding-probe.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [probe, arrival], { cwd: fileURLToPath(new URL("../../", import.meta.url)), maxBuffer: 1 << 24 });
  return JSON.parse(stdout.trim().split("\n").pop() ?? "") as OnboardingReport;
}

test("INV-30: through the shim's real wiring, initializers and startup, the wizard opens over a pristine copy and stays shut when a document arrives by file, link or restore", { timeout: 120_000 }, async () => {
  const arrivals = ["pristine", "file", "link", "desktop pristine", "restore"];
  const reports = await Promise.all(arrivals.map(bootFresh));
  for (const report of reports) {
    assert.equal(report.error, null, report.arrival + ": the app booted");
    assert.equal(report.booted, true, report.arrival + ": the onboarding initializer ran");
    assert.equal(report.seedCheck, true, report.arrival + ": the seed check passes, so only the arrival can keep the wizard shut");
  }
  assert.deepEqual(reports.map((r) => [r.arrival, r.desktop, r.opened]), [
    ["pristine", false, true],
    ["file", false, false],
    ["link", false, false],
    ["desktop pristine", true, true],
    ["restore", true, false]
  ], "the pristine copies are the positive controls: the same boot path opens the wizard when nothing arrives");
});

interface InitialLoadReport {
  readonly pristine: boolean;
  readonly error: string | null;
  readonly seedCheck: boolean | null;
  readonly title: string | null;
  readonly docIdIsTheFiles: boolean;
  readonly writtenOut: boolean;
}

async function loadFresh(kind: "pristine" | "saved"): Promise<InitialLoadReport> {
  const probe = fileURLToPath(new URL("../../src/test/_initial-load-probe.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [probe, kind], { cwd: fileURLToPath(new URL("../../", import.meta.url)), maxBuffer: 1 << 24 });
  return JSON.parse(stdout.trim().split("\n").pop() ?? "") as InitialLoadReport;
}

test("the booted app's initial load gets the seed check through its port: a pristine copy of a saved page is a fresh document, the same page without the check opens as its file", { timeout: 120_000 }, async () => {
  const [pristine, saved] = await Promise.all([loadFresh("pristine"), loadFresh("saved")]);
  for (const report of [pristine, saved]) {
    assert.equal(report.error, null);
    assert.equal(report.title, "Saved", "both pages carry the same saved script");
  }
  assert.deepEqual([pristine.seedCheck, pristine.docIdIsTheFiles, pristine.writtenOut], [true, false, false], "a pristine copy is not the file it came from");
  assert.deepEqual([saved.seedCheck, saved.docIdIsTheFiles, saved.writtenOut], [false, true, true], "a saved page opens as its file");
});
