import type { ActionRegistry } from "../../application/actions.ts";
import type { PreferenceChange, PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { SaveState } from "../../application/save/save-state.ts";
import type { ScreenState } from "../../application/screen.ts";
import { appActions } from "../../legacy/app-actions.ts";
import { PREF_EVENT, preferences } from "../../legacy/preferences-bridge.ts";
import { autoSavePolicy, onSaveChange, resumeAutoSave, saveBusy, unsavedChanges } from "../../legacy/save-bridge.ts";
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

const saves: SaveState = {
  unsaved: () => unsavedChanges(),
  busy: () => saveBusy(),
  onChange: (listener) => onSaveChange(listener),
  dueNow: () => { autoSavePolicy().dueNow(); },
  resume: () => { resumeAutoSave(); }
};

const shared = {
  actions,
  changes,
  saves,
  screen: (): ScreenState => screenNow()
};

export function sharedPorts(): typeof shared {
  return shared;
}
