import { chordKey } from "./shortcuts.ts";
import type { KeyedAction } from "./shortcuts.ts";

export type { KeyedAction } from "./shortcuts.ts";

export type ActionSource = "menu" | "command-menu" | "shortcut" | "button" | "native-menu";

export interface Availability {
  readonly enabled: boolean;
  readonly reason?: string;
  readonly checked?: boolean;
  readonly visible?: boolean;
}

export interface ActionDefinition {
  readonly id: string;
  readonly label: string | (() => string);
  readonly group: string;
  readonly icon?: string;
  readonly keys?: readonly string[] | (() => readonly string[]);
  readonly bindKeys?: () => boolean;
  readonly claimKeys?: boolean;
  readonly words?: string;
  readonly availability?: () => Availability;
  readonly run: (source: ActionSource) => void;
}

export interface ActionView {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly icon: string;
  readonly keys: readonly string[];
  readonly words: string;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly reason: string;
  readonly checked: boolean | null;
}

export type InvokeOutcome =
  | { readonly kind: "ran"; readonly id: string }
  | { readonly kind: "unavailable"; readonly id: string; readonly reason: string }
  | { readonly kind: "unknown"; readonly id: string }
  | { readonly kind: "failed"; readonly id: string; readonly error: unknown };

export interface ActionRegistry {
  register(definition: ActionDefinition): () => void;
  has(id: string): boolean;
  shortcuts(): readonly KeyedAction[];
  view(id: string): ActionView | undefined;
  list(): readonly ActionView[];
  invoke(id: string, source: ActionSource): InvokeOutcome;
}

export interface RegistryOptions {
  readonly report?: (error: unknown, id: string) => void;
}

const ALWAYS: Availability = { enabled: true };

function availabilityOf(definition: ActionDefinition): Availability {
  return definition.availability ? definition.availability() : ALWAYS;
}

function keysOf(definition: ActionDefinition): readonly string[] {
  const keys = definition.keys;
  if (keys === undefined) return [];
  return typeof keys === "function" ? keys() : keys;
}

function toView(definition: ActionDefinition): ActionView {
  const a = availabilityOf(definition);
  const visible = a.visible !== false;
  return {
    id: definition.id,
    label: typeof definition.label === "function" ? definition.label() : definition.label,
    group: definition.group,
    icon: definition.icon ?? "",
    keys: keysOf(definition),
    words: definition.words ?? "",
    enabled: a.enabled,
    visible,
    reason: a.enabled ? "" : a.reason ?? "",
    checked: a.checked ?? null
  };
}

function claimChords(definitions: ReadonlyMap<string, ActionDefinition>, definition: ActionDefinition): void {
  const owners = new Map<string, string>();
  for (const other of definitions.values()) {
    for (const k of keysOf(other)) owners.set(chordKey(k), other.id);
  }
  for (const k of keysOf(definition)) {
    const chord = chordKey(k);
    const owner = owners.get(chord);
    if (owner !== undefined) throw new Error(`shortcut ${chord} is already bound to ${owner}`);
    owners.set(chord, definition.id);
  }
}

export function createActionRegistry(options: RegistryOptions = {}): ActionRegistry {
  const definitions = new Map<string, ActionDefinition>();

  return {
    register(definition) {
      if (definitions.has(definition.id)) throw new Error(`action ${definition.id} is already registered`);
      claimChords(definitions, definition);
      definitions.set(definition.id, definition);
      return () => {
        if (definitions.get(definition.id) === definition) definitions.delete(definition.id);
      };
    },
    has(id) {
      return definitions.has(id);
    },
    shortcuts() {
      return [...definitions.values()]
        .filter((d) => d.bindKeys ? d.bindKeys() : true)
        .map((d) => ({ id: d.id, keys: keysOf(d), claim: d.claimKeys === true }))
        .filter((k) => k.keys.length > 0);
    },
    view(id) {
      const definition = definitions.get(id);
      return definition ? toView(definition) : undefined;
    },
    list() {
      return [...definitions.values()].map(toView);
    },
    invoke(id, source) {
      const definition = definitions.get(id);
      if (!definition) return { kind: "unknown", id };
      const a = availabilityOf(definition);
      if (!a.enabled) return { kind: "unavailable", id, reason: a.reason ?? "" };
      try {
        definition.run(source);
        return { kind: "ran", id };
      } catch (error) {
        options.report?.(error, id);
        return { kind: "failed", id, error };
      }
    }
  };
}
