import { wireProductionIndex } from "./wiring/production-index.ts";
export { mountScriptZoomFeature } from "./wiring/script-zoom.ts";
import type { BulkTagPorts } from "../application/commands/bulk-tags.ts";
import { registerBuiltInExporters } from "./wiring/exporters.ts";
import { wireProductionEditing } from "./wiring/production-editing.ts";
import type { ActionRegistry } from "../application/actions.ts";
import { createExportRegistry } from "../application/export/registry.ts";
import type { ExportRegistry } from "../application/export/registry.ts";
import { installExportServices } from "../application/export/services.ts";
import { installProjectFileServices } from "../application/formats/project-file-services.ts";
import type { ProjectFileServices } from "../application/formats/project-file-services.ts";
import type { DocumentSession, DocumentView, Plan } from "../application/session/document-session.ts";
import type { ChangeSet, SessionChange } from "../application/session/change-set.ts";
import type { ValidatedDocument } from "../core/document/validated.ts";
import type { Capability, DocumentEntry, ReportPort, TimerPort, UndoPort } from "../application/session/ports.ts";
import type { SaveOwnershipPort } from "../application/save/coordinator.ts";
import { startPageEffects } from "./effects.ts";
import { legacyExportServices } from "./export-services.ts";
import { createAppActions, installAppActions } from "../legacy/app-actions.ts";
import { installExportFormats } from "../legacy/export-formats.ts";
import { startEditor } from "../legacy/editor-bridge.ts";
import { startLocation } from "../legacy/location-bridge.ts";
import { startPreferences } from "../legacy/preferences-bridge.ts";
import { legacyShotHidingPorts, startShotHiding } from "../legacy/shot-hiding-bridge.ts";
import { startRecovery } from "../legacy/recovery-bridge.ts";
import type { LegacyRecoveryPorts } from "../legacy/recovery-bridge.ts";
import { saveDestinations, startSaves } from "../legacy/save-bridge.ts";
import type { LegacyAutoSavePorts, LegacySaveDestination, LegacySavePorts } from "../legacy/save-bridge.ts";
import { liveDocumentPort, liveSession, startSessionBridge } from "../legacy/session-bridge.ts";
import type { RecordsReconciler, SessionBridgePorts, SessionUndoPorts } from "../legacy/session-bridge.ts";
import { captureOperation, documentSources, startTransitions, stillOwns } from "../legacy/transition-bridge.ts";
import type { LegacyDocumentSource, LegacyTransitionPorts } from "../legacy/transition-bridge.ts";
import { createUndoAdapter, routeReplays } from "../legacy/undo-adapter.ts";

export interface SessionEffects {
  readonly dirty: (change: SessionChange) => void;
  readonly draft: (change: SessionChange) => void;
  readonly save: (change: SessionChange) => void;
  readonly edit: () => Capability;
  readonly attribute: (doc: DocumentView) => Plan | null;
}

export interface WiringDeps {
  readonly entry: DocumentEntry;
  readonly effects: SessionEffects;
  readonly editorName: () => string;
  readonly refresh: (jobs: ReadonlySet<string>) => void;
  readonly records: RecordsReconciler;
  readonly bulkTags: BulkTagPorts;
  readonly saves: (ownership: SaveOwnershipPort) => LegacySavePorts;
  readonly destinations: () => readonly LegacySaveDestination[];
  readonly transitions: TransitionDeps;
  readonly sources: () => readonly LegacyDocumentSource[];
  readonly recovery: () => LegacyRecoveryPorts;
  readonly projectFiles: () => ProjectFileServices;
  readonly keyTarget: EventTarget;
  readonly actions?: (() => ActionRegistry) | undefined;
  readonly exporters?: ((registry: ExportRegistry) => () => void) | undefined;
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
  "location",
  "page effects",
  "action registry",
  "export services",
  "project file services",
  "export registry",
  "built-in exporters",
  "session",
  "saves",
  "save destinations",
  "transitions",
  "document sources",
  "recovery",
  "editor",
  "production editing",
  "preferences",
  "shot hiding"
] as const);

export type WiringStep = (typeof WIRING_STEPS)[number];

const REQUIRED: readonly (readonly [keyof WiringDeps, "function" | "object"])[] = [
  ["entry", "function"],
  ["effects", "object"],
  ["editorName", "function"],
  ["refresh", "function"],
  ["records", "function"],
  ["saves", "function"],
  ["destinations", "function"],
  ["transitions", "object"],
  ["sources", "function"],
  ["recovery", "function"],
  ["projectFiles", "function"],
  ["keyTarget", "object"]
];

const OPTIONAL: readonly (readonly [keyof WiringDeps, "function" | "object"])[] = [
  ["actions", "function"],
  ["exporters", "function"],
  ["undo", "object"],
  ["timers", "object"],
  ["report", "function"]
];

export type TransitionDeps = Omit<LegacyTransitionPorts, "live">;

const TRANSITION_PORTS: { readonly [P in keyof TransitionDeps]: readonly (keyof TransitionDeps[P])[] } = {
  destination: ["set", "confirm"],
  identity: ["mint", "writtenOut", "markWrittenOut"],
  history: ["keep"]
};

const SAVE_PORTS: readonly (keyof Omit<LegacySavePorts, "ownership" | "autosave">)[] = ["destination", "keyOf", "obsolete"];

const OWNERSHIP_PORTS: readonly (keyof SaveOwnershipPort)[] = ["capture", "stillOwns"];

const AUTOSAVE_PORTS: readonly (keyof LegacyAutoSavePorts)[] = ["enabledAtStart", "changed"];

const UNDO_PORTS: readonly (keyof SessionUndoPorts)[] = ["adapter", "route"];

const SESSION_EFFECTS: readonly (keyof SessionEffects)[] = ["dirty", "draft", "save", "edit", "attribute"];

const TIMER_METHODS: readonly (keyof TimerPort)[] = ["now", "start", "stop"];

const UNDO_ADAPTER_METHODS: readonly (keyof UndoPort)[] = ["adopt", "record", "absorbServer", "absorbReload"];

const KEY_TARGET_METHODS: readonly (keyof EventTarget)[] = ["addEventListener", "removeEventListener"];

const ACTION_REGISTRY_METHODS: readonly (keyof ActionRegistry)[] = ["register", "has", "shortcuts", "view", "list", "invoke", "presentRefusals"];

const RECOVERY_METHODS: readonly (keyof LegacyRecoveryPorts)[] = ["now", "desktop", "sessionStorage", "localStorage", "internImage", "merge"];

function present(value: unknown, kind: "function" | "object"): boolean {
  return value !== null && typeof value === kind;
}

function lacking(given: unknown, methods: readonly string[]): string | null {
  for (const method of methods) {
    if (!present((given as Record<string, unknown>)[method], "function")) return method;
  }
  return null;
}

function checkedActions(registry: ActionRegistry | null | undefined): ActionRegistry {
  if (!present(registry, "object")) throw new WiringError("action registry", "Wiring: the actions dependency returned no action registry");
  const missing = lacking(registry, ACTION_REGISTRY_METHODS);
  if (missing) throw new WiringError("action registry", "Wiring: the action registry has no " + missing + " function");
  return registry as ActionRegistry;
}

function checkedExporters(drop: (() => void) | null | undefined): () => void {
  if (!present(drop, "function")) throw new WiringError("built-in exporters", "Wiring: the exporters dependency returned no function to remove them");
  return drop as () => void;
}

function checkedDestinations(list: readonly LegacySaveDestination[] | null | undefined): readonly LegacySaveDestination[] {
  if (!Array.isArray(list)) throw new WiringError("save destinations", "Wiring: the destinations dependency returned no list of destinations");
  return list as readonly LegacySaveDestination[];
}

function checkedSources(list: readonly LegacyDocumentSource[] | null | undefined): readonly LegacyDocumentSource[] {
  if (!Array.isArray(list)) throw new WiringError("document sources", "Wiring: the sources dependency returned no list of sources");
  return list as readonly LegacyDocumentSource[];
}

function registerSources(list: readonly LegacyDocumentSource[]): () => void {
  const registry = documentSources();
  const drops: (() => void)[] = [];
  try {
    for (const source of list) drops.push(registry.register(source));
  } catch (error) {
    drain(drops);
    throw error;
  }
  return () => { drain(drops); };
}

function registerDestinations(list: readonly LegacySaveDestination[]): () => void {
  const registry = saveDestinations();
  const drops: (() => void)[] = [];
  try {
    for (const destination of list) drops.push(registry.register(destination));
  } catch (error) {
    drain(drops);
    throw error;
  }
  return () => { drain(drops); };
}

function checkedRecovery(ports: LegacyRecoveryPorts | null | undefined): LegacyRecoveryPorts {
  if (!ports || !present(ports, "object")) throw new WiringError("recovery", "Wiring: the recovery dependency returned no recovery ports");
  const missing = lacking(ports, RECOVERY_METHODS);
  if (missing) throw new WiringError("recovery", "Wiring: the recovery dependency returned no " + missing + " function");
  return ports;
}

function checkedSaves(ports: LegacySavePorts | null | undefined): LegacySavePorts {
  if (!present(ports, "object")) throw new WiringError("saves", "Wiring: the saves dependency returned no save ports");
  const given = ports as unknown as Record<string, unknown>;
  for (const port of SAVE_PORTS) {
    if (!present(given[port], "function")) throw new WiringError("saves", "Wiring: the saves dependency returned no " + port + " port");
  }
  const ownership = given["ownership"];
  if (!present(ownership, "object")) throw new WiringError("saves", "Wiring: the saves dependency returned no ownership port");
  for (const method of OWNERSHIP_PORTS) {
    if (!present((ownership as Record<string, unknown>)[method], "function")) {
      throw new WiringError("saves", "Wiring: the saves dependency's ownership port has no " + method + " function");
    }
  }
  const autosave = given["autosave"];
  if (!present(autosave, "object")) throw new WiringError("saves", "Wiring: the saves dependency returned no autosave port");
  const missingAutoSave = lacking(autosave, AUTOSAVE_PORTS);
  if (missingAutoSave) throw new WiringError("saves", "Wiring: the saves dependency's autosave port has no " + missingAutoSave + " function");
  return ports as LegacySavePorts;
}

function validate(deps: WiringDeps | null | undefined): void {
  if (!deps || typeof deps !== "object") throw new WiringError("dependencies", "Wiring: no dependencies were passed");
  for (const [name, kind] of REQUIRED) {
    if (!present(deps[name], kind)) throw new WiringError(name, "Wiring: the " + name + " dependency is missing");
  }
  for (const [name, kind] of OPTIONAL) {
    if (deps[name] !== undefined && !present(deps[name], kind)) throw new WiringError(name, "Wiring: the " + name + " dependency is not a " + kind);
  }
  for (const effect of SESSION_EFFECTS) {
    if (!present(deps.effects[effect], "function")) throw new WiringError("effects", "Wiring: the effects dependency has no " + effect + " effect");
  }
  for (const [port, methods] of Object.entries(TRANSITION_PORTS) as [keyof TransitionDeps, readonly string[]][]) {
    const given: unknown = deps.transitions[port];
    if (!present(given, "object")) throw new WiringError("transitions", "Wiring: the transitions dependency has no " + port + " port");
    for (const method of methods) {
      if (!present((given as Record<string, unknown>)[method], "function")) {
        throw new WiringError("transitions", "Wiring: the transitions dependency's " + port + " port has no " + method + " function");
      }
    }
  }
  if (deps.undo) {
    for (const port of UNDO_PORTS) {
      if (!present(deps.undo[port], port === "adapter" ? "object" : "function")) throw new WiringError("undo", "Wiring: the undo dependency has no " + port + " port");
    }
    const missing = lacking(deps.undo.adapter, UNDO_ADAPTER_METHODS);
    if (missing) throw new WiringError("undo", "Wiring: the undo dependency's adapter port has no " + missing + " function");
  }
  if (deps.timers) {
    const missing = lacking(deps.timers, TIMER_METHODS);
    if (missing) throw new WiringError("timers", "Wiring: the timers dependency has no " + missing + " function");
  }
  const missingKey = lacking(deps.keyTarget, KEY_TARGET_METHODS);
  if (missingKey) throw new WiringError("keyTarget", "Wiring: the keyTarget dependency has no " + missingKey + " function");
}

const SYSTEM_TIMERS: TimerPort = Object.freeze({
  now: function () { return Date.now(); },
  start: function (run: () => void, ms: number) { return setTimeout(run, ms); },
  stop: function (handle: unknown) { clearTimeout(handle as number); }
});

const LEGACY_UNDO: Omit<SessionUndoPorts, "adapter"> = Object.freeze({ route: routeReplays });

function reportError(error: unknown): void {
  console.error(error);
}

export type SessionPortDeps = Pick<WiringDeps, "entry" | "effects" | "editorName" | "refresh" | "records" | "undo" | "timers" | "report">;

export function legacySessionPorts(deps: SessionPortDeps): SessionBridgePorts {
  const effects = deps.effects;
  return Object.freeze({
    entry: function (raw: unknown) { return deps.entry(raw); },
    undo: deps.undo ?? Object.freeze({ adapter: createUndoAdapter(), ...LEGACY_UNDO }),
    effects: Object.freeze({
      dirty: function (change: SessionChange) { effects.dirty(change); },
      draft: function (change: SessionChange) { effects.draft(change); },
      save: function (change: SessionChange) { effects.save(change); },
      refresh: function (jobs: ReadonlySet<string>) { deps.refresh(jobs); }
    }),
    capability: Object.freeze({ edit: function () { return effects.edit(); } }),
    editor: Object.freeze({ name: function () { return deps.editorName(); } }),
    records: function (doc: ValidatedDocument, changes: ChangeSet) { return deps.records(doc, changes); },
    attribution: Object.freeze({ attribute: function (doc: DocumentView) { return effects.attribute(doc); } }),
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
  build("location", () => startLocation(), (stop) => stop);
  build("page effects", () => startPageEffects(window), (stop) => stop);
  const actions = build("action registry", () => checkedActions((deps.actions ?? createAppActions)()), installAppActions);
  build("export services", () => legacyExportServices(), installExportServices);
  build("project file services", () => deps.projectFiles(), installProjectFileServices);
  const exports = build("export registry", () => createExportRegistry(), installExportFormats);
  build("built-in exporters", () => checkedExporters((deps.exporters ?? registerBuiltInExporters)(exports)), (drop) => drop);
  build("session", () => {
    const stopIndex = wireProductionIndex(deps.bulkTags);
    try {
      const stopSession = startSessionBridge(legacySessionPorts(deps));
      return () => {
        try { stopSession(); } finally { stopIndex(); }
      };
    } catch (error) {
      stopIndex();
      throw error;
    }
  }, (stop) => stop);
  build("saves", () => startSaves(checkedSaves(deps.saves({ capture: captureOperation, stillOwns: stillOwns })), deps.timers ?? SYSTEM_TIMERS), (stop) => stop);
  build("save destinations", () => registerDestinations(checkedDestinations(deps.destinations())), (drop) => drop);
  build("transitions", () => startTransitions({ ...deps.transitions, live: liveDocumentPort }), (stop) => stop);
  build("document sources", () => registerSources(checkedSources(deps.sources())), (drop) => drop);
  build("recovery", () => startRecovery(checkedRecovery(deps.recovery())), (stop) => stop);
  build("editor", () => startEditor(liveDocumentPort), (stop) => stop);
  build("production editing", () => wireProductionEditing(deps.timers ?? SYSTEM_TIMERS), (stop) => stop);
  build("preferences", () => startPreferences(), (stop) => stop);
  build("shot hiding", () => startShotHiding(legacyShotHidingPorts(deps.timers ?? SYSTEM_TIMERS)), (stop) => stop);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const failures = drain(disposers);
    if (failures.length) throw new AggregateError(failures, failures.length + " of the wiring's release steps failed; the rest still ran");
  };
  return Object.freeze({ actions: actions, exports: exports, session: liveSession(), keyTarget: deps.keyTarget, dispose: dispose });
}
