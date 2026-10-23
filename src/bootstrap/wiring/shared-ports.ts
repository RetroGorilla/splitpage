import type { ActionRegistry } from "../../application/actions.ts";
import type { PreferenceChange, PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentDestination } from "../../application/transitions/ports.ts";
import type { Transitions } from "../../application/transitions/transitions.ts";
import { appActions } from "../../legacy/app-actions.ts";
import { PREF_EVENT, preferences } from "../../legacy/preferences-bridge.ts";
import { screenNow } from "../../legacy/screen-state.ts";
import { documentTransitions } from "../../legacy/transition-bridge.ts";

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

const transitions: Transitions<DocumentDestination> = {
  open: (opening) => documentTransitions().open(opening),
  startNew: (arrival) => documentTransitions().startNew(arrival),
  restore: (restoration) => documentTransitions().restore(restoration),
  recover: (recovery) => documentTransitions().recover(recovery),
  publish: (ctx, publication) => documentTransitions().publish(ctx, publication),
  copyId: () => documentTransitions().copyId()
};

const shared = {
  actions,
  changes,
  screen: (): ScreenState => screenNow(),
  transitions
};

export function sharedPorts(): typeof shared {
  return shared;
}
