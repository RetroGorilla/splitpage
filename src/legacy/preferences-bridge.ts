import { createPanelWidths } from "../application/preferences/panel-widths.ts";
import type { PanelWidths } from "../application/preferences/panel-widths.ts";
import { createPreferences } from "../application/preferences/preferences.ts";
import type { PreferenceChange, Preferences } from "../application/preferences/preferences.ts";
import { createViewFlags } from "../application/preferences/view-flags.ts";
import type { ViewFlags } from "../application/preferences/view-flags.ts";
import type { KeyValueStorage } from "../application/recovery/conflict-stash.ts";

export const PREF_EVENT = "splitpage:pref";

export interface LegacyPreferencePorts {
  readonly storage: () => KeyValueStorage | null | undefined;
  readonly announce: (change: PreferenceChange) => void;
  readonly watch: (heard: (change: PreferenceChange) => void) => () => void;
}

interface Started {
  readonly preferences: Preferences;
  readonly flags: ViewFlags;
  readonly panels: PanelWidths;
}

let started: Started | null = null;

const changeListeners: ((change: PreferenceChange) => void)[] = [];

export function onPreferenceChange(listener: (change: PreferenceChange) => void): () => void {
  changeListeners.push(listener);
  return function () {
    const at = changeListeners.indexOf(listener);
    if (at !== -1) changeListeners.splice(at, 1);
  };
}

function tellListeners(change: PreferenceChange): void {
  changeListeners.slice().forEach(function (listener) { listener(change); });
}

function running(): Started {
  if (!started) throw new Error("The preferences are not started yet");
  return started;
}

export function browserPreferencePorts(): LegacyPreferencePorts {
  return {
    storage: function () {
      try { return window.localStorage; } catch (e) { return null; }
    },
    announce: function (change) {
      document.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: change.key, value: change.value } }));
    },
    watch: function (heard) {
      function announced(e: Event): void {
        const detail = (e as CustomEvent<Partial<PreferenceChange> | null>).detail;
        if (detail && typeof detail.key === "string") heard({ key: detail.key, value: detail.value ?? null });
      }
      function stored(e: StorageEvent): void {
        if (e.key !== null) heard({ key: e.key, value: e.newValue });
      }
      document.addEventListener(PREF_EVENT, announced);
      window.addEventListener("storage", stored);
      return function () {
        document.removeEventListener(PREF_EVENT, announced);
        window.removeEventListener("storage", stored);
      };
    }
  };
}

export function startPreferences(ports: LegacyPreferencePorts = browserPreferencePorts()): () => void {
  if (started) throw new Error("The preferences are already started; stop them first");
  let announcing = false;
  const preferences = createPreferences({
    storage: ports.storage,
    announce: function (change) {
      announcing = true;
      try {
        ports.announce(change);
      } finally {
        announcing = false;
        tellListeners(change);
      }
    }
  });
  const mine: Started = {
    preferences: preferences,
    flags: createViewFlags({ hideShot: preferences.hideShot }),
    panels: createPanelWidths({ storage: ports.storage })
  };
  started = mine;
  let unwatch = ports.watch(function (change) {
    if (!announcing && started === mine) tellListeners(change);
  });
  return function () {
    unwatch();
    unwatch = function () {};
    if (started === mine) started = null;
  };
}

export function preferencesStarted(): boolean {
  return started !== null;
}

export function preferences(): Preferences {
  return running().preferences;
}

export function viewFlags(): ViewFlags {
  return running().flags;
}

export function panelWidths(): PanelWidths {
  return running().panels;
}
