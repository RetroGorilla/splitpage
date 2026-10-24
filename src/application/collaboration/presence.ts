import { paletteColor, personKey, resolvePersonColor } from "../../core/document/person-colors.ts";

export const PRESENCE_MAX_SHOWN = 8;

export interface PresentPerson {
  readonly id?: string;
  readonly name?: string;
  readonly color?: string;
  readonly rowId?: string;
  readonly field?: string;
}

export interface PresencePerson {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly rowId: string;
  readonly field: string;
}

export interface PresenceView {
  readonly shown: () => readonly PresencePerson[];
}

export interface PresencePorts {
  readonly selfName: () => string;
  readonly selfColor: () => string;
  readonly documentColors: () => unknown;
}

export interface Presence extends PresenceView {
  readonly here: () => readonly PresentPerson[];
  readonly nameOf: (person: PresentPerson | null | undefined) => string;
  readonly colorOf: (person: PresentPerson | null | undefined) => string;
  readonly personColor: (seed: unknown) => string;
  readonly apply: (list: readonly PresentPerson[] | null | undefined) => void;
  readonly onChange: (listener: () => void) => () => void;
  readonly onRecolor: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

function listenerList(): { add: (listener: () => void) => () => void; tell: () => void; clear: () => void } {
  const listeners: (() => void)[] = [];
  return {
    add: function (listener) {
      listeners.push(listener);
      return function () {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
    tell: function () { listeners.slice().forEach(function (listener) { listener(); }); },
    clear: function () { listeners.length = 0; }
  };
}

export function createPresence(ports: PresencePorts): Presence {
  let here: readonly PresentPerson[] = [];
  let liveColors: Record<string, string> = {};
  const changes = listenerList();
  const recolors = listenerList();

  function nameOf(person: PresentPerson | null | undefined): string {
    return (person && person.name) || "Guest";
  }

  function seedOf(person: PresentPerson | null | undefined): string {
    return (person && person.name) || (person && person.id) || "";
  }

  function personColor(seed: unknown): string {
    const doc = ports.documentColors();
    return resolvePersonColor(seed, {
      self: ports.selfName(),
      selfColor: ports.selfColor(),
      live: liveColors,
      doc: doc && typeof doc === "object" ? doc as Readonly<Record<string, unknown>> : null
    });
  }

  function colorOf(person: PresentPerson | null | undefined): string {
    return paletteColor(person && person.color) || personColor(seedOf(person));
  }

  function noteLiveColors(list: readonly PresentPerson[]): boolean {
    const next: Record<string, string> = {};
    list.forEach(function (person) {
      const color = paletteColor(person && person.color);
      const key = personKey(person && person.name);
      if (color && key) next[key] = color;
    });
    const changed = JSON.stringify(next) !== JSON.stringify(liveColors);
    liveColors = next;
    return changed;
  }

  return Object.freeze({
    here: function (): readonly PresentPerson[] { return here; },
    shown: function (): readonly PresencePerson[] {
      return here.slice(0, PRESENCE_MAX_SHOWN).map(function (person) {
        return {
          id: String((person && person.id) || seedOf(person)),
          name: nameOf(person),
          color: colorOf(person),
          rowId: (person && person.rowId) || "",
          field: (person && person.field) || ""
        };
      });
    },
    nameOf: nameOf,
    colorOf: colorOf,
    personColor: personColor,
    apply: function (list: readonly PresentPerson[] | null | undefined): void {
      here = list || [];
      const recolored = noteLiveColors(here);
      changes.tell();
      if (recolored) recolors.tell();
    },
    onChange: changes.add,
    onRecolor: recolors.add,
    dispose: function (): void {
      here = [];
      liveColors = {};
      changes.clear();
      recolors.clear();
    }
  });
}
