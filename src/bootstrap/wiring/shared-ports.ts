import type { ActionRegistry } from "../../application/actions.ts";
import type { PreferenceChange, PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { ProductionIndexOwner } from "../../core/production/index.ts";
import { appActions } from "../../legacy/app-actions.ts";
import { PREF_EVENT, preferences } from "../../legacy/preferences-bridge.ts";
import { productionIndex } from "../../legacy/production-index-bridge.ts";
import { screenNow } from "../../legacy/screen-state.ts";

const actions: Pick<ActionRegistry, "invoke" | "view"> = {
  invoke: (id, source) => appActions.invoke(id, source),
  view: (id, source) => appActions.view(id, source)
};

const changes: PreferenceChanges = {
  onChange(listener) {
    const onPreference = (event: Event): void => {
      const change = (event as CustomEvent<PreferenceChange | undefined>).detail;
      if (!change) return;
      const name = preferences().nameOf(change.key);
      if (name) listener({ name, value: change.value, elsewhere: false });
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null) return;
      const name = preferences().nameOf(event.key);
      if (name) listener({ name, value: event.newValue, elsewhere: true });
    };
    document.addEventListener(PREF_EVENT, onPreference);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener(PREF_EVENT, onPreference);
      window.removeEventListener("storage", onStorage);
    };
  }
};

const production: ProductionIndexOwner = {
  entries: (doc) => productionIndex().entries(doc),
  current: (doc) => productionIndex().current(doc),
  derived: () => productionIndex().derived(),
  resetDerived: () => { productionIndex().resetDerived(); },
  recordsPlan: (doc, viewed) => productionIndex().recordsPlan(doc, viewed)
};

const shared = {
  actions,
  changes,
  production,
  screen: (): ScreenState => screenNow()
};

export function sharedPorts(): typeof shared {
  return shared;
}
