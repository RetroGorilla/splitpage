import type { ActionRegistry } from "../application/actions.ts";
import { createExportRegistry } from "../application/export/registry.ts";
import type { ExportRegistry } from "../application/export/registry.ts";
import type { DocumentSession } from "../application/session/document-session.ts";
import type { DocumentEntry, ReportPort, TimerPort } from "../application/session/ports.ts";
import type { SaveOwnershipPort } from "../application/save/coordinator.ts";
import { createAppActions, installAppActions } from "../legacy/app-actions.ts";
import { installExportFormats } from "../legacy/export-formats.ts";
import { startRecovery } from "../legacy/recovery-bridge.ts";
import type { LegacyRecoveryPorts } from "../legacy/recovery-bridge.ts";
import { startSaves } from "../legacy/save-bridge.ts";
import type { LegacySavePorts } from "../legacy/save-bridge.ts";
import { liveSession, providedSessionEffects, startSessionBridge, unprovidedSessionEffects } from "../legacy/session-bridge.ts";
import type { SessionBridgePorts, SessionUndoPorts } from "../legacy/session-bridge.ts";
import { captureOperation, startTransitions, stillOwns } from "../legacy/transition-bridge.ts";
import type { LegacyTransitionPorts } from "../legacy/transition-bridge.ts";
import { createUndoAdapter, routeReplays, watchUndoAdoption } from "../legacy/undo-adapter.ts";

export interface WiringDeps {
  readonly entry: DocumentEntry;
  readonly exporters: (registry: ExportRegistry) => () => void;
  readonly saves: (ownership: SaveOwnershipPort) => LegacySavePorts;
  readonly transitions: LegacyTransitionPorts;
  readonly recovery: () => LegacyRecoveryPorts;
  readonly keyTarget: EventTarget;
  readonly actions?: (() => ActionRegistry) | undefined;
  readonly undo?: SessionUndoPorts | undefined;
  readonly timers?: TimerPort | undefined;
  readonly report?: ReportPort | undefined;
}

export interface Wiring {
  readonly actions: ActionRegistry;
  readonly exports: ExportRegistry;
  readonly session: DocumentSession;
  readonly keyTarget: EventTarget;
  readonly dispose: () => void;
}

export class WiringError extends Error {
  readonly step: string;

  constructor(step: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WiringError";
    this.step = step;
  }
}

export const WIRING_STEPS = Object.freeze([
  "action registry",
  "export registry",
  "built-in exporters",
  "session",
  "saves",
  "transitions",
  "recovery"
] as const);

export type WiringStep = (typeof WIRING_STEPS)[number];

const REQUIRED: readonly (readonly [keyof WiringDeps, "function" | "object"])[] = [
  ["entry", "function"],
  ["exporters", "function"],
  ["saves", "function"],
  ["transitions", "object"],
  ["recovery", "function"],
  ["keyTarget", "object"]
];

const OPTIONAL: readonly (readonly [keyof WiringDeps, "function" | "object"])[] = [
  ["actions", "function"],
  ["undo", "object"],
  ["timers", "object"],
  ["report", "function"]
];

const TRANSITION_PORTS: readonly (keyof LegacyTransitionPorts)[] = ["live", "destination", "identity"];

const UNDO_PORTS: readonly (keyof SessionUndoPorts)[] = ["adapter", "route", "watch"];

function present(value: unknown, kind: "function" | "object"): boolean {
  return value !== null && typeof value === kind;
}

function validate(deps: WiringDeps | null | undefined): void {
  if (!deps || typeof deps !== "object") throw new WiringError("dependencies", "Wiring: no dependencies were passed");
  for (const [name, kind] of REQUIRED) {
    if (!present(deps[name], kind)) throw new WiringError(name, "Wiring: the " + name + " dependency is missing");
  }
  for (const [name, kind] of OPTIONAL) {
    if (deps[name] !== undefined && !present(deps[name], kind)) throw new WiringError(name, "Wiring: the " + name + " dependency is not a " + kind);
  }
  for (const port of TRANSITION_PORTS) {
    if (!present(deps.transitions[port], "object")) throw new WiringError("transitions", "Wiring: the transitions dependency has no " + port + " port");
  }
  if (deps.undo) {
    for (const port of UNDO_PORTS) {
      if (!present(deps.undo[port], port === "adapter" ? "object" : "function")) throw new WiringError("undo", "Wiring: the undo dependency has no " + port + " port");
    }
  }
  const unprovided = unprovidedSessionEffects();
  if (unprovided.length) throw new WiringError("session effects", "Wiring: the session's " + unprovided.join(", ") + " not provided before wiring");
}

const SYSTEM_TIMERS: TimerPort = Object.freeze({
  now: function () { return Date.now(); },
  start: function (run: () => void, ms: number) { return setTimeout(run, ms); },
  stop: function (handle: unknown) { clearTimeout(handle as number); }
});

const LEGACY_UNDO: Omit<SessionUndoPorts, "adapter"> = Object.freeze({ route: routeReplays, watch: watchUndoAdoption });

function reportError(error: unknown): void {
  console.error(error);
}

export function legacySessionPorts(deps: Pick<WiringDeps, "entry" | "undo" | "timers" | "report">): SessionBridgePorts {
  return Object.freeze({
    entry: function (raw: unknown) { return deps.entry(raw); },
    undo: deps.undo ?? Object.freeze({ adapter: createUndoAdapter(), ...LEGACY_UNDO }),
    ...providedSessionEffects(),
    report: deps.report ?? reportError,
    timers: deps.timers ?? SYSTEM_TIMERS
  });
}

function drain(disposers: (() => void)[]): unknown[] {
  const failures: unknown[] = [];
  while (disposers.length) {
    try {
      disposers.pop()?.();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export function wireApp(deps: WiringDeps): Wiring {
  validate(deps);
  const disposers: (() => void)[] = [];
  const build = <T>(step: WiringStep, construct: () => T, release: (built: T) => () => void): T => {
    try {
      const built = construct();
      disposers.push(release(built));
      return built;
    } catch (error) {
      const failures = drain(disposers);
      const message = "Wiring: the " + step + " step failed" + (failures.length ? ", and undoing the steps before it also failed" : "");
      throw new WiringError(step, message, failures.length ? new AggregateError([error, ...failures], message) : error);
    }
  };
  const actions = build("action registry", deps.actions ?? createAppActions, installAppActions);
  const exports = build("export registry", () => createExportRegistry(), installExportFormats);
  build("built-in exporters", () => deps.exporters(exports), (drop) => drop);
  build("session", () => startSessionBridge(legacySessionPorts(deps)), (stop) => stop);
  build("saves", () => startSaves(deps.saves({ capture: captureOperation, stillOwns: stillOwns })), (stop) => stop);
  build("transitions", () => startTransitions(deps.transitions), (stop) => stop);
  build("recovery", () => startRecovery(deps.recovery()), (stop) => stop);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const failures = drain(disposers);
    if (failures.length) throw new AggregateError(failures, failures.length + " of the wiring's release steps failed; the rest still ran");
  };
  return Object.freeze({ actions: actions, exports: exports, session: liveSession(), keyTarget: deps.keyTarget, dispose: dispose });
}
